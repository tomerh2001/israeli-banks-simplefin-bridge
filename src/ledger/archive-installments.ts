import {createHash} from 'node:crypto';
import {z} from 'zod';
import {toCalendarDate} from '../normalize.js';
import type {ArchiveInstallmentPair, LedgerTransaction} from '../types.js';

const archiveSchema = z.object({
	origin: z.enum(['actual', 'sure']),
	originRowId: z.uuid(),
	purchaseOrEventDate: z.iso.date(),
	sourceIdentifier: z.string().min(1),
	sourceRecord: z.object({
		origin_row_id: z.uuid(),
		account_id: z.string(),
		company: z.literal('visaCal'),
		amount: z.union([z.string(), z.number()]),
		currency: z.string(),
		description: z.string(),
		purchase_date: z.iso.date(),
	}),
}).loose();

function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Keep original archive evidence across ordinary portal refreshes as well as ID coalescing. */
export function preserveArchiveRaw(existing: LedgerTransaction, incoming: LedgerTransaction): unknown {
	const old = object(existing.raw);
	const archive = object(old?.archiveMigration);
	if (!archive || !z.object({origin: z.enum(['actual', 'sure']), originRowId: z.uuid()}).safeParse(archive).success) {
		return incoming.raw;
	}

	return {...object(incoming.raw), archiveMigration: archive};
}

function occurrenceDate(value: unknown, timezone: string): string | undefined {
	if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value)) {
		return undefined;
	}

	try {
		return toCalendarDate(value, timezone);
	} catch {
		return undefined;
	}
}

/** A source ID alone is reused across installments: require the entire observed occurrence. */
export function matchesArchiveInstallment(archive: LedgerTransaction, incoming: LedgerTransaction, timezone: string): boolean {
	if (archive.company !== 'visaCal' || incoming.company !== 'visaCal'
		|| archive.synthetic || incoming.synthetic || archive.status !== 'posted' || incoming.status !== 'posted'
		|| !archive.identifier || archive.identifier !== incoming.identifier || archive.accountId !== incoming.accountId
		|| archive.amount !== incoming.amount || archive.currency !== incoming.currency || archive.description !== incoming.description
		|| !Number.isSafeInteger(archive.installmentNumber) || !Number.isSafeInteger(archive.installmentTotal)
		|| (archive.installmentNumber ?? 0) < 1 || (archive.installmentTotal ?? 0) < 2
		|| archive.installmentNumber! > archive.installmentTotal!
		|| archive.installmentNumber !== incoming.installmentNumber || archive.installmentTotal !== incoming.installmentTotal) {
		return false;
	}

	const parsed = archiveSchema.safeParse(object(archive.raw)?.archiveMigration);
	if (!parsed.success) {
		return false;
	}

	const evidence = parsed.data;
	const record = evidence.sourceRecord;
	const raw = object(incoming.raw);
	const installments = object(raw?.installments);
	return evidence.originRowId.toLowerCase() === record.origin_row_id.toLowerCase()
		&& evidence.sourceIdentifier === archive.identifier
		&& record.account_id === archive.accountId
		&& Number(record.amount) === archive.amount && Number.isFinite(archive.amount)
		&& record.currency === archive.currency && record.description === archive.description
		&& evidence.purchaseOrEventDate === record.purchase_date
		&& evidence.purchaseOrEventDate === occurrenceDate(raw?.date, timezone)
		&& installments?.number === incoming.installmentNumber && installments?.total === incoming.installmentTotal
		&& (typeof raw?.identifier === 'string' || typeof raw?.identifier === 'number') && String(raw.identifier) === incoming.identifier
		&& raw?.description === incoming.description
		&& raw.chargedAmount === incoming.amount
		&& incoming.chargeDate !== undefined && incoming.chargeDate === occurrenceDate(raw.processedDate, timezone)
		&& (archive.originalAmount === undefined || incoming.originalAmount === undefined || archive.originalAmount === incoming.originalAmount)
		&& (archive.originalCurrency === undefined || incoming.originalCurrency === undefined || archive.originalCurrency === incoming.originalCurrency);
}

/** Refuse ambiguous occurrences instead of guessing which archived row a portal ID refers to. */
export function findArchiveInstallment(candidates: LedgerTransaction[], incoming: LedgerTransaction, timezone: string): LedgerTransaction | undefined {
	const matches = candidates.filter(row => row.id !== incoming.id && matchesArchiveInstallment(row, incoming, timezone));
	if (matches.length > 1) {
		throw new Error('Ambiguous archived installment identity; no transaction coalesced');
	}

	return matches[0];
}

/** Resolve a whole scrape before writing, so two portal rows cannot consume one archive occurrence. */
export function resolveArchiveInstallments(rows: LedgerTransaction[], stored: LedgerTransaction[], timezone: string): Map<string, LedgerTransaction> {
	const byId = new Map(stored.map(row => [row.id, row]));
	const byIdentifier = new Map<string, LedgerTransaction[]>();
	for (const row of stored) {
		const key = JSON.stringify([row.accountId, row.identifier]);
		const candidates = byIdentifier.get(key) ?? [];
		candidates.push(row);
		byIdentifier.set(key, candidates);
	}

	const resolved = new Map<string, LedgerTransaction>();
	const claimed = new Map<string, string>();
	for (const incoming of rows) {
		const existing = byId.get(incoming.id);
		const canonical = existing ?? findArchiveInstallment(byIdentifier.get(JSON.stringify([incoming.accountId, incoming.identifier])) ?? [], incoming, timezone);
		if (!canonical) {
			continue;
		}

		const previous = claimed.get(canonical.id);
		if (previous !== undefined && previous !== incoming.id) {
			throw new Error('Multiple portal rows match one archived installment; no transaction coalesced');
		}

		claimed.set(canonical.id, incoming.id);
		resolved.set(incoming.id, canonical);
	}

	return resolved;
}

function sortedJson(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(item => sortedJson(item));
	}

	const record = object(value);
	return record ? Object.fromEntries(Object.keys(record).sort().map(key => [key, sortedJson(record[key])])) : value;
}

/** Full private row fingerprint for an explicitly reviewed maintenance plan. */
export function archiveInstallmentStateHash(row: LedgerTransaction): string {
	return createHash('sha256').update(JSON.stringify(sortedJson(row))).digest('hex');
}

/** Validate every pair before any maintenance write; no implicit discovery or startup repair. */
export function validateArchiveInstallmentPairs(
	pairs: ArchiveInstallmentPair[],
	rows: LedgerTransaction[],
	timezone: string,
): Array<{canonical: LedgerTransaction; duplicate: LedgerTransaction}> {
	if (pairs.length === 0 || pairs.length > 100) {
		throw new Error('Expected between 1 and 100 explicitly reviewed installment pairs');
	}

	const ids = pairs.flatMap(pair => [pair.canonicalId, pair.duplicateId]);
	if (new Set(ids).size !== ids.length) {
		throw new Error('Installment maintenance pairs must contain distinct transaction IDs');
	}

	return pairs.map(pair => {
		const canonical = rows.find(row => row.id === pair.canonicalId);
		const duplicate = rows.find(row => row.id === pair.duplicateId);
		if (!canonical || !duplicate || archiveInstallmentStateHash(canonical) !== pair.canonicalStateHash
			|| archiveInstallmentStateHash(duplicate) !== pair.duplicateStateHash
			|| findArchiveInstallment(rows, duplicate, timezone)?.id !== canonical.id) {
			throw new Error('Installment maintenance pre-state or complete source identity changed; no repair applied');
		}

		return {canonical, duplicate};
	});
}
