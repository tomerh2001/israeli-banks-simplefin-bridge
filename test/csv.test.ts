import {describe, expect, it} from 'vitest';
import {CSV_HEADER, csvField, exportCsv} from '../src/export/csv.js';
import {createMemoryLedger} from '../src/ledger/memory.js';
import {companyConfig, HAPOALIM_ACCOUNT, makeConfig, seedAccount, seedCardAccount, seedTransaction, VISACAL_ACCOUNT} from './helpers/seed.js';

function parseCsv(text: string): string[][] {
	expect(text.endsWith('\r\n')).toBe(true);
	return text.slice(0, -2).split('\r\n').map(line => line.split(','));
}

describe('csvField', () => {
	it('quotes per RFC 4180 only when needed', () => {
		expect(csvField('plain')).toBe('plain');
		expect(csvField('a,b')).toBe('"a,b"');
		expect(csvField('say "hi"')).toBe('"say ""hi"""');
		expect(csvField('line\nbreak')).toBe('"line\nbreak"');
		expect(csvField('')).toBe('');
	});
});

describe('exportCsv', () => {
	it('writes the Securo header and one row per posted transaction with absolute amount + type', () => {
		const ledger = createMemoryLedger();
		seedAccount(ledger);
		seedTransaction(ledger, {bookedDate: '2026-09-01', amount: -12.345, description: 'Shop', memo: 'ref 1'});
		seedTransaction(ledger, {bookedDate: '2026-09-02', amount: 1500, description: 'Salary'});
		const rows = parseCsv(exportCsv(ledger, makeConfig()));
		expect(rows[0]).toEqual([...CSV_HEADER]);
		expect(rows[1]).toEqual(['2026-09-01', 'Shop', '12.35', 'debit', 'ILS', expect.stringContaining(HAPOALIM_ACCOUNT) as string, 'Shop', 'ref 1']);
		expect(rows[2]).toEqual(['2026-09-02', 'Salary', '1500.00', 'credit', 'ILS', expect.any(String) as string, 'Salary', '']);
	});

	it('quotes descriptions with commas and quotes', () => {
		const ledger = createMemoryLedger();
		seedAccount(ledger);
		seedTransaction(ledger, {description: 'Cafe "Noir", Tel Aviv'});
		const csv = exportCsv(ledger, makeConfig());
		expect(csv).toContain('"Cafe ""Noir"", Tel Aviv"');
	});

	it('excludes pending rows unless the company includes pending, and disabled companies', () => {
		const ledger = createMemoryLedger();
		seedAccount(ledger);
		seedCardAccount(ledger);
		seedTransaction(ledger, {accountId: HAPOALIM_ACCOUNT, status: 'pending', description: 'bank pending'});
		seedTransaction(ledger, {accountId: VISACAL_ACCOUNT, status: 'pending', description: 'card pending'});
		seedTransaction(ledger, {accountId: VISACAL_ACCOUNT, description: 'card posted'});
		const csv = exportCsv(ledger, makeConfig());
		expect(csv).not.toContain('bank pending');
		expect(csv).toContain('card pending');
		expect(csv).toContain('card posted');

		const config = makeConfig();
		config.companies.visaCal = companyConfig({label: 'Visa Cal', enabled: false});
		expect(parseCsv(exportCsv(ledger, config))).toHaveLength(1);
	});

	it('honours account and date filters (from inclusive, to exclusive)', () => {
		const ledger = createMemoryLedger();
		seedAccount(ledger);
		seedCardAccount(ledger);
		seedTransaction(ledger, {bookedDate: '2026-08-31', description: 'a'});
		seedTransaction(ledger, {bookedDate: '2026-09-01', description: 'b'});
		seedTransaction(ledger, {bookedDate: '2026-09-02', description: 'c'});
		seedTransaction(ledger, {accountId: VISACAL_ACCOUNT, bookedDate: '2026-09-01', description: 'card'});
		const rows = parseCsv(exportCsv(ledger, makeConfig(), {accountIds: [HAPOALIM_ACCOUNT], from: '2026-09-01', to: '2026-09-02'}));
		expect(rows.slice(1).map(row => row[1])).toEqual(['b']);
	});
});
