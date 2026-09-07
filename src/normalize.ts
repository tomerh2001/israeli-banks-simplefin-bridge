/**
 * israeli-bank-scrapers result -> ledger rows. Pure; no I/O.
 * See docs/architecture.md, "Dates, amounts, currency".
 *
 * Shapes observed in israeli-bank-scrapers 6.9.0 (lib/scrapers/*.js):
 * - hapoalim: accountNumber `<bank>-<branch>-<account>` (e.g. `00-000-000001`), identifier = numeric
 *   `referenceNumber` (institution code, reused across rows), status pending when `serialNumber === 0`,
 *   currency always `ILS`, `date` = eventDate, `processedDate` = valueDate, memo from beneficiary details.
 * - visaCal: accountNumber = last 4 digits, identifier = `trnIntId` for completed rows and undefined for
 *   pending ones, `originalCurrency` = `trnCurrencySymbol` (a symbol such as `₪`), `chargedCurrency` only on
 *   completed rows, installments `{number, total}` with `date` shifted by `number - 1` months, `balance` =
 *   `-nextTotalDebit` (the next bill; already negative = debt), `balanceDate` = next debit date.
 * - max: identifier = `${dealData.arn}_${installment}` which yields the literal `undefined_<n>` when the
 *   ARN is missing, `chargedCurrency` already mapped from numeric ISO (376/840/978), `balance` =
 *   `-(CreditLimit - OpenToBuy)` (already negative = debt).
 * - leumi: accountNumber `<branch>_<account>` digits only, identifier = `ReferenceNumberLong`.
 * - isracard/amex: identifier = numeric voucher number (may repeat across installment months), no balance.
 * In every scraper `chargedAmount` is signed with negative = money out.
 */

import moment from 'moment-timezone';
import type {ScraperScrapingResult} from 'israeli-bank-scrapers';
import {accountId, assignTransactionIds, normalizeIdentifier} from './ids.js';
import {
	ID_SCHEME_VERSION,
	type AccountKind,
	type CompanyConfig,
	type CompanyId,
	type IsoDate,
	type IsoDateTime,
	type LedgerAccount,
	type LedgerHolding,
	type LedgerTransaction,
	type SourceFetchResult,
} from './types.js';

export type NormalizeInput = {
	company: CompanyId;
	config: CompanyConfig;
	result: ScraperScrapingResult;
	scrapedAt: IsoDateTime;
	timezone: string;
	defaultCurrency: string;
};

type ScrapedAccount = NonNullable<ScraperScrapingResult['accounts']>[number];
type ScrapedTransaction = ScrapedAccount['txns'][number];

/** Securo truncates descriptions at 500 characters; keep ours identical so the frozen value matches what is served. */
const MAX_DESCRIPTION_LENGTH = 500;

/** Convert a full scrape result into accounts, transactions (with ids assigned) and holdings. */
export function normalizeScrapeResult(input: NormalizeInput): SourceFetchResult {
	const accounts: LedgerAccount[] = [];
	const transactions: LedgerTransaction[] = [];
	const holdings: LedgerHolding[] = [];
	for (const scraped of selectAccounts(input.result.accounts ?? [], input.config.accounts)) {
		const account = normalizeAccount(scraped, input);
		accounts.push(account);
		transactions.push(...normalizeTransactions(scraped.txns ?? [], account, input));
		holdings.push(...normalizeHoldings(scraped, account));
	}

	return {accounts, transactions, holdings, scrapedAt: input.scrapedAt};
}

/** Apply the `accounts` filter of the company config (compared as trimmed strings). */
function selectAccounts(accounts: ScrapedAccount[], selector: CompanyConfig['accounts']): ScrapedAccount[] {
	if (selector === 'all') {
		return accounts;
	}

	const wanted = new Set(selector.map(value => value.trim()));
	return accounts.filter(account => wanted.has(account.accountNumber.trim()));
}

function normalizeAccount(scraped: ScrapedAccount, input: NormalizeInput): LedgerAccount {
	const accountNumber = scraped.accountNumber.trim();
	const currency = normalizeCurrencyCode(scraped.currency, input.defaultCurrency);
	return {
		id: accountId(input.company, accountNumber),
		company: input.company,
		accountNumber,
		kind: input.config.kind,
		currency,
		name: `${input.config.label} ····${accountNumber.slice(-4)}`,
		balance: normalizeBalance(input.config.kind, scraped.balance),
		balanceAt: input.scrapedAt,
		firstSeen: input.scrapedAt,
		lastSeen: input.scrapedAt,
		raw: {...scraped, txns: undefined},
	};
}

/**
 * Balance in the account currency, or undefined when the scraper gives none.
 * Checking/savings: the real signed balance. Credit cards: negative = debt. israeli-bank-scrapers already
 * reports card balances that way (visaCal `-nextTotalDebit`, max `-(CreditLimit - OpenToBuy)`), so the sign
 * is kept as-is: a positive card balance is a genuine credit (refund larger than the next bill).
 */
function normalizeBalance(_kind: AccountKind, balance: unknown): number | undefined {
	const value = toFiniteNumber(balance);
	return value === undefined ? undefined : roundMoney(value);
}

function normalizeTransactions(rows: ScrapedTransaction[], account: LedgerAccount, input: NormalizeInput): LedgerTransaction[] {
	const prepared: Array<Omit<LedgerTransaction, 'id'>> = [];
	for (const row of rows) {
		const normalized = normalizeTransaction(row, account, input);
		if (normalized) {
			prepared.push(normalized);
		}
	}

	return assignTransactionIds(prepared);
}

/** One scraper transaction -> ledger row without id. Returns undefined when no usable amount exists. */
function normalizeTransaction(row: ScrapedTransaction, account: LedgerAccount, input: NormalizeInput): Omit<LedgerTransaction, 'id'> | undefined {
	const currency = normalizeCurrencyCode(row.chargedCurrency ?? account.currency, account.currency);
	const originalCurrency = row.originalCurrency === undefined ? undefined : normalizeCurrencyCode(row.originalCurrency, currency);
	const originalAmount = toFiniteNumber(row.originalAmount);
	const amount = toFiniteNumber(row.chargedAmount) ?? (originalCurrency === currency ? originalAmount : undefined);
	if (amount === undefined || !row.date) {
		return undefined;
	}

	const processedDate = row.processedDate ? toCalendarDate(row.processedDate, input.timezone) : undefined;
	const purchaseDate = toCalendarDate(row.date, input.timezone);
	return {
		accountId: account.id,
		company: input.company,
		identifier: normalizeIdentifier(row.identifier),
		bookedDate: input.config.dateMode === 'charge' ? processedDate ?? purchaseDate : purchaseDate,
		chargeDate: processedDate,
		amount,
		currency,
		description: (row.description ?? '').trim().slice(0, MAX_DESCRIPTION_LENGTH),
		memo: cleanText(row.memo),
		status: (row.status as string) === 'pending' ? 'pending' : 'posted',
		installmentNumber: toPositiveInteger(row.installments?.number),
		installmentTotal: toPositiveInteger(row.installments?.total),
		originalAmount,
		originalCurrency,
		category: cleanText(row.category),
		synthetic: false,
		firstSeen: input.scrapedAt,
		lastSeen: input.scrapedAt,
		idSchemeVersion: ID_SCHEME_VERSION,
		raw: row,
	};
}

/**
 * HOOK: securities/holdings. israeli-bank-scrapers 6.9.0 exposes no holdings on TransactionsAccount, so
 * this always returns []. When a future library version (or a bridge-side investment source) provides
 * positions, map them here using `holdingId(account.id, symbol ?? description)` from ./ids.ts.
 */
function normalizeHoldings(_scraped: ScrapedAccount, _account: LedgerAccount): LedgerHolding[] {
	return [];
}

const numericIsoCurrencies: Record<string, string> = {
	376: 'ILS',
	840: 'USD',
	978: 'EUR',
	826: 'GBP',
};

const currencyAliases: Record<string, string> = {
	'₪': 'ILS',
	'ש"ח': 'ILS',
	'ש״ח': 'ILS',
	שח: 'ILS',
	NIS: 'ILS',
	$: 'USD',
	'US DOLLAR': 'USD',
	USDOLLAR: 'USD',
	'€': 'EUR',
	'£': 'GBP',
};

/** Scraper currency strings/symbols/numeric ISO codes -> ISO-4217; unknown -> fallback. */
export function normalizeCurrencyCode(value: unknown, fallback: string): string {
	if (typeof value === 'number') {
		return numericIsoCurrencies[String(value)] ?? fallback;
	}

	if (typeof value !== 'string') {
		return fallback;
	}

	const trimmed = value.trim();
	if (/^\d+$/.test(trimmed)) {
		return numericIsoCurrencies[trimmed] ?? fallback;
	}

	// `ILS(₪)`, `USD($)`: an ISO code followed by its symbol in parentheses.
	const upper = trimmed.replaceAll(/\s*\(.*\)\s*$/g, '').toUpperCase();
	const alias = currencyAliases[trimmed] ?? currencyAliases[upper];
	if (alias) {
		return alias;
	}

	return /^[A-Z]{3}$/.test(upper) ? upper : fallback;
}

/** Calendar date (YYYY-MM-DD) of an ISO timestamp or Date in the given IANA timezone. */
export function toCalendarDate(value: string | Date, timezone: string): IsoDate {
	const instant = value instanceof Date ? moment(value) : moment.tz(value, moment.ISO_8601, timezone);
	if (!instant.isValid()) {
		throw new TypeError(`Not a valid ISO timestamp: ${String(value)}`);
	}

	return instant.tz(timezone).format('YYYY-MM-DD');
}

/** Epoch seconds for 12:00 UTC of a calendar date (what SimpleFIN `posted` carries). */
export function calendarDateToPostedEpoch(date: IsoDate): number {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
		throw new TypeError(`Not a calendar date: ${date}`);
	}

	const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
	return Date.UTC(year, month - 1, day, 12) / 1000;
}

function toFiniteNumber(value: unknown): number | undefined {
	if (typeof value === 'number') {
		return Number.isFinite(value) ? value : undefined;
	}

	if (typeof value === 'string' && value.trim() !== '') {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}

	return undefined;
}

function toPositiveInteger(value: unknown): number | undefined {
	const parsed = toFiniteNumber(value);
	return parsed !== undefined && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function roundMoney(value: number): number {
	return Math.round(value * 100) / 100;
}

/** Trimmed text or undefined when empty/missing. */
function cleanText(value: unknown): string | undefined {
	const text = typeof value === 'number' ? String(value) : (typeof value === 'string' ? value.trim() : '');
	return text === '' ? undefined : text;
}
