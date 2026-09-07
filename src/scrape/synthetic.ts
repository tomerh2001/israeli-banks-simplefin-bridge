/**
 * Synthetic card payments (opt-in per company, credit cards only).
 *
 * Credit-card scrapers show purchases but not the monthly debit that pays the
 * bill, while the bank side shows the debit as one outgoing row. Emitting one
 * positive "Card payment" row per charge date lets consumers pair the two as a
 * transfer. Amounts are frozen once emitted: a later scrape never recomputes
 * a cycle that already has a synthetic row, even if late postings change the sum.
 */

import {syntheticPaymentId} from '../ids.js';
import type {Logger} from '../log.js';
import {
	ID_SCHEME_VERSION,
	type CompanyConfig,
	type IsoDate,
	type Ledger,
	type LedgerAccount,
	type LedgerTransaction,
} from '../types.js';
import {addDays} from './dates.js';

/** Charge dates newer than this many days ago may still receive rows; wait. */
const SETTLE_DAYS = 2;
/** A charge date within this many days of the earliest booked row may be a partial cycle. */
const PARTIAL_CYCLE_DAYS = 35;

function roundMoney(value: number): number {
	return Math.round(value * 100) / 100;
}

/** Sum of posted, non-synthetic amounts per charge date. */
function sumByChargeDate(rows: LedgerTransaction[]): Map<IsoDate, {total: number; count: number}> {
	const groups = new Map<IsoDate, {total: number; count: number}>();
	for (const row of rows) {
		if (!row.chargeDate) {
			continue;
		}

		const group = groups.get(row.chargeDate) ?? {total: 0, count: 0};
		group.total += row.amount;
		group.count++;
		groups.set(row.chargeDate, group);
	}

	return groups;
}

/**
 * Compute, persist (in `syntheticPayments`) and return the new synthetic rows
 * for one account. Returned rows still need `ledger.upsertTransactions`.
 */
export function computeSyntheticPayments(
	ledger: Ledger,
	account: LedgerAccount,
	config: CompanyConfig,
	today: IsoDate,
	logger?: Logger,
): LedgerTransaction[] {
	if (!config.synthesizePayments || account.kind !== 'credit_card') {
		return [];
	}

	const rows = ledger.listTransactions({accountIds: [account.id], includePending: false, includeSynthetic: false});
	const groups = sumByChargeDate(rows);
	const emitted = new Set(ledger.listSyntheticPayments(account.id).map(payment => payment.chargeDate));
	const cutoff = addDays(today, -SETTLE_DAYS);
	const earliest = ledger.earliestBookedDate(account.id);
	const partialUntil = earliest ? addDays(earliest, PARTIAL_CYCLE_DAYS) : undefined;
	const now = new Date().toISOString();
	const created: LedgerTransaction[] = [];

	for (const [chargeDate, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
		if (chargeDate > cutoff || emitted.has(chargeDate)) {
			continue;
		}

		if (partialUntil && chargeDate < partialUntil) {
			logger?.info('skipping synthetic payment: cycle may be partial', {account: account.id, chargeDate, earliest});
			continue;
		}

		const amount = roundMoney(-group.total);
		if (Math.abs(amount) < 0.005) {
			continue;
		}

		const id = syntheticPaymentId(account.company, account.accountNumber, chargeDate);
		created.push({
			id,
			accountId: account.id,
			company: account.company,
			identifier: undefined,
			bookedDate: chargeDate,
			chargeDate,
			amount,
			currency: account.currency,
			description: `Card payment ${config.label} ${chargeDate}`,
			memo: undefined,
			status: 'posted',
			installmentNumber: undefined,
			installmentTotal: undefined,
			originalAmount: undefined,
			originalCurrency: undefined,
			category: undefined,
			synthetic: true,
			firstSeen: now,
			lastSeen: now,
			idSchemeVersion: ID_SCHEME_VERSION,
			raw: {synthetic: true, chargeDate, rows: group.count},
		});
		ledger.insertSyntheticPayment({transactionId: id, accountId: account.id, chargeDate, amount, emittedAt: now});
	}

	return created;
}
