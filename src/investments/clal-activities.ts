import {createHash} from 'node:crypto';
import {ClalCollectionError} from './browser.js';
import {
	clalArray,
	clalProductIdentity,
	clalRecord,
	parseClalDate,
	parseClalMoney,
	requireClalSuccess,
	type ClalApiResponse,
	type ClalPortfolioInput,
} from './clal-portfolio.js';
import {investmentActivityId} from './ids.js';
import {investmentSnapshotSchema} from './schema.js';
import type {InvestmentActivity, InvestmentSnapshot} from './types.js';

type OptionalText = ReturnType<typeof parseClalDate>;

type Component = {column: string; kind: InvestmentActivity['kind']; label: string};
type Group = {activity: InvestmentActivity; cents: bigint};
type Dimensions = {
	productId: string;
	employerId: OptionalText;
	employerName: OptionalText;
	bookingDate: OptionalText;
	salaryMonth: OptionalText;
	description: string;
	track: OptionalText;
};

const pensionComponents: Component[] = [
	{column: 'TigmulimAmit', kind: 'employee_contribution', label: 'Employee contribution'},
	{column: 'TigmulimMaasik', kind: 'employer_contribution', label: 'Employer contribution'},
	{column: 'Compensation', kind: 'severance_contribution', label: 'Severance contribution'},
];
const gemelComponents: Component[] = [
	{column: 'TotalSumEmployee', kind: 'employee_contribution', label: 'Employee contribution'},
	{column: 'TotalSumEmployer', kind: 'employer_contribution', label: 'Employer contribution'},
	{column: 'TotalSumCompensation', kind: 'severance_contribution', label: 'Severance contribution'},
	{column: 'TotalSumSelfEmployed', kind: 'other', label: 'Self-employed contribution'},
];

function invalid(): never {
	throw new ClalCollectionError('INVALID_RESPONSE');
}

function optionalText(value: unknown): OptionalText {
	const absent: readonly unknown[] = [null, undefined, ''];
	if (absent.includes(value)) {
		return null;
	}

	if (typeof value !== 'string') {
		return invalid();
	}

	return value.trim() || null;
}

function cents(value: unknown): bigint {
	return BigInt(parseClalMoney(value).replace('.', ''));
}

function money(value: bigint): string {
	const absolute = value < 0n ? -value : value;
	return `${value < 0n ? '-' : ''}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, '0')}`;
}

function yearText(value: unknown): string {
	const text = optionalText(value);
	return text && /^\d{4}$/.test(text) ? text : invalid();
}

function salaryMonth(value: unknown): OptionalText {
	const text = optionalText(value);
	if (text === null) {
		return null;
	}

	const monthFirst = /^(?<month>0[1-9]|1[0-2])\/(?<year>\d{4})$/.exec(text);
	if (monthFirst) {
		return `${monthFirst.groups!.year}-${monthFirst.groups!.month}`;
	}

	return /^\d{4}-(?:0[1-9]|1[0-2])$/.test(text) ? text : invalid();
}

/** The annual source bucket supplies the century; never use a guessed pivot year. */
function bookingDate(value: unknown, year: string): OptionalText {
	const text = optionalText(value);
	const abbreviated = text && /^(?<day>\d{2})\/(?<month>\d{2})\/(?<year>\d{2})$/.exec(text);
	if (abbreviated) {
		if (abbreviated.groups!.year !== year.slice(-2)) {
			return invalid();
		}

		return parseClalDate(`${abbreviated.groups!.day}/${abbreviated.groups!.month}/${year}`);
	}

	const parsed = parseClalDate(text);
	return parsed !== null && !parsed.startsWith(`${year}-`) ? invalid() : parsed;
}

function body(response: ClalApiResponse): Record<string, unknown> {
	if (!Number.isSafeInteger(response.status) || response.status < 200 || response.status > 299) {
		return invalid();
	}

	return requireClalSuccess(response.data);
}

function componentAmounts(row: Record<string, unknown>, components: Component[], totalColumn: string): bigint[] {
	const amounts = components.map(component => cents(row[component.column]));
	if (amounts.reduce((sum, amount) => sum + amount, 0n) !== cents(row[totalColumn])) {
		return invalid();
	}

	return amounts;
}

function addGroups(groups: Map<string, Group>, dimensions: Dimensions, components: Component[], amounts: bigint[], observedAt: string): void {
	const date = dimensions.bookingDate ?? dimensions.salaryMonth;
	if (date === null) {
		return invalid();
	}

	for (const [index, component] of components.entries()) {
		// No source row ID exists. These are explicitly groups of all source
		// rows with identical complete dimensions, not deduplicated purchases.
		// Amount is excluded so source corrections update the same group.
		const key = JSON.stringify([
			'clal-deposit-source-group-v1',
			dimensions.productId,
			dimensions.employerId,
			dimensions.employerName,
			dimensions.bookingDate,
			dimensions.salaryMonth,
			dimensions.description,
			dimensions.track,
			component.column,
			component.kind,
		]);
		const sourceId = `source-group-v1:${createHash('sha256').update(key).digest('hex')}`;
		const existing = groups.get(sourceId);
		const amount = amounts[index]!;
		if (existing) {
			existing.cents += amount;
			continue;
		}

		const description = [
			component.label,
			dimensions.employerName,
			dimensions.description,
			dimensions.salaryMonth ? `Salary month ${dimensions.salaryMonth}` : null,
			dimensions.track ? `Track ${dimensions.track}` : null,
			'Source group',
		].filter(Boolean).join('; ');
		groups.set(sourceId, {
			cents: amount,
			activity: {
				id: investmentActivityId(dimensions.productId, sourceId), productId: dimensions.productId,
				sourceId, date, dateKind: dimensions.bookingDate ? 'booking' : 'contribution_month',
				kind: component.kind, amount: '0.00', currency: 'ILS', description, observedAt,
			},
		});
	}
}

function checkAnnualTotals(total: bigint, sums: bigint[], subtotal: bigint[] | undefined): void {
	if (sums.reduce((sum, amount) => sum + amount, 0n) !== total
		|| (subtotal?.some((amount, index) => amount !== sums[index]))) {
		return invalid();
	}
}

function pensionHistory(data: Record<string, unknown>, groups: Map<string, Group>, observedAt: string): string {
	const details = clalRecord(data.PolicyDetails);
	const {id: productId} = clalProductIdentity('pension', details.PolicyId);
	const years = new Set<string>();
	for (const rawYear of clalArray(data.NDepositingList)) {
		const block = clalRecord(rawYear);
		const year = yearText(block.BeginYear);
		if (years.has(year)) {
			return invalid();
		}

		years.add(year);
		const rows = clalArray(requireClalSuccess(block.TransactionsData).DepositingPerMonthList);
		const sums = pensionComponents.map(() => 0n);
		let subtotal: bigint[] | undefined;
		for (const rawRow of rows) {
			const row = clalRecord(rawRow);
			const amounts = componentAmounts(row, pensionComponents, 'Total');
			const companyName = optionalText(row.CompanyName);
			const salary = salaryMonth(row.SalaryDate);
			const booked = bookingDate(row.DepositingDate, year);
			if (companyName?.toLowerCase() === 'all' && booked === null && salary === null) {
				if (subtotal) {
					return invalid();
				}

				subtotal = amounts;
				// eslint-disable-next-line unicorn/no-break-in-nested-loop -- Subtotals must never enter the deposit ledger.
				continue;
			}

			if (!companyName) {
				return invalid();
			}

			for (const [index, amount] of amounts.entries()) {
				sums[index]! += amount;
			}

			// Pension rows name their employer but do not expose an employer ID.
			// Do not attach today's employer number to historical employers.
			addGroups(groups, {productId, employerId: null, employerName: companyName, bookingDate: booked,
				salaryMonth: salary, description: 'Deposit', track: null}, pensionComponents, amounts, observedAt);
		}

		checkAnnualTotals(cents(block.Total), sums, subtotal);
	}

	return productId;
}

function gemelHistory(data: Record<string, unknown>, groups: Map<string, Group>, observedAt: string): string {
	if (data.IsHishtalmut !== true) {
		return invalid();
	}

	const details = clalRecord(data.FundDetails);
	const {id: productId} = clalProductIdentity('hishtalmut', details.FundNumber);
	const years = new Set<string>();
	for (const rawYear of clalArray(clalRecord(data.TransactionsTab).TransactionsList)) {
		const block = clalRecord(rawYear);
		const transactionData = clalRecord(block.TransactionsData);
		const rows = clalArray(transactionData.GetFundTransPerYearList);
		if (block.Year === null && rows.length === 0) {
			// The API includes a non-year footer/template. Its Sum is neither
			// dated activity nor evidence of missing history. Never import it.
			continue;
		}

		const year = yearText(block.Year);
		if (years.has(year)) {
			return invalid();
		}

		years.add(year);
		requireClalSuccess(transactionData);
		if (clalArray(transactionData.GetFundTransPerYearNotIncludedList).length > 0) {
			return invalid();
		}

		const sums = gemelComponents.map(() => 0n);
		let subtotal: bigint[] | undefined;
		for (const rawRow of rows) {
			const row = clalRecord(rawRow);
			const amounts = componentAmounts(row, gemelComponents, 'TotalSum');
			const description = optionalText(row.TransactionDescription);
			const salary = salaryMonth(row.SalaryMonth);
			const booked = bookingDate(row.TransactionDate, year);
			const track = optionalText(row.Maslul);
			if (description === 'Total' && booked === null && salary === null && track === null) {
				if (subtotal) {
					return invalid();
				}

				subtotal = amounts;
				// eslint-disable-next-line unicorn/no-break-in-nested-loop -- Subtotals must never enter the deposit ledger.
				continue;
			}

			// Only this exact source label has been verified as a deposit.
			// Transfers/withdrawals must not become employer contributions.
			if (description !== 'הפקדה') {
				return invalid();
			}

			for (const [index, amount] of amounts.entries()) {
				sums[index]! += amount;
			}

			addGroups(groups, {
				productId, employerId: optionalText(details.EmployerNum), employerName: optionalText(details.EmployerName),
				bookingDate: booked, salaryMonth: salary, description, track,
			}, gemelComponents, amounts, observedAt);
		}

		checkAnnualTotals(cents(block.Sum), sums, subtotal);
	}

	return productId;
}

/** Enrich only proven deposits; period summaries and template history are not activity. */
export function enrichClalActivities(
	snapshot: InvestmentSnapshot,
	input: Pick<ClalPortfolioInput, 'pensionDetails' | 'gemelDetails'>,
): InvestmentSnapshot {
	const groups = new Map<string, Group>();
	const covered = new Set<string>();
	for (const [family, responses] of [
		['pension', input.pensionDetails ?? []], ['hishtalmut', input.gemelDetails ?? []],
	] as const) {
		for (const response of responses) {
			const data = body(response);
			const productId = family === 'pension'
				? pensionHistory(data, groups, snapshot.observedAt)
				: gemelHistory(data, groups, snapshot.observedAt);
			if (covered.has(productId) || snapshot.products.every(product => product.id !== productId)) {
				return invalid();
			}

			covered.add(productId);
		}
	}

	const activities = [...groups.values()]
		.map(group => ({...group.activity, amount: money(group.cents)}));
	const existing = new Map(snapshot.activities.map(activity => [activity.id, activity]));
	for (const activity of activities) {
		existing.set(activity.id, activity);
	}

	return investmentSnapshotSchema.parse({
		...snapshot,
		activities: [...existing.values()].sort((left, right) => left.id.localeCompare(right.id)),
		products: snapshot.products.map(product => covered.has(product.id)
			? {...product, coverage: {...product.coverage, activities: 'partial'}}
			: product),
	});
}
