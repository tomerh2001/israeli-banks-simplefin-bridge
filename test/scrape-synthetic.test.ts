import {describe, expect, it, vi} from 'vitest';
import {createMemoryLedger} from '../src/ledger/memory.js';
import {addDays, calendarDate} from '../src/scrape/dates.js';
import {createPostLoginDetector} from '../src/scrape/login.js';
import {computeSyntheticPayments} from '../src/scrape/synthetic.js';
import type {LedgerTransaction} from '../src/types.js';
import {account, companyConfig, createCapturingLogger, transaction} from './mocks/fixtures.js';

vi.mock('../src/ids.js', () => ({
	syntheticPaymentId: (company: string, accountNumber: string, chargeDate: string) => `${company}:${accountNumber}:payment:${chargeDate}`,
}));

const card = account({id: 'visaCal:1234', company: 'visaCal', accountNumber: '1234', kind: 'credit_card'});
const cardConfig = companyConfig({label: 'Visa Cal', kind: 'credit_card', synthesizePayments: true});

function row(id: string, bookedDate: string, chargeDate: string | undefined, amount: number, extra: Partial<LedgerTransaction> = {}): LedgerTransaction {
	return transaction({id: `visaCal:1234:${id}`, accountId: card.id, company: 'visaCal', bookedDate, chargeDate, amount, description: id, ...extra});
}

function seededLedger(rows: LedgerTransaction[]) {
	const ledger = createMemoryLedger();
	ledger.upsertAccount(card);
	ledger.upsertTransactions(rows);
	return ledger;
}

describe('computeSyntheticPayments', () => {
	it('returns nothing when disabled or for non-card accounts', () => {
		const ledger = seededLedger([row('a', '2026-05-01', '2026-06-10', -100), row('b', '2026-06-20', '2026-07-10', -50)]);
		expect(computeSyntheticPayments(ledger, card, companyConfig({kind: 'credit_card', synthesizePayments: false}), '2026-09-05')).toEqual([]);
		expect(computeSyntheticPayments(ledger, {...card, kind: 'checking'}, cardConfig, '2026-09-05')).toEqual([]);
		expect(ledger.listSyntheticPayments(card.id)).toEqual([]);
	});

	it('groups posted rows by charge date, skips pending, synthetic, undated and unsettled cycles', () => {
		const ledger = seededLedger([
			row('a', '2026-05-20', '2026-06-10', -100),
			row('b', '2026-06-25', '2026-07-10', -50.25),
			row('c', '2026-06-21', '2026-07-10', -49.75),
			row('d', '2026-06-22', '2026-07-10', -5, {status: 'pending'}),
			row('e', '2026-06-23', undefined, -7),
			row('f', '2026-07-20', '2026-08-10', -20),
			row('g', '2026-09-03', '2026-09-04', -1),
		]);
		const logger = createCapturingLogger();

		const rows = computeSyntheticPayments(ledger, card, cardConfig, '2026-09-05', logger);

		// 06-10 is within 35 days of the earliest booked row (05-20 + 35 = 06-24) -> partial-cycle skip (logged).
		// 09-04 is newer than today-2 -> not settled yet.
		expect(rows.map(r => [r.id, r.amount, r.bookedDate, r.chargeDate, r.description, r.status, r.synthetic])).toEqual([
			['visaCal:1234:payment:2026-07-10', 100, '2026-07-10', '2026-07-10', 'Card payment Visa Cal 2026-07-10', 'posted', true],
			['visaCal:1234:payment:2026-08-10', 20, '2026-08-10', '2026-08-10', 'Card payment Visa Cal 2026-08-10', 'posted', true],
		]);
		expect(rows[0]).toMatchObject({accountId: card.id, company: 'visaCal', currency: 'ILS', identifier: undefined, idSchemeVersion: 1});
		expect(logger.lines.some(line => line.message.includes('partial') && line.extra?.chargeDate === '2026-06-10')).toBe(true);
		expect(ledger.listSyntheticPayments(card.id).map(payment => [payment.chargeDate, payment.amount])).toEqual([['2026-07-10', 100], ['2026-08-10', 20]]);
	});

	it('freezes amounts: an emitted cycle is never recomputed', () => {
		const ledger = seededLedger([row('a', '2026-01-01', '2026-02-10', -100), row('b', '2026-06-20', '2026-07-10', -50)]);
		const first = computeSyntheticPayments(ledger, card, cardConfig, '2026-09-05');
		expect(first.map(r => r.amount)).toEqual([100, 50]);
		ledger.upsertTransactions(first);

		ledger.upsertTransactions([row('late', '2026-06-30', '2026-07-10', -25)]);
		const second = computeSyntheticPayments(ledger, card, cardConfig, '2026-09-06');
		expect(second).toEqual([]);
		expect(ledger.listSyntheticPayments(card.id).find(payment => payment.chargeDate === '2026-07-10')!.amount).toBe(50);
	});

	it('emits the settle date boundary inclusively', () => {
		const ledger = seededLedger([row('a', '2026-01-01', '2026-02-10', -100), row('b', '2026-08-20', '2026-09-03', -30)]);
		expect(computeSyntheticPayments(ledger, card, cardConfig, '2026-09-04').map(r => r.chargeDate)).toEqual(['2026-02-10']);
		expect(computeSyntheticPayments(ledger, card, cardConfig, '2026-09-05').map(r => r.chargeDate)).toEqual(['2026-09-03']);
	});
});

describe('dates', () => {
	it('computes calendar dates in the bridge timezone', () => {
		expect(calendarDate(new Date('2026-09-05T21:30:00.000Z'), 'Asia/Jerusalem')).toBe('2026-09-06');
		expect(calendarDate(new Date('2026-09-05T21:30:00.000Z'), 'UTC')).toBe('2026-09-05');
		expect(calendarDate(new Date('2026-01-31T22:30:00.000Z'), 'Asia/Jerusalem')).toBe('2026-02-01');
	});

	it('adds days across month and year boundaries', () => {
		expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
		expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
		expect(addDays('2026-02-28', 35)).toBe('2026-04-04');
	});
});

describe('createPostLoginDetector', () => {
	it('matches the known portals', () => {
		const hapoalim = createPostLoginDetector('hapoalim', []);
		expect(hapoalim('https://login.bankhapoalim.co.il/ng-portals/rb/he/homepage')).toBe(true);
		expect(hapoalim('https://login.bankhapoalim.co.il/ng-portals-bt/rb/he/homepage')).toBe(true);
		expect(hapoalim('https://login.bankhapoalim.co.il/ng-portals/auth/he/otp')).toBe(false);

		const cal = createPostLoginDetector('visaCal', []);
		expect(cal('https://digital-web.cal-online.co.il/dashboard')).toBe(true);
		expect(cal('https://www.cal-online.co.il/')).toBe(false);
	});

	it('falls back to "changed and not auth-like" for other companies', () => {
		const generic = createPostLoginDetector('max', ['https://www.max.co.il/login', 'about:blank']);
		expect(generic('https://www.max.co.il/login')).toBe(false);
		expect(generic('https://www.max.co.il/otp/verify')).toBe(false);
		expect(generic('about:blank')).toBe(false);
		expect(generic('https://www.max.co.il/homepage/personal')).toBe(true);
	});
});
