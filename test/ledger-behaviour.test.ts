/**
 * One behavioural suite run against every Ledger implementation, so the SQLite ledger and the
 * in-memory test fake can never drift apart.
 */

import {mkdtempSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {afterAll, afterEach, beforeEach, describe, expect, it} from 'vitest';
import {createMemoryLedger, createSqliteLedger} from '../src/ledger/index.js';
import {
	ID_SCHEME_VERSION,
	type Anomaly,
	type Consumer,
	type Ledger,
	type LedgerAccount,
	type LedgerHolding,
	type LedgerTransaction,
	type RunRecord,
	type SourceState,
} from '../src/types.js';

const t0 = '2024-03-01T04:00:00.000Z';
const t1 = '2024-03-02T04:00:00.000Z';
const t2 = '2024-03-03T04:00:00.000Z';

function account(overrides: Partial<LedgerAccount> = {}): LedgerAccount {
	return {
		id: 'hapoalim:00-000-000001',
		company: 'hapoalim',
		accountNumber: '00-000-000001',
		kind: 'checking',
		currency: 'ILS',
		name: 'Bank Hapoalim ····0001',
		balance: 100,
		balanceAt: t0,
		firstSeen: t0,
		lastSeen: t0,
		raw: {some: 'thing'},
		...overrides,
	};
}

function transaction(overrides: Partial<LedgerTransaction> = {}): LedgerTransaction {
	return {
		id: 'hapoalim:00-000-000001:51:0000000000000001',
		accountId: 'hapoalim:00-000-000001',
		company: 'hapoalim',
		identifier: '51',
		bookedDate: '2024-02-01',
		chargeDate: '2024-02-01',
		amount: -120.5,
		currency: 'ILS',
		description: 'עמלת ניהול',
		memo: undefined,
		status: 'posted',
		installmentNumber: undefined,
		installmentTotal: undefined,
		originalAmount: -120.5,
		originalCurrency: 'ILS',
		category: undefined,
		synthetic: false,
		firstSeen: t0,
		lastSeen: t0,
		idSchemeVersion: ID_SCHEME_VERSION,
		raw: {referenceNumber: 51},
		...overrides,
	};
}

function holding(overrides: Partial<LedgerHolding> = {}): LedgerHolding {
	return {
		id: 'hapoalim:00-000-000001:aapl',
		accountId: 'hapoalim:00-000-000001',
		symbol: 'AAPL',
		description: 'Apple Inc.',
		marketValue: 1234.5,
		shares: 10,
		purchasePrice: 100,
		costBasis: 1000,
		currency: 'USD',
		firstSeen: t0,
		lastSeen: t0,
		raw: undefined,
		...overrides,
	};
}

function run(overrides: Partial<RunRecord> = {}): RunRecord {
	return {
		id: 'run-1',
		company: 'hapoalim',
		startedAt: t0,
		finishedAt: t0,
		status: 'success',
		errorType: undefined,
		message: undefined,
		accountsSeen: 1,
		transactionsSeen: 10,
		transactionsNew: 2,
		anomalies: 0,
		...overrides,
	};
}

function sourceState(overrides: Partial<SourceState> = {}): SourceState {
	return {
		company: 'hapoalim',
		lastRunAt: t0,
		lastSuccessAt: t0,
		lastErrorAt: undefined,
		lastErrorType: undefined,
		lastErrorMessage: undefined,
		consecutiveFailures: 0,
		parked: false,
		parkedReason: undefined,
		parkedAt: undefined,
		credentialFingerprint: 'abc',
		nextAllowedAt: undefined,
		loginAttemptsDate: '2024-03-01',
		loginAttempts: 1,
		earliestScrapedDate: '2024-01-01',
		...overrides,
	};
}

function consumer(overrides: Partial<Consumer> = {}): Consumer {
	return {
		id: 'consumer-1',
		label: 'securo',
		basicUser: 'securo_user',
		secretHash: 'scrypt$salt$hash',
		secretPlain: 'plain',
		claimId: 'claim-1',
		claimExpiresAt: t1,
		claimCount: 0,
		maxClaims: 3,
		claimedAt: undefined,
		firstAuthenticatedAt: undefined,
		lastSeenAt: undefined,
		createdAt: t0,
		revokedAt: undefined,
		...overrides,
	};
}

function anomaly(overrides: Partial<Anomaly> = {}): Anomaly {
	return {transactionId: 'x', field: 'amount', previous: '1.00', incoming: '2.00', seenAt: t0, ...overrides};
}

const implementations: Array<[string, () => Ledger]> = [
	['memory', () => createMemoryLedger()],
	['sqlite(:memory:)', () => createSqliteLedger(':memory:')],
];

describe.each(implementations)('Ledger behaviour: %s', (_name, create) => {
	let ledger: Ledger;
	beforeEach(() => {
		ledger = create();
	});
	afterEach(() => {
		ledger.close();
	});

	describe('source state', () => {
		it('round-trips and replaces', () => {
			expect(ledger.getSourceState('hapoalim')).toBeUndefined();
			ledger.upsertSourceState(sourceState());
			expect(ledger.getSourceState('hapoalim')).toEqual(sourceState());
			ledger.upsertSourceState(sourceState({parked: true, parkedReason: 'INVALID_PASSWORD', consecutiveFailures: 2}));
			ledger.upsertSourceState(sourceState({company: 'visaCal'}));
			expect(ledger.getSourceState('hapoalim')).toMatchObject({parked: true, parkedReason: 'INVALID_PASSWORD', consecutiveFailures: 2});
			expect(ledger.listSourceStates().map(state => state.company).sort()).toEqual(['hapoalim', 'visaCal']);
		});
	});

	describe('runs', () => {
		it('lists newest first with company filter and limit', () => {
			ledger.recordRun(run({id: 'a', startedAt: t0}));
			ledger.recordRun(run({id: 'c', startedAt: t2, company: 'visaCal', status: 'timeout', errorType: 'TIMEOUT', message: 'took too long'}));
			ledger.recordRun(run({id: 'b', startedAt: t1}));
			expect(ledger.listRuns().map(item => item.id)).toEqual(['c', 'b', 'a']);
			expect(ledger.listRuns({company: 'hapoalim'}).map(item => item.id)).toEqual(['b', 'a']);
			expect(ledger.listRuns({limit: 1}).map(item => item.id)).toEqual(['c']);
			expect(ledger.listRuns({company: 'visaCal'})[0]).toEqual(run({id: 'c', startedAt: t2, company: 'visaCal', status: 'timeout', errorType: 'TIMEOUT', message: 'took too long'}));
		});
	});

	describe('accounts', () => {
		it('upserts keeping firstSeen and refreshing the rest', () => {
			ledger.upsertAccount(account());
			ledger.upsertAccount(account({balance: 250.25, balanceAt: t1, name: 'renamed', firstSeen: t1, lastSeen: t1, raw: {v: 2}}));
			expect(ledger.getAccount('hapoalim:00-000-000001')).toEqual(account({balance: 250.25, balanceAt: t1, name: 'renamed', firstSeen: t0, lastSeen: t1, raw: {v: 2}}));
			expect(ledger.getAccount('missing')).toBeUndefined();
		});

		it('stores undefined balances and lists sorted by id with company filter', () => {
			ledger.upsertAccount(account({id: 'visaCal:1234', company: 'visaCal', accountNumber: '1234', kind: 'credit_card', balance: undefined, balanceAt: undefined}));
			ledger.upsertAccount(account());
			expect(ledger.listAccounts().map(item => item.id)).toEqual(['hapoalim:00-000-000001', 'visaCal:1234']);
			expect(ledger.listAccounts({company: 'visaCal'})[0]).toMatchObject({balance: undefined, balanceAt: undefined, kind: 'credit_card'});
		});
	});

	describe('transactions', () => {
		it('inserts, then reports unchanged on an identical re-scrape', () => {
			const rows = [transaction(), transaction({id: 'x2', amount: -35, description: 'עמלת ערוץ ישיר'})];
			expect(ledger.upsertTransactions(rows)).toEqual({inserted: 2, updated: 0, unchanged: 0, anomalies: []});
			expect(ledger.upsertTransactions(rows.map(row => ({...row, lastSeen: t1, raw: {seen: 2}})))).toEqual({inserted: 0, updated: 0, unchanged: 2, anomalies: []});
			expect(ledger.getTransaction(rows[0]!.id)).toEqual(transaction({lastSeen: t1, raw: {seen: 2}}));
			expect(ledger.getTransaction('missing')).toBeUndefined();
		});

		it('upgrades pending to posted and refreshes chargeDate, category and memo', () => {
			ledger.upsertTransactions([transaction({status: 'pending', chargeDate: undefined, category: undefined, memo: undefined})]);
			const summary = ledger.upsertTransactions([transaction({status: 'posted', chargeDate: '2024-02-03', category: 'fees', memo: 'note', lastSeen: t1})]);
			expect(summary).toMatchObject({inserted: 0, updated: 1, unchanged: 0, anomalies: []});
			expect(ledger.getTransaction(transaction().id)).toMatchObject({status: 'posted', chargeDate: '2024-02-03', category: 'fees', memo: 'note', firstSeen: t0, lastSeen: t1, postedSeenAt: t1});
			ledger.upsertTransactions([transaction({lastSeen: t2})]);
			expect(ledger.getTransaction(transaction().id)).toMatchObject({postedSeenAt: t1, lastSeen: t2});
		});

		it('never regresses posted to pending and keeps refreshable values when the incoming ones are missing', () => {
			ledger.upsertTransactions([transaction({status: 'posted', chargeDate: '2024-02-03', category: 'fees', memo: 'note'})]);
			const summary = ledger.upsertTransactions([transaction({status: 'pending', chargeDate: undefined, category: undefined, memo: undefined, lastSeen: t1})]);
			expect(summary).toMatchObject({updated: 1, unchanged: 0});
			expect(ledger.getTransaction(transaction().id)).toMatchObject({status: 'posted', chargeDate: '2024-02-03', category: 'fees', memo: 'note', lastSeen: t1});
		});

		it('freezes amount, bookedDate and description and records anomalies instead', () => {
			ledger.upsertTransactions([transaction()]);
			const summary = ledger.upsertTransactions([transaction({amount: -121, bookedDate: '2024-02-02', description: 'changed', lastSeen: t1})]);
			expect(summary.inserted).toBe(0);
			expect(summary.anomalies).toEqual([
				{transactionId: transaction().id, field: 'amount', previous: '-120.50', incoming: '-121.00', seenAt: t1},
				{transactionId: transaction().id, field: 'bookedDate', previous: '2024-02-01', incoming: '2024-02-02', seenAt: t1},
				{transactionId: transaction().id, field: 'description', previous: 'עמלת ניהול', incoming: 'changed', seenAt: t1},
			]);
			expect(ledger.getTransaction(transaction().id)).toMatchObject({amount: -120.5, bookedDate: '2024-02-01', description: 'עמלת ניהול', lastSeen: t1});
			expect(ledger.listAnomalies()).toEqual(summary.anomalies);
		});

		it('does not flag float noise below a cent as an anomaly', () => {
			ledger.upsertTransactions([transaction({amount: -120.5})]);
			expect(ledger.upsertTransactions([transaction({amount: -120.504})]).anomalies).toEqual([]);
		});

		it('lists with filters and deterministic ordering', () => {
			ledger.upsertTransactions([
				transaction({id: 'b', bookedDate: '2024-02-02'}),
				transaction({id: 'a', bookedDate: '2024-02-02'}),
				transaction({id: 'p', bookedDate: '2024-02-03', status: 'pending'}),
				transaction({id: 's', bookedDate: '2024-01-15', synthetic: true}),
				transaction({id: 'other', bookedDate: '2024-02-01', accountId: 'visaCal:1234', company: 'visaCal'}),
				transaction({id: 'late', bookedDate: '2024-02-10'}),
			]);
			const ids = (query: Partial<Parameters<Ledger['listTransactions']>[0]>) =>
				ledger.listTransactions({includePending: false, includeSynthetic: false, ...query}).map(row => row.id);
			expect(ids({})).toEqual(['other', 'a', 'b', 'late']);
			expect(ids({includePending: true, includeSynthetic: true})).toEqual(['s', 'other', 'a', 'b', 'p', 'late']);
			expect(ids({accountIds: ['hapoalim:00-000-000001']})).toEqual(['a', 'b', 'late']);
			expect(ids({accountIds: []})).toEqual([]);
			expect(ids({from: '2024-02-02', to: '2024-02-10'})).toEqual(['a', 'b']);
			expect(ids({from: '2024-02-02', to: '2024-02-10', includePending: true})).toEqual(['a', 'b', 'p']);
		});

		it('finds duplicates and the earliest non-synthetic bookedDate', () => {
			ledger.upsertTransactions([
				transaction({id: 'a'}),
				transaction({id: 'b'}),
				transaction({id: 'c', amount: -120.504}),
				transaction({id: 'd', description: 'different'}),
				transaction({id: 's', bookedDate: '2023-12-31', synthetic: true}),
			]);
			expect(ledger.findDuplicates()).toEqual([{
				accountId: 'hapoalim:00-000-000001',
				bookedDate: '2024-02-01',
				amount: -120.5,
				description: 'עמלת ניהול',
				transactionIds: ['a', 'b', 'c'],
			}]);
			expect(ledger.earliestBookedDate('hapoalim:00-000-000001')).toBe('2024-02-01');
			expect(ledger.earliestBookedDate('nope')).toBeUndefined();
		});
	});

	describe('holdings', () => {
		it('upserts keeping firstSeen and filters by account', () => {
			ledger.upsertHoldings([
				holding(),
				holding({id: 'other:1', accountId: 'other', symbol: undefined, shares: undefined, purchasePrice: undefined, costBasis: undefined}),
			]);
			ledger.upsertHoldings([holding({marketValue: 2000, firstSeen: t1, lastSeen: t1})]);
			expect(ledger.listHoldings('hapoalim:00-000-000001')).toEqual([holding({marketValue: 2000, firstSeen: t0, lastSeen: t1})]);
			expect(ledger.listHoldings()).toHaveLength(2);
			expect(ledger.listHoldings('other')[0]).toMatchObject({symbol: undefined, shares: undefined, purchasePrice: undefined, costBasis: undefined});
		});
	});

	describe('synthetic payments', () => {
		it('inserts and lists per account', () => {
			const payment = {transactionId: 'visaCal:1234:payment:2024-03-02', accountId: 'visaCal:1234', chargeDate: '2024-03-02', amount: 2345.6, emittedAt: t0};
			ledger.insertSyntheticPayment(payment);
			ledger.insertSyntheticPayment({transactionId: 'max:5678:payment:2024-03-10', accountId: 'max:5678', chargeDate: '2024-03-10', amount: 1500, emittedAt: t0});
			expect(ledger.listSyntheticPayments('visaCal:1234')).toEqual([payment]);
			expect(ledger.listSyntheticPayments('nope')).toEqual([]);
		});
	});

	describe('consumers', () => {
		it('creates, looks up by id, claim and basic user, updates', () => {
			ledger.createConsumer(consumer());
			expect(ledger.getConsumer('consumer-1')).toEqual(consumer());
			expect(ledger.getConsumerByClaimId('claim-1')).toEqual(consumer());
			expect(ledger.getConsumerByBasicUser('securo_user')).toEqual(consumer());
			expect(ledger.getConsumerByClaimId('nope')).toBeUndefined();
			expect(ledger.getConsumerByBasicUser('nope')).toBeUndefined();

			ledger.updateConsumer(consumer({claimId: undefined, secretPlain: undefined, claimCount: 1, claimedAt: t1, firstAuthenticatedAt: t1, lastSeenAt: t2}));
			expect(ledger.getConsumer('consumer-1')).toEqual(consumer({claimId: undefined, secretPlain: undefined, claimCount: 1, claimedAt: t1, firstAuthenticatedAt: t1, lastSeenAt: t2}));
			expect(ledger.getConsumerByClaimId('claim-1')).toBeUndefined();

			ledger.createConsumer(consumer({id: 'consumer-2', basicUser: 'actual', claimId: 'claim-2'}));
			expect(ledger.listConsumers().map(item => item.id)).toEqual(['consumer-1', 'consumer-2']);
		});

		it('rejects duplicate ids', () => {
			ledger.createConsumer(consumer());
			expect(() => ledger.createConsumer(consumer({basicUser: 'another', claimId: 'claim-9'}))).toThrow(/already exists/);
			expect(ledger.listConsumers()).toHaveLength(1);
		});
	});

	describe('anomalies and meta', () => {
		it('appends anomalies and returns the last N in order', () => {
			ledger.recordAnomalies([anomaly({transactionId: '1'}), anomaly({transactionId: '2'})]);
			ledger.recordAnomalies([anomaly({transactionId: '3', field: 'description', previous: 'a', incoming: 'b', seenAt: t1})]);
			expect(ledger.listAnomalies().map(item => item.transactionId)).toEqual(['1', '2', '3']);
			expect(ledger.listAnomalies({limit: 2}).map(item => item.transactionId)).toEqual(['2', '3']);
			expect(ledger.listAnomalies({limit: 1})).toEqual([anomaly({transactionId: '3', field: 'description', previous: 'a', incoming: 'b', seenAt: t1})]);
		});

		it('gets and sets meta', () => {
			expect(ledger.getMeta('nope')).toBeUndefined();
			ledger.setMeta('k', 'v1');
			ledger.setMeta('k', 'v2');
			expect(ledger.getMeta('k')).toBe('v2');
		});
	});
});

describe('SQLite ledger specifics', () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), 'ibs-ledger-'));
	afterAll(() => {
		rmSync(directory, {recursive: true, force: true});
	});

	it('stamps the id scheme version on a fresh ledger', () => {
		const ledger = createSqliteLedger(':memory:');
		expect(ledger.getMeta('id_scheme_version')).toBe(String(ID_SCHEME_VERSION));
		expect(ledger.getMeta('schema_version')).toBe('2');
		ledger.close();
	});

	it('enforces unique basic users and claim ids', () => {
		const ledger = createSqliteLedger(':memory:');
		ledger.createConsumer(consumer());
		expect(() => ledger.createConsumer(consumer({id: 'consumer-2', claimId: 'claim-2'}))).toThrow(/UNIQUE/);
		expect(() => ledger.createConsumer(consumer({id: 'consumer-2', basicUser: 'other'}))).toThrow(/UNIQUE/);
		ledger.createConsumer(consumer({id: 'consumer-2', basicUser: 'other', claimId: undefined}));
		ledger.createConsumer(consumer({id: 'consumer-3', basicUser: 'third', claimId: undefined}));
		expect(ledger.listConsumers()).toHaveLength(3);
		ledger.close();
	});

	it('persists across reopen', () => {
		const file = path.join(directory, 'persist.sqlite');
		const first = createSqliteLedger(file);
		first.upsertAccount(account());
		first.upsertTransactions([transaction()]);
		first.createConsumer(consumer());
		first.upsertSourceState(sourceState());
		first.recordRun(run());
		first.close();

		const second = createSqliteLedger(file);
		expect(second.getAccount(account().id)).toEqual(account());
		expect(second.getTransaction(transaction().id)).toEqual(transaction());
		expect(second.getConsumerByBasicUser('securo_user')).toEqual(consumer());
		expect(second.getSourceState('hapoalim')).toEqual(sourceState());
		expect(second.listRuns()).toEqual([run()]);
		expect(second.upsertTransactions([transaction({lastSeen: t1})])).toMatchObject({inserted: 0, unchanged: 1});
		second.close();
	});

	it('migrates existing rows without changing their ids or discovery dates', () => {
		const file = path.join(directory, 'migrate.sqlite');
		const first = createSqliteLedger(file);
		first.upsertTransactions([transaction({status: 'pending'})]);
		first.close();
		const previous = new DatabaseSync(file);
		previous.exec('ALTER TABLE transactions DROP COLUMN posted_seen_at; UPDATE meta SET value = \'1\' WHERE key = \'schema_version\'');
		previous.close();
		const migrated = createSqliteLedger(file);
		try {
			expect(migrated.getTransaction(transaction().id)).toEqual(transaction({status: 'pending'}));
			migrated.upsertTransactions([transaction({lastSeen: t1})]);
			expect(migrated.getTransaction(transaction().id)).toMatchObject({firstSeen: t0, postedSeenAt: t1});
		} finally {
			migrated.close();
		}
	});

	it('refuses a ledger written with another id scheme version', () => {
		const file = path.join(directory, 'scheme.sqlite');
		const ledger = createSqliteLedger(file);
		ledger.setMeta('id_scheme_version', '999');
		ledger.close();
		expect(() => createSqliteLedger(file)).toThrow(/id scheme version 999/);
		// The lock must be released so the operator can inspect or move the file.
		expect(() => createSqliteLedger(':memory:').close()).not.toThrow();
	});
});
