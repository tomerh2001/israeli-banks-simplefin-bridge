/**
 * Test fixtures: config factory, ledger seeding and Basic-auth helpers shared by the
 * SimpleFIN, health and CSV suites. All dates are relative to a fixed clock.
 */

import {Buffer} from 'node:buffer';
import {createMemoryLedger} from '../../src/ledger/memory.js';
import type {Logger} from '../../src/log.js';
import type {
	CompanyConfig,
	CompanyId,
	Config,
	IsoDate,
	Ledger,
	LedgerAccount,
	LedgerHolding,
	LedgerTransaction,
	SourceState,
} from '../../src/types.js';

/** Fixed "now" for every suite: 2026-09-05 10:00 UTC (13:00 in Asia/Jerusalem). */
export const NOW = new Date('2026-09-05T10:00:00.000Z');
export const TODAY: IsoDate = '2026-09-05';

export const HAPOALIM_ACCOUNT = 'hapoalim:00-000-000001';
export const VISACAL_ACCOUNT = 'visaCal:1234';

export function companyConfig(overrides: Partial<CompanyConfig> = {}): CompanyConfig {
	return {
		enabled: true,
		label: 'Bank',
		kind: 'checking',
		credentials: {username: 'u', password: 'p'},
		accounts: 'all',
		additionalTransactionInformation: false,
		includePending: false,
		dateMode: 'purchase',
		synthesizePayments: false,
		timeoutMinutes: 20,
		...overrides,
	};
}

/** Two companies: a checking bank (pending hidden) and a credit card (pending served). */
export function makeConfig(overrides: Partial<Config> = {}): Config {
	return {
		timezone: 'Asia/Jerusalem',
		currency: 'ILS',
		staleHours: 30,
		overlapDays: 30,
		maxLoginAttemptsPerDay: 2,
		companies: {
			hapoalim: companyConfig({label: 'Bank Hapoalim', kind: 'checking'}),
			visaCal: companyConfig({label: 'Visa Cal', kind: 'credit_card', includePending: true}),
		},
		server: {
			publicUrl: 'http://israeli-banks-bridge:8080',
			port: 8080,
			host: '0.0.0.0',
			claimTtlMinutes: 15,
			maxClaims: 3,
		},
		...overrides,
	};
}

/** `YYYY-MM-DD` shifted by `days` from a base date (UTC arithmetic). */
export function shiftDate(date: IsoDate, days: number): IsoDate {
	const ms = Date.parse(`${date}T00:00:00Z`) + (days * 86_400_000);
	return new Date(ms).toISOString().slice(0, 10);
}

/** Epoch seconds of UTC midnight of a calendar date (what Securo sends as start-date/end-date). */
export function utcMidnight(date: IsoDate): number {
	return Date.parse(`${date}T00:00:00Z`) / 1000;
}

/** Epoch seconds of 12:00 UTC of a calendar date (what the bridge emits as `posted`). */
export function noonEpoch(date: IsoDate): number {
	return Date.parse(`${date}T12:00:00Z`) / 1000;
}

export function seedAccount(ledger: Ledger, overrides: Partial<LedgerAccount> = {}): LedgerAccount {
	const account: LedgerAccount = {
		id: HAPOALIM_ACCOUNT,
		company: 'hapoalim',
		accountNumber: '00-000-000001',
		kind: 'checking',
		currency: 'ILS',
		name: 'Bank Hapoalim ····0001',
		balance: 1234.5,
		balanceAt: '2026-09-05T03:00:00.000Z',
		firstSeen: '2026-01-01T00:00:00.000Z',
		lastSeen: '2026-09-05T03:00:00.000Z',
		raw: {},
		...overrides,
	};
	ledger.upsertAccount(account);
	return account;
}

export function seedCardAccount(ledger: Ledger, overrides: Partial<LedgerAccount> = {}): LedgerAccount {
	return seedAccount(ledger, {
		id: VISACAL_ACCOUNT,
		company: 'visaCal',
		accountNumber: '1234',
		kind: 'credit_card',
		name: 'Visa Cal ····1234',
		balance: -2500.25,
		...overrides,
	});
}

let transactionSequence = 0;

export function seedTransaction(ledger: Ledger, overrides: Partial<LedgerTransaction> = {}): LedgerTransaction {
	transactionSequence++;
	const accountId = overrides.accountId ?? HAPOALIM_ACCOUNT;
	const company = overrides.company ?? (accountId.split(':', 1)[0] as CompanyId);
	const row: LedgerTransaction = {
		id: `${accountId}:${transactionSequence}:${'0'.repeat(16)}`,
		accountId,
		company,
		identifier: String(transactionSequence),
		bookedDate: TODAY,
		chargeDate: undefined,
		amount: -100,
		currency: 'ILS',
		description: `Purchase ${transactionSequence}`,
		memo: undefined,
		status: 'posted',
		installmentNumber: undefined,
		installmentTotal: undefined,
		originalAmount: undefined,
		originalCurrency: undefined,
		category: undefined,
		synthetic: false,
		firstSeen: '2026-09-05T03:00:00.000Z',
		lastSeen: '2026-09-05T03:00:00.000Z',
		idSchemeVersion: 1,
		raw: {},
		...overrides,
	};
	ledger.upsertTransactions([row]);
	return row;
}

export function seedHolding(ledger: Ledger, overrides: Partial<LedgerHolding> = {}): LedgerHolding {
	const row: LedgerHolding = {
		id: `${HAPOALIM_ACCOUNT}:TEVA`,
		accountId: HAPOALIM_ACCOUNT,
		symbol: 'TEVA',
		description: 'Teva Pharmaceutical',
		marketValue: 1050.5,
		shares: 10,
		purchasePrice: 95,
		costBasis: 950,
		currency: 'ILS',
		firstSeen: '2026-09-05T03:00:00.000Z',
		lastSeen: '2026-09-05T03:00:00.000Z',
		raw: {},
		...overrides,
	};
	ledger.upsertHoldings([row]);
	return row;
}

export function seedSourceState(ledger: Ledger, company: CompanyId, overrides: Partial<SourceState> = {}): SourceState {
	const state: SourceState = {
		company,
		lastRunAt: '2026-09-05T03:00:00.000Z',
		lastSuccessAt: '2026-09-05T03:00:00.000Z',
		lastErrorAt: undefined,
		lastErrorType: undefined,
		lastErrorMessage: undefined,
		consecutiveFailures: 0,
		parked: false,
		parkedReason: undefined,
		parkedAt: undefined,
		credentialFingerprint: undefined,
		nextAllowedAt: undefined,
		loginAttemptsDate: undefined,
		loginAttempts: 0,
		earliestScrapedDate: undefined,
		...overrides,
	};
	ledger.upsertSourceState(state);
	return state;
}

/**
 * A fresh ledger with both companies healthy, one checking account with a year of
 * posted rows (one every 30 days, plus edge rows) and one card with a pending row.
 */
export function seedLedger(): Ledger {
	const ledger = createMemoryLedger();
	seedSourceState(ledger, 'hapoalim');
	seedSourceState(ledger, 'visaCal');
	seedAccount(ledger);
	seedCardAccount(ledger);
	for (let daysAgo = 0; daysAgo <= 365; daysAgo += 30) {
		seedTransaction(ledger, {bookedDate: shiftDate(TODAY, -daysAgo), amount: -(daysAgo + 1)});
	}

	const oldDate = shiftDate(TODAY, -366);
	seedTransaction(ledger, {bookedDate: oldDate, firstSeen: `${oldDate}T03:00:00.000Z`, amount: -999, description: 'Too old'});
	seedTransaction(ledger, {accountId: VISACAL_ACCOUNT, bookedDate: shiftDate(TODAY, -2), amount: -45.5, status: 'pending', description: 'Pending coffee'});
	seedTransaction(ledger, {accountId: VISACAL_ACCOUNT, bookedDate: shiftDate(TODAY, -10), amount: 2500, description: 'Card payment', synthetic: true});
	return ledger;
}

export function basicHeader(user: string, secret: string): string {
	return `Basic ${Buffer.from(`${user}:${secret}`).toString('base64')}`;
}

/** Logger that swallows output; `lines` collects every message for assertions. */
export function silentLogger(lines: string[] = []): Logger {
	const record = (level: string) => (message: string, extra?: Record<string, unknown>) => {
		lines.push(`${level} ${message} ${JSON.stringify(extra ?? {})}`);
	};

	return {
		info: record('info'),
		warn: record('warn'),
		error: record('error'),
		debug: record('debug'),
		child: () => silentLogger(lines),
	};
}
