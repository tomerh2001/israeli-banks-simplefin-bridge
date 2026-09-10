import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {afterEach, describe, expect, it} from 'vitest';
import {parseConfig, readRuntimeEnv} from '../../config.js';
import {investmentExecutionId, investmentValuationId} from '../ids.js';
import {investmentActivitySchema, investmentFeedSchema, investmentValuationMoneySchema} from '../schema.js';
import {createInvestmentStore} from '../store.js';
import {prepareHapoalimArchive, seedHapoalimArchive} from './archive.js';
import {HAPOALIM_INVESTMENTS_DATABASE} from './runtime.js';

const accountId = '11111111-1111-4111-8111-111111111111';
const entryId = '22222222-2222-4222-8222-222222222222';
const valuationId = '33333333-3333-4333-8333-333333333333';
const observedAt = '2026-09-10T09:00:00.000Z';
const selector = '00-000-000001';
const providerProductId = `${selector}:securities`;
const sourceEntry = {
	id: entryId, account_id: accountId, entryable_id: valuationId, entryable_type: 'Valuation',
	date: '2026-04-02', amount: '1234.5678', currency: 'ILS', excluded: false,
};
const sourceExport = {
	accounts: [{id: accountId, accountable_type: 'Investment'}], entries: [sourceEntry],
	transactions: [], valuations: [{id: valuationId, kind: 'reconciliation'}], holdings: [], trades: [],
};
const sourceJson = JSON.stringify(sourceExport);
const sourceSha256 = createHash('sha256').update(sourceJson).digest('hex');

function manifest() {
	return {
		archiveManifestVersion: 1, status: 'prepared_for_review_not_imported', reviewPurpose: 'surviving-archive-baseline',
		source: {kind: 'sure_targeted_json_archive', sha256: sourceSha256, observedAt, observationBasis: 'archive_read'},
		account: {
			legacyIdentity: `sure:account:${accountId}`, sourceProviderLabel: 'hapoalim', currency: 'ILS',
			sourceAccount: sourceExport.accounts[0], currentValuationId: null, currentBalanceVerified: false,
		},
		activities: [], valuations: [{
			sourceEntryId: entryId, externalIdentity: `sure:entry:${entryId}`, legacyAccountIdentity: `sure:account:${accountId}`,
			currency: 'ILS', observedAt, asOf: '2026-04-02', amount: '1234.5678', sourceKind: 'reconciliation', current: false,
			provenance: {
				origin: 'sure_archive', bankObservationVerified: false, sourceEntry: {...sourceEntry},
				sourceValuation: sourceExport.valuations[0],
			},
		}],
		sourceCollection: {lastAttemptAt: null, lastSuccessAt: null},
	};
}

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories) {
		rmSync(directory, {recursive: true, force: true});
	}

	directories.length = 0;
});

describe('Hapoalim archival investment foundation', () => {
	it('retains original valuation identity, sub-cent amount and date without marking a source success', () => {
		const snapshot = prepareHapoalimArchive(manifest(), providerProductId);
		const store = createInvestmentStore(':memory:', 'hapoalim');
		try {
			const {source} = store.getFeed(new Date(observedAt), 30);
			expect(store.seedArchive(snapshot, {sourceSha256, manifest: manifest()})).toMatchObject({inserted: 2, updated: 0});
			expect(store.seedArchive(snapshot, {sourceSha256, manifest: manifest()})).toMatchObject({inserted: 0, unchanged: 2});
			const feed = store.getFeed(new Date(observedAt), 30);
			expect(feed.source).toEqual(source);
			expect(feed.source.status).toBe('never_synced');
			expect(feed.products[0]?.currentValuationId).toBeNull();
			expect(feed.valuations[0]).toMatchObject({id: `sure:entry:${entryId}`, amount: '1234.5678', asOf: '2026-04-02'});
			expect(feed.activities).toEqual([]);
			expect(feed.executions).toEqual([]);
			const product = snapshot.products[0]!;
			store.applySnapshot({
				...snapshot, valuations: [], products: [{...product, coverage: {...product.coverage, valuations: 'unavailable'}}],
			});
			const afterHistory = store.getFeed(new Date(observedAt), 30);
			expect(afterHistory.valuations).toEqual(feed.valuations);
			expect(afterHistory.products[0]?.coverage.valuations).toBe('partial');
			expect(afterHistory.products[0]?.currentValuationId).toBeNull();
		} finally {
			store.close();
		}
	});

	it('rejects old activity archives, invented dates and provenance mismatches', () => {
		const changed = manifest();
		changed.reviewPurpose = 'april-evidence-only';
		expect(() => prepareHapoalimArchive(changed, providerProductId)).toThrow('reviewed surviving');
		const mismatched = manifest();
		mismatched.valuations[0]!.amount = '1.00';
		expect(() => prepareHapoalimArchive(mismatched, providerProductId)).toThrow('original evidence');
		const duplicated = manifest();
		duplicated.valuations.push(duplicated.valuations[0]!);
		expect(() => prepareHapoalimArchive(duplicated, providerProductId)).toThrow('identities');
	});

	it('rolls back all new rows when an archived identity conflicts, retaining previous provenance and source', () => {
		const snapshot = prepareHapoalimArchive(manifest(), providerProductId);
		const store = createInvestmentStore(':memory:', 'hapoalim');
		try {
			store.seedArchive(snapshot, {sourceSha256, manifest: manifest()});
			const before = store.getFeed(new Date(observedAt), 30);
			const previous = snapshot.valuations[0]!;
			const newId = '44444444-4444-4444-8444-444444444444';
			const changed = {
				...snapshot, valuations: [
					{...previous, id: `sure:entry:${newId}`, asOf: '2026-04-03', provenance: {...previous.provenance!, sourceEntryId: newId}},
					{...previous, amount: '1.00', provenance: {...previous.provenance!, sourceAmount: '1.00'}},
				],
			};
			expect(() => store.seedArchive(changed, {sourceSha256, manifest: manifest()})).toThrow('conflicts');
			expect(store.getFeed(new Date(observedAt), 30)).toEqual(before);
			expect(() => store.seedArchive(snapshot, {sourceSha256, manifest: {...manifest(), changed: true}})).toThrow('evidence conflicts');
			expect(store.getFeed(new Date(observedAt), 30)).toEqual(before);
		} finally {
			store.close();
		}
	});

	it('allows only valuation precision to increase and rejects floats or unbounded decimals', () => {
		for (const value of ['1.00', '1.2345', '1.000001']) {
			expect(investmentValuationMoneySchema.parse(value)).toBe(value);
		}

		for (const value of [1.2345, '-1.00', '1.0000001', '1e3', '01.00', '1000000000.00', '999999999.990001']) {
			expect(investmentValuationMoneySchema.safeParse(value).success).toBe(false);
		}

		expect(investmentActivitySchema.shape.amount.safeParse('1.2345').success).toBe(false);
	});

	it('does not replace an existing current value or source state when archive history is added', () => {
		const archived = prepareHapoalimArchive(manifest(), providerProductId);
		const store = createInvestmentStore(':memory:', 'hapoalim');
		try {
			const product = archived.products[0]!;
			const currentId = investmentValuationId(product.id, '2026-09-10');
			store.applySnapshot({
				...archived, inventoryComplete: true, products: [{...product, currentValuationId: currentId}],
				valuations: [{id: currentId, productId: product.id, asOf: '2026-09-10', observedAt, amount: '0.00', currency: 'ILS'}],
			});
			const before = store.getFeed(new Date(observedAt), 30);
			store.seedArchive(archived, {sourceSha256, manifest: manifest()});
			const after = store.getFeed(new Date(observedAt), 30);
			expect(after.source).toEqual(before.source);
			expect(after.products).toEqual(before.products);
			expect(after.valuations).toHaveLength(2);
		} finally {
			store.close();
		}
	});

	it('retains verified executions under partial current portfolio state without fabricating source success', () => {
		const snapshot = prepareHapoalimArchive(manifest(), providerProductId);
		const product = snapshot.products[0]!;
		const sourceId = `natural-key-v1:${'a'.repeat(64)}`;
		const execution = {
			id: investmentExecutionId(product.id, sourceId), productId: product.id, sourceId, sourceIdKind: 'natural_key' as const,
			kind: 'buy' as const, securityId: 'EXAMPLE', isin: null, symbol: null, name: 'Example security',
			tradeDate: '2026-03-01', valueDate: null, settlementDate: null, cancelDate: null, cancelled: false,
			quantity: '1.23456789', unitPrice: '1.00', netCashAmount: '-1.23', currency: 'USD',
			settlementNetCashAmount: null, settlementCurrency: 'ILS', sourceTradeType: 'example', sourceTransactionType: 'example',
			sourcePaymentType: null, observedAt,
		};
		const store = createInvestmentStore(':memory:', 'hapoalim');
		try {
			const live = {...snapshot, valuations: [], products: [{...product, coverage: {...product.coverage, valuations: 'unavailable' as const}}], executions: [execution]};
			expect(store.applySnapshot(live).applied).toBe(true);
			const feed = store.getFeed(new Date(observedAt), 30);
			expect(feed.source).toMatchObject({status: 'partial', lastAttemptAt: observedAt, lastSuccessAt: null, inventoryComplete: false});
			expect(feed.executions).toEqual([execution]);
			expect(feed.activities).toEqual([]);
			expect(() => store.applySnapshot({...live, executions: [execution, execution]})).toThrow('Duplicate');
		} finally {
			store.close();
		}
	});

	it('preserves the last verified current value and date when a later history-only collection is partial', () => {
		const archived = prepareHapoalimArchive(manifest(), providerProductId);
		const product = archived.products[0]!;
		const currentId = investmentValuationId(product.id, '2026-09-09');
		const store = createInvestmentStore(':memory:', 'hapoalim');
		try {
			store.applySnapshot({
				...archived, inventoryComplete: true, products: [{...product, currentValuationId: currentId}],
				valuations: [{id: currentId, productId: product.id, asOf: '2026-09-09', observedAt, amount: '42.00', currency: 'ILS'}],
			});
			const before = store.getFeed(new Date(observedAt), 30);
			const later = '2026-09-10T15:00:00.000Z';
			store.applySnapshot({
				...archived, observedAt: later, valuations: [], inventoryComplete: false,
				products: [{...product, coverage: {...product.coverage, valuations: 'unavailable'}}],
			});
			const after = store.getFeed(new Date(later), 30);
			expect(after.products[0]?.currentValuationId).toBe(currentId);
			expect(after.valuations).toEqual(before.valuations);
			expect(after.source).toMatchObject({status: 'partial', lastAttemptAt: later, lastSuccessAt: observedAt});
		} finally {
			store.close();
		}
	});

	it('ignores older partial snapshots across restarts without regressing execution corrections or source attempts', () => {
		const directory = mkdtempSync(path.join(os.tmpdir(), 'hapoalim-observation-'));
		directories.push(directory);
		const filename = path.join(directory, 'investment.sqlite');
		const feed = investmentFeedSchema.parse(JSON.parse(readFileSync(new URL('../../../fixtures/hapoalim-investment-feed.json', import.meta.url), 'utf8')));
		const snapshot = (at: string, name: string) => ({
			observedAt: at, complete: true, inventoryComplete: false,
			products: feed.products.map(product => ({...product, coverage: {...product.coverage, valuations: 'unavailable' as const}})),
			valuations: [], activities: [], tracks: [], executions: feed.executions!.map(row => ({...row, name, observedAt: at})),
		});
		const newerAt = '2026-09-10T16:00:00.000Z';
		const newer = snapshot(newerAt, 'Corrected example');
		const first = createInvestmentStore(filename, 'hapoalim');
		first.applySnapshot(newer);
		first.close();
		const store = createInvestmentStore(filename, 'hapoalim');
		try {
			const before = store.getFeed(new Date(newerAt), 30);
			expect(store.applySnapshot(snapshot('2026-09-10T12:00:00Z', 'Old example'))).toEqual({applied: false, inserted: 0, updated: 0, unchanged: 0});
			expect(store.getFeed(new Date(newerAt), 30)).toEqual(before);
			expect(before.source).toMatchObject({lastSuccessAt: null, lastAttemptAt: newerAt});
			// Equal instants with different allowed ISO precision are not older observations.
			expect(store.applySnapshot(snapshot('2026-09-10T16:00:00Z', 'Corrected example')).applied).toBe(true);
		} finally {
			store.close();
		}
	});

	it('makes a private native backup and verifies original evidence before seeding, without opening the bank ledger', async () => {
		const dataDir = mkdtempSync(path.join(os.tmpdir(), 'hapoalim-archive-'));
		directories.push(dataDir);
		const archivePath = path.join(dataDir, 'review.json');
		const sourcePath = path.join(dataDir, 'source.json');
		writeFileSync(archivePath, JSON.stringify(manifest()), {mode: 0o600});
		writeFileSync(sourcePath, sourceJson, {mode: 0o600});
		const config = parseConfig({companies: {hapoalim: {label: 'Example bank', kind: 'checking', credentials: {}, accounts: [selector]}}, hapoalimInvestments: {}});
		const env = {...readRuntimeEnv(), dataDir, ledgerPath: path.join(dataDir, 'bank.sqlite')};
		const backupDir = path.join(dataDir, 'backups');
		const result = await seedHapoalimArchive({archivePath, sourcePath, providerProductId, backupDir, config, env});
		expect(result).toMatchObject({inserted: 2, sourceStatus: 'never_synced', sourceFreshnessPreserved: true});
		const configPath = path.join(dataDir, 'config.json');
		writeFileSync(configPath, JSON.stringify(config), {mode: 0o600});
		const root = path.resolve(import.meta.dirname, '../../..');
		const args = [
			'--import',
			'tsx',
			path.join(root, 'src/cli.ts'),
			'hapoalim-investments-seed',
			'--config',
			configPath,
			'--data-dir',
			dataDir,
			'--archive',
			archivePath,
			'--source',
			sourcePath,
			'--provider-product-id',
			providerProductId,
			'--backup-dir',
			backupDir,
		];
		const child = await new Promise<{stdout: string; stderr: string}>((resolve, reject) => {
			execFile(process.execPath, args, {cwd: root, timeout: 25_000}, (error, stdout, stderr) => {
				if (error) {
					reject(new Error('Native archive CLI failed', {cause: error}));
					return;
				}

				resolve({stdout, stderr});
			});
		});
		expect(JSON.parse(child.stdout)).toMatchObject({inserted: 0, unchanged: 2, sourceStatus: 'never_synced'});
		expect(child.stdout).not.toContain(entryId);
		expect(child.stdout).not.toContain(sourceEntry.amount);
		expect(readdirSync(dataDir)).not.toContain('bank.sqlite');
		expect(readdirSync(dataDir)).not.toContain('ledger.sqlite');
		const backup = path.join(backupDir, readdirSync(backupDir)[0]!);
		expect(statSync(backup).mode % 0o1000).toBe(0o600);
		const before = new DatabaseSync(backup, {readOnly: true});
		expect(before.prepare('SELECT count(*) AS n FROM investment_records').get()?.n).toBe(0);
		before.close();
		const after = new DatabaseSync(path.join(dataDir, HAPOALIM_INVESTMENTS_DATABASE), {readOnly: true});
		expect(after.prepare('SELECT count(*) AS n FROM investment_archive_evidence').get()?.n).toBe(1);
		after.close();
		expect(readFileSync(sourcePath, 'utf8')).toBe(sourceJson);
	});
});
