import {readFileSync} from 'node:fs';
import path from 'node:path';
import type {ScraperScrapingResult} from 'israeli-bank-scrapers';
import {describe, expect, it} from 'vitest';
import {
	calendarDateToPostedEpoch,
	normalizeCurrencyCode,
	normalizeScrapeResult,
	toCalendarDate,
	type NormalizeInput,
} from './normalize.js';
import {createMemoryLedger, createSqliteLedger} from './ledger/index.js';
import {ID_SCHEME_VERSION, type CompanyConfig, type CompanyId} from './types.js';

const fixturesDir = path.resolve(import.meta.dirname, '../test/fixtures');
const scrapedAt = '2024-03-06T04:00:00.000Z';

function fixture(name: string): ScraperScrapingResult {
	return JSON.parse(readFileSync(path.join(fixturesDir, name), 'utf8')) as ScraperScrapingResult;
}

function companyConfig(overrides: Partial<CompanyConfig> = {}): CompanyConfig {
	return {
		enabled: true,
		label: 'Bank',
		kind: 'checking',
		credentials: {},
		accounts: 'all',
		additionalTransactionInformation: false,
		includePending: false,
		dateMode: 'purchase',
		synthesizePayments: false,
		timeoutMinutes: 20,
		...overrides,
	};
}

function input(company: CompanyId, file: string, overrides: Partial<CompanyConfig> = {}, extra: Partial<NormalizeInput> = {}): NormalizeInput {
	return {
		company,
		config: companyConfig(overrides),
		result: fixture(file),
		scrapedAt,
		timezone: 'Asia/Jerusalem',
		defaultCurrency: 'ILS',
		...extra,
	};
}

describe('normalizeScrapeResult: hapoalim checking', () => {
	const result = normalizeScrapeResult(input('hapoalim', 'hapoalim-checking.json', {label: 'Bank Hapoalim'}));
	const [account] = result.accounts;
	const rows = result.transactions.filter(row => row.accountId === account!.id);

	it('maps the account', () => {
		expect(result.accounts).toHaveLength(2);
		expect(account).toMatchObject({
			id: 'hapoalim:00-000-000001',
			company: 'hapoalim',
			accountNumber: '00-000-000001',
			kind: 'checking',
			currency: 'ILS',
			name: 'Bank Hapoalim ····0001',
			balance: 4321.57,
			balanceAt: scrapedAt,
			firstSeen: scrapedAt,
			lastSeen: scrapedAt,
		});
		expect((account!.raw as {txns?: unknown}).txns).toBeUndefined();
		expect(result.holdings).toEqual([]);
		expect(result.scrapedAt).toBe(scrapedAt);
	});

	it('assigns unique, stable ids to rows sharing an institution code', () => {
		const ids = rows.map(row => row.id);
		expect(new Set(ids).size).toBe(rows.length);
		expect(ids[0]).toMatch(/^hapoalim:00-000-000001:51:[\da-f]{16}$/);
		expect(ids[1]).toBe(`${ids[0]}#2`);
		expect(ids[2]).toMatch(/^hapoalim:00-000-000001:51:[\da-f]{16}$/);
		expect(ids[2]).not.toBe(ids[0]);
		const again = normalizeScrapeResult(input('hapoalim', 'hapoalim-checking.json', {label: 'Bank Hapoalim'}));
		expect(again.transactions.map(row => row.id)).toEqual(result.transactions.map(row => row.id));
	});

	it('books near-midnight timestamps on the Israeli calendar day', () => {
		expect(rows[0]).toMatchObject({bookedDate: '2024-02-01', chargeDate: '2024-02-01'});
		expect(rows[4]).toMatchObject({bookedDate: '2024-02-02', chargeDate: '2024-02-04', amount: 15_000});
	});

	it('keeps pending rows with an unusable identifier', () => {
		expect(rows[3]).toMatchObject({status: 'pending', identifier: undefined, amount: -250});
		expect(rows[3]!.id).toContain(':-:');
	});

	it('preserves foreign-currency information and signs', () => {
		expect(rows[5]).toMatchObject({amount: -370.25, currency: 'ILS', originalAmount: -100, originalCurrency: 'USD'});
		expect(rows[0]).toMatchObject({
			amount: -120.5,
			currency: 'ILS',
			description: 'עמלת ניהול',
			memo: undefined,
			status: 'posted',
			identifier: '51',
			synthetic: false,
			firstSeen: scrapedAt,
			lastSeen: scrapedAt,
			idSchemeVersion: ID_SCHEME_VERSION,
		});
		expect(rows[4]!.memo).toBe('פרטי המוטב: חברה בע"מ.');
		expect(rows[0]!.raw).toEqual(fixture('hapoalim-checking.json').accounts![0]!.txns[0]);
	});

	it('honours dateMode charge', () => {
		const charged = normalizeScrapeResult(input('hapoalim', 'hapoalim-checking.json', {dateMode: 'charge'}));
		const salary = charged.transactions.find(row => row.description === 'משכורת');
		expect(salary).toMatchObject({bookedDate: '2024-02-04', chargeDate: '2024-02-04'});
		expect(salary!.id).not.toBe(rows[4]!.id);
	});

	it('filters accounts by config.accounts', () => {
		const filtered = normalizeScrapeResult(input('hapoalim', 'hapoalim-checking.json', {accounts: ['12-627-999999']}));
		expect(filtered.accounts.map(item => item.accountNumber)).toEqual(['12-627-999999']);
		expect(filtered.transactions).toEqual([]);
		expect(normalizeScrapeResult(input('hapoalim', 'hapoalim-checking.json', {accounts: ['nope']})).accounts).toEqual([]);
	});
});

describe('normalizeScrapeResult: visaCal card', () => {
	const result = normalizeScrapeResult(input('visaCal', 'visacal-card.json', {label: 'Visa Cal', kind: 'credit_card'}));
	const rows = result.transactions;
	const byDescription = (description: string) => rows.filter(row => row.description === description);

	it('emits the card with a negative (debt) balance', () => {
		expect(result.accounts[0]).toMatchObject({
			id: 'visaCal:1234',
			kind: 'credit_card',
			name: 'Visa Cal ····1234',
			currency: 'ILS',
			balance: -2345.6,
		});
		expect(result.accounts[0]!.balance).toBeLessThan(0);
	});

	it('gives installments of one deal distinct ids under the same identifier', () => {
		const [first, second] = byDescription('KSP');
		expect(first).toMatchObject({identifier: '987654321', installmentNumber: 1, installmentTotal: 3, amount: -400, bookedDate: '2024-02-15', chargeDate: '2024-03-02'});
		expect(second).toMatchObject({identifier: '987654321', installmentNumber: 2, installmentTotal: 3, amount: -400, bookedDate: '2024-03-15', chargeDate: '2024-04-02'});
		expect(first!.id).not.toBe(second!.id);
		expect(first!.id.startsWith('visaCal:1234:987654321:')).toBe(true);
		expect(first!.id).not.toContain('#');
	});

	it('keeps pending rows without identifier', () => {
		const [pending] = byDescription('WOLT');
		expect(pending).toMatchObject({status: 'pending', identifier: undefined, amount: -89.9, currency: 'ILS', memo: undefined, category: 'מסעדות'});
		expect(pending!.id).toMatch(/^visaCal:1234:-:[\da-f]{16}$/);
	});

	it('keeps refunds positive and normalises symbols', () => {
		expect(byDescription('ZARA')[0]).toMatchObject({amount: 150, currency: 'ILS', originalAmount: 150, originalCurrency: 'ILS', memo: 'זיכוי'});
		expect(byDescription('AMAZON.COM')[0]).toMatchObject({amount: -92.75, currency: 'ILS', originalAmount: -25, originalCurrency: 'USD', category: undefined});
	});
});

describe('normalizeScrapeResult: max card', () => {
	const result = normalizeScrapeResult(input('max', 'max-card.json', {label: 'Max', kind: 'credit_card'}));

	it('treats the literal undefined_<n> identifier as missing', () => {
		expect(result.transactions[0]).toMatchObject({identifier: undefined, installmentNumber: 2, installmentTotal: 3, amount: -300});
		expect(result.transactions[0]!.id).toMatch(/^max:5678:-:/);
		expect(result.transactions[1]).toMatchObject({identifier: 'ARN123456', memo: undefined});
		expect(result.accounts[0]!.balance).toBe(-1500);
	});
});

describe('normalizeScrapeResult: edge cases', () => {
	const scrapedAccount = {
		accountNumber: '9',
		currency: 'USD',
		txns: [
			{
				type: 'normal', status: 'completed', date: '2024-03-01T00:00:00.000Z', processedDate: '2024-03-01T00:00:00.000Z',
				originalAmount: -10, originalCurrency: 'USD', description: 'no charged amount, same currency',
			},
			{
				type: 'normal', status: 'completed', date: '2024-03-01T00:00:00.000Z', processedDate: '2024-03-01T00:00:00.000Z',
				originalAmount: -10, originalCurrency: 'EUR', description: 'no charged amount, other currency',
			},
			{type: 'normal', status: 'completed', date: '2024-03-01T00:00:00.000Z', processedDate: '', originalAmount: -1, originalCurrency: 'USD', chargedAmount: -1, description: 'x'.repeat(600)},
		],
	};
	const result = normalizeScrapeResult(input('leumi', 'max-card.json', {}, {result: {success: true, accounts: [scrapedAccount as never]}}));

	it('falls back to originalAmount only when currencies match, truncates descriptions, tolerates missing processedDate', () => {
		expect(result.accounts[0]).toMatchObject({currency: 'USD', balance: undefined});
		expect(result.transactions).toHaveLength(2);
		expect(result.transactions[0]).toMatchObject({amount: -10, currency: 'USD'});
		expect(result.transactions[1]!.description).toHaveLength(500);
		expect(result.transactions[1]!.chargeDate).toBeUndefined();
	});

	it('handles a result without accounts', () => {
		expect(normalizeScrapeResult(input('leumi', 'max-card.json', {}, {result: {success: false}}))).toEqual({accounts: [], transactions: [], holdings: [], scrapedAt});
	});
});

describe('normalizeScrapeResult -> Ledger round trip', () => {
	it.each([['memory', createMemoryLedger], ['sqlite', () => createSqliteLedger(':memory:')]])('stores the normalised output verbatim (%s)', (_name, create) => {
		const ledger = create();
		const result = normalizeScrapeResult(input('hapoalim', 'hapoalim-checking.json', {label: 'Bank Hapoalim'}));
		for (const account of result.accounts) {
			ledger.upsertAccount(account);
		}

		expect(ledger.upsertTransactions(result.transactions)).toMatchObject({inserted: result.transactions.length, anomalies: []});
		expect(ledger.upsertTransactions(result.transactions)).toMatchObject({inserted: 0, updated: 0, unchanged: result.transactions.length, anomalies: []});
		expect(ledger.listTransactions({includePending: true, includeSynthetic: true})).toHaveLength(result.transactions.length);
		for (const row of result.transactions) {
			expect(ledger.getTransaction(row.id)).toEqual(row);
		}

		expect(ledger.listAccounts()).toEqual([...result.accounts].sort((a, b) => a.id.localeCompare(b.id)));
		ledger.close();
	});
});

describe('normalizeCurrencyCode', () => {
	it('maps symbols, keywords and numeric ISO codes', () => {
		const cases: Array<[unknown, string]> = [
			['₪', 'ILS'],
			['ש"ח', 'ILS'],
			['שח', 'ILS'],
			['NIS', 'ILS'],
			['ILS(₪)', 'ILS'],
			['ils', 'ILS'],
			['$', 'USD'],
			['USD($)', 'USD'],
			['€', 'EUR'],
			['£', 'GBP'],
			[376, 'ILS'],
			[840, 'USD'],
			[978, 'EUR'],
			[826, 'GBP'],
			['376', 'ILS'],
			['USD', 'USD'],
			[' eur ', 'EUR'],
		];
		for (const [value, expected] of cases) {
			expect(normalizeCurrencyCode(value, 'XXX'), JSON.stringify(value)).toBe(expected);
		}
	});

	it('falls back for unknown values', () => {
		for (const value of [undefined, null, '', '¥¥', 'shekels', 999, {}]) {
			expect(normalizeCurrencyCode(value, 'ILS'), JSON.stringify(value)).toBe('ILS');
		}
	});
});

describe('toCalendarDate / calendarDateToPostedEpoch', () => {
	it('uses the requested timezone', () => {
		expect(toCalendarDate('2024-01-31T22:00:00.000Z', 'Asia/Jerusalem')).toBe('2024-02-01');
		expect(toCalendarDate('2024-01-31T22:00:00.000Z', 'UTC')).toBe('2024-01-31');
		expect(toCalendarDate('2024-06-30T21:30:00.000Z', 'Asia/Jerusalem')).toBe('2024-07-01');
		expect(toCalendarDate(new Date('2024-01-31T22:00:00.000Z'), 'Asia/Jerusalem')).toBe('2024-02-01');
		expect(toCalendarDate('2024-02-01', 'Asia/Jerusalem')).toBe('2024-02-01');
	});

	it('rejects garbage', () => {
		expect(() => toCalendarDate('not a date', 'Asia/Jerusalem')).toThrow(TypeError);
		expect(() => calendarDateToPostedEpoch('2024-2-1')).toThrow(TypeError);
	});

	it('pins posted to 12:00 UTC of the calendar date', () => {
		expect(calendarDateToPostedEpoch('2024-02-01')).toBe(Date.UTC(2024, 1, 1, 12) / 1000);
		expect(new Date(calendarDateToPostedEpoch('2024-02-01') * 1000).toISOString()).toBe('2024-02-01T12:00:00.000Z');
	});
});
