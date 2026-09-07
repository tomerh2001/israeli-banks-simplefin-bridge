/**
 * Id scheme (ID_SCHEME_VERSION 1). See docs/architecture.md, "Id scheme".
 * Pure functions; no I/O.
 *
 * Every id is ASCII and at most 255 characters. Scraper-provided segments
 * (account number, identifier) are percent-encoded so that ':' and '#' stay
 * reserved as separators and Hebrew/other non-ASCII text never leaks into ids.
 */

import {createHash} from 'node:crypto';
import type {CompanyId, IsoDate, LedgerTransaction} from './types.js';

export type FingerprintParts = {
	bookedDate: IsoDate;
	amount: number;
	description: string;
	memo?: string | undefined;
	installmentNumber?: number | undefined;
	installmentTotal?: number | undefined;
};

/** Hard limit shared by every id (Securo/Actual store ids as String(255)). */
export const MAX_ID_LENGTH = 255;

const FINGERPRINT_LENGTH = 16;

/** Percent-encode everything outside `[A-Za-z0-9_.-]` so the segment is ASCII and separator-free. */
function encodeSegment(value: string): string {
	return value.replaceAll(/[^\w\-.]/g, character => encodeURIComponent(character));
}

/** True when every character is printable ASCII (U+0020..U+007E). */
function isPrintableAscii(value: string): boolean {
	return [...value].every(character => {
		const codePoint = character.codePointAt(0) ?? 0;
		return codePoint >= 0x20 && codePoint <= 0x7E;
	});
}

/** Throws when an assembled id is not printable ASCII or exceeds {@link MAX_ID_LENGTH}. */
function assertId(id: string): string {
	if (id === '' || !isPrintableAscii(id)) {
		throw new Error('Id contains non-ASCII characters');
	}

	if (id.length > MAX_ID_LENGTH) {
		throw new Error(`Id exceeds ${MAX_ID_LENGTH} characters (${id.length})`);
	}

	return id;
}

/** `<company>:<accountNumber>` */
export function accountId(company: CompanyId, accountNumber: string): string {
	return assertId(`${company}:${encodeSegment(accountNumber.trim())}`);
}

/** Inverse of {@link accountId}: the raw account number carried by an account id. */
export function accountNumberFromAccountId(id: string): string {
	const separator = id.indexOf(':');
	return decodeURIComponent(separator === -1 ? id : id.slice(separator + 1));
}

/** Returns the identifier as a trimmed string, or undefined when it is missing/unusable (undefined, null, '', 0, 'undefined', 'undefined_1', ...). */
export function normalizeIdentifier(identifier: unknown): string | undefined {
	if (typeof identifier === 'number') {
		return Number.isFinite(identifier) && identifier !== 0 ? String(identifier) : undefined;
	}

	if (typeof identifier !== 'string') {
		return undefined;
	}

	const trimmed = identifier.trim();
	if (trimmed === '' || /^0+$/.test(trimmed) || trimmed.startsWith('undefined')) {
		return undefined;
	}

	return trimmed;
}

/** First 16 hex chars of sha256 over the frozen row fields. */
export function transactionFingerprint(parts: FingerprintParts): string {
	const material = [
		parts.bookedDate,
		parts.amount.toFixed(2),
		parts.description.trim(),
		parts.memo?.trim() ?? '',
		`${parts.installmentNumber ?? ''}/${parts.installmentTotal ?? ''}`,
	].join('|');
	return createHash('sha256').update(material, 'utf8').digest('hex').slice(0, FINGERPRINT_LENGTH);
}

/** `<company>:<accountNumber>:<identifier|->:<fingerprint>[#ordinal]` (ordinal >= 2 only). */
export function transactionId(input: {
	company: CompanyId;
	accountNumber: string;
	identifier: string | undefined;
	fingerprint: string;
	ordinal?: number;
}): string {
	const identifier = input.identifier === undefined ? '-' : encodeSegment(input.identifier);
	const suffix = input.ordinal !== undefined && input.ordinal >= 2 ? `#${input.ordinal}` : '';
	return assertId(`${accountId(input.company, input.accountNumber)}:${identifier}:${input.fingerprint}${suffix}`);
}

type IndexedRow = {row: Omit<LedgerTransaction, 'id'>; index: number};

/** Stable order for ordinal assignment: chargeDate, identifier, then the scraper's own order. */
function compareForOrdinals(a: IndexedRow, b: IndexedRow): number {
	return (a.row.chargeDate ?? '').localeCompare(b.row.chargeDate ?? '')
		|| (a.row.identifier ?? '').localeCompare(b.row.identifier ?? '')
		|| a.index - b.index;
}

function baseTransactionId(row: Omit<LedgerTransaction, 'id'>): string {
	return transactionId({
		company: row.company,
		accountNumber: accountNumberFromAccountId(row.accountId),
		identifier: row.identifier,
		fingerprint: transactionFingerprint(row),
	});
}

/**
 * Assign ids to a batch of rows from ONE scrape. Rows that would collide get stable
 * ordinal suffixes (#2, #3 ...) after a stable sort on (chargeDate, identifier, original order).
 * The result keeps the input order.
 */
export function assignTransactionIds(rows: Array<Omit<LedgerTransaction, 'id'>>): LedgerTransaction[] {
	const ordered = rows.map((row, index) => ({row, index})).sort(compareForOrdinals);
	const seen = new Map<string, number>();
	const result: LedgerTransaction[] = Array.from({length: rows.length});
	for (const {row, index} of ordered) {
		const base = baseTransactionId(row);
		const ordinal = (seen.get(base) ?? 0) + 1;
		seen.set(base, ordinal);
		result[index] = {...row, id: ordinal >= 2 ? assertId(`${base}#${ordinal}`) : base};
	}

	return result;
}

/** `<company>:<accountNumber>:payment:<chargeDate>` */
export function syntheticPaymentId(company: CompanyId, accountNumber: string, chargeDate: IsoDate): string {
	return assertId(`${accountId(company, accountNumber)}:payment:${chargeDate}`);
}

/** Lower-case slug: runs of non-alphanumerics become one '-'. Empty (e.g. Hebrew-only text) falls back to a short hash. */
function slug(value: string): string {
	const slugged = value.toLowerCase().replaceAll(/[^0-9a-z]+/g, '-').replaceAll(/^-+|-+$/g, '');
	return slugged === '' ? createHash('sha256').update(value, 'utf8').digest('hex').slice(0, FINGERPRINT_LENGTH) : slugged;
}

/** `<accountId>:<symbol or slug(description)>` */
export function holdingId(ownerAccountId: string, symbolOrDescription: string): string {
	return assertId(`${ownerAccountId}:${slug(symbolOrDescription.trim())}`);
}
