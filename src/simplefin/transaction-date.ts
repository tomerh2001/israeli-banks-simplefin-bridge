import {toCalendarDate} from '../normalize.js';
import type {IsoDate, LedgerTransaction} from '../types.js';

export type TransactionDateKind = 'purchase' | 'installment_occurrence' | 'archive_purchase_or_occurrence';
export type TransactionDate = {date: IsoDate; kind?: TransactionDateKind; chargeDate?: IsoDate};

function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function sourceDate(value: unknown, timezone: string): IsoDate | undefined {
	if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value)) {
		return undefined;
	}

	try {
		return toCalendarDate(value, timezone);
	} catch {
		return undefined;
	}
}

/** Recover presentation dates from retained evidence without changing frozen ledger dates or IDs. */
export function transactionDate(row: LedgerTransaction, timezone: string, creditCard: boolean): TransactionDate {
	if (!creditCard || row.synthetic) {
		return {date: row.bookedDate, chargeDate: row.chargeDate};
	}

	const raw = object(row.raw);
	const migration = object(raw?.archiveMigration);
	// Some Actual imports copied purchase date into booked/charge date solely for stable IDs.
	const chargeDate = sourceDate(raw?.processedDate, timezone) ?? (migration
		? (migration.dateBasis === 'source_processed_date' ? sourceDate(object(migration.sourceRecord)?.booked_date, timezone) : undefined)
		: row.chargeDate);
	const purchase = sourceDate(raw?.date, timezone);
	if (purchase) {
		// CAL moves later installments by installment-number-minus-one months.
		const installment = object(raw?.installments)?.number;
		const shifted = row.company === 'visaCal' && typeof installment === 'number' && installment > 1;
		return {date: purchase, kind: shifted ? 'installment_occurrence' : 'purchase', chargeDate};
	}

	const archived = sourceDate(migration?.purchaseOrEventDate, timezone);
	return archived ? {date: archived, kind: 'archive_purchase_or_occurrence', chargeDate} : {date: row.bookedDate, chargeDate};
}
