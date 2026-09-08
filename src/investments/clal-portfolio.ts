import {z} from 'zod';
import {ClalCollectionError} from './browser.js';
import {investmentProductId, investmentTrackId, investmentValuationId} from './ids.js';
import {investmentSnapshotSchema} from './schema.js';
import type {InvestmentProduct, InvestmentSnapshot, InvestmentTrack, InvestmentValuation} from './types.js';

export type ClalApiResponse = {status: number; data: unknown};
export type ClalPortfolioInput = {
	portfolio: ClalApiResponse;
	dailyBalances?: ClalApiResponse;
	pensionDetails?: ClalApiResponse[];
	gemelDetails?: ClalApiResponse[];
	observedAt: string;
};

function invalid(): never {
	// Error text must never contain a policy, account, balance, or raw response.
	throw new ClalCollectionError('INVALID_RESPONSE');
}

export function clalRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return invalid();
	}

	return value as Record<string, unknown>;
}

export function clalArray(value: unknown): unknown[] {
	if (!Array.isArray(value)) {
		return invalid();
	}

	return value;
}

function text(value: unknown): string {
	if (typeof value !== 'string' || !value.trim()) {
		return invalid();
	}

	return value.trim();
}

/** Parse provider decimal strings without binary arithmetic or implicit rounding. */
export function parseClalMoney(value: unknown): string {
	const input = text(value);
	if (!/^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(input)) {
		return invalid();
	}

	const unsigned = input.replace(/^-/, '').replaceAll(',', '');
	const [integer = '', fraction = ''] = unsigned.split('.');
	const amount = `${BigInt(integer)}.${fraction.padEnd(2, '0')}`;
	return input.startsWith('-') && amount !== '0.00' ? `-${amount}` : amount;
}

/** Missing dates stay missing; abbreviated years require separate source context. */
export function parseClalDate(value: unknown): InvestmentValuation['asOf'] {
	if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) {
		return null;
	}

	const input = text(value);
	const dayFirst = /^(?<day>\d{2})(?<separator>[./])(?<month>\d{2})\k<separator>(?<year>\d{4})$/.exec(input)?.groups;
	const candidate = dayFirst ? `${dayFirst.year}-${dayFirst.month}-${dayFirst.day}` : input;
	return z.iso.date().safeParse(candidate).success ? candidate : invalid();
}

export function requireClalSuccess(value: unknown): Record<string, unknown> {
	const record = clalRecord(value);
	if (record.IsSuccess !== true) {
		return invalid();
	}

	for (const flag of ['IsGeneralError', 'ResponseIsAppErrorIsAppError', 'GetDailyBalanceItemFailed']) {
		if (record[flag] !== undefined && record[flag] !== false) {
			return invalid();
		}
	}

	return record;
}

export function clalProductIdentity(family: 'pension' | 'hishtalmut', value: unknown): {id: string; providerProductId: string} {
	const providerProductId = `${family}:${text(value)}`;
	return {id: investmentProductId(providerProductId), providerProductId};
}

function responseData(response: ClalApiResponse): Record<string, unknown> {
	if (!Number.isSafeInteger(response.status) || response.status < 200 || response.status > 299) {
		return invalid();
	}

	return requireClalSuccess(response.data);
}

function nonnegativeMoney(value: unknown): string {
	const amount = parseClalMoney(value);
	return amount.startsWith('-') ? invalid() : amount;
}

function cents(value: string): bigint {
	return BigInt(value.replace('.', ''));
}

function product(family: 'pension' | 'hishtalmut', rawId: unknown, name: unknown): InvestmentProduct {
	return {
		...clalProductIdentity(family, rawId), provider: 'clal',
		kind: family === 'pension' ? 'pension' : 'keren_hishtalmut', name: text(name), currency: 'ILS',
		currentValuationId: null,
		liquidity: {status: 'unknown', availableFrom: null, availableAmount: null},
		coverage: {valuations: 'unavailable', activities: 'unavailable', tracks: 'unavailable'},
		forecast: null,
	};
}

function currentValue(snapshot: InvestmentSnapshot, item: InvestmentProduct, rawAmount: unknown, rawDate: unknown): void {
	if (([null, undefined, ''] as unknown[]).includes(rawAmount)) {
		snapshot.complete = false;
		return;
	}

	const amount = nonnegativeMoney(rawAmount);
	const asOf = parseClalDate(rawDate);
	const id = investmentValuationId(item.id, asOf);
	snapshot.valuations.push({id, productId: item.id, amount, asOf, observedAt: snapshot.observedAt, currency: 'ILS'});
	item.currentValuationId = id;
	item.coverage.valuations = 'partial';
}

function indexDetails(responses: ClalApiResponse[], family: 'pension' | 'hishtalmut'): Map<string, Record<string, unknown>> {
	const result = new Map<string, Record<string, unknown>>();
	for (const response of responses) {
		const data = responseData(response);
		const detail = clalRecord(family === 'pension' ? data.PolicyDetails : data.FundDetails);
		const {id} = clalProductIdentity(family, family === 'pension' ? detail.PolicyId : detail.FundNumber);
		if (result.has(id)) {
			return invalid();
		}

		result.set(id, data);
	}

	return result;
}

function verifyCurrentValue(snapshot: InvestmentSnapshot, item: InvestmentProduct, amount: unknown, date: unknown): void {
	const current = snapshot.valuations.find(row => row.id === item.currentValuationId);
	if (current?.amount !== nonnegativeMoney(amount) || current?.asOf !== parseClalDate(date)) {
		snapshot.complete = false;
	}
}

function pensionMetadata(snapshot: InvestmentSnapshot, item: InvestmentProduct, data: Record<string, unknown>): void {
	const details = clalRecord(data.PolicyDetails);
	verifyCurrentValue(snapshot, item, details.BalanceTotal, clalRecord(data.PeriodBalance).Date);
	if (data.hasPolicyInsCoverages === true) {
		const coverages = clalRecord(data.PolicyInsCoverages);
		if (coverages.PensiaPrisha !== null && coverages.PensiaPrisha !== undefined && coverages.PensiaPrisha !== '') {
			item.forecast = {monthlyPension: nonnegativeMoney(coverages.PensiaPrisha), currency: 'ILS', asOf: null};
		}
	}

	const rows = clalArray(clalRecord(data.InvestmentTracks).InvestmentTracksRows);
	for (const raw of rows) {
		const row = clalRecord(raw);
		snapshot.tracks.push({
			id: investmentTrackId(item.id, text(row.TrackNum)), productId: item.id, name: text(row.TrackName),
			amount: null, allocationPercent: null, currency: 'ILS', asOf: null, observedAt: snapshot.observedAt,
		});
	}

	item.coverage.tracks = rows.length > 0 ? 'partial' : 'unavailable';
}

function trackDate(value: unknown, referenceDate: InvestmentValuation['asOf']): InvestmentValuation['asOf'] {
	if (typeof value === 'string' && /^\d{2}\/\d{2}\/\d{2}$/.test(value.trim())) {
		const [day, month, shortYear] = value.trim().split('/');
		// Only the identical year from a full provider date establishes the century.
		// Never apply the usual 19xx/20xx pivot or substitute the product's day/month.
		if (!referenceDate || referenceDate.slice(2, 4) !== shortYear) {
			return null;
		}

		return parseClalDate(`${day}/${month}/${referenceDate.slice(0, 4)}`);
	}

	return parseClalDate(value);
}

function gemelMetadata(snapshot: InvestmentSnapshot, item: InvestmentProduct, data: Record<string, unknown>): void {
	if (data.IsHishtalmut !== true || data.IsGemelDailyBalanceSuccess !== true) {
		return invalid();
	}

	const details = clalRecord(data.FundDetails);
	const date = parseClalDate(details.ProfitUpdateDate);
	const balance = nonnegativeMoney(details.Balance);
	verifyCurrentValue(snapshot, item, balance, date);
	// Verified against the rendered Clal label “קרן השתלמות – כל הכספים”.
	// DateNazil2/3 concern other conditions and cannot replace this missing field.
	const availableFrom = parseClalDate(details.DateNazil1);
	if (availableFrom) {
		const today = new Date(snapshot.observedAt).toLocaleDateString('sv-SE', {timeZone: 'Asia/Jerusalem'});
		item.liquidity = {status: availableFrom <= today ? 'available' : 'restricted', availableFrom, availableAmount: null};
	}

	const tab = clalRecord(data.MaslulimTab);
	const rows = clalArray(tab.Maslulim);
	const parsed: InvestmentTrack[] = [];
	let sum = 0n;
	for (const raw of rows) {
		const row = clalRecord(raw);
		const amount = nonnegativeMoney(row.CurrentBalance);
		sum += cents(amount);
		// Clal includes inactive zero-value routes. They are not current holdings.
		if (amount === '0.00') {
			continue;
		}

		const trackId = [row.ConfirmationCode, row.ProductCode, row.KupaCode].map(value => encodeURIComponent(text(value))).join(':');
		parsed.push({
			id: investmentTrackId(item.id, trackId), productId: item.id, name: text(row.Name),
			amount, allocationPercent: null, currency: 'ILS', asOf: trackDate(row.ValidateDate, date), observedAt: snapshot.observedAt,
		});
	}

	if (sum !== cents(balance) || nonnegativeMoney(tab.BalanceSum) !== balance) {
		snapshot.complete = false;
		return;
	}

	snapshot.tracks.push(...parsed);
	item.coverage.tracks = parsed.length > 0 ? 'partial' : 'unavailable';
}

/** Parse current pension/hishtalmut inventory; only a fully matched collection can replace saved data. */
export function parseClalPortfolioSnapshot(input: ClalPortfolioInput): InvestmentSnapshot {
	if (!z.iso.datetime().safeParse(input.observedAt).success) {
		return invalid();
	}

	const home = responseData(input.portfolio);
	const snapshot: InvestmentSnapshot = {observedAt: input.observedAt, complete: true, inventoryComplete: true, products: [], valuations: [], activities: [], tracks: []};
	const pensionDetails = indexDetails(input.pensionDetails ?? [], 'pension');
	const gemelDetails = indexDetails(input.gemelDetails ?? [], 'hishtalmut');
	const pensionRows = clalArray(home.PortfolioDataPensionFundation);
	const hishtalmutRows = clalArray(home.PortfolioDataGemelHichudList).map(value => clalRecord(value)).filter(row => {
		if (typeof row.IsHishtalmut !== 'boolean') {
			return invalid();
		}

		return row.IsHishtalmut;
	});
	const dailyItems = new Map<string, Record<string, unknown>>();
	if (input.dailyBalances) {
		const daily = responseData(input.dailyBalances);
		if (daily.AllPoliciesFoundInCache !== true) {
			snapshot.complete = false;
		}

		for (const raw of clalArray(requireClalSuccess(daily.GemelDailyBalanceData).Items)) {
			const row = clalRecord(raw);
			const {id} = clalProductIdentity('hishtalmut', row.InsuranceNumber);
			if (dailyItems.has(id)) {
				return invalid();
			}

			dailyItems.set(id, row);
		}
	}

	for (const raw of pensionRows) {
		const row = clalRecord(raw);
		const item = product('pension', row.PolicyId, row.PensionPlanName || row.FoundationName);
		snapshot.products.push(item);
		currentValue(snapshot, item, row.BalanceTotal, row.ValidationDate);
		const detail = pensionDetails.get(item.id);
		if (detail) {
			pensionMetadata(snapshot, item, detail);
			pensionDetails.delete(item.id);
		} else {
			snapshot.complete = false;
		}
	}

	for (const row of hishtalmutRows) {
		const item = product('hishtalmut', row.InsuranceNumber, row.InsuranceName || row.InsuranceTypeName);
		snapshot.products.push(item);
		const daily = dailyItems.get(item.id);
		currentValue(snapshot, item, daily?.Balance, daily?.ProfitUpdateDate);
		const detail = gemelDetails.get(item.id);
		if (detail) {
			gemelMetadata(snapshot, item, detail);
			gemelDetails.delete(item.id);
		} else {
			snapshot.complete = false;
		}
	}

	if (pensionDetails.size > 0 || gemelDetails.size > 0 || snapshot.products.length === 0) {
		return invalid();
	}

	for (const rows of [snapshot.products, snapshot.valuations, snapshot.tracks]) {
		if (new Set(rows.map(row => row.id)).size !== rows.length) {
			return invalid();
		}
	}

	snapshot.inventoryComplete = snapshot.complete;
	const result = investmentSnapshotSchema.safeParse(snapshot);
	return result.success ? result.data : invalid();
}
