/**
 * Shared contracts for israeli-banks-simplefin-bridge.
 *
 * Every module codes against these types. Keep this file dependency-free
 * (types only) so it can be imported from tests, the CLI and the server alike.
 */

import type {CompanyTypes} from 'israeli-bank-scrapers';
import type {BestInvestConfig, HapoalimInvestmentsConfig, InvestmentConfig} from './investments/config.js';
import type {InvestmentStore} from './investments/types.js';

export type CompanyId = `${CompanyTypes}`;

/** How Securo/Actual should think about the account. Securo types every SimpleFIN account "checking" and the operator retypes cards once in the UI; we still carry the hint in `extra.kind`. */
export type AccountKind = 'checking' | 'credit_card' | 'savings' | 'investment';

export type TransactionStatus = 'pending' | 'posted';

/** ISO calendar date `YYYY-MM-DD` in the bridge timezone (Asia/Jerusalem by default). */
export type IsoDate = string;

/** ISO-8601 timestamp with timezone (`toISOString()`). */
export type IsoDateTime = string;

/** Version of the transaction-id scheme. Changing the scheme silently duplicates history in every consumer, so it is recorded in the ledger and refused on mismatch. */
export const ID_SCHEME_VERSION = 1;

// ---------------------------------------------------------------------------
// Configuration (validated by src/config.ts)
// ---------------------------------------------------------------------------

export type CompanyConfig = {
	/** Default true. Disabled companies are never scraped and never served. */
	enabled: boolean;
	/** Human label used for SimpleFIN `connections[].name`, account names and logs. */
	label: string;
	/** Default kind for every account of this company. */
	kind: AccountKind;
	/**
	 * Credential fields exactly as israeli-bank-scrapers expects them for this company
	 * (userCode/password, username/password, id/card6Digits/password, ...).
	 * Values may be literal strings or `op://<vault>/<item>/<field>` references
	 * resolved through 1Password Connect at run time.
	 */
	credentials: Record<string, string>;
	/** Scraper `accountNumber` filter; default "all". */
	accounts: 'all' | string[];
	/** Lower bound for scraping, `YYYY-MM-DD`. Each scraper clamps to its own max lookback. */
	startDate?: IsoDate;
	/** israeli-bank-scrapers option; slower, more bot-detection exposure. Changing it can change identifiers for some banks. Default false. */
	additionalTransactionInformation: boolean;
	/** Emit pending rows to consumers. Default false (pending ids are unstable for several companies). */
	includePending: boolean;
	/** israeli-bank-scrapers option (credit cards). */
	futureMonthsToScrape?: number;
	/** Which date becomes the row's `posted` date: purchase/event date (`date`) or bank charge/billing date (`processedDate`). Default purchase. */
	dateMode: 'purchase' | 'charge';
	/** Credit cards only: day of month the bank account is debited for the bill. Documentation + synthetic payments. */
	chargeDay?: number;
	/** Credit cards only, opt-in: emit one synthetic positive "card payment" row per charge date so consumers can pair it with the bank-side debit. Default false. */
	synthesizePayments: boolean;
	/** Wall-clock limit for one scrape of this company, minutes. Default 20. */
	timeoutMinutes: number;
	/** Extra israeli-bank-scrapers options passed through verbatim (e.g. optInFeatures, viewportSize). */
	scraperOptions?: Record<string, unknown>;
};

export type ServerConfig = {
	/** Base URL consumers use to reach this bridge, no trailing slash. Default `http://israeli-banks-bridge:8080`. */
	publicUrl: string;
	/** Listen port. Default 8080. */
	port: number;
	/** Listen host. Default 0.0.0.0. */
	host: string;
	/** Setup tokens expire this many minutes after minting. Default 15. */
	claimTtlMinutes: number;
	/** Maximum setup-token claims within its TTL, including partially failed connection retries. Default 3. */
	maxClaims: number;
};

export type Config = {
	/** Cron expression for scheduled scrapes. Empty/undefined = one-shot mode when run via CLI. */
	schedule?: string;
	/** IANA timezone used for calendar dates. Default Asia/Jerusalem. */
	timezone: string;
	/** Default account currency when a scraper does not say. Default ILS. */
	currency: string;
	/** `/healthz` returns 503 when an enabled company has no successful scrape within this many hours. Default 30. */
	staleHours: number;
	/** Days re-scraped on every run to catch late postings (scrape window starts at lastSuccess - overlapDays). Default 30. */
	overlapDays: number;
	/** Max login attempts per company per calendar day (bank lockout guard). Default 2. */
	maxLoginAttemptsPerDay: number;
	companies: Partial<Record<CompanyId, CompanyConfig>>;
	/** Dedicated investment collection/feed; never exported as SimpleFIN accounts. */
	investments?: InvestmentConfig;
	bestInvest?: BestInvestConfig;
	hapoalimInvestments?: HapoalimInvestmentsConfig;
	server: ServerConfig;
};

/** Resolved process-level settings (env). */
export type RuntimeEnv = {
	configPath: string;
	dataDir: string;
	ledgerPath: string;
	chromeDir: string;
	screenshotsDir: string;
	opConnectHost?: string;
	opConnectTokenFile?: string;
	/** Set when 1Password resolution is disabled and config values are literal. */
	opDisabled: boolean;
	verbose: boolean;
	showBrowser: boolean;
	puppeteerExecutablePath?: string;
};

// ---------------------------------------------------------------------------
// Ledger rows
// ---------------------------------------------------------------------------

export type LedgerAccount = {
	/** `<company>:<accountNumber>` — becomes the consumer's account external id; STABLE forever. */
	id: string;
	company: CompanyId;
	accountNumber: string;
	kind: AccountKind;
	/** ISO-4217, 3 upper-case letters. */
	currency: string;
	/** Display name, e.g. "Bank Hapoalim ····7430". Overwritten by every scrape. */
	name: string;
	/** Signed balance in `currency`; checking = real balance, credit card = negative debt. Null when the scraper does not provide one. */
	balance: number | undefined;
	balanceAt: IsoDateTime | undefined;
	firstSeen: IsoDateTime;
	lastSeen: IsoDateTime;
	raw: unknown;
};

export type LedgerTransaction = {
	/** Bridge transaction id (see docs/architecture.md, "Id scheme"). STABLE; frozen at first sight. */
	id: string;
	accountId: string;
	company: CompanyId;
	/** Bank/card identifier as scraped, or undefined when missing/unusable. */
	identifier: string | undefined;
	/** Calendar date served as the row date (`posted`). Frozen at first sight. */
	bookedDate: IsoDate;
	/** Bank charge/billing date (`processedDate`), when known. */
	chargeDate: IsoDate | undefined;
	/** Signed amount in the account currency; negative = money out. Frozen at first sight. */
	amount: number;
	currency: string;
	/** Frozen at first sight. */
	description: string;
	memo: string | undefined;
	status: TransactionStatus;
	/** When an existing pending row first became posted; used to deliver late completions. */
	postedSeenAt?: IsoDateTime;
	installmentNumber: number | undefined;
	installmentTotal: number | undefined;
	originalAmount: number | undefined;
	originalCurrency: string | undefined;
	category: string | undefined;
	/** True for bridge-generated rows (synthetic card payments). */
	synthetic: boolean;
	firstSeen: IsoDateTime;
	lastSeen: IsoDateTime;
	idSchemeVersion: number;
	raw: unknown;
};

export type LedgerHolding = {
	/** `<accountId>:<symbol-or-name>`; STABLE. */
	id: string;
	accountId: string;
	symbol: string | undefined;
	description: string;
	marketValue: number;
	shares: number | undefined;
	purchasePrice: number | undefined;
	costBasis: number | undefined;
	currency: string;
	firstSeen: IsoDateTime;
	lastSeen: IsoDateTime;
	raw: unknown;
};

export type SyntheticPayment = {
	transactionId: string;
	accountId: string;
	chargeDate: IsoDate;
	/** Positive amount (credit on the card). Frozen once emitted. */
	amount: number;
	emittedAt: IsoDateTime;
};

/** A field that came back different from the frozen ledger value. Reported, never applied. */
export type Anomaly = {
	transactionId: string;
	field: 'amount' | 'bookedDate' | 'description';
	previous: string;
	incoming: string;
	seenAt: IsoDateTime;
};

export type UpsertSummary = {
	inserted: number;
	updated: number;
	unchanged: number;
	anomalies: Anomaly[];
};

export type DuplicateGroup = {
	accountId: string;
	bookedDate: IsoDate;
	amount: number;
	description: string;
	transactionIds: string[];
};

export type TransactionQuery = {
	accountIds?: string[];
	/** Inclusive lower bound on bookedDate. */
	from?: IsoDate;
	/** Exclusive upper bound on bookedDate. */
	to?: IsoDate;
	includePending: boolean;
	includeSynthetic: boolean;
};

// ---------------------------------------------------------------------------
// Scrape state
// ---------------------------------------------------------------------------

export type ScrapeErrorType =
	| 'INVALID_PASSWORD'
	| 'CHANGE_PASSWORD'
	| 'ACCOUNT_BLOCKED'
	| 'TIMEOUT'
	| 'GENERIC'
	| 'GENERAL_ERROR'
	| 'TWO_FACTOR_RETRIEVER_MISSING'
	| 'OTP_REQUIRED'
	| 'BRIDGE_ERROR';

export type SourceState = {
	company: CompanyId;
	lastRunAt: IsoDateTime | undefined;
	lastSuccessAt: IsoDateTime | undefined;
	lastErrorAt: IsoDateTime | undefined;
	lastErrorType: ScrapeErrorType | undefined;
	/** Sanitized, fixed per error type. Never bank page text. */
	lastErrorMessage: string | undefined;
	consecutiveFailures: number;
	/** Parked companies are not retried until their credential fingerprint changes or `bridge unpark`. */
	parked: boolean;
	parkedReason: string | undefined;
	parkedAt: IsoDateTime | undefined;
	/** sha256 of the resolved credential tuple; a change auto-unparks. */
	credentialFingerprint: string | undefined;
	/** Backoff: do not run before this time. */
	nextAllowedAt: IsoDateTime | undefined;
	/** Calendar date (bridge tz) and count of login attempts, for the per-day lockout guard. */
	loginAttemptsDate: IsoDate | undefined;
	loginAttempts: number;
	/** Earliest bookedDate ever scraped for this company; partial-cycle guard for synthetic payments. */
	earliestScrapedDate: IsoDate | undefined;
};

export type RunStatus = 'success' | 'login_failed' | 'timeout' | 'error' | 'skipped';

export type RunRecord = {
	id: string;
	company: CompanyId;
	startedAt: IsoDateTime;
	finishedAt: IsoDateTime;
	status: RunStatus;
	errorType: ScrapeErrorType | undefined;
	message: string | undefined;
	accountsSeen: number;
	transactionsSeen: number;
	transactionsNew: number;
	anomalies: number;
};

// ---------------------------------------------------------------------------
// Consumers (SimpleFIN clients such as Securo or Actual)
// ---------------------------------------------------------------------------

export type Consumer = {
	id: string;
	label: string;
	/** Basic-auth user name, `[A-Za-z0-9_-]+`. */
	basicUser: string;
	/** scrypt hash of the Basic-auth secret, encoded `scrypt$<saltB64>$<hashB64>`. */
	secretHash: string;
	/** Plain secret, retained only while the claim TTL and attempt limit allow a retry. */
	secretPlain: string | undefined;
	/** One-time claim id embedded in the setup token URL. */
	claimId: string | undefined;
	claimExpiresAt: IsoDateTime | undefined;
	claimCount: number;
	maxClaims: number;
	claimedAt: IsoDateTime | undefined;
	firstAuthenticatedAt: IsoDateTime | undefined;
	lastSeenAt: IsoDateTime | undefined;
	createdAt: IsoDateTime;
	revokedAt: IsoDateTime | undefined;
};

// ---------------------------------------------------------------------------
// Ledger interface (implemented by src/ledger/sqlite.ts; src/ledger/memory.ts is the test fake)
// ---------------------------------------------------------------------------

export type Ledger = {
	// Source state + runs
	getSourceState(company: CompanyId): SourceState | undefined;
	upsertSourceState(state: SourceState): void;
	listSourceStates(): SourceState[];
	recordRun(run: RunRecord): void;
	listRuns(options?: {company?: CompanyId; limit?: number}): RunRecord[];

	// Accounts
	/** Insert or update; keeps the existing `firstSeen`. */
	upsertAccount(account: LedgerAccount): void;
	getAccount(id: string): LedgerAccount | undefined;
	listAccounts(options?: {company?: CompanyId}): LedgerAccount[];

	// Transactions
	/**
	 * Freeze semantics: an existing row keeps its id, amount, bookedDate and description;
	 * only lastSeen, status (pending -> posted), chargeDate, category, memo and raw are refreshed.
	 * Differences in frozen fields are returned as anomalies and NOT applied.
	 */
	upsertTransactions(rows: LedgerTransaction[]): UpsertSummary;
	getTransaction(id: string): LedgerTransaction | undefined;
	listTransactions(query: TransactionQuery): LedgerTransaction[];
	/** Rows sharing (accountId, bookedDate, amount, description) under different ids. */
	findDuplicates(): DuplicateGroup[];
	/** Earliest bookedDate stored for the account, if any. */
	earliestBookedDate(accountId: string): IsoDate | undefined;

	// Holdings
	upsertHoldings(rows: LedgerHolding[]): void;
	listHoldings(accountId?: string): LedgerHolding[];

	// Synthetic card payments
	listSyntheticPayments(accountId: string): SyntheticPayment[];
	insertSyntheticPayment(payment: SyntheticPayment): void;

	// Consumers
	createConsumer(consumer: Consumer): void;
	updateConsumer(consumer: Consumer): void;
	getConsumer(id: string): Consumer | undefined;
	getConsumerByClaimId(claimId: string): Consumer | undefined;
	getConsumerByBasicUser(basicUser: string): Consumer | undefined;
	listConsumers(): Consumer[];

	// Anomalies (append-only log)
	recordAnomalies(anomalies: Anomaly[]): void;
	listAnomalies(options?: {limit?: number}): Anomaly[];

	// Misc
	getMeta(key: string): string | undefined;
	setMeta(key: string, value: string): void;
	close(): void;
};

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

export type SecretsResolver = {
	/** Resolve a literal or `op://` reference. Literal values are returned unchanged. */
	resolve(reference: string): Promise<string>;
	/** Resolve every value of the record. */
	resolveAll(values: Record<string, string>): Promise<Record<string, string>>;
};

// ---------------------------------------------------------------------------
// Sources (scrapers)
// ---------------------------------------------------------------------------

export type SourceFetchResult = {
	accounts: LedgerAccount[];
	transactions: LedgerTransaction[];
	holdings: LedgerHolding[];
	scrapedAt: IsoDateTime;
};

export type SourceRunContext = {
	company: CompanyId;
	config: CompanyConfig;
	/** Resolved credentials (never log). */
	credentials: Record<string, string>;
	/** Scrape window lower bound (already clamped by the scheduler). */
	startDate: Date;
	env: RuntimeEnv;
	timezone: string;
	defaultCurrency: string;
	/** Absolute Chrome profile directory for this company. */
	profileDir: string;
	/** Optional investment reads share the existing guarded Hapoalim login. */
	hapoalimInvestments?: {config: HapoalimInvestmentsConfig; store: InvestmentStore};
};

export type SourceRunOutcome =
	| {ok: true; result: SourceFetchResult}
	| {ok: false; errorType: ScrapeErrorType; message: string};

export type Source = {
	company: CompanyId;
	run(context: SourceRunContext): Promise<SourceRunOutcome>;
};

// ---------------------------------------------------------------------------
// SimpleFIN wire shapes (union of protocol v1 and v2 so one payload serves Securo and Actual)
// ---------------------------------------------------------------------------

export type SimpleFinOrg = {
	id: string;
	name: string;
	domain: string;
	url: string;
	'sfin-url': string;
};

export type SimpleFinConnection = {
	conn_id: string;
	name: string;
	org_id: string;
	org_url: string;
	sfin_url: string;
};

export type SimpleFinTransaction = {
	id: string;
	/** Epoch seconds at 12:00 UTC of the booked date; 0 while pending. */
	posted: number;
	transacted_at: number;
	/** Signed, two decimals, negative = money out. */
	amount: string;
	description: string;
	payee?: string;
	memo?: string;
	pending: boolean;
	currency?: string;
	extra?: Record<string, unknown>;
};

export type SimpleFinHolding = {
	id: string;
	market_value: string;
	description: string;
	symbol?: string;
	currency: string;
	shares?: string;
	purchase_price?: string;
	cost_basis?: string;
	created?: number;
};

export type SimpleFinAccount = {
	id: string;
	name: string;
	conn_id: string;
	org: SimpleFinOrg;
	currency: string;
	/** Exactly two decimals. */
	balance: string;
	'available-balance'?: string;
	'balance-date': number;
	transactions: SimpleFinTransaction[];
	holdings?: SimpleFinHolding[];
	extra?: Record<string, unknown>;
};

export type SimpleFinError = {
	code: string;
	msg: string;
	conn_id?: string;
	account_id?: string;
};

export type SimpleFinResponse = {
	errlist: SimpleFinError[];
	errors: string[];
	connections: SimpleFinConnection[];
	accounts: SimpleFinAccount[];
};

/** Query parameters consumers send to GET /simplefin/accounts. */
export type AccountsQuery = {
	version?: string;
	/** Epoch seconds, inclusive. */
	startDate?: number;
	/** Epoch seconds, exclusive. */
	endDate?: number;
	pending: boolean;
	balancesOnly: boolean;
	accountIds?: string[];
};

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export type CompanyHealth = {
	company: CompanyId;
	enabled: boolean;
	healthy: boolean;
	parked: boolean;
	lastSuccessAt: IsoDateTime | undefined;
	lastErrorType: ScrapeErrorType | undefined;
	staleHours: number;
	accounts: number;
};

export type HealthReport = {
	ok: boolean;
	checkedAt: IsoDateTime;
	companies: CompanyHealth[];
	consumers: Array<{label: string; lastSeenAt: IsoDateTime | undefined; claimed: boolean}>;
	idSchemeVersion: number;
};
