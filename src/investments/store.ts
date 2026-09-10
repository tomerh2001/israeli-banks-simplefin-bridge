import {backup, DatabaseSync} from 'node:sqlite';
import {z} from 'zod';
import {investmentActivityId, investmentExecutionId, investmentProductId, investmentValuationId} from './ids.js';
import {clalSessionStateSchema, investmentFeedSchema, investmentSnapshotSchema, investmentSourceStateSchema} from './schema.js';
import type {
	ClalSessionState,
	InvestmentFailure,
	InvestmentFeed,
	InvestmentImportSummary,
	InvestmentProduct,
	InvestmentProvider,
	InvestmentSnapshot,
	InvestmentSourceState,
	InvestmentStore,
} from './types.js';

const recordKinds = ['products', 'valuations', 'activities', 'tracks', 'executions'] as const;
type RecordKind = typeof recordKinds[number];
type InvestmentRecord = NonNullable<InvestmentSnapshot[RecordKind]>[number];

function initialState(provider: InvestmentProvider): InvestmentSourceState {
	return {
		provider, status: 'never_synced', lastAttemptAt: null, lastSuccessAt: null,
		staleAfterHours: 168, errorCode: null, inventoryComplete: false,
	};
}

function validateRelations(snapshot: InvestmentSnapshot, provider: InvestmentProvider): void {
	const products = new Map(snapshot.products.map(product => [product.id, product]));
	for (const kind of recordKinds) {
		const identifiers = (snapshot[kind] ?? []).map(row => row.id);
		if (new Set(identifiers).size !== identifiers.length) {
			throw new Error(`Duplicate investment ${kind} identities`);
		}
	}

	for (const product of snapshot.products) {
		if (product.provider !== provider || product.id !== investmentProductId(product.providerProductId, provider)) {
			throw new Error('Investment product identity does not match its provider identity');
		}

		if (product.coverage.valuations !== 'unavailable' && snapshot.valuations.every(row => row.productId !== product.id)) {
			throw new Error('Investment product declares valuations without a value');
		}

		if (product.currentValuationId && snapshot.valuations.every(row => row.productId !== product.id || row.id !== product.currentValuationId)) {
			throw new Error('Investment product current value does not identify one of its valuations');
		}
	}

	for (const row of [...snapshot.valuations, ...snapshot.activities, ...snapshot.tracks]) {
		const product = products.get(row.productId);
		if (product?.currency !== row.currency) {
			throw new Error('Investment record has an unknown product or inconsistent currency');
		}
	}

	for (const row of snapshot.valuations) {
		const archived = row.provenance;
		if (archived) {
			if (provider !== 'hapoalim' || row.id !== `sure:entry:${archived.sourceEntryId}` || row.asOf === null
				|| row.amount !== archived.sourceAmount || row.observedAt !== archived.archiveObservedAt
				|| products.get(row.productId)?.currentValuationId === row.id) {
				throw new Error('Archive valuation must preserve its identity, value and historical provenance');
			}
		} else if (row.id !== investmentValuationId(row.productId, row.asOf)) {
			throw new Error('Investment valuation identity does not match its date');
		}
	}

	for (const row of snapshot.activities) {
		if (row.id !== investmentActivityId(row.productId, row.sourceId)) {
			throw new Error('Investment activity identity does not match its provider identity');
		}
	}

	for (const row of snapshot.tracks) {
		if (!row.id.startsWith(`${row.productId}:track:`)) {
			throw new Error('Investment track identity does not match its product');
		}
	}

	for (const row of snapshot.executions ?? []) {
		if (provider !== 'hapoalim' || !products.has(row.productId) || row.id !== investmentExecutionId(row.productId, row.sourceId)) {
			throw new Error('Investment execution identity does not match its provider product');
		}
	}
}

/** Observation time is freshness metadata; it does not create a financial revision. */
function financialContent(row: InvestmentRecord): string {
	return JSON.stringify({...row, observedAt: undefined});
}

/** Separate database: investment writes cannot mutate bank accounts or their source freshness. */
export function createInvestmentStore(filename: string, provider: InvestmentProvider = 'clal'): InvestmentStore {
	const db = new DatabaseSync(filename);
	db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
	db.exec('CREATE TABLE IF NOT EXISTS investment_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
	const schemaVersion = db.prepare('SELECT value FROM investment_meta WHERE key = ?').get('schema_version')?.value;
	if (schemaVersion !== undefined && schemaVersion !== '1') {
		db.close();
		throw new Error('Unsupported investment database schema version');
	}

	db.exec(`
		CREATE TABLE IF NOT EXISTS investment_records (
			kind TEXT NOT NULL,
			id TEXT NOT NULL,
			product_id TEXT NOT NULL,
			json TEXT NOT NULL,
			PRIMARY KEY (kind, id)
		);
		CREATE INDEX IF NOT EXISTS investment_records_product ON investment_records (product_id, kind);
		CREATE TABLE IF NOT EXISTS investment_revisions (
			sequence INTEGER PRIMARY KEY AUTOINCREMENT,
			kind TEXT NOT NULL,
			id TEXT NOT NULL,
			replaced_at TEXT NOT NULL,
			json TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS investment_archive_evidence (
			sha256 TEXT PRIMARY KEY,
			json TEXT NOT NULL
		);
		INSERT OR IGNORE INTO investment_meta (key, value) VALUES ('schema_version', '1');
	`);

	const readState = (): InvestmentSourceState => {
		const row = db.prepare('SELECT value FROM investment_meta WHERE key = ?').get('source_state');
		const state = row ? investmentSourceStateSchema.parse(JSON.parse(String(row.value))) : initialState(provider);
		if (state.provider !== provider) {
			throw new Error('Investment database belongs to another provider');
		}

		return state;
	};

	const writeState = (state: InvestmentSourceState): void => {
		const validated = investmentSourceStateSchema.parse(state);
		db.prepare('INSERT OR REPLACE INTO investment_meta (key, value) VALUES (?, ?)').run('source_state', JSON.stringify(validated));
	};

	// Bind even an archive-only database to its provider before any source collection.
	const owner = db.prepare('SELECT value FROM investment_meta WHERE key = ?').get('provider');
	if (owner && owner.value !== provider) {
		db.close();
		throw new Error('Investment database belongs to another provider');
	}

	try {
		readState();
		db.prepare('INSERT OR IGNORE INTO investment_meta (key, value) VALUES (?, ?)').run('provider', provider);
	} catch (error) {
		db.close();
		throw error;
	}

	const recordFailure = (failure: InvestmentFailure): void => {
		db.exec('BEGIN IMMEDIATE');
		try {
			const state = readState();
			if (!state.lastAttemptAt || failure.attemptedAt >= state.lastAttemptAt) {
				writeState({
					...state, status: failure.status, lastAttemptAt: failure.attemptedAt,
					errorCode: failure.errorCode, inventoryComplete: false,
				});
			}

			db.exec('COMMIT');
		} catch (error) {
			db.exec('ROLLBACK');
			throw error;
		}
	};

	const recordQuery = db.prepare('SELECT json FROM investment_records WHERE kind = ? AND id = ?');
	const saveRecord = db.prepare('INSERT OR REPLACE INTO investment_records (kind, id, product_id, json) VALUES (?, ?, ?, ?)');
	const saveRevision = db.prepare('INSERT INTO investment_revisions (kind, id, replaced_at, json) VALUES (?, ?, ?, ?)');
	const upsertRecord = (kind: RecordKind, row: InvestmentRecord, observedAt: string): 'inserted' | 'updated' | 'unchanged' => {
		const previous = recordQuery.get(kind, row.id);
		let outcome: 'inserted' | 'updated' | 'unchanged' = 'inserted';
		if (previous) {
			const old = JSON.parse(String(previous.json)) as InvestmentRecord;
			if (kind === 'products') {
				const oldProduct = old as InvestmentProduct;
				let product = row as InvestmentProduct;
				if (provider === 'hapoalim') {
					const coverage = {...product.coverage};
					if (coverage.valuations === 'unavailable') {
						coverage.valuations = oldProduct.coverage.valuations;
					}

					product = {
						...product, currentValuationId: product.currentValuationId ?? oldProduct.currentValuationId,
						coverage,
					};

					row = product;
				}

				if (oldProduct.reportSummaries || product.reportSummaries) {
					const reports = new Map((oldProduct.reportSummaries ?? []).map(report => [report.id, report]));
					for (const report of product.reportSummaries ?? []) {
						reports.set(report.id, report);
					}

					row = {...product, reportSummaries: [...reports.values()].sort((a, b) => a.id.localeCompare(b.id))};
				}
			}

			outcome = financialContent(old) === financialContent(row) ? 'unchanged' : 'updated';
			if (outcome === 'updated') {
				saveRevision.run(kind, row.id, observedAt, String(previous.json));
			}
		}

		const productId = 'productId' in row ? row.productId : row.id;
		saveRecord.run(kind, row.id, productId, JSON.stringify(row));
		return outcome;
	};

	const appendArchiveRecord = (kind: 'products' | 'valuations', row: InvestmentRecord, observedAt: string): 'inserted' | 'updated' | 'unchanged' => {
		const previous = recordQuery.get(kind, row.id);
		if (!previous) {
			return upsertRecord(kind, row, observedAt);
		}

		const old = JSON.parse(String(previous.json)) as InvestmentRecord;
		// Existing current pointers and metadata belong to the live source, never the archive.
		if (kind === 'products') {
			const product = old as InvestmentProduct;
			if (product.provider !== provider || product.currency !== row.currency) {
				throw new Error('Archive product conflicts with existing source identity');
			}
		} else if (financialContent(old) !== financialContent(row)) {
			throw new Error('Archive valuation conflicts with an existing record');
		}

		return 'unchanged';
	};

	return {
		async backup(destination): Promise<void> {
			await backup(db, destination);
		},
		seedArchive(input, evidence): InvestmentImportSummary {
			const snapshot = investmentSnapshotSchema.parse(input);
			if (provider !== 'hapoalim' || snapshot.activities.length > 0 || snapshot.tracks.length > 0 || (snapshot.executions?.length ?? 0) > 0
				|| snapshot.products.length !== 1 || snapshot.valuations.length === 0
				|| snapshot.products.some(product => product.currentValuationId !== null)
				|| snapshot.valuations.some(row => !row.provenance)) {
				throw new Error('Archive seed requires one historical Hapoalim product and only provenanced valuations');
			}

			validateRelations(snapshot, provider);
			if (!/^[\da-f]{64}$/.test(evidence.sourceSha256)
				|| snapshot.valuations.some(row => row.provenance?.sourceSha256 !== evidence.sourceSha256)) {
				throw new Error('Archive evidence does not match its valuation provenance');
			}

			const evidenceJson = JSON.stringify(evidence.manifest);
			if (!evidenceJson || evidenceJson.length > 20 * 1024 * 1024) {
				throw new Error('Archive evidence is missing or exceeds the size limit');
			}

			const summary = {applied: true, inserted: 0, updated: 0, unchanged: 0};
			db.exec('BEGIN IMMEDIATE');
			try {
				readState(); // Refuse a database owned by another provider before any writes.
				const previousEvidence = db.prepare('SELECT json FROM investment_archive_evidence WHERE sha256 = ?').get(evidence.sourceSha256);
				if (previousEvidence && previousEvidence.json !== evidenceJson) {
					throw new Error('Archive evidence conflicts with its stored source hash');
				}

				db.prepare('INSERT OR IGNORE INTO investment_archive_evidence (sha256, json) VALUES (?, ?)')
					.run(evidence.sourceSha256, evidenceJson);
				for (const kind of ['products', 'valuations'] as const) {
					for (const row of snapshot[kind] ?? []) {
						summary[appendArchiveRecord(kind, row, snapshot.observedAt)]++;
					}
				}

				db.exec('COMMIT');
				return summary;
			} catch (error) {
				db.exec('ROLLBACK');
				throw error;
			}
		},
		getAutomaticSmsNextAllowedAt(at): InvestmentSourceState['lastAttemptAt'] {
			const timestamp = Date.parse(z.iso.datetime().parse(at));
			const row = db.prepare('SELECT value FROM investment_meta WHERE key = ?').get('automatic_sms_attempts');
			const previous = row ? z.array(z.iso.datetime()).max(2).parse(JSON.parse(String(row.value))) : [];
			const recent = previous.map(value => Date.parse(value)).filter(value => value > timestamp - 86_400_000);
			return recent.length >= 2 ? new Date(Math.min(...recent) + 86_400_000).toISOString() : null;
		},
		consumeControlRefreshAttempt(at): {allowed: boolean; retryAfterSeconds: number} {
			const timestamp = Date.parse(z.iso.datetime().parse(at));
			db.exec('BEGIN IMMEDIATE');
			try {
				const row = db.prepare('SELECT value FROM investment_meta WHERE key = ?').get('control_refresh_attempts');
				const previous = row ? z.array(z.iso.datetime()).max(2).parse(JSON.parse(String(row.value))) : [];
				const recent = previous.filter(value => Date.parse(value) > timestamp - 60_000);
				const allowed = recent.length < 2;
				const retryAfterSeconds = allowed ? 0 : Math.ceil((Math.min(...recent.map(value => Date.parse(value))) + 60_000 - timestamp) / 1000);
				if (allowed) {
					recent.push(at);
					db.prepare('INSERT OR REPLACE INTO investment_meta (key, value) VALUES (?, ?)')
						.run('control_refresh_attempts', JSON.stringify(recent));
				}

				db.exec('COMMIT');
				return {allowed, retryAfterSeconds};
			} catch (error) {
				db.exec('ROLLBACK');
				throw error;
			}
		},
		consumeAutomaticSmsAttempt(attemptedAt): boolean {
			const timestamp = Date.parse(z.iso.datetime().parse(attemptedAt));
			db.exec('BEGIN IMMEDIATE');
			try {
				const row = db.prepare('SELECT value FROM investment_meta WHERE key = ?').get('automatic_sms_attempts');
				const previous = row ? z.array(z.iso.datetime()).max(2).parse(JSON.parse(String(row.value))) : [];
				// Retain future timestamps if the wall clock moves backwards: a clock
				// adjustment cannot silently replenish the request allowance.
				const recent = previous.filter(value => Date.parse(value) > timestamp - 86_400_000);
				const allowed = recent.length < 2;
				if (allowed) {
					recent.push(attemptedAt);
					db.prepare('INSERT OR REPLACE INTO investment_meta (key, value) VALUES (?, ?)')
						.run('automatic_sms_attempts', JSON.stringify(recent));
				}

				db.exec('COMMIT');
				return allowed;
			} catch (error) {
				db.exec('ROLLBACK');
				throw error;
			}
		},
		getSessionState(): ClalSessionState {
			const row = db.prepare('SELECT value FROM investment_meta WHERE key = ?').get('session_state');
			return row
				? clalSessionStateSchema.parse(JSON.parse(String(row.value)))
				: {status: 'unknown', lastCheckedAt: null, lastRenewedAt: null, expiresAt: null, errorCode: null};
		},
		setSessionState(state): void {
			const validated = clalSessionStateSchema.parse(state);
			db.exec('BEGIN IMMEDIATE');
			try {
				const row = db.prepare('SELECT value FROM investment_meta WHERE key = ?').get('session_state');
				const previous = row ? clalSessionStateSchema.parse(JSON.parse(String(row.value))) : undefined;
				if (!previous?.lastCheckedAt || (validated.lastCheckedAt && Date.parse(validated.lastCheckedAt) >= Date.parse(previous.lastCheckedAt))) {
					db.prepare('INSERT OR REPLACE INTO investment_meta (key, value) VALUES (?, ?)').run('session_state', JSON.stringify(validated));
				}

				db.exec('COMMIT');
			} catch (error) {
				db.exec('ROLLBACK');
				throw error;
			}
		},
		applySnapshot(input): InvestmentImportSummary {
			const snapshot = investmentSnapshotSchema.parse(input);
			if (!snapshot.complete || (!snapshot.inventoryComplete && provider !== 'hapoalim')) {
				recordFailure({status: 'partial', attemptedAt: snapshot.observedAt, errorCode: 'INCOMPLETE_RESPONSE'});
				return {applied: false, inserted: 0, updated: 0, unchanged: 0};
			}

			validateRelations(snapshot, provider);
			const summary = {applied: true, inserted: 0, updated: 0, unchanged: 0};
			db.exec('BEGIN IMMEDIATE');
			try {
				const state = readState();
				if (provider === 'hapoalim') {
					const prior = db.prepare('SELECT value FROM investment_meta WHERE key = ?').get('last_applied_observation');
					const appliedAt = prior ? z.iso.datetime().parse(prior.value) : null;
					const newest = Math.max(...[appliedAt, state.lastAttemptAt, state.lastSuccessAt]
						.filter((value): value is string => value !== null).map(value => Date.parse(value)));
					if (Date.parse(snapshot.observedAt) < newest) {
						db.exec('COMMIT');
						return {applied: false, inserted: 0, updated: 0, unchanged: 0};
					}
				}

				if (provider !== 'hapoalim' && state.lastSuccessAt && snapshot.observedAt < state.lastSuccessAt) {
					throw new Error('Investment observation predates the last successful collection');
				}

				for (const kind of recordKinds) {
					for (const row of snapshot[kind] ?? []) {
						summary[upsertRecord(kind, row, snapshot.observedAt)]++;
					}
				}

				const currentValuesComplete = provider !== 'hapoalim'
					|| (snapshot.inventoryComplete && snapshot.products.length > 0 && snapshot.products.every(product => product.currentValuationId !== null));
				writeState({
					...readState(), status: currentValuesComplete ? 'ok' : 'partial', lastAttemptAt: snapshot.observedAt,
					lastSuccessAt: currentValuesComplete ? snapshot.observedAt : state.lastSuccessAt,
					errorCode: currentValuesComplete ? null : 'INCOMPLETE_RESPONSE', inventoryComplete: snapshot.inventoryComplete,
				});
				if (provider === 'hapoalim') {
					db.prepare('INSERT OR REPLACE INTO investment_meta (key, value) VALUES (?, ?)')
						.run('last_applied_observation', new Date(snapshot.observedAt).toISOString());
				}

				db.exec('COMMIT');
				return summary;
			} catch (error) {
				db.exec('ROLLBACK');
				throw error;
			}
		},
		recordFailure,
		getFeed(now, staleAfterHours): InvestmentFeed {
			db.exec('BEGIN');
			try {
				const data = Object.fromEntries(recordKinds.map(kind => [kind,
					db.prepare('SELECT json FROM investment_records WHERE kind = ? ORDER BY id').all(kind)
						.map(row => JSON.parse(String(row.json)) as unknown)]));
				const feed = investmentFeedSchema.parse({
					schemaVersion: 1, generatedAt: now.toISOString(),
					source: {...readState(), staleAfterHours}, ...data,
				});
				db.exec('COMMIT');
				return feed;
			} catch (error) {
				db.exec('ROLLBACK');
				throw error;
			}
		},
		close() {
			db.close();
		},
	};
}
