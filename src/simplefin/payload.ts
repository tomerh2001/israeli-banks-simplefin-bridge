/**
 * GET /simplefin/accounts: query parsing and payload building.
 *
 * The response is the UNION of SimpleFIN v1 and v2 shapes so one bridge serves
 * Securo (v2 reader: connections/errlist) and Actual Budget (v1 reader:
 * accounts[].org / errors). See docs/securo-simplefin-contract.md.
 *
 * Transactions are only returned when a window (`start-date` and/or `end-date`)
 * is given: Securo ignores transactions on its window-less account-list, holdings
 * and logo calls, so returning [] there keeps those calls small.
 *
 * Window membership deviates from the spec's posted-only rule in one way: a row is
 * in the window when its booked date OR the instant the bridge first saw it (or saw it posted) falls
 * inside it. Israeli issuers publish rows days or weeks late and Securo only ever
 * rewinds 14 days, so a late row would otherwise never reach the consumer. Both
 * consumers dedup by id, so a row appearing in two windows is harmless.
 */

import {createLogger, type Logger} from '../log.js';
import type {
	AccountsQuery,
	CompanyConfig,
	CompanyId,
	Config,
	IsoDate,
	Ledger,
	LedgerAccount,
	LedgerHolding,
	LedgerTransaction,
	SimpleFinAccount,
	SimpleFinConnection,
	SimpleFinError,
	SimpleFinHolding,
	SimpleFinOrg,
	SimpleFinResponse,
	SimpleFinTransaction,
	SourceState,
} from '../types.js';
import {orgDomain, orgFor} from './orgs.js';
import {calendarDateToPostedEpoch, toEpochSeconds, windowEndDate, windowStartDate} from './time.js';

const defaultLogger = createLogger('simplefin:payload');

/** Fixed, sanitized errlist messages. Scraper/bank text is never forwarded. */
export const ERROR_MESSAGES = {
	parked: 'This bank connection is paused on the bridge and needs operator attention.',
	stale: 'Bank data on the bridge is stale; the last successful refresh is older than expected.',
	balanceUnavailable: 'The bank did not report a balance for this account; 0.00 is shown.',
} as const;

const maxNameLength = 255;
const maxDescriptionLength = 500;

// ---------------------------------------------------------------------------
// Query parsing
// ---------------------------------------------------------------------------

/** 12:00 UTC of 9999-12-31, the last epoch whose window date is still a four-digit year; larger values are ignored. */
const maxEpochSeconds = 253_402_257_600;

function parseEpoch(value: string | undefined): number | undefined {
	if (value === undefined || value.trim() === '') {
		return undefined;
	}

	const number = Number(value);
	return Number.isFinite(number) && number >= 0 && number <= maxEpochSeconds ? Math.floor(number) : undefined;
}

function isTruthyFlag(value: string | undefined): boolean {
	return value !== undefined && ['1', 'true', 'yes'].includes(value.trim().toLowerCase());
}

/** Parse the `/accounts` query string. Unparseable dates are ignored, `account` may repeat. */
export function parseAccountsQuery(searchParameters: URLSearchParams): AccountsQuery {
	const get = (name: string) => searchParameters.get(name) ?? undefined;
	const accountIds = searchParameters.getAll('account').map(id => id.trim()).filter(Boolean);
	const version = get('version')?.trim();
	return {
		version: version || undefined,
		startDate: parseEpoch(get('start-date')),
		endDate: parseEpoch(get('end-date')),
		pending: isTruthyFlag(get('pending')),
		balancesOnly: isTruthyFlag(get('balances-only')),
		accountIds: accountIds.length > 0 ? accountIds : undefined,
	};
}

/** Calendar-date window (from inclusive, to exclusive) implied by the epoch bounds; undefined when no window was requested. */
export function windowDates(query: AccountsQuery): {from?: IsoDate; to?: IsoDate} | undefined {
	if (query.startDate === undefined && query.endDate === undefined) {
		return undefined;
	}

	return {
		from: query.startDate === undefined ? undefined : windowStartDate(query.startDate),
		to: query.endDate === undefined ? undefined : windowEndDate(query.endDate),
	};
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Signed decimal string with exactly two decimals; never `-0.00`. */
export function formatAmount(value: number): string {
	const fixed = value.toFixed(2);
	return fixed === '-0.00' ? '0.00' : fixed;
}

function formatOptionalNumber(value: number | undefined): string | undefined {
	return value === undefined || !Number.isFinite(value) ? undefined : String(value);
}

/** Exactly three ASCII letters, upper-cased; otherwise the fallback. */
export function normalizeCurrency(value: string | undefined, fallback: string): string {
	const trimmed = value?.trim().toUpperCase();
	return trimmed && /^[A-Z]{3}$/.test(trimmed) ? trimmed : fallback;
}

function truncate(value: string, max: number): string {
	const trimmed = value.trim();
	return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/** Drop undefined values so the JSON never contains `null` placeholders. */
function compact<T extends Record<string, unknown>>(object: T): T {
	return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined)) as T;
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

function sfinUrl(config: Config): string {
	return `${config.server.publicUrl}/simplefin`;
}

function connectionFor(company: CompanyId, companyConfig: CompanyConfig, config: Config): SimpleFinConnection {
	const org = orgFor(company);
	return {
		conn_id: company,
		name: truncate(companyConfig.label || org.name, maxNameLength),
		org_id: company,
		org_url: org.url,
		sfin_url: sfinUrl(config),
	};
}

function orgObjectFor(company: CompanyId, companyConfig: CompanyConfig, config: Config): SimpleFinOrg {
	const org = orgFor(company);
	return {
		id: company,
		name: truncate(companyConfig.label || org.name, maxNameLength),
		domain: orgDomain(org),
		url: org.url,
		'sfin-url': sfinUrl(config),
	};
}

/** Ledger transaction -> SimpleFIN transaction. */
export function toSimpleFinTransaction(row: LedgerTransaction, accountCurrency: string): SimpleFinTransaction {
	const pending = row.status === 'pending';
	const bookedEpoch = calendarDateToPostedEpoch(row.bookedDate);
	const description = truncate(row.description, maxDescriptionLength) || 'Transaction';
	const installment = row.installmentNumber === undefined
		? undefined
		: {number: row.installmentNumber, total: row.installmentTotal};
	return compact({
		id: row.id,
		posted: pending ? 0 : bookedEpoch,
		transacted_at: bookedEpoch,
		amount: formatAmount(row.amount),
		description,
		payee: description,
		memo: row.memo?.trim() || undefined,
		pending,
		currency: normalizeCurrency(row.currency, accountCurrency),
		extra: compact({
			identifier: row.identifier,
			charge_date: row.chargeDate,
			installment,
			original_amount: formatOptionalNumber(row.originalAmount),
			original_currency: row.originalCurrency,
			category: row.category,
			status: row.status,
			synthetic: row.synthetic ? true : undefined,
		}),
	});
}

/** Ledger holding -> SimpleFIN holding (Bridge extension read by Securo). */
export function toSimpleFinHolding(row: LedgerHolding, accountCurrency: string): SimpleFinHolding {
	return compact({
		id: row.id,
		market_value: formatAmount(row.marketValue),
		description: row.description || row.symbol || row.id,
		symbol: row.symbol,
		currency: normalizeCurrency(row.currency, accountCurrency),
		shares: formatOptionalNumber(row.shares),
		purchase_price: formatOptionalNumber(row.purchasePrice),
		cost_basis: formatOptionalNumber(row.costBasis),
	});
}

type AccountContext = {
	ledger: Ledger;
	config: Config;
	query: AccountsQuery;
	now: Date;
	errlist: SimpleFinError[];
	logger: Logger;
};

/** True when the bridge first saw the row, or first observed it posted, inside the epoch window. */
function firstSeenInWindow(row: LedgerTransaction, query: AccountsQuery): boolean {
	return [row.firstSeen, row.postedSeenAt].some(value => {
		const seen = value === undefined ? NaN : Date.parse(value) / 1000;
		return query.startDate !== undefined && seen >= query.startDate && (query.endDate === undefined || seen < query.endDate);
	});
}

/**
 * A pending row is current only while the latest scrape of its account still reported it:
 * rows of one scrape share `lastSeen` with the account, so anything older vanished at the
 * bank (voided hold, or re-identified when it posted) and must not be served forever.
 */
function isCurrentPending(row: LedgerTransaction, account: LedgerAccount): boolean {
	return row.status !== 'pending' || Date.parse(row.lastSeen) >= Date.parse(account.lastSeen);
}

function transactionsFor(account: LedgerAccount, currency: string, companyConfig: CompanyConfig, context: AccountContext): SimpleFinTransaction[] {
	const window = windowDates(context.query);
	if (context.query.balancesOnly || !window) {
		return [];
	}

	// The lower bound is applied here, not in the query, so late-arriving rows can qualify by firstSeen.
	const rows = context.ledger.listTransactions({
		accountIds: [account.id],
		to: window.to,
		includePending: context.query.pending && companyConfig.includePending,
		includeSynthetic: true,
	});
	return rows
		.filter(row => window.from === undefined || row.bookedDate >= window.from || firstSeenInWindow(row, context.query))
		.filter(row => isCurrentPending(row, account))
		.map(row => toSimpleFinTransaction(row, currency));
}

function toSimpleFinAccount(account: LedgerAccount, companyConfig: CompanyConfig, context: AccountContext): SimpleFinAccount {
	const currency = normalizeCurrency(account.currency, context.config.currency);
	if (account.balance === undefined) {
		context.errlist.push({code: 'act.balance_unavailable', msg: ERROR_MESSAGES.balanceUnavailable, account_id: account.id});
		context.logger.debug('balance unavailable', {account: account.id});
	}

	return compact({
		id: account.id,
		name: truncate(account.name, maxNameLength) || account.id,
		conn_id: account.company,
		org: orgObjectFor(account.company, companyConfig, context.config),
		currency,
		balance: formatAmount(account.balance ?? 0),
		'balance-date': toEpochSeconds(account.balanceAt ?? context.now),
		transactions: transactionsFor(account, currency, companyConfig, context),
		holdings: context.ledger.listHoldings(account.id).map(row => toSimpleFinHolding(row, currency)),
		extra: {kind: account.kind, company: account.company, accountNumber: account.accountNumber},
	});
}

// ---------------------------------------------------------------------------
// Company-level errors
// ---------------------------------------------------------------------------

function isStale(state: SourceState | undefined, config: Config, now: Date): boolean {
	if (!state?.lastSuccessAt) {
		return true;
	}

	return now.getTime() - Date.parse(state.lastSuccessAt) > config.staleHours * 3_600_000;
}

/** errlist entries for a company that is parked or whose data is stale. Never gen.auth/con.auth. */
function companyErrors(company: CompanyId, accounts: LedgerAccount[], context: AccountContext): SimpleFinError[] {
	const state = context.ledger.getSourceState(company);
	if (state?.parked) {
		return [{code: 'con.failed', msg: ERROR_MESSAGES.parked, conn_id: company}];
	}

	if (isStale(state, context.config, context.now)) {
		return accounts.map(account => ({code: 'act.failed', msg: ERROR_MESSAGES.stale, conn_id: company, account_id: account.id}));
	}

	return [];
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

/** Enabled companies from the config, in config order. */
function enabledCompanies(config: Config): Array<[CompanyId, CompanyConfig]> {
	return (Object.entries(config.companies) as Array<[CompanyId, CompanyConfig | undefined]>)
		.filter((entry): entry is [CompanyId, CompanyConfig] => entry[1]?.enabled === true);
}

/**
 * Build the `/accounts` payload. One connection per enabled company, even before its
 * first scrape (Securo names the connection after `connections[0]` at connect time and
 * never renames it); disabled or unknown companies are omitted entirely.
 */
export function buildAccountsResponse(ledger: Ledger, config: Config, query: AccountsQuery, now: Date, logger: Logger = defaultLogger): SimpleFinResponse {
	const context: AccountContext = {ledger, config, query, now, errlist: [], logger};
	const connections: SimpleFinConnection[] = [];
	const accounts: SimpleFinAccount[] = [];
	const wanted = query.accountIds ? new Set(query.accountIds) : undefined;

	for (const [company, companyConfig] of enabledCompanies(config)) {
		connections.push(connectionFor(company, companyConfig, config));
		const companyAccounts = ledger.listAccounts({company});
		const selected = companyAccounts.filter(account => !wanted || wanted.has(account.id));
		context.errlist.push(...companyErrors(company, selected, context));
		for (const account of selected) {
			accounts.push(toSimpleFinAccount(account, companyConfig, context));
		}
	}

	return {
		errlist: context.errlist,
		errors: context.errlist.map(error => error.msg),
		connections,
		accounts,
	};
}
