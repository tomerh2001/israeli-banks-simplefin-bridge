/**
 * Shared fixtures for the scrape-side tests: a capturing logger, a temp
 * RuntimeEnv, company configs and canned SourceFetchResults.
 */

import {mkdtempSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {Logger} from '../../src/log.js';
import type {
	CompanyConfig,
	Config,
	LedgerAccount,
	LedgerTransaction,
	RuntimeEnv,
	SourceFetchResult,
} from '../../src/types.js';

export type CapturedLine = {level: string; scope: string; message: string; extra?: Record<string, unknown>};

export type CapturingLogger = Logger & {lines: CapturedLine[]};

export type Gate = {promise: Promise<void>; open(): void};

/** A promise that resolves when `open()` is called (test synchronisation). */
export function createGate(): Gate {
	const target = new EventTarget();
	return {
		promise: new Promise(resolve => {
			target.addEventListener('open', () => resolve(), {once: true});
		}),
		open() {
			target.dispatchEvent(new Event('open'));
		},
	};
}

/** Logger that records every line instead of printing. */
export function createCapturingLogger(scope = 'test', lines: CapturedLine[] = []): CapturingLogger {
	const push = (level: string) => (message: string, extra?: Record<string, unknown>) => {
		lines.push({level, scope, message, extra});
	};

	return {
		lines,
		info: push('info'),
		warn: push('warn'),
		error: push('error'),
		debug: push('debug'),
		child: child => createCapturingLogger(`${scope}:${child}`, lines),
	};
}

/** Fresh temp DATA_DIR and a RuntimeEnv rooted in it. */
export function createTemporaryEnv(overrides: Partial<RuntimeEnv> = {}): RuntimeEnv {
	const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ibs-bridge-test-'));
	return {
		configPath: path.join(dataDir, 'config.json'),
		dataDir,
		ledgerPath: path.join(dataDir, 'ledger.sqlite'),
		chromeDir: path.join(dataDir, 'chrome'),
		screenshotsDir: path.join(dataDir, 'screenshots'),
		opConnectHost: undefined,
		opConnectTokenFile: undefined,
		opDisabled: true,
		verbose: false,
		showBrowser: false,
		puppeteerExecutablePath: undefined,
		...overrides,
	};
}

export function companyConfig(overrides: Partial<CompanyConfig> = {}): CompanyConfig {
	return {
		enabled: true,
		label: 'Test Bank',
		kind: 'checking',
		credentials: {userCode: 'user-1', password: 'pass-1234'},
		accounts: 'all',
		startDate: undefined,
		additionalTransactionInformation: false,
		includePending: false,
		futureMonthsToScrape: undefined,
		dateMode: 'purchase',
		chargeDay: undefined,
		synthesizePayments: false,
		timeoutMinutes: 20,
		scraperOptions: undefined,
		...overrides,
	};
}

export function bridgeConfig(overrides: Partial<Config> = {}): Config {
	return {
		schedule: undefined,
		timezone: 'Asia/Jerusalem',
		currency: 'ILS',
		staleHours: 30,
		overlapDays: 30,
		maxLoginAttemptsPerDay: 2,
		companies: {},
		server: {publicUrl: 'http://bridge:8080', port: 8080, host: '0.0.0.0', claimTtlMinutes: 15, maxClaims: 3},
		...overrides,
	};
}

export function account(overrides: Partial<LedgerAccount> = {}): LedgerAccount {
	const now = '2026-09-05T06:00:00.000Z';
	return {
		id: 'hapoalim:00-000-000001',
		company: 'hapoalim',
		accountNumber: '00-000-000001',
		kind: 'checking',
		currency: 'ILS',
		name: 'Bank Hapoalim ····7430',
		balance: 1234.56,
		balanceAt: now,
		firstSeen: now,
		lastSeen: now,
		raw: {},
		...overrides,
	};
}

export function transaction(overrides: Partial<LedgerTransaction> = {}): LedgerTransaction {
	const now = '2026-09-05T06:00:00.000Z';
	return {
		id: 'hapoalim:00-000-000001:1001:abcdef0123456789',
		accountId: 'hapoalim:00-000-000001',
		company: 'hapoalim',
		identifier: '1001',
		bookedDate: '2026-08-20',
		chargeDate: '2026-08-20',
		amount: -50,
		currency: 'ILS',
		description: 'Groceries',
		memo: undefined,
		status: 'posted',
		installmentNumber: undefined,
		installmentTotal: undefined,
		originalAmount: undefined,
		originalCurrency: undefined,
		category: undefined,
		synthetic: false,
		firstSeen: now,
		lastSeen: now,
		idSchemeVersion: 1,
		raw: {},
		...overrides,
	};
}

export function fetchResult(overrides: Partial<SourceFetchResult> = {}): SourceFetchResult {
	return {
		accounts: [account()],
		transactions: [transaction()],
		holdings: [],
		scrapedAt: '2026-09-05T06:00:00.000Z',
		...overrides,
	};
}
