import {z} from 'zod';
import {investmentProductId, investmentTrackId, investmentValuationId} from '../ids.js';
import {investmentSnapshotSchema} from '../schema.js';
import type {InvestmentProduct, InvestmentSnapshot, InvestmentTrack, InvestmentValuation} from '../types.js';

export type BestInvestCapturedPolicy = {
	/** Raw details response, with numeric JSON tokens preserved by parseBestInvestJson. */
	details: unknown;
	/** Optional current-year deposits response; these rows have no proven ledger identities. */
	deposits?: unknown;
	/** Actual year requested from GetDepositsByYear, never inferred from a valuation date. */
	depositsYear?: number;
	/** Exact inventory identity, if available; no padding or numeric conversion is inferred. */
	expectedPolicyId?: string;
};

export type BuildBestInvestSnapshotInput = {
	observedAt: string;
	policies: BestInvestCapturedPolicy[];
	inventoryComplete: boolean;
	/** Fixed diagnostic codes only; observation must not affect financial decisions. */
	onIncomplete?(reason: BestInvestIncompleteReason): void;
};

export type BestInvestIncompleteReason =
	| 'INVENTORY_INCOMPLETE'
	| 'POLICIES_EMPTY'
	| 'POLICY_DETAILS_MISSING'
	| 'POLICY_ID_MISSING'
	| 'POLICY_NAME_MISSING'
	| 'VALUATION_AMOUNT_MISSING'
	| 'TRACK_ACCUMULATION_MISSING'
	| 'TRACK_ALLOCATION_MISSING'
	| 'TRACK_ROWS_INVALID'
	| 'TRACK_ALLOCATION_ROWS_INVALID'
	| 'TRACK_TOTAL_MISSING'
	| 'TRACK_AMOUNT_MISSING'
	| 'TRACK_MAPPING_MISSING'
	| 'TRACK_MAPPING_AMBIGUOUS'
	| 'TRACK_ID_MISSING'
	| 'TRACK_SUM_MISMATCH'
	| 'TRACK_TOTAL_MISMATCH'
	| 'DEPOSITS_MISSING'
	| 'DEPOSIT_ROWS_INVALID'
	| 'DEPOSITS_TOTAL_MISSING'
	| 'DEPOSIT_AMOUNT_MISSING'
	| 'DEPOSITS_SUM_MISMATCH';

function incomplete(snapshot: InvestmentSnapshot, onIncomplete: BuildBestInvestSnapshotInput['onIncomplete'], reason: BestInvestIncompleteReason): void {
	snapshot.complete = false;
	try {
		onIncomplete?.(reason);
	} catch {
		// Diagnostics cannot turn a partial response into an error or accepted data.
	}
}

export class BestInvestParseError extends Error {
	constructor() {
		super('INVALID_RESPONSE');
	}

	get code() {
		return 'INVALID_RESPONSE' as const;
	}
}

function invalid(): never {
	throw new BestInvestParseError();
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value)
		? value as Record<string, unknown>
		: invalid();
}

function missing(value: unknown): boolean {
	return value === null || value === undefined || (typeof value === 'string' && !value.trim());
}

function text(value: unknown): string {
	return typeof value === 'string' && value.trim() ? value.trim() : invalid();
}

function identity(value: unknown): string {
	if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
		return String(value);
	}

	return text(value);
}

/**
 * Preserve JSON number lexemes before any binary conversion, including integers used as IDs.
 * Strings, escaped quotes, booleans and null retain their normal JSON meaning.
 */
export function parseBestInvestJson(input: string): unknown {
	try {
		let result = '';
		let quoted = false;
		let escaped = false;
		for (let index = 0; index < input.length; index++) {
			const character = input[index]!;
			if (quoted) {
				result += character;
				if (escaped) {
					escaped = false;
				} else if (character === '\\') {
					escaped = true;
				} else if (character === '"') {
					quoted = false;
				}
			} else if (character === '"') {
				quoted = true;
				result += character;
			} else if (character === '-' || /\d/.test(character)) {
				const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?/i.exec(input.slice(index))?.[0];
				if (!number) {
					return invalid();
				}

				result += JSON.stringify(number);
				index += number.length - 1;
			} else {
				result += character;
			}
		}

		return JSON.parse(result) as unknown;
	} catch {
		return invalid();
	}
}

/** Exact shekel/cents strings. Fractional JS numbers must arrive through parseBestInvestJson. */
export function parseBestInvestMoney(value: unknown): string {
	const input = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : text(value);
	if (!/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(input)) {
		return invalid();
	}

	const unsigned = input.replace(/^[+-]/, '').replaceAll(',', '');
	const [integer = '', fraction = ''] = unsigned.split('.');
	const amount = `${BigInt(integer)}.${fraction.padEnd(2, '0')}`;
	return input.startsWith('-') && amount !== '0.00' ? `-${amount}` : amount;
}

/** Retain the provider's calendar date, without converting its offset into another day. */
export function parseBestInvestDate(value: unknown): InvestmentValuation['asOf'] {
	if (missing(value)) {
		return null;
	}

	const input = text(value);
	if (/^0001-01-01(?:T|$)/.test(input)) {
		return null;
	}

	const dayFirst = /^(?<day>\d{2})(?<separator>[./])(?<month>\d{2})\k<separator>(?<year>\d{4})$/.exec(input)?.groups;
	const candidate = dayFirst ? `${dayFirst.year}-${dayFirst.month}-${dayFirst.day}` : input.slice(0, 10);
	const validDate = z.iso.date().safeParse(candidate).success;
	const validFormat = Boolean(dayFirst)
		|| input === candidate
		|| /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/.test(input);
	return validDate && validFormat ? candidate : invalid();
}

function nonnegativeMoney(value: unknown): string {
	const amount = parseBestInvestMoney(value);
	return amount.startsWith('-') ? invalid() : amount;
}

function cents(value: string): bigint {
	return BigInt(value.replace('.', ''));
}

function fromCents(value: bigint): string {
	const unsigned = (value < 0n ? -value : value).toString().padStart(3, '0');
	return `${value < 0n ? '-' : ''}${unsigned.slice(0, -2)}.${unsigned.slice(-2)}`;
}

function policyProduct(details: Record<string, unknown>): InvestmentProduct {
	const providerProductId = identity(details.PolicyId);
	return {
		id: investmentProductId(providerProductId, 'hachshara_best_invest'),
		provider: 'hachshara_best_invest', providerProductId,
		kind: 'investment', name: text(details.ProductName), currency: 'ILS',
		currentValuationId: null,
		liquidity: {status: 'unknown', availableFrom: null, availableAmount: null},
		coverage: {valuations: 'unavailable', activities: 'unavailable', tracks: 'unavailable'},
		forecast: null, reportSummaries: [],
	};
}

function addTracks(
	snapshot: InvestmentSnapshot, product: InvestmentProduct, details: Record<string, unknown>,
	asOf: InvestmentValuation['asOf'], balance: string, onIncomplete: BuildBestInvestSnapshotInput['onIncomplete'],
): void {
	if (missing(details.PidyonTzvira) || missing(details.InvestmentPolicy)) {
		incomplete(snapshot, onIncomplete, missing(details.PidyonTzvira) ? 'TRACK_ACCUMULATION_MISSING' : 'TRACK_ALLOCATION_MISSING');
		return;
	}

	const accumulation = record(details.PidyonTzvira);
	const investment = record(details.InvestmentPolicy);
	if (!Array.isArray(accumulation.Pidyon) || !Array.isArray(investment.Investments)
		|| missing(accumulation.TotalTzviraMaslulim)) {
		const reason = Array.isArray(accumulation.Pidyon)
			? (Array.isArray(investment.Investments) ? 'TRACK_TOTAL_MISSING' : 'TRACK_ALLOCATION_ROWS_INVALID')
			: 'TRACK_ROWS_INVALID';
		incomplete(snapshot, onIncomplete, reason);
		return;
	}

	const allocations = investment.Investments.map(value => record(value));
	const tracks: InvestmentTrack[] = [];
	let sum = 0n;
	for (const raw of accumulation.Pidyon) {
		const row = record(raw);
		if (missing(row.TotalTzvira)) {
			incomplete(snapshot, onIncomplete, 'TRACK_AMOUNT_MISSING');
			return;
		}

		const amount = nonnegativeMoney(row.TotalTzvira);
		sum += cents(amount);
		if (amount === '0.00') {
			continue;
		}

		const house = text(row.BeitHashkaot);
		const route = text(row.Maslul);
		// The accumulation table lacks IDs. Join only a unique exact house/route pair
		// to the policy allocation table, which supplies stable provider codes.
		const matches = allocations.filter(candidate => text(candidate.BeitHashkaotName) === house && text(candidate.Maslul) === route);
		if (matches.length !== 1) {
			incomplete(snapshot, onIncomplete, matches.length === 0 ? 'TRACK_MAPPING_MISSING' : 'TRACK_MAPPING_AMBIGUOUS');
			return;
		}

		const match = matches[0]!;
		if (missing(match.BeitHashkaotId) || missing(match.MaslulId)) {
			incomplete(snapshot, onIncomplete, 'TRACK_ID_MISSING');
			return;
		}

		const sourceId = [match.BeitHashkaotId, match.MaslulId].map(value => encodeURIComponent(identity(value))).join(':');
		tracks.push({
			id: investmentTrackId(product.id, sourceId), productId: product.id,
			name: `${house} — ${route}`, amount, allocationPercent: null, currency: 'ILS',
			asOf, observedAt: snapshot.observedAt,
		});
	}

	if (new Set(tracks.map(track => track.id)).size !== tracks.length) {
		return invalid();
	}

	if (sum !== cents(balance)) {
		incomplete(snapshot, onIncomplete, 'TRACK_SUM_MISMATCH');
		return;
	}

	if (nonnegativeMoney(accumulation.TotalTzviraMaslulim) !== balance) {
		incomplete(snapshot, onIncomplete, 'TRACK_TOTAL_MISMATCH');
		return;
	}

	snapshot.tracks.push(...tracks);
	product.coverage.tracks = 'complete';
}

function addDepositSummary(snapshot: InvestmentSnapshot, product: InvestmentProduct, capture: BestInvestCapturedPolicy, onIncomplete: BuildBestInvestSnapshotInput['onIncomplete']): void {
	if (capture.deposits === undefined) {
		return;
	}

	if (!Number.isSafeInteger(capture.depositsYear) || capture.depositsYear! < 1900 || capture.depositsYear! > 9999) {
		return invalid();
	}

	if (capture.deposits === null) {
		incomplete(snapshot, onIncomplete, 'DEPOSITS_MISSING');
		return;
	}

	const data = record(capture.deposits);
	if (!Array.isArray(data.Deposits) || missing(data.TotalAmount)) {
		incomplete(snapshot, onIncomplete, Array.isArray(data.Deposits) ? 'DEPOSITS_TOTAL_MISSING' : 'DEPOSIT_ROWS_INVALID');
		return;
	}

	let sum = 0n;
	for (const raw of data.Deposits) {
		const row = record(raw);
		if (missing(row.Amount)) {
			incomplete(snapshot, onIncomplete, 'DEPOSIT_AMOUNT_MISSING');
			return;
		}

		// Identical rows can be distinct payments. Sum every source row; no deduplication.
		sum += cents(parseBestInvestMoney(row.Amount));
	}

	if (fromCents(sum) !== parseBestInvestMoney(data.TotalAmount)) {
		incomplete(snapshot, onIncomplete, 'DEPOSITS_SUM_MISMATCH');
		return;
	}

	product.reportSummaries = [{
		id: `${product.id}:deposits:${capture.depositsYear}`,
		title: `הפקדות שדווחו לשנת ${capture.depositsYear}`,
		// The endpoint's requested year does not establish the returned coverage dates.
		fromDate: null, toDate: null,
		lines: [{label: 'סך הפקדות שדווחו', amount: fromCents(sum)}],
	}];
}

/** A missing product or failed reconciliation makes the whole collection ineligible to replace saved data. */
export function buildBestInvestSnapshot(input: BuildBestInvestSnapshotInput): InvestmentSnapshot {
	if (!z.iso.datetime().safeParse(input.observedAt).success || !Array.isArray(input.policies)
		|| typeof input.inventoryComplete !== 'boolean') {
		return invalid();
	}

	const snapshot: InvestmentSnapshot = {
		observedAt: input.observedAt, complete: input.inventoryComplete && input.policies.length > 0,
		inventoryComplete: input.inventoryComplete, products: [], valuations: [], activities: [], tracks: [],
	};
	if (!input.inventoryComplete) {
		incomplete(snapshot, input.onIncomplete, 'INVENTORY_INCOMPLETE');
	}

	if (input.policies.length === 0) {
		incomplete(snapshot, input.onIncomplete, 'POLICIES_EMPTY');
	}

	for (const capture of input.policies) {
		if (missing(capture.details)) {
			incomplete(snapshot, input.onIncomplete, 'POLICY_DETAILS_MISSING');
			continue;
		}

		const details = record(capture.details);
		if (missing(details.PolicyId) || missing(details.ProductName)) {
			incomplete(snapshot, input.onIncomplete, missing(details.PolicyId) ? 'POLICY_ID_MISSING' : 'POLICY_NAME_MISSING');
			continue;
		}

		const product = policyProduct(details);
		if (capture.expectedPolicyId !== undefined && identity(capture.expectedPolicyId) !== product.providerProductId) {
			return invalid();
		}

		if (snapshot.products.some(item => item.id === product.id)) {
			return invalid();
		}

		snapshot.products.push(product);
		if (missing(details.TotalSavings)) {
			incomplete(snapshot, input.onIncomplete, 'VALUATION_AMOUNT_MISSING');
			continue;
		}

		const amount = nonnegativeMoney(details.TotalSavings);
		const accumulation = missing(details.PidyonTzvira) ? undefined : record(details.PidyonTzvira);
		const rawDate = accumulation?.AppraislDate;
		const asOf = parseBestInvestDate(rawDate === '0001-01-01T00:00:00' ? details.UpdatedToDate : rawDate);
		const id = investmentValuationId(product.id, asOf);
		snapshot.valuations.push({id, productId: product.id, amount, asOf, currency: 'ILS', observedAt: input.observedAt});
		product.currentValuationId = id;
		product.coverage.valuations = 'partial';
		addTracks(snapshot, product, details, asOf, amount, input.onIncomplete);
		addDepositSummary(snapshot, product, capture, input.onIncomplete);
	}

	snapshot.inventoryComplete = input.inventoryComplete && snapshot.complete;
	const result = investmentSnapshotSchema.safeParse(snapshot);
	return result.success ? result.data : invalid();
}
