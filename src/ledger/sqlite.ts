/**
 * `Ledger` on `node:sqlite` (DatabaseSync). Semantics mirror src/ledger/memory.ts exactly:
 * freeze rules, anomaly reporting, ordering. All SQL lives in this file; nothing outside
 * src/ledger/ touches SQLite.
 */

import {DatabaseSync, type StatementSync, type SQLInputValue, type SQLOutputValue} from 'node:sqlite';
import {
	ID_SCHEME_VERSION,
	type Anomaly,
	type CompanyId,
	type Consumer,
	type DuplicateGroup,
	type IsoDate,
	type Ledger,
	type LedgerAccount,
	type LedgerHolding,
	type LedgerTransaction,
	type RunRecord,
	type SourceState,
	type SyntheticPayment,
	type TransactionQuery,
	type UpsertSummary,
} from '../types.js';

const META_SCHEMA_VERSION = 'schema_version';
const META_ID_SCHEME_VERSION = 'id_scheme_version';

/** Ordered list of migrations; index + 1 is the schema version they produce. */
const migrations: string[] = [
	`
	CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
	CREATE TABLE IF NOT EXISTS source_states (company TEXT PRIMARY KEY, json TEXT NOT NULL);
	CREATE TABLE IF NOT EXISTS runs (
		id TEXT PRIMARY KEY,
		company TEXT NOT NULL,
		started_at TEXT NOT NULL,
		finished_at TEXT NOT NULL,
		status TEXT NOT NULL,
		error_type TEXT,
		message TEXT,
		accounts_seen INTEGER NOT NULL,
		transactions_seen INTEGER NOT NULL,
		transactions_new INTEGER NOT NULL,
		anomalies INTEGER NOT NULL
	);
	CREATE INDEX IF NOT EXISTS runs_company_started ON runs (company, started_at);
	CREATE TABLE IF NOT EXISTS accounts (
		id TEXT PRIMARY KEY,
		company TEXT NOT NULL,
		account_number TEXT NOT NULL,
		kind TEXT NOT NULL,
		currency TEXT NOT NULL,
		name TEXT NOT NULL,
		balance REAL,
		balance_at TEXT,
		first_seen TEXT NOT NULL,
		last_seen TEXT NOT NULL,
		raw TEXT
	);
	CREATE TABLE IF NOT EXISTS transactions (
		id TEXT PRIMARY KEY,
		account_id TEXT NOT NULL,
		company TEXT NOT NULL,
		identifier TEXT,
		booked_date TEXT NOT NULL,
		charge_date TEXT,
		amount REAL NOT NULL,
		currency TEXT NOT NULL,
		description TEXT NOT NULL,
		memo TEXT,
		status TEXT NOT NULL,
		installment_number INTEGER,
		installment_total INTEGER,
		original_amount REAL,
		original_currency TEXT,
		category TEXT,
		synthetic INTEGER NOT NULL DEFAULT 0,
		first_seen TEXT NOT NULL,
		last_seen TEXT NOT NULL,
		id_scheme_version INTEGER NOT NULL,
		raw TEXT
	);
	CREATE INDEX IF NOT EXISTS transactions_account_booked ON transactions (account_id, booked_date);
	CREATE INDEX IF NOT EXISTS transactions_dedup ON transactions (account_id, booked_date, amount, description);
	CREATE TABLE IF NOT EXISTS holdings (
		id TEXT PRIMARY KEY,
		account_id TEXT NOT NULL,
		symbol TEXT,
		description TEXT NOT NULL,
		market_value REAL NOT NULL,
		shares REAL,
		purchase_price REAL,
		cost_basis REAL,
		currency TEXT NOT NULL,
		first_seen TEXT NOT NULL,
		last_seen TEXT NOT NULL,
		raw TEXT
	);
	CREATE INDEX IF NOT EXISTS holdings_account ON holdings (account_id);
	CREATE TABLE IF NOT EXISTS synthetic_payments (
		transaction_id TEXT PRIMARY KEY,
		account_id TEXT NOT NULL,
		charge_date TEXT NOT NULL,
		amount REAL NOT NULL,
		emitted_at TEXT NOT NULL
	);
	CREATE INDEX IF NOT EXISTS synthetic_payments_account ON synthetic_payments (account_id, charge_date);
	CREATE TABLE IF NOT EXISTS consumers (
		id TEXT PRIMARY KEY,
		label TEXT NOT NULL,
		basic_user TEXT NOT NULL UNIQUE,
		secret_hash TEXT NOT NULL,
		secret_plain TEXT,
		claim_id TEXT UNIQUE,
		claim_expires_at TEXT,
		claim_count INTEGER NOT NULL DEFAULT 0,
		max_claims INTEGER NOT NULL,
		claimed_at TEXT,
		first_authenticated_at TEXT,
		last_seen_at TEXT,
		created_at TEXT NOT NULL,
		revoked_at TEXT
	);
	CREATE TABLE IF NOT EXISTS anomalies (
		transaction_id TEXT NOT NULL,
		field TEXT NOT NULL,
		previous TEXT NOT NULL,
		incoming TEXT NOT NULL,
		seen_at TEXT NOT NULL
	);
	CREATE INDEX IF NOT EXISTS anomalies_transaction ON anomalies (transaction_id);
	`,
	'ALTER TABLE transactions ADD COLUMN posted_seen_at TEXT;',
];

type Row = Record<string, SQLOutputValue>;

const toJson = (value: unknown): string => JSON.stringify(value ?? null);
/** A column value as returned by node:sqlite (`undefined` only when the column is absent from the row). */
type Column = SQLOutputValue | undefined;

/** Parse a JSON column; SQL NULL and JSON null both come back as undefined. */
const fromJson = (value: Column): unknown => (typeof value === 'string' ? (JSON.parse(value) as unknown) ?? undefined : undefined);
/** Bind an optional field as SQL NULL when absent. */
const orNull = (value: string | number | undefined): SQLInputValue => value ?? null;
/** TEXT column -> string (undefined for NULL). */
const optionalText = (value: Column): string | undefined => (typeof value === 'string' ? value : undefined);
/** NOT NULL TEXT column -> string. */
const columnText = (value: Column): string => optionalText(value) ?? '';
/** REAL/INTEGER column -> number (undefined for NULL). */
function optionalNumber(value: Column): number | undefined {
	if (typeof value === 'number') {
		return value;
	}

	return typeof value === 'bigint' ? Number(value) : undefined;
}

/** NOT NULL numeric column -> number. */
const columnNumber = (value: Column): number => optionalNumber(value) ?? 0;

function accountFromRow(row: Row): LedgerAccount {
	return {
		id: columnText(row.id),
		company: columnText(row.company) as CompanyId,
		accountNumber: columnText(row.account_number),
		kind: columnText(row.kind) as LedgerAccount['kind'],
		currency: columnText(row.currency),
		name: columnText(row.name),
		balance: optionalNumber(row.balance),
		balanceAt: optionalText(row.balance_at),
		firstSeen: columnText(row.first_seen),
		lastSeen: columnText(row.last_seen),
		raw: fromJson(row.raw),
	};
}

function transactionFromRow(row: Row): LedgerTransaction {
	return {
		id: columnText(row.id),
		accountId: columnText(row.account_id),
		company: columnText(row.company) as CompanyId,
		identifier: optionalText(row.identifier),
		bookedDate: columnText(row.booked_date),
		chargeDate: optionalText(row.charge_date),
		amount: columnNumber(row.amount),
		currency: columnText(row.currency),
		description: columnText(row.description),
		memo: optionalText(row.memo),
		status: columnText(row.status) as LedgerTransaction['status'],
		postedSeenAt: optionalText(row.posted_seen_at),
		installmentNumber: optionalNumber(row.installment_number),
		installmentTotal: optionalNumber(row.installment_total),
		originalAmount: optionalNumber(row.original_amount),
		originalCurrency: optionalText(row.original_currency),
		category: optionalText(row.category),
		synthetic: columnNumber(row.synthetic) === 1,
		firstSeen: columnText(row.first_seen),
		lastSeen: columnText(row.last_seen),
		idSchemeVersion: columnNumber(row.id_scheme_version),
		raw: fromJson(row.raw),
	};
}

function holdingFromRow(row: Row): LedgerHolding {
	return {
		id: columnText(row.id),
		accountId: columnText(row.account_id),
		symbol: optionalText(row.symbol),
		description: columnText(row.description),
		marketValue: columnNumber(row.market_value),
		shares: optionalNumber(row.shares),
		purchasePrice: optionalNumber(row.purchase_price),
		costBasis: optionalNumber(row.cost_basis),
		currency: columnText(row.currency),
		firstSeen: columnText(row.first_seen),
		lastSeen: columnText(row.last_seen),
		raw: fromJson(row.raw),
	};
}

function runFromRow(row: Row): RunRecord {
	return {
		id: columnText(row.id),
		company: columnText(row.company) as CompanyId,
		startedAt: columnText(row.started_at),
		finishedAt: columnText(row.finished_at),
		status: columnText(row.status) as RunRecord['status'],
		errorType: optionalText(row.error_type) as RunRecord['errorType'],
		message: optionalText(row.message),
		accountsSeen: columnNumber(row.accounts_seen),
		transactionsSeen: columnNumber(row.transactions_seen),
		transactionsNew: columnNumber(row.transactions_new),
		anomalies: columnNumber(row.anomalies),
	};
}

function consumerFromRow(row: Row): Consumer {
	return {
		id: columnText(row.id),
		label: columnText(row.label),
		basicUser: columnText(row.basic_user),
		secretHash: columnText(row.secret_hash),
		secretPlain: optionalText(row.secret_plain),
		claimId: optionalText(row.claim_id),
		claimExpiresAt: optionalText(row.claim_expires_at),
		claimCount: columnNumber(row.claim_count),
		maxClaims: columnNumber(row.max_claims),
		claimedAt: optionalText(row.claimed_at),
		firstAuthenticatedAt: optionalText(row.first_authenticated_at),
		lastSeenAt: optionalText(row.last_seen_at),
		createdAt: columnText(row.created_at),
		revokedAt: optionalText(row.revoked_at),
	};
}

function anomalyFromRow(row: Row): Anomaly {
	return {
		transactionId: columnText(row.transaction_id),
		field: columnText(row.field) as Anomaly['field'],
		previous: columnText(row.previous),
		incoming: columnText(row.incoming),
		seenAt: columnText(row.seen_at),
	};
}

function syntheticPaymentFromRow(row: Row): SyntheticPayment {
	return {
		transactionId: columnText(row.transaction_id),
		accountId: columnText(row.account_id),
		chargeDate: columnText(row.charge_date),
		amount: columnNumber(row.amount),
		emittedAt: columnText(row.emitted_at),
	};
}

/** Thin wrapper: prepared-statement cache, transactions, migrations. */
class Store {
	private readonly statements = new Map<string, StatementSync>();

	constructor(readonly db: DatabaseSync) {}

	statement(sql: string): StatementSync {
		let prepared = this.statements.get(sql);
		if (!prepared) {
			prepared = this.db.prepare(sql);
			this.statements.set(sql, prepared);
		}

		return prepared;
	}

	run(sql: string, ...parameters: SQLInputValue[]): void {
		this.statement(sql).run(...parameters);
	}

	get(sql: string, ...parameters: SQLInputValue[]): Row | undefined {
		return this.statement(sql).get(...parameters);
	}

	all(sql: string, ...parameters: SQLInputValue[]): Row[] {
		return this.statement(sql).all(...parameters);
	}

	transaction<T>(work: () => T): T {
		this.db.exec('BEGIN IMMEDIATE');
		try {
			const result = work();
			this.db.exec('COMMIT');
			return result;
		} catch (error) {
			this.db.exec('ROLLBACK');
			throw error;
		}
	}

	getMeta(key: string): string | undefined {
		const row = this.get('SELECT value FROM meta WHERE key = ?', key);
		return row ? optionalText(row.value) : undefined;
	}

	setMeta(key: string, value: string): void {
		this.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
	}

	migrate(): void {
		this.db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
		const current = Number(this.getMeta(META_SCHEMA_VERSION) ?? 0);
		if (current > migrations.length) {
			throw new Error(`Ledger schema version ${current} is newer than this build supports (${migrations.length})`);
		}

		for (let version = current + 1; version <= migrations.length; version++) {
			this.transaction(() => {
				this.db.exec(migrations[version - 1]!);
				this.setMeta(META_SCHEMA_VERSION, String(version));
			});
		}
	}
}

function openStore(path: string): Store {
	const db = new DatabaseSync(path);
	db.exec('PRAGMA journal_mode = WAL');
	db.exec('PRAGMA foreign_keys = ON');
	db.exec('PRAGMA busy_timeout = 5000');
	const store = new Store(db);
	try {
		store.migrate();
		assertIdScheme(store, path);
	} catch (error) {
		db.close();
		throw error;
	}

	return store;
}

/** Refuse a ledger written with a different id scheme; otherwise stamp ours. */
function assertIdScheme(store: Store, path: string): void {
	const stored = store.getMeta(META_ID_SCHEME_VERSION);
	if (stored !== undefined && Number(stored) !== ID_SCHEME_VERSION) {
		throw new Error(`Ledger ${path} was written with transaction id scheme version ${stored}, but this build uses version ${ID_SCHEME_VERSION}. `
			+ 'Serving it would duplicate every transaction in consumers. Start from a fresh ledger or run the matching bridge version.');
	}

	if (stored === undefined) {
		store.setMeta(META_ID_SCHEME_VERSION, String(ID_SCHEME_VERSION));
	}
}

const insertTransactionSql = `
	INSERT INTO transactions (
		id, account_id, company, identifier, booked_date, charge_date, amount, currency, description, memo, status,
		installment_number, installment_total, original_amount, original_currency, category, synthetic,
		first_seen, last_seen, id_scheme_version, raw, posted_seen_at
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const refreshTransactionSql = `
	UPDATE transactions SET status = ?, charge_date = ?, category = ?, memo = ?, raw = ?, last_seen = ?, posted_seen_at = ? WHERE id = ?`;

const insertAnomalySql = 'INSERT INTO anomalies (transaction_id, field, previous, incoming, seen_at) VALUES (?, ?, ?, ?, ?)';

function insertTransaction(store: Store, row: LedgerTransaction): void {
	store.run(
		insertTransactionSql,
		row.id,
		row.accountId,
		row.company,
		orNull(row.identifier),
		row.bookedDate,
		orNull(row.chargeDate),
		row.amount,
		row.currency,
		row.description,
		orNull(row.memo),
		row.status,
		orNull(row.installmentNumber),
		orNull(row.installmentTotal),
		orNull(row.originalAmount),
		orNull(row.originalCurrency),
		orNull(row.category),
		row.synthetic ? 1 : 0,
		row.firstSeen,
		row.lastSeen,
		row.idSchemeVersion,
		toJson(row.raw),
		orNull(row.postedSeenAt),
	);
}

/** Frozen-field comparison; returns the anomalies (never applies the incoming values). */
function frozenFieldAnomalies(existing: LedgerTransaction, incoming: LedgerTransaction): Anomaly[] {
	const frozen: Array<[Anomaly['field'], string, string]> = [
		['amount', existing.amount.toFixed(2), incoming.amount.toFixed(2)],
		['bookedDate', existing.bookedDate, incoming.bookedDate],
		['description', existing.description, incoming.description],
	];
	return frozen
		.filter(([, previous, current]) => previous !== current)
		.map(([field, previous, current]) => ({transactionId: incoming.id, field, previous, incoming: current, seenAt: incoming.lastSeen}));
}

/** Apply the refreshable fields of `incoming` onto `existing`; returns whether anything user-visible changed. */
function refreshTransaction(store: Store, existing: LedgerTransaction, incoming: LedgerTransaction): boolean {
	const status = existing.status === 'pending' && incoming.status === 'posted' ? 'posted' : existing.status;
	const changed = status !== existing.status
		|| existing.chargeDate !== incoming.chargeDate
		|| existing.category !== incoming.category
		|| existing.memo !== incoming.memo;
	store.run(
		refreshTransactionSql,
		status,
		orNull(incoming.chargeDate ?? existing.chargeDate),
		orNull(incoming.category ?? existing.category),
		orNull(incoming.memo ?? existing.memo),
		toJson(incoming.raw),
		incoming.lastSeen,
		orNull(existing.postedSeenAt ?? (status === existing.status ? undefined : incoming.lastSeen)),
		existing.id,
	);
	return changed;
}

function upsertTransactions(store: Store, rows: LedgerTransaction[]): UpsertSummary {
	const summary: UpsertSummary = {inserted: 0, updated: 0, unchanged: 0, anomalies: []};
	store.transaction(() => {
		for (const row of rows) {
			const existingRow = store.get('SELECT * FROM transactions WHERE id = ?', row.id);
			if (!existingRow) {
				insertTransaction(store, row);
				summary.inserted++;
				continue;
			}

			const existing = transactionFromRow(existingRow);
			summary.anomalies.push(...frozenFieldAnomalies(existing, row));
			if (refreshTransaction(store, existing, row)) {
				summary.updated++;
			} else {
				summary.unchanged++;
			}
		}

		for (const anomaly of summary.anomalies) {
			store.run(insertAnomalySql, anomaly.transactionId, anomaly.field, anomaly.previous, anomaly.incoming, anomaly.seenAt);
		}
	});
	return summary;
}

function listTransactions(store: Store, query: TransactionQuery): LedgerTransaction[] {
	const clauses: string[] = [];
	const parameters: SQLInputValue[] = [];
	if (query.accountIds) {
		if (query.accountIds.length === 0) {
			return [];
		}

		clauses.push(`account_id IN (${query.accountIds.map(() => '?').join(', ')})`);
		parameters.push(...query.accountIds);
	}

	if (query.from) {
		clauses.push('booked_date >= ?');
		parameters.push(query.from);
	}

	if (query.to) {
		clauses.push('booked_date < ?');
		parameters.push(query.to);
	}

	if (!query.includePending) {
		clauses.push('status <> \'pending\'');
	}

	if (!query.includeSynthetic) {
		clauses.push('synthetic = 0');
	}

	const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
	return store.all(`SELECT * FROM transactions${where} ORDER BY booked_date, id`, ...parameters).map(row => transactionFromRow(row));
}

const duplicatesSql = `
	SELECT account_id, booked_date, amount, description, id FROM transactions
	WHERE (account_id, booked_date, printf('%.2f', amount), description) IN (
		SELECT account_id, booked_date, printf('%.2f', amount), description FROM transactions
		GROUP BY account_id, booked_date, printf('%.2f', amount), description HAVING count(*) > 1
	)
	ORDER BY account_id, booked_date, rowid`;

function findDuplicates(store: Store): DuplicateGroup[] {
	const groups = new Map<string, DuplicateGroup>();
	for (const row of store.all(duplicatesSql)) {
		const amount = columnNumber(row.amount);
		const key = [columnText(row.account_id), columnText(row.booked_date), amount.toFixed(2), columnText(row.description)].join(' ');
		const group = groups.get(key) ?? {
			accountId: columnText(row.account_id),
			bookedDate: columnText(row.booked_date),
			amount,
			description: columnText(row.description),
			transactionIds: [],
		};
		group.transactionIds.push(columnText(row.id));
		groups.set(key, group);
	}

	return [...groups.values()];
}

const upsertAccountSql = `
	INSERT INTO accounts (id, company, account_number, kind, currency, name, balance, balance_at, first_seen, last_seen, raw)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(id) DO UPDATE SET
		company = excluded.company, account_number = excluded.account_number, kind = excluded.kind,
		currency = excluded.currency, name = excluded.name, balance = excluded.balance, balance_at = excluded.balance_at,
		last_seen = excluded.last_seen, raw = excluded.raw`;

const upsertHoldingSql = `
	INSERT INTO holdings (id, account_id, symbol, description, market_value, shares, purchase_price, cost_basis, currency, first_seen, last_seen, raw)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(id) DO UPDATE SET
		account_id = excluded.account_id, symbol = excluded.symbol, description = excluded.description,
		market_value = excluded.market_value, shares = excluded.shares, purchase_price = excluded.purchase_price,
		cost_basis = excluded.cost_basis, currency = excluded.currency, last_seen = excluded.last_seen, raw = excluded.raw`;

const consumerColumns = [
	'id',
	'label',
	'basic_user',
	'secret_hash',
	'secret_plain',
	'claim_id',
	'claim_expires_at',
	'claim_count',
	'max_claims',
	'claimed_at',
	'first_authenticated_at',
	'last_seen_at',
	'created_at',
	'revoked_at',
];

const insertConsumerSql = `INSERT INTO consumers (${consumerColumns.join(', ')}) VALUES (${consumerColumns.map(() => '?').join(', ')})`;

const updateConsumerSql = `${insertConsumerSql} ON CONFLICT(id) DO UPDATE SET ${
	consumerColumns.filter(column => column !== 'id').map(column => `${column} = excluded.${column}`).join(', ')}`;

function consumerParameters(consumer: Consumer): SQLInputValue[] {
	return [
		consumer.id,
		consumer.label,
		consumer.basicUser,
		consumer.secretHash,
		orNull(consumer.secretPlain),
		orNull(consumer.claimId),
		orNull(consumer.claimExpiresAt),
		consumer.claimCount,
		consumer.maxClaims,
		orNull(consumer.claimedAt),
		orNull(consumer.firstAuthenticatedAt),
		orNull(consumer.lastSeenAt),
		consumer.createdAt,
		orNull(consumer.revokedAt),
	];
}

const insertRunSql = `
	INSERT INTO runs (id, company, started_at, finished_at, status, error_type, message, accounts_seen, transactions_seen, transactions_new, anomalies)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(id) DO UPDATE SET
		company = excluded.company, started_at = excluded.started_at, finished_at = excluded.finished_at, status = excluded.status,
		error_type = excluded.error_type, message = excluded.message, accounts_seen = excluded.accounts_seen,
		transactions_seen = excluded.transactions_seen, transactions_new = excluded.transactions_new, anomalies = excluded.anomalies`;

/**
 * Open (or create) the SQLite ledger at `path` (`':memory:'` for tests), run migrations and
 * verify the id scheme version. Throws when the ledger was written with another scheme.
 */
export function createSqliteLedger(path: string): Ledger {
	const store = openStore(path);
	return {
		getSourceState(company) {
			const row = store.get('SELECT json FROM source_states WHERE company = ?', company);
			return row ? fromJson(row.json) as SourceState : undefined;
		},
		upsertSourceState(state) {
			store.run(
				'INSERT INTO source_states (company, json) VALUES (?, ?) ON CONFLICT(company) DO UPDATE SET json = excluded.json',
				state.company,
				toJson(state),
			);
		},
		listSourceStates: () => store.all('SELECT json FROM source_states ORDER BY company').map(row => fromJson(row.json) as SourceState),
		recordRun(run) {
			store.run(
				insertRunSql,
				run.id,
				run.company,
				run.startedAt,
				run.finishedAt,
				run.status,
				orNull(run.errorType),
				orNull(run.message),
				run.accountsSeen,
				run.transactionsSeen,
				run.transactionsNew,
				run.anomalies,
			);
		},
		listRuns(options) {
			const company = options?.company ?? null;
			return store
				.all('SELECT * FROM runs WHERE (? IS NULL OR company = ?) ORDER BY started_at DESC, rowid DESC LIMIT ?', company, company, options?.limit ?? 100)
				.map(row => runFromRow(row));
		},

		upsertAccount(account) {
			store.run(
				upsertAccountSql,
				account.id,
				account.company,
				account.accountNumber,
				account.kind,
				account.currency,
				account.name,
				orNull(account.balance),
				orNull(account.balanceAt),
				account.firstSeen,
				account.lastSeen,
				toJson(account.raw),
			);
		},
		getAccount(id) {
			const row = store.get('SELECT * FROM accounts WHERE id = ?', id);
			return row ? accountFromRow(row) : undefined;
		},
		listAccounts(options) {
			const company = options?.company ?? null;
			return store.all('SELECT * FROM accounts WHERE (? IS NULL OR company = ?) ORDER BY id', company, company).map(row => accountFromRow(row));
		},

		upsertTransactions: rows => upsertTransactions(store, rows),
		getTransaction(id) {
			const row = store.get('SELECT * FROM transactions WHERE id = ?', id);
			return row ? transactionFromRow(row) : undefined;
		},
		listTransactions: query => listTransactions(store, query),
		findDuplicates: () => findDuplicates(store),
		earliestBookedDate(accountId): IsoDate | undefined {
			const row = store.get('SELECT min(booked_date) AS earliest FROM transactions WHERE account_id = ? AND synthetic = 0', accountId);
			return row ? optionalText(row.earliest) : undefined;
		},

		upsertHoldings(rows) {
			store.transaction(() => {
				for (const row of rows) {
					store.run(
						upsertHoldingSql,
						row.id,
						row.accountId,
						orNull(row.symbol),
						row.description,
						row.marketValue,
						orNull(row.shares),
						orNull(row.purchasePrice),
						orNull(row.costBasis),
						row.currency,
						row.firstSeen,
						row.lastSeen,
						toJson(row.raw),
					);
				}
			});
		},
		listHoldings(accountId) {
			return store
				.all('SELECT * FROM holdings WHERE (? IS NULL OR account_id = ?) ORDER BY rowid', accountId ?? null, accountId ?? null)
				.map(row => holdingFromRow(row));
		},

		listSyntheticPayments: accountId => store
			.all('SELECT * FROM synthetic_payments WHERE account_id = ? ORDER BY rowid', accountId)
			.map(row => syntheticPaymentFromRow(row)),
		insertSyntheticPayment(payment) {
			store.run(
				'INSERT INTO synthetic_payments (transaction_id, account_id, charge_date, amount, emitted_at) VALUES (?, ?, ?, ?, ?)',
				payment.transactionId,
				payment.accountId,
				payment.chargeDate,
				payment.amount,
				payment.emittedAt,
			);
		},

		createConsumer(consumer) {
			if (store.get('SELECT 1 FROM consumers WHERE id = ?', consumer.id)) {
				throw new Error(`Consumer ${consumer.id} already exists`);
			}

			store.run(insertConsumerSql, ...consumerParameters(consumer));
		},
		updateConsumer(consumer) {
			store.run(updateConsumerSql, ...consumerParameters(consumer));
		},
		getConsumer(id) {
			const row = store.get('SELECT * FROM consumers WHERE id = ?', id);
			return row ? consumerFromRow(row) : undefined;
		},
		getConsumerByClaimId(claimId) {
			const row = store.get('SELECT * FROM consumers WHERE claim_id = ?', claimId);
			return row ? consumerFromRow(row) : undefined;
		},
		getConsumerByBasicUser(basicUser) {
			const row = store.get('SELECT * FROM consumers WHERE basic_user = ?', basicUser);
			return row ? consumerFromRow(row) : undefined;
		},
		listConsumers: () => store.all('SELECT * FROM consumers ORDER BY rowid').map(row => consumerFromRow(row)),

		recordAnomalies(items) {
			store.transaction(() => {
				for (const anomaly of items) {
					store.run(insertAnomalySql, anomaly.transactionId, anomaly.field, anomaly.previous, anomaly.incoming, anomaly.seenAt);
				}
			});
		},
		listAnomalies(options) {
			return store
				.all('SELECT * FROM (SELECT rowid AS row_id, * FROM anomalies ORDER BY rowid DESC LIMIT ?) ORDER BY row_id', options?.limit ?? 100)
				.map(row => anomalyFromRow(row));
		},

		getMeta: key => store.getMeta(key),
		setMeta(key, value) {
			store.setMeta(key, value);
		},
		close() {
			store.db.close();
		},
	};
}
