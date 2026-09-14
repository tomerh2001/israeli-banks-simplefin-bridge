import {describe, expect, it} from 'vitest';
import {createMemoryLedger} from '../src/ledger/memory.js';
import {buildAccountsResponse} from '../src/simplefin/payload.js';
import {transactionDate} from '../src/simplefin/transaction-date.js';
import {makeConfig, noonEpoch, NOW, seedAccount, seedCardAccount, seedSourceState, seedTransaction, silentLogger, utcMidnight, VISACAL_ACCOUNT} from './helpers/seed.js';

function fixture() {
	const ledger = createMemoryLedger();
	seedCardAccount(ledger);
	seedSourceState(ledger, 'visaCal');
	return ledger;
}

function feed(ledger: ReturnType<typeof createMemoryLedger>) {
	return buildAccountsResponse(ledger, makeConfig(), {
		pending: true, balancesOnly: false, startDate: utcMidnight('2026-09-05'), endDate: utcMidnight('2026-09-06'),
	}, NOW, silentLogger()).accounts[0]!.transactions;
}

describe('evidenced card transaction dates', () => {
	it('describes verified card bill and checking balance meanings explicitly', () => {
		const ledger = fixture();
		seedAccount(ledger);
		const {accounts} = buildAccountsResponse(ledger, makeConfig(), {pending: false, balancesOnly: true}, NOW, silentLogger());
		expect(accounts.find(account => account.id === VISACAL_ACCOUNT)?.extra).toMatchObject({balance_semantics: 'next_statement_debit'});
		expect(accounts.find(account => account.id !== VISACAL_ACCOUNT)?.extra).toMatchObject({balance_semantics: 'balance'});
	});

	it('serves an already-posted purchase in its actual date window despite a future billing date, preserving ledger identity', () => {
		const ledger = fixture();
		const row = seedTransaction(ledger, {accountId: VISACAL_ACCOUNT, bookedDate: '2026-10-10', chargeDate: '2026-10-10',
			firstSeen: '2026-08-01T00:00:00Z', raw: {date: '2026-09-04T21:30:00Z'}});
		const [transaction] = feed(ledger);
		expect(transaction).toMatchObject({id: row.id, posted: noonEpoch('2026-09-05'), transacted_at: noonEpoch('2026-09-05'),
			extra: {transaction_date: '2026-09-05', transaction_date_kind: 'purchase', charge_date: '2026-10-10'}});
		expect(ledger.listTransactions({accountIds: [VISACAL_ACCOUNT], includePending: true, includeSynthetic: true})[0]).toMatchObject({id: row.id, bookedDate: '2026-10-10'});
	});

	it('uses archived purchase-or-occurrence evidence and labels its weaker precision explicitly', () => {
		const ledger = fixture();
		seedTransaction(ledger, {accountId: VISACAL_ACCOUNT, bookedDate: '2026-10-10', chargeDate: '2026-10-10',
			firstSeen: '2026-08-01T00:00:00Z', raw: {archiveMigration: {purchaseOrEventDate: '2026-09-05'}}});
		expect(feed(ledger)[0]).toMatchObject({posted: noonEpoch('2026-09-05'), extra: {transaction_date_kind: 'archive_purchase_or_occurrence'}});
	});

	it('omits an unavailable Actual billing date even when its ledger date duplicates the purchase date', () => {
		const ledger = fixture();
		seedTransaction(ledger, {accountId: VISACAL_ACCOUNT, bookedDate: '2026-09-05', chargeDate: '2026-09-05', raw: {archiveMigration: {
			purchaseOrEventDate: '2026-09-05', dateBasis: 'archived_purchase_or_installment_date_charge_date_unavailable',
			sourceRecord: {booked_date: '2026-09-05', purchase_date: '2026-09-05'},
		}}});
		expect(feed(ledger)[0]!.extra).not.toHaveProperty('charge_date');
	});

	it('retains verified Sure statement dates from source-processed evidence', () => {
		const ledger = fixture();
		seedTransaction(ledger, {accountId: VISACAL_ACCOUNT, bookedDate: '2026-10-10', chargeDate: '2026-10-10', raw: {archiveMigration: {
			purchaseOrEventDate: '2026-09-05', dateBasis: 'source_processed_date', sourceRecord: {booked_date: '2026-10-10'},
		}}});
		expect(feed(ledger)[0]!.extra).toMatchObject({transaction_date: '2026-09-05', charge_date: '2026-10-10'});
	});

	it('labels shifted CAL installments as occurrences and does not expose future occurrences early', () => {
		const ledger = fixture();
		const occurrence = seedTransaction(ledger, {accountId: VISACAL_ACCOUNT, bookedDate: '2026-10-10',
			raw: {date: '2026-09-05T00:00:00+03:00', installments: {number: 2, total: 5}}});
		seedTransaction(ledger, {accountId: VISACAL_ACCOUNT, bookedDate: '2026-10-10', firstSeen: NOW.toISOString(),
			raw: {date: '2026-10-05T00:00:00+03:00', installments: {number: 3, total: 5}}});
		const transactions = feed(ledger);
		expect(transactions).toHaveLength(1);
		expect(transactions[0]).toMatchObject({id: occurrence.id, extra: {transaction_date_kind: 'installment_occurrence'}});
	});

	it('keeps fallback dates for malformed evidence, bank entries and synthetic payments', () => {
		const ledger = fixture();
		const row = seedTransaction(ledger, {accountId: VISACAL_ACCOUNT, bookedDate: '2026-09-05', raw: {date: '2026-02-31', archiveMigration: {purchaseOrEventDate: 'not a date'}}});
		expect(transactionDate(row, 'Asia/Jerusalem', true)).toEqual({date: '2026-09-05'});
		expect(transactionDate({...row, synthetic: true, raw: {date: '2026-08-05'}}, 'Asia/Jerusalem', true)).toEqual({date: '2026-09-05'});
		seedAccount(ledger);
		const bank = seedTransaction(ledger, {bookedDate: '2026-09-05', raw: {date: '2026-08-05'}});
		expect(transactionDate(bank, 'Asia/Jerusalem', false)).toEqual({date: '2026-09-05'});
	});
});
