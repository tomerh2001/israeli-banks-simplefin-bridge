import {afterEach, describe, expect, it} from 'vitest';
import {createMemoryLedger, createSqliteLedger} from '../src/ledger/index.js';
import {archiveInstallmentStateHash} from '../src/ledger/archive-installments.js';
import {buildAccountsResponse} from '../src/simplefin/payload.js';
import type {Ledger, LedgerTransaction} from '../src/types.js';
import {makeConfig, noonEpoch, seedCardAccount, seedSourceState, silentLogger, utcMidnight, VISACAL_ACCOUNT} from './helpers/seed.js';

const timezone = 'Asia/Jerusalem';
const archiveRowId = '11111111-1111-4111-8111-111111111111';
const event = '2024-02-03';
const billing = '2024-03-12';
function fixture(installmentNumber = 2): {archive: LedgerTransaction; portal: LedgerTransaction} {
	const archive: LedgerTransaction = {
		id: `${VISACAL_ACCOUNT}:example:aaaaaaaaaaaaaaaa`, accountId: VISACAL_ACCOUNT, company: 'visaCal', identifier: 'example',
		bookedDate: event, chargeDate: undefined, amount: -48.5, currency: 'ILS', description: 'Example computer shop',
		memo: 'Example installment', status: 'posted', installmentNumber, installmentTotal: 3,
		originalAmount: undefined, originalCurrency: undefined, category: undefined, synthetic: false,
		firstSeen: '2024-03-01T00:00:00Z', lastSeen: '2024-03-01T00:00:00Z', idSchemeVersion: 1,
		raw: {archiveMigration: {origin: 'actual', originRowId: archiveRowId, sourceIdentifier: 'example', purchaseOrEventDate: event,
			dateBasis: 'archived_purchase_or_installment_date_charge_date_unavailable',
			sourceRecord: {origin_row_id: archiveRowId, account_id: VISACAL_ACCOUNT, company: 'visaCal', purchase_date: event,
				booked_date: event, amount: '-48.5', currency: 'ILS', description: 'Example computer shop', privateNote: 'not for the feed'},
		}},
	};
	return {archive, portal: {...archive, id: `${VISACAL_ACCOUNT}:example:bbbbbbbbbbbbbbbb`, bookedDate: billing, chargeDate: billing,
		originalAmount: -145.5, originalCurrency: 'ILS', category: 'Electronics',
		firstSeen: '2024-03-02T00:00:00Z', lastSeen: '2024-03-02T00:00:00Z',
		raw: {identifier: 'example', description: archive.description, chargedAmount: -48.5, originalAmount: -145.5,
			date: '2024-02-02T23:30:00Z', processedDate: '2024-03-11T22:00:00Z', installments: {number: installmentNumber, total: 3}},
	}};
}

function plan(archive: LedgerTransaction, portal: LedgerTransaction) {
	return [{canonicalId: archive.id, duplicateId: portal.id,
		canonicalStateHash: archiveInstallmentStateHash(archive), duplicateStateHash: archiveInstallmentStateHash(portal)}];
}

for (const [kind, create] of [['memory', createMemoryLedger], ['sqlite', () => createSqliteLedger(':memory:')]] as const) {
	describe(`${kind}: archived installment identity`, () => {
		let ledger: Ledger;
		afterEach(() => ledger?.close());
		function seeded(duplicates = false, installmentNumber = 2) {
			ledger = create();
			const rows = fixture(installmentNumber);
			ledger.upsertTransactions(duplicates ? [rows.archive, rows.portal] : [rows.archive]);
			return rows;
		}

		it('keeps canonical frozen fields and provenance, learns billing, and remains stable on replay', () => {
			const {archive, portal} = seeded();
			expect(ledger.upsertTransactions([portal], {timezone})).toEqual({inserted: 0, updated: 1, unchanged: 0, anomalies: []});
			const stored = ledger.getTransaction(archive.id)!;
			expect(stored).toMatchObject({...archive, chargeDate: billing, category: 'Electronics', lastSeen: portal.lastSeen});
			expect(stored.raw).toEqual({...portal.raw as Record<string, unknown>, ...archive.raw as Record<string, unknown>});
			expect(ledger.getTransaction(portal.id)).toBeUndefined();
			expect(ledger.upsertTransactions([portal], {timezone})).toMatchObject({inserted: 0, updated: 0, unchanged: 1, anomalies: []});
			ledger.upsertTransactions([{...portal, id: archive.id, bookedDate: archive.bookedDate}], {timezone});
			expect(ledger.getTransaction(archive.id)?.raw).toEqual(stored.raw);
		});

		it.each([
			{identifier: 'another'},
			{accountId: 'visaCal:9999'},
			{amount: -49},
			{currency: 'USD'},
			{description: 'Different shop'},
			{installmentNumber: 1},
			{installmentTotal: 4},
			{installmentNumber: undefined},
			{status: 'pending'},
			{synthetic: true},
			{company: 'max'},
		] satisfies Array<Partial<LedgerTransaction>>)('does not coalesce a differing identity: %j', changes => {
			const {archive, portal} = seeded();
			expect(ledger.upsertTransactions([{...portal, ...changes}], {timezone}).inserted).toBe(1);
			expect(ledger.getTransaction(archive.id)).toMatchObject(archive);
		});

		it('requires valid archive evidence, the exact local date, and observed processed date', () => {
			const {archive, portal} = seeded();
			ledger.upsertTransactions([{...portal, raw: {...portal.raw as Record<string, unknown>, date: '2024-02-04T12:00:00Z'}}], {timezone});
			expect(ledger.getTransaction(portal.id)).toBeDefined();
			const second = {...portal, id: 'invalid-evidence', raw: {...portal.raw as Record<string, unknown>, processedDate: 'invalid'}};
			expect(ledger.upsertTransactions([second], {timezone}).inserted).toBe(1);
			expect(ledger.getTransaction(archive.id)?.chargeDate).toBeUndefined();
		});

		it('rejects two canonical candidates and two portal rows for one canonical occurrence atomically', () => {
			const {archive, portal} = seeded();
			const before = ledger.getTransaction(archive.id);
			expect(() => ledger.upsertTransactions([portal, {...portal, id: `${portal.id}#2`}], {timezone})).toThrow(/Multiple portal rows/);
			expect(ledger.getTransaction(archive.id)).toEqual(before);
			ledger.upsertTransactions([{...archive, id: `${archive.id}#2`}]);
			expect(() => ledger.upsertTransactions([portal], {timezone})).toThrow(/Ambiguous/);
			expect(ledger.getTransaction(portal.id)).toBeUndefined();
		});

		it('validates all explicit maintenance hashes before repair, and dry-run never changes either row', () => {
			const {archive, portal} = seeded(true);
			const pairs = plan(ledger.getTransaction(archive.id)!, ledger.getTransaction(portal.id)!);
			expect(ledger.coalesceArchiveInstallments(pairs, {timezone, dryRun: true})).toEqual({matched: 1, coalesced: 0});
			expect(ledger.getTransaction(portal.id)).toMatchObject(portal);
			expect(() => ledger.coalesceArchiveInstallments([{...pairs[0]!, canonicalStateHash: 'stale'}], {timezone, dryRun: false})).toThrow(/pre-state/);
			expect(ledger.getTransaction(archive.id)).toMatchObject(archive);
			expect(ledger.coalesceArchiveInstallments(pairs, {timezone, dryRun: false})).toEqual({matched: 1, coalesced: 1});
			expect(ledger.getTransaction(portal.id)).toBeUndefined();
			expect(ledger.getTransaction(archive.id)).toMatchObject({...archive, chargeDate: billing, category: 'Electronics', lastSeen: portal.lastSeen});
			expect(() => ledger.coalesceArchiveInstallments(pairs, {timezone, dryRun: false})).toThrow(/pre-state/);
			expect(ledger.upsertTransactions([portal], {timezone}).inserted).toBe(0);
		});

		it('checks every pair before mutation when a later pre-state is stale', () => {
			const {archive, portal} = seeded(true);
			const second = fixture();
			second.archive.id = 'second-canonical';
			second.archive.identifier = 'second-example';
			const archiveRaw = second.archive.raw as {archiveMigration: {sourceIdentifier: string}};
			archiveRaw.archiveMigration.sourceIdentifier = 'second-example';
			second.portal.id = 'second-duplicate';
			second.portal.identifier = 'second-example';
			(second.portal.raw as Record<string, unknown>).identifier = 'second-example';
			ledger.upsertTransactions([second.archive, second.portal]);
			const firstPair = plan(ledger.getTransaction(archive.id)!, ledger.getTransaction(portal.id)!);
			const secondPair = plan(ledger.getTransaction(second.archive.id)!, ledger.getTransaction(second.portal.id)!);
			secondPair[0]!.duplicateStateHash = 'stale';
			expect(() => ledger.coalesceArchiveInstallments([...firstPair, ...secondPair], {timezone, dryRun: false})).toThrow(/pre-state/);
			expect(ledger.getTransaction(archive.id)).toMatchObject(archive);
			expect(ledger.getTransaction(portal.id)).toMatchObject(portal);
		});

		it('rejects duplicate pair IDs and dependencies without deleting anything', () => {
			const {archive, portal} = seeded(true);
			const pairs = plan(ledger.getTransaction(archive.id)!, ledger.getTransaction(portal.id)!);
			expect(() => ledger.coalesceArchiveInstallments([...pairs, ...pairs], {timezone, dryRun: false})).toThrow(/distinct/);
			ledger.recordAnomalies([{transactionId: portal.id, field: 'amount', previous: '1', incoming: '2', seenAt: portal.lastSeen}]);
			expect(() => ledger.coalesceArchiveInstallments(pairs, {timezone, dryRun: false})).toThrow(/dependent/);
			expect(ledger.getTransaction(portal.id)).toBeDefined();
		});

		it.each([1, 2])('serves old ID with verified billing and archive identity for installment %i', installmentNumber => {
			const {archive, portal} = seeded(true, installmentNumber);
			seedCardAccount(ledger);
			seedSourceState(ledger, 'visaCal');
			const accountBefore = ledger.getAccount(VISACAL_ACCOUNT);
			ledger.coalesceArchiveInstallments(plan(ledger.getTransaction(archive.id)!, ledger.getTransaction(portal.id)!), {timezone, dryRun: false});
			const feed = buildAccountsResponse(ledger, makeConfig(), {pending: false, balancesOnly: false,
				startDate: utcMidnight(event), endDate: utcMidnight('2024-02-04')}, new Date('2024-04-01T12:00:00Z'), silentLogger());
			const {transactions} = (feed.accounts[0]!);
			expect(transactions).toHaveLength(1);
			expect(transactions[0]).toMatchObject({id: archive.id, amount: '-48.50', posted: noonEpoch(event), transacted_at: noonEpoch(event),
				extra: {transaction_date: event, transaction_date_kind: installmentNumber === 1 ? 'purchase' : 'installment_occurrence', charge_date: billing,
					source_provenance: {origin: 'actual_archive', source_record_id: archiveRowId}}});
			expect(JSON.stringify(transactions)).not.toContain('not for the feed');
			expect(ledger.getAccount(VISACAL_ACCOUNT)).toEqual(accountBefore);
			expect(ledger.getTransaction(archive.id)?.bookedDate).toBe(event);
		});
	});
}
