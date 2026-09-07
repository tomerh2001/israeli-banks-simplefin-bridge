/**
 * Payload builder rules: number formatting, date conventions, sign conventions,
 * currency fallback, window edges, flags, errlist and the org map.
 */

import {CompanyTypes} from 'israeli-bank-scrapers';
import {describe, expect, it} from 'vitest';
import {createMemoryLedger} from '../src/ledger/memory.js';
import {ORGS} from '../src/simplefin/orgs.js';
import {buildAccountsResponse, ERROR_MESSAGES, formatAmount, parseAccountsQuery, windowDates} from '../src/simplefin/payload.js';
import {calendarDateToPostedEpoch, windowEndDate, windowStartDate} from '../src/simplefin/time.js';
import type {AccountsQuery, Config} from '../src/types.js';
import {
	companyConfig,
	HAPOALIM_ACCOUNT,
	makeConfig,
	noonEpoch,
	NOW,
	seedAccount,
	seedCardAccount,
	seedHolding,
	seedSourceState,
	seedTransaction,
	shiftDate,
	silentLogger,
	TODAY,
	utcMidnight,
	VISACAL_ACCOUNT,
} from './helpers/seed.js';

const noWindow: AccountsQuery = {version: '2', pending: false, balancesOnly: false};
const lastYear: AccountsQuery = {
	...noWindow,
	pending: true,
	startDate: utcMidnight(shiftDate(TODAY, -365)),
	endDate: utcMidnight(shiftDate(TODAY, 1)),
};

function build(ledger: ReturnType<typeof createMemoryLedger>, query: AccountsQuery, config: Config = makeConfig()) {
	return buildAccountsResponse(ledger, config, query, NOW, silentLogger());
}

function healthyLedger() {
	const ledger = createMemoryLedger();
	seedSourceState(ledger, 'hapoalim');
	seedSourceState(ledger, 'visaCal');
	return ledger;
}

describe('parseAccountsQuery', () => {
	it('reads every parameter Securo and Actual send', () => {
		const raw = ['version=2', 'pending=1', 'account=a:1', 'account=b:2', 'start-date=1700000000', 'end-date=1700086400', 'balances-only=1'].join('&');
		const query = parseAccountsQuery(new URLSearchParams(raw));
		expect(query).toEqual({version: '2', pending: true, balancesOnly: true, accountIds: ['a:1', 'b:2'], startDate: 1_700_000_000, endDate: 1_700_086_400});
	});

	it('ignores garbage and empty values', () => {
		const query = parseAccountsQuery(new URLSearchParams('start-date=abc&end-date=&pending=0&account='));
		expect(query).toEqual({version: undefined, pending: false, balancesOnly: false, accountIds: undefined, startDate: undefined, endDate: undefined});
		expect(windowDates(query)).toBeUndefined();
	});

	it('ignores epochs beyond year 9999 instead of failing on an invalid Date', () => {
		for (const value of ['1e300', '1e15', '-5', 'Infinity']) {
			const query = parseAccountsQuery(new URLSearchParams(`start-date=${value}&end-date=${value}`));
			expect(query.startDate, value).toBeUndefined();
			expect(query.endDate, value).toBeUndefined();
			expect(windowDates(query)).toBeUndefined();
		}

		const edge = parseAccountsQuery(new URLSearchParams('start-date=253402257600&end-date=253402257601'));
		expect(edge).toMatchObject({startDate: 253_402_257_600, endDate: undefined});
		expect(windowDates(edge)?.from).toBe('9999-12-31');
	});
});

describe('formatting and dates', () => {
	it('formats amounts and balances with exactly two decimals', () => {
		expect(formatAmount(1234.5)).toBe('1234.50');
		expect(formatAmount(-33.333)).toBe('-33.33');
		expect(formatAmount(0)).toBe('0.00');
		expect(formatAmount(-0.001)).toBe('0.00');
		expect(formatAmount(1e6)).toBe('1000000.00');
	});

	it('posted and transacted_at are 12:00 UTC of the booked date', () => {
		expect(calendarDateToPostedEpoch('2026-09-05')).toBe(Date.UTC(2026, 8, 5, 12) / 1000);
		const ledger = healthyLedger();
		seedAccount(ledger);
		seedTransaction(ledger, {
			bookedDate: '2026-03-31',
			chargeDate: '2026-04-10',
			installmentNumber: 2,
			installmentTotal: 6,
			identifier: 'ABC',
			originalAmount: -30,
			originalCurrency: 'USD',
			category: 'food',
			memo: 'note',
		});
		const [transaction] = build(ledger, lastYear).accounts[0]!.transactions;
		expect(transaction?.posted).toBe(noonEpoch('2026-03-31'));
		expect(transaction?.transacted_at).toBe(noonEpoch('2026-03-31'));
		expect(new Date(transaction!.posted * 1000).toISOString().slice(0, 10)).toBe('2026-03-31');
		expect(transaction?.payee).toBe(transaction?.description);
		expect(transaction?.memo).toBe('note');
		expect(transaction?.extra).toEqual({
			identifier: 'ABC',
			charge_date: '2026-04-10',
			installment: {number: 2, total: 6},
			original_amount: '-30',
			original_currency: 'USD',
			category: 'food',
			status: 'posted',
		});
	});

	it('pending rows have posted=0, pending=true and keep transacted_at', () => {
		const ledger = healthyLedger();
		seedCardAccount(ledger);
		seedTransaction(ledger, {accountId: VISACAL_ACCOUNT, status: 'pending', bookedDate: shiftDate(TODAY, -1)});
		const [transaction] = build(ledger, lastYear).accounts[0]!.transactions;
		expect(transaction).toMatchObject({posted: 0, pending: true, transacted_at: noonEpoch(shiftDate(TODAY, -1))});
	});

	it('pending rows that the latest scrape no longer reported are not served', () => {
		const ledger = healthyLedger();
		const latest = '2026-09-05T03:00:00.000Z';
		seedCardAccount(ledger, {lastSeen: latest});
		seedTransaction(ledger, {accountId: VISACAL_ACCOUNT, status: 'pending', lastSeen: latest, description: 'still pending'});
		seedTransaction(ledger, {accountId: VISACAL_ACCOUNT, status: 'pending', lastSeen: '2026-09-01T03:00:00.000Z', description: 'vanished hold'});
		seedTransaction(ledger, {accountId: VISACAL_ACCOUNT, status: 'posted', lastSeen: '2026-08-01T03:00:00.000Z', description: 'old posted'});
		const descriptions = build(ledger, lastYear).accounts[0]!.transactions.map(transaction => transaction.description);
		expect(descriptions.sort()).toEqual(['old posted', 'still pending']);
	});

	it('pending rows are hidden without pending=1 or when the company does not include pending', () => {
		const ledger = healthyLedger();
		seedAccount(ledger);
		seedCardAccount(ledger);
		seedTransaction(ledger, {accountId: HAPOALIM_ACCOUNT, status: 'pending'});
		seedTransaction(ledger, {accountId: VISACAL_ACCOUNT, status: 'pending'});
		const withPending = build(ledger, lastYear);
		expect(withPending.accounts[0]!.transactions).toHaveLength(0); // hapoalim: includePending false
		expect(withPending.accounts[1]!.transactions).toHaveLength(1); // visaCal: includePending true
		const withoutFlag = build(ledger, {...lastYear, pending: false});
		expect(withoutFlag.accounts[1]!.transactions).toHaveLength(0);
	});
});

describe('sign and currency conventions', () => {
	it('labels an unavailable balance until a later scrape reports it without changing account or transaction identity', () => {
		const ledger = healthyLedger();
		const account = seedCardAccount(ledger, {name: '  Visa Cal ····1234  ', balance: undefined});
		seedTransaction(ledger, {accountId: account.id});
		const unavailable = build(ledger, lastYear);
		expect(unavailable.accounts[0]).toMatchObject({id: account.id, name: 'Visa Cal ····1234 (balance unavailable)', balance: '0.00'});
		expect(unavailable.errlist).toEqual([{code: 'act.balance_unavailable', msg: ERROR_MESSAGES.balanceUnavailable, account_id: account.id}]);
		expect(build(ledger, lastYear).accounts[0]?.name).toBe(unavailable.accounts[0]?.name);
		expect(ledger.getAccount(account.id)?.name).toBe(account.name);

		ledger.upsertAccount({...account, balance: -42.5, lastSeen: NOW.toISOString()});
		const reported = build(ledger, lastYear);
		expect(reported.accounts[0]).toMatchObject({id: account.id, name: 'Visa Cal ····1234', balance: '-42.50'});
		expect(reported.accounts[0]?.transactions).toEqual(unavailable.accounts[0]?.transactions);
		expect(reported.errlist).toEqual([]);
	});

	it('does not label a reported zero balance as unavailable', () => {
		const ledger = healthyLedger();
		const account = seedCardAccount(ledger, {balance: 0});
		const response = build(ledger, noWindow);
		expect(response.accounts[0]).toMatchObject({id: account.id, name: account.name, balance: '0.00'});
		expect(response.errlist).toEqual([]);
	});

	it('keeps the complete unavailable warning within the 255-character account name limit', () => {
		const ledger = healthyLedger();
		const account = seedCardAccount(ledger, {name: `  ${'א'.repeat(300)}  `, balance: undefined});
		const unavailable = build(ledger, noWindow).accounts[0]!;
		expect(unavailable.id).toBe(account.id);
		expect(unavailable.name).toHaveLength(255);
		expect(unavailable.name).toMatch(/^א+ \(balance unavailable\)$/);

		ledger.upsertAccount({...account, balance: 0});
		const reported = build(ledger, noWindow).accounts[0]!;
		expect(reported.id).toBe(account.id);
		expect(reported.name).toBe('א'.repeat(255));
	});

	it('passes balances through: checking real balance, card negative debt, null -> 0.00 + errlist', () => {
		const ledger = healthyLedger();
		seedAccount(ledger, {balance: 100.1});
		seedCardAccount(ledger, {balance: -50});
		seedAccount(ledger, {id: 'hapoalim:2', accountNumber: '2', balance: undefined, balanceAt: undefined});
		const response = build(ledger, noWindow);
		const byId = new Map(response.accounts.map(account => [account.id, account]));
		expect(byId.get(HAPOALIM_ACCOUNT)?.balance).toBe('100.10');
		expect(byId.get(VISACAL_ACCOUNT)?.balance).toBe('-50.00');
		expect(byId.get('hapoalim:2')?.balance).toBe('0.00');
		expect(byId.get('hapoalim:2')?.['balance-date']).toBe(Math.floor(NOW.getTime() / 1000));
		expect(response.errlist).toEqual([{code: 'act.balance_unavailable', msg: ERROR_MESSAGES.balanceUnavailable, account_id: 'hapoalim:2'}]);
		expect(response.errors).toEqual([ERROR_MESSAGES.balanceUnavailable]);
	});

	it('card purchases are negative and repayments positive', () => {
		const ledger = healthyLedger();
		seedCardAccount(ledger);
		seedTransaction(ledger, {accountId: VISACAL_ACCOUNT, amount: -120});
		seedTransaction(ledger, {accountId: VISACAL_ACCOUNT, amount: 120, synthetic: true});
		const amounts = build(ledger, lastYear).accounts[0]!.transactions.map(transaction => transaction.amount).sort();
		expect(amounts).toEqual(['-120.00', '120.00']);
	});

	it('falls back to the config currency for accounts and to the account currency for rows', () => {
		const ledger = healthyLedger();
		seedAccount(ledger, {currency: '₪'});
		seedAccount(ledger, {id: 'hapoalim:usd', accountNumber: 'usd', currency: 'usd'});
		seedTransaction(ledger, {accountId: 'hapoalim:usd', currency: 'US$'});
		const response = build(ledger, lastYear);
		expect(response.accounts[0]?.currency).toBe('ILS');
		expect(response.accounts[1]?.currency).toBe('USD');
		expect(response.accounts[1]?.transactions[0]?.currency).toBe('USD');
	});
});

describe('company selection and errors', () => {
	it('omits disabled and unknown companies but lists enabled ones before their first scrape', () => {
		const ledger = healthyLedger();
		seedAccount(ledger);
		seedCardAccount(ledger);
		seedAccount(ledger, {id: 'leumi:9', company: 'leumi', accountNumber: '9'});
		const config = makeConfig();
		config.companies.visaCal = companyConfig({label: 'Visa Cal', enabled: false});
		config.companies.max = companyConfig({label: 'Max'});
		const response = build(ledger, noWindow, config);
		// `max` has no ledger accounts yet; its connection is still announced so Securo names and ids the
		// connection after it from the first connect on, instead of a hashed id and 'SimpleFIN Connection'.
		expect(response.connections.map(connection => [connection.conn_id, connection.name])).toEqual([['hapoalim', 'Bank Hapoalim'], ['max', 'Max']]);
		expect(response.accounts.map(account => account.id)).toEqual([HAPOALIM_ACCOUNT]);
		expect(response.errlist).toEqual([]);
	});

	it('filters by repeated account ids and keeps the connection list', () => {
		const ledger = healthyLedger();
		seedAccount(ledger);
		seedCardAccount(ledger);
		const response = build(ledger, {...noWindow, accountIds: [VISACAL_ACCOUNT, 'nope']});
		expect(response.accounts.map(account => account.id)).toEqual([VISACAL_ACCOUNT]);
		expect(response.connections).toHaveLength(2);
	});

	it('flags parked companies as con.failed and stale ones as act.failed with fixed messages', () => {
		const ledger = createMemoryLedger();
		seedSourceState(ledger, 'hapoalim', {parked: true, parkedReason: 'INVALID_PASSWORD: bank said "wrong password for 12345"', lastErrorMessage: 'bank page text'});
		seedSourceState(ledger, 'visaCal', {lastSuccessAt: new Date(NOW.getTime() - (31 * 3_600_000)).toISOString()});
		seedAccount(ledger);
		seedCardAccount(ledger);
		const response = build(ledger, noWindow);
		expect(response.errlist).toEqual([
			{code: 'con.failed', msg: ERROR_MESSAGES.parked, conn_id: 'hapoalim'},
			{code: 'act.failed', msg: ERROR_MESSAGES.stale, conn_id: 'visaCal', account_id: VISACAL_ACCOUNT},
		]);
		expect(response.errors).toEqual([ERROR_MESSAGES.parked, ERROR_MESSAGES.stale]);
		expect(JSON.stringify(response)).not.toMatch(/wrong password|bank page text|12345/);
		expect(response.errlist.some(error => error.code.endsWith('.auth'))).toBe(false);
		expect(response.accounts).toHaveLength(2);
	});

	it('emits holdings with numeric strings', () => {
		const ledger = healthyLedger();
		seedAccount(ledger);
		seedHolding(ledger);
		const [holding] = build(ledger, noWindow).accounts[0]!.holdings!;
		expect(holding).toEqual({
			id: `${HAPOALIM_ACCOUNT}:TEVA`,
			market_value: '1050.50',
			description: 'Teva Pharmaceutical',
			symbol: 'TEVA',
			currency: 'ILS',
			shares: '10',
			purchase_price: '95',
			cost_basis: '950',
		});
	});
});

describe('windows', () => {
	it('maps epoch bounds onto calendar dates with the 12:00Z convention', () => {
		expect(windowStartDate(utcMidnight('2026-09-01'))).toBe('2026-09-01');
		expect(windowStartDate(noonEpoch('2026-09-01'))).toBe('2026-09-01');
		expect(windowStartDate(noonEpoch('2026-09-01') + 1)).toBe('2026-09-02');
		expect(windowEndDate(utcMidnight('2026-09-02'))).toBe('2026-09-02');
		expect(windowEndDate(noonEpoch('2026-09-02'))).toBe('2026-09-02');
		expect(windowEndDate(noonEpoch('2026-09-02') + 1)).toBe('2026-09-03');
	});

	it('includes start-date day, includes the day before end-date and excludes the end-date day', () => {
		const ledger = healthyLedger();
		seedAccount(ledger);
		seedTransaction(ledger, {bookedDate: '2026-08-31', description: 'before'});
		seedTransaction(ledger, {bookedDate: '2026-09-01', description: 'start'});
		seedTransaction(ledger, {bookedDate: '2026-09-03', description: 'last'});
		seedTransaction(ledger, {bookedDate: '2026-09-04', description: 'end'});
		const query: AccountsQuery = {...noWindow, startDate: utcMidnight('2026-09-01'), endDate: utcMidnight('2026-09-04')};
		const descriptions = build(ledger, query).accounts[0]!.transactions.map(transaction => transaction.description);
		expect(descriptions).toEqual(['start', 'last']);

		const exact: AccountsQuery = {...noWindow, startDate: noonEpoch('2026-09-01'), endDate: noonEpoch('2026-09-03')};
		expect(build(ledger, exact).accounts[0]!.transactions.map(transaction => transaction.description)).toEqual(['start']);
	});

	it('serves rows first seen inside the window even when their booked date is older (late postings)', () => {
		const ledger = healthyLedger();
		seedAccount(ledger);
		const late = seedTransaction(ledger, {bookedDate: shiftDate(TODAY, -40), firstSeen: new Date(NOW.getTime() - 86_400_000).toISOString(), description: 'late'});
		seedTransaction(ledger, {bookedDate: shiftDate(TODAY, -40), firstSeen: new Date(NOW.getTime() - (39 * 86_400_000)).toISOString(), description: 'on time'});
		// Securo's incremental window: last sync - 14 days .. tomorrow.
		const incremental: AccountsQuery = {...noWindow, startDate: utcMidnight(shiftDate(TODAY, -14)), endDate: utcMidnight(shiftDate(TODAY, 1))};
		expect(build(ledger, incremental).accounts[0]!.transactions.map(transaction => transaction.description)).toEqual(['late']);
		expect(build(ledger, incremental).accounts[0]!.transactions[0]!.posted).toBe(noonEpoch(late.bookedDate));

		// A backfill chunk that ended before the row was first seen does not repeat it.
		const oldChunk: AccountsQuery = {...noWindow, startDate: utcMidnight(shiftDate(TODAY, -30)), endDate: utcMidnight(shiftDate(TODAY, -20))};
		expect(build(ledger, oldChunk).accounts[0]!.transactions).toEqual([]);

		// The chunk covering the booked date serves both rows by date, as before.
		const bookedChunk: AccountsQuery = {...noWindow, startDate: utcMidnight(shiftDate(TODAY, -60)), endDate: utcMidnight(shiftDate(TODAY, -30))};
		expect(build(ledger, bookedChunk).accounts[0]!.transactions.map(transaction => transaction.description).sort()).toEqual(['late', 'on time']);

		// The exclusive upper bound still applies to the booked date.
		const future = seedTransaction(ledger, {bookedDate: shiftDate(TODAY, 20), firstSeen: NOW.toISOString(), description: 'future installment'});
		expect(build(ledger, incremental).accounts[0]!.transactions.some(transaction => transaction.id === future.id)).toBe(false);
	});

	it('returns no transactions without a window or with balances-only=1', () => {
		const ledger = healthyLedger();
		seedAccount(ledger);
		seedTransaction(ledger);
		expect(build(ledger, noWindow).accounts[0]!.transactions).toEqual([]);
		expect(build(ledger, {...lastYear, balancesOnly: true}).accounts[0]!.transactions).toEqual([]);
		expect(build(ledger, {...noWindow, startDate: utcMidnight(shiftDate(TODAY, -1))}).accounts[0]!.transactions).toHaveLength(1);
		expect(build(ledger, {...noWindow, endDate: utcMidnight(shiftDate(TODAY, 1))}).accounts[0]!.transactions).toHaveLength(1);
	});

	it('delivers an old pending row when it becomes posted after the consumer rewind window', () => {
		const ledger = healthyLedger();
		seedAccount(ledger);
		const pending = seedTransaction(ledger, {
			bookedDate: shiftDate(TODAY, -40),
			firstSeen: `${shiftDate(TODAY, -40)}T03:00:00.000Z`,
			lastSeen: `${shiftDate(TODAY, -40)}T03:00:00.000Z`,
			status: 'pending',
		});
		const incremental = {...noWindow, startDate: utcMidnight(shiftDate(TODAY, -14)), endDate: utcMidnight(shiftDate(TODAY, 1))};
		expect(build(ledger, incremental).accounts[0]!.transactions).toEqual([]);
		ledger.upsertTransactions([{...pending, status: 'posted', lastSeen: NOW.toISOString()}]);
		const served = build(ledger, incremental).accounts[0]!.transactions;
		expect(served).toHaveLength(1);
		expect(served[0]).toMatchObject({id: pending.id, pending: false, posted: noonEpoch(pending.bookedDate)});
		// Another identical scrape does not continually move the posting discovery date forward.
		ledger.upsertTransactions([{...pending, status: 'posted', lastSeen: `${shiftDate(TODAY, 30)}T03:00:00.000Z`}]);
		expect(build(ledger, {...incremental, startDate: utcMidnight(shiftDate(TODAY, 16)), endDate: utcMidnight(shiftDate(TODAY, 31))}).accounts[0]!.transactions).toEqual([]);
	});
});

describe('org map', () => {
	it('covers every CompanyTypes value with a name and an https url', () => {
		const companyTypes = Object.values(CompanyTypes as unknown as Record<string, string>);
		expect(companyTypes.length).toBeGreaterThan(0);
		for (const company of companyTypes) {
			const org = (ORGS as Record<string, {name: string; url: string} | undefined>)[company];
			expect(org, company).toBeDefined();
			expect(org?.name.length).toBeGreaterThan(0);
			expect(org?.url).toMatch(/^https:\/\/[\w\-.]+$/);
		}

		const byName = (a: string, b: string) => a.localeCompare(b);
		expect(Object.keys(ORGS).sort(byName)).toEqual(companyTypes.sort(byName));
	});
});
