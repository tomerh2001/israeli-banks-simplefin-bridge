import {DatabaseSync} from 'node:sqlite';
import {investmentActivityId, investmentProductId, investmentValuationId} from './ids.js';
import {clalSessionStateSchema, investmentFeedSchema, investmentSnapshotSchema, investmentSourceStateSchema} from './schema.js';
import type {
	ClalSessionState,
	InvestmentFailure,
	InvestmentFeed,
	InvestmentImportSummary,
	InvestmentProduct,
	InvestmentSnapshot,
	InvestmentSourceState,
	InvestmentStore,
} from './types.js';

const recordKinds = ['products', 'valuations', 'activities', 'tracks'] as const;
type RecordKind = typeof recordKinds[number];
type InvestmentRecord = InvestmentSnapshot[RecordKind][number];

function initialState(): InvestmentSourceState {
	return {
		provider: 'clal', status: 'never_synced', lastAttemptAt: null, lastSuccessAt: null,
		staleAfterHours: 168, errorCode: null, inventoryComplete: false,
	};
}

function validateRelations(snapshot: InvestmentSnapshot): void {
	const products = new Map(snapshot.products.map(product => [product.id, product]));
	for (const kind of recordKinds) {
		const identifiers = snapshot[kind].map(row => row.id);
		if (new Set(identifiers).size !== identifiers.length) {
			throw new Error(`Duplicate investment ${kind} identities`);
		}
	}

	for (const product of snapshot.products) {
		if (product.id !== investmentProductId(product.providerProductId)) {
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
		if (row.id !== investmentValuationId(row.productId, row.asOf)) {
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
}

/** Observation time is freshness metadata; it does not create a financial revision. */
function financialContent(row: InvestmentRecord): string {
	return JSON.stringify({...row, observedAt: undefined});
}

/** Separate database: investment writes cannot mutate bank accounts or their source freshness. */
export function createInvestmentStore(filename: string): InvestmentStore {
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
		INSERT OR IGNORE INTO investment_meta (key, value) VALUES ('schema_version', '1');
	`);

	const readState = (): InvestmentSourceState => {
		const row = db.prepare('SELECT value FROM investment_meta WHERE key = ?').get('source_state');
		return row ? investmentSourceStateSchema.parse(JSON.parse(String(row.value))) : initialState();
	};

	const writeState = (state: InvestmentSourceState): void => {
		const validated = investmentSourceStateSchema.parse(state);
		db.prepare('INSERT OR REPLACE INTO investment_meta (key, value) VALUES (?, ?)').run('source_state', JSON.stringify(validated));
	};

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
				const product = row as InvestmentProduct;
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

	return {
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
			if (!snapshot.complete || !snapshot.inventoryComplete) {
				recordFailure({status: 'partial', attemptedAt: snapshot.observedAt, errorCode: 'INCOMPLETE_RESPONSE'});
				return {applied: false, inserted: 0, updated: 0, unchanged: 0};
			}

			validateRelations(snapshot);
			const summary = {applied: true, inserted: 0, updated: 0, unchanged: 0};
			db.exec('BEGIN IMMEDIATE');
			try {
				const state = readState();
				if (state.lastSuccessAt && snapshot.observedAt < state.lastSuccessAt) {
					throw new Error('Investment observation predates the last successful collection');
				}

				for (const kind of recordKinds) {
					for (const row of snapshot[kind]) {
						summary[upsertRecord(kind, row, snapshot.observedAt)]++;
					}
				}

				writeState({
					...readState(), status: 'ok', lastAttemptAt: snapshot.observedAt,
					lastSuccessAt: snapshot.observedAt, errorCode: null, inventoryComplete: true,
				});
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
