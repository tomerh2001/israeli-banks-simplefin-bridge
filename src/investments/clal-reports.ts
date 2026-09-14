import {ClalCollectionError} from './browser.js';
import {clalArray, clalProductIdentity, clalRecord, parseClalDate, parseClalMoney, requireClalSuccess, type ClalPortfolioInput} from './clal-portfolio.js';
import {investmentSnapshotSchema} from './schema.js';
import {investmentValuationId} from './ids.js';
import type {InvestmentProduct, InvestmentSnapshot, InvestmentValuation} from './types.js';

type Report = NonNullable<InvestmentProduct['reportSummaries']>[number];

function label(value: unknown): string {
	if (typeof value !== 'string' || !value.trim()) {
		throw new ClalCollectionError('INVALID_RESPONSE');
	}

	return value.trim();
}

function lines(value: unknown): Report['lines'] {
	return clalArray(value).map(raw => clalRecord(raw)).filter(row =>
		row.Total !== null && row.Total !== undefined && (typeof row.Total !== 'string' || !['', '-', '—'].includes(row.Total.trim()))).map(row => ({label: label(row.Title), amount: parseClalMoney(row.Total)}));
}

function openingDate(rows: Report['lines']): Report['fromDate'] {
	const opening = rows.find(row => row.label.includes('(פתיחה)'));
	const date = opening?.label.match(/\b\d{2}\/\d{2}\/\d{4}\b/)?.[0];
	return parseClalDate(date);
}

function reportBalances(product: InvestmentProduct, current: InvestmentValuation, report: Report): InvestmentValuation[] {
	// Lifetime report origins can contain template zero balances long before
	// a policy existed. Only the actual annual period is usable.
	if (!report.toDate || report.fromDate?.slice(0, 4) !== report.toDate.slice(0, 4)
		|| report.toDate > current.observedAt.slice(0, 10)) {
		return [];
	}

	return report.lines.flatMap(line => {
		if (!/^(?:יתרת הכספים|יתרה צבורה)(?:\s|$)/u.test(line.label) || line.amount.startsWith('-')) {
			return [];
		}

		const asOf = parseClalDate((/\b\d{2}\/\d{2}\/\d{4}\b/.exec(line.label))?.[0]);
		const opening = line.label.includes('(פתיחה)');
		if (!asOf || asOf !== (opening ? report.fromDate : report.toDate)) {
			return [];
		}

		return [{id: investmentValuationId(product.id, asOf), productId: product.id, amount: line.amount,
			asOf, observedAt: current.observedAt, currency: product.currency}];
	});
}

/** Extract only dated balance observations; period flows never become valuations. */
export function enrichClalReportValuations<T extends Pick<InvestmentSnapshot, 'products' | 'valuations'>>(snapshot: T): T {
	const valuations = [...snapshot.valuations];
	for (const product of snapshot.products) {
		const current = snapshot.valuations.find(value => value.id === product.currentValuationId && value.productId === product.id);
		if (product.provider !== 'clal' || !current) {
			continue;
		}

		const candidates = (product.reportSummaries ?? []).flatMap(report => reportBalances(product, current, report));
		for (const value of candidates) {
			// A directly reported portfolio valuation wins over a report total
			// for the same date, including its original identity.
			const directlyObserved = snapshot.valuations.some(row => row.productId === product.id && row.asOf === value.asOf);
			if (!directlyObserved) {
				const existing = valuations.find(row => row.id === value.id);
				if (existing && existing.amount !== value.amount) {
					throw new ClalCollectionError('INVALID_RESPONSE');
				}

				if (!existing) {
					valuations.push(value);
				}
			}
		}
	}

	return {...snapshot, valuations};
}

/** Preserve all report totals as context; only explicit balance dates extend history. */
export function enrichClalReports(snapshot: InvestmentSnapshot, input: Pick<ClalPortfolioInput, 'pensionDetails' | 'gemelDetails'>): InvestmentSnapshot {
	const products = snapshot.products.map(product => ({...product}));
	for (const [family, responses] of [
		['pension', input.pensionDetails ?? []], ['hishtalmut', input.gemelDetails ?? []],
	] as const) {
		for (const response of responses) {
			if (response.status !== 200) {
				throw new ClalCollectionError('INVALID_RESPONSE');
			}

			const data = requireClalSuccess(response.data);
			const details = clalRecord(family === 'pension' ? data.PolicyDetails : data.FundDetails);
			const {id} = clalProductIdentity(family, family === 'pension' ? details.PolicyId : details.FundNumber);
			const product = products.find(item => item.id === id);
			if (!product) {
				throw new ClalCollectionError('INVALID_RESPONSE');
			}

			const reports: Report[] = [];
			const keys = family === 'pension' ? ['PeriodBalance', 'PeriodBalanceLastYear'] : ['DeposMonthlyBalance'];
			const availableKeys = keys.filter(key => data[key] !== null && data[key] !== undefined);
			for (const key of availableKeys) {
				const block = clalRecord(data[key]);
				const reportLines = lines(family === 'pension' ? block.PeriodBalanceRows : block.DeposMonthlyList);
				const fromDate = family === 'pension' ? openingDate(reportLines) : parseClalDate(block.StartYear);
				const toDate = parseClalDate(family === 'pension' ? block.Date : block.EndYear);
				reports.push({id: `${key}:${fromDate ?? 'unknown'}:${toDate ?? 'unknown'}`, title: 'תנועות ויתרות', fromDate, toDate, lines: reportLines});
			}

			product.reportSummaries = reports;
		}
	}

	return investmentSnapshotSchema.parse(enrichClalReportValuations({...snapshot, products}));
}
