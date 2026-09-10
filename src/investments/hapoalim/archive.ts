import {createHash} from 'node:crypto';
import {chmodSync, existsSync, lstatSync, mkdirSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {z} from 'zod';
import type {Config, RuntimeEnv} from '../../types.js';
import {investmentProductId} from '../ids.js';
import {investmentSnapshotSchema, investmentValuationMoneySchema} from '../schema.js';
import {createInvestmentStore} from '../store.js';
import type {InvestmentSnapshot} from '../types.js';
import {HAPOALIM_INVESTMENTS_DATABASE} from './runtime.js';

const uuid = z.uuid();
const archiveSchema = z.object({
	archiveManifestVersion: z.literal(1),
	status: z.literal('prepared_for_review_not_imported'),
	reviewPurpose: z.literal('surviving-archive-baseline'),
	source: z.object({
		sha256: z.string().regex(/^[\da-f]{64}$/),
		kind: z.literal('sure_targeted_json_archive'),
		observedAt: z.iso.datetime({offset: true}),
		observationBasis: z.enum(['archive_capture', 'archive_read']),
	}),
	account: z.object({
		legacyIdentity: z.string(),
		sourceProviderLabel: z.literal('hapoalim'),
		currency: z.string().regex(/^[A-Z]{3}$/),
		sourceAccount: z.object({id: uuid, accountable_type: z.literal('Investment')}),
		currentValuationId: z.null(),
		currentBalanceVerified: z.literal(false),
	}),
	activities: z.array(z.unknown()).length(0),
	valuations: z.array(z.object({
		sourceEntryId: uuid,
		externalIdentity: z.string(),
		legacyAccountIdentity: z.string(),
		currency: z.string().regex(/^[A-Z]{3}$/),
		observedAt: z.iso.datetime({offset: true}),
		asOf: z.iso.date(),
		amount: investmentValuationMoneySchema,
		sourceKind: z.literal('reconciliation'),
		current: z.literal(false),
		provenance: z.object({
			origin: z.literal('sure_archive'),
			bankObservationVerified: z.literal(false),
			sourceEntry: z.object({
				id: uuid, account_id: uuid, entryable_id: uuid, entryable_type: z.literal('Valuation'),
				date: z.iso.date(), amount: investmentValuationMoneySchema, currency: z.string(),
				excluded: z.literal(false),
			}),
			sourceValuation: z.object({id: uuid, kind: z.literal('reconciliation')}),
		}),
	})).min(1).max(10_000),
	sourceCollection: z.strictObject({lastAttemptAt: z.null(), lastSuccessAt: z.null()}),
});

/** Convert reviewed surviving archive rows. This function cannot advance source freshness. */
export function prepareHapoalimArchive(input: unknown, providerProductId: string): InvestmentSnapshot {
	const parsed = archiveSchema.safeParse(input);
	if (!parsed.success || !/^\d+-\d+-\d+:securities$/.test(providerProductId)) {
		throw new Error('Expected a reviewed surviving Hapoalim valuation archive and explicit securities identity');
	}

	const archive = parsed.data;
	const productId = investmentProductId(providerProductId, 'hapoalim');
	const accountId = archive.account.sourceAccount.id;
	const accountIdentity = `sure:account:${accountId}`;
	const observedAt = new Date(archive.source.observedAt).toISOString();
	if (archive.account.legacyIdentity !== accountIdentity
		|| new Set(archive.valuations.map(row => row.sourceEntryId)).size !== archive.valuations.length
		|| new Set(archive.valuations.map(row => row.asOf)).size !== archive.valuations.length) {
		throw new Error('Archive identities or valuation dates are inconsistent');
	}

	const valuations = archive.valuations.map(row => {
		const entry = row.provenance.sourceEntry;
		if (row.externalIdentity !== `sure:entry:${row.sourceEntryId}` || row.legacyAccountIdentity !== accountIdentity
			|| entry.id !== row.sourceEntryId || entry.account_id !== accountId || entry.date !== row.asOf
			|| entry.amount !== row.amount || entry.currency !== row.currency || row.currency !== archive.account.currency
			|| entry.entryable_id !== row.provenance.sourceValuation.id
			|| new Date(row.observedAt).toISOString() !== observedAt) {
			throw new Error('Archive valuation differs from its original evidence');
		}

		return {
			id: row.externalIdentity, productId, asOf: row.asOf, amount: row.amount, currency: row.currency, observedAt,
			provenance: {
				origin: 'sure_archive' as const, sourceEntryId: row.sourceEntryId, sourceAccountId: accountId,
				sourceSha256: archive.source.sha256, archiveObservedAt: observedAt,
				observationBasis: archive.source.observationBasis, bankObservationVerified: false as const, sourceAmount: row.amount,
			},
		};
	});
	return investmentSnapshotSchema.parse({
		observedAt, complete: true, inventoryComplete: false,
		products: [{
			id: productId, provider: 'hapoalim', providerProductId, kind: 'investment', name: 'Hapoalim Investments',
			currency: archive.account.currency, currentValuationId: null,
			liquidity: {status: 'unknown', availableFrom: null, availableAmount: null},
			coverage: {valuations: 'partial', activities: 'unavailable', tracks: 'unavailable', executions: 'unavailable'}, forecast: null,
		}],
		valuations, activities: [], tracks: [], executions: [],
	});
}

export function assertHapoalimStoreOwnership(filename: string): void {
	for (const candidate of [filename, `${filename}-wal`, `${filename}-shm`]) {
		if (!existsSync(candidate)) {
			continue;
		}

		const stat = lstatSync(candidate);
		if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.gid !== process.getgid?.()) {
			throw new Error('Investment database must be opened by its owning service user and group');
		}
	}
}

function readPrivateJson(filename: string): {raw: Uint8Array; value: unknown} {
	const stat = lstatSync(filename);
	if (!stat.isFile() || stat.size > 20 * 1024 * 1024) {
		throw new Error('Archive input must be a bounded regular file');
	}

	try {
		const raw = readFileSync(filename);
		return {raw, value: JSON.parse(raw.toString('utf8')) as unknown};
	} catch {
		throw new Error('Archive input is not valid JSON');
	}
}

/** Offline native import with a consistent private backup before every material change. */
export async function seedHapoalimArchive(options: {
	archivePath: string;
	sourcePath: string;
	providerProductId: string;
	backupDir: string;
	config: Config;
	env: RuntimeEnv;
}) {
	const {config, env, providerProductId} = options;
	const accounts = config.companies.hapoalim?.accounts;
	if (!config.hapoalimInvestments || !Array.isArray(accounts)
		|| accounts.every(account => `${account}:securities` !== providerProductId)) {
		throw new Error('Archive target must match an explicitly configured Hapoalim bank account');
	}

	const manifest = readPrivateJson(options.archivePath).value;
	const snapshot = prepareHapoalimArchive(manifest, providerProductId);
	const source = readPrivateJson(options.sourcePath);
	const sourceSha256 = createHash('sha256').update(source.raw).digest('hex');
	if (snapshot.valuations.some(row => row.provenance?.sourceSha256 !== sourceSha256)) {
		throw new Error('Archive source hash does not match the reviewed evidence');
	}

	const sourceExport = z.object({
		accounts: z.array(z.object({id: uuid, accountable_type: z.literal('Investment')})).length(1),
		entries: z.array(archiveSchema.shape.valuations.element.shape.provenance.shape.sourceEntry),
		transactions: z.array(z.unknown()).length(0), holdings: z.array(z.unknown()).length(0), trades: z.array(z.unknown()).length(0),
	}).safeParse(source.value);
	if (!sourceExport.success || sourceExport.data.entries.length !== snapshot.valuations.length
		|| new Set(sourceExport.data.entries.map(row => row.id)).size !== snapshot.valuations.length) {
		throw new Error('Archive source is not the surviving valuation-only export');
	}

	const originalEntries = new Map(sourceExport.data.entries.map(row => [row.id, row]));
	for (const row of snapshot.valuations) {
		const original = originalEntries.get(row.provenance!.sourceEntryId);
		if (original?.account_id !== sourceExport.data.accounts[0]!.id
			|| original.account_id !== row.provenance!.sourceAccountId || original.date !== row.asOf
			|| original.amount !== row.amount || original.currency !== row.currency) {
			throw new Error('Reviewed valuation does not match the hashed source export');
		}
	}

	const filename = path.join(env.dataDir, HAPOALIM_INVESTMENTS_DATABASE);
	assertHapoalimStoreOwnership(filename);
	mkdirSync(options.backupDir, {recursive: true, mode: 0o700});
	const privateDir = lstatSync(options.backupDir);
	if (!privateDir.isDirectory() || privateDir.isSymbolicLink() || privateDir.mode % 0o100 !== 0
		|| privateDir.uid !== process.getuid?.()) {
		throw new Error('Archive backup directory must be private and owned by the service user');
	}

	const store = createInvestmentStore(filename, 'hapoalim');
	try {
		chmodSync(filename, 0o600);
		const backupPath = path.join(options.backupDir, `hapoalim-investments-before-${Date.now()}.sqlite`);
		if (existsSync(backupPath)) {
			throw new Error('Archive backup already exists');
		}

		await store.backup(backupPath);
		chmodSync(backupPath, 0o600);
		const before = store.getFeed(new Date(), config.hapoalimInvestments.staleHours).source;
		const result = store.seedArchive(snapshot, {sourceSha256, manifest});
		const feed = store.getFeed(new Date(), config.hapoalimInvestments.staleHours);
		if (JSON.stringify(before) !== JSON.stringify(feed.source)) {
			throw new Error('Archive seed unexpectedly changed provider freshness');
		}

		assertHapoalimStoreOwnership(filename);
		return {...result, products: feed.products.length, valuations: feed.valuations.length, sourceStatus: feed.source.status, sourceFreshnessPreserved: true};
	} finally {
		store.close();
		assertHapoalimStoreOwnership(filename);
	}
}
