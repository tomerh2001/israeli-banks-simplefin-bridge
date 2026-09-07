import {describe, expect, it} from 'vitest';
import {
	MAX_ID_LENGTH,
	accountId,
	accountNumberFromAccountId,
	assignTransactionIds,
	holdingId,
	normalizeIdentifier,
	syntheticPaymentId,
	transactionFingerprint,
	transactionId,
} from './ids.js';
import {ID_SCHEME_VERSION, type LedgerTransaction} from './types.js';

const baseParts = {bookedDate: '2024-02-01', amount: -120.5, description: 'עמלת ניהול', memo: ''};

function row(overrides: Partial<Omit<LedgerTransaction, 'id'>> = {}): Omit<LedgerTransaction, 'id'> {
	return {
		accountId: 'hapoalim:00-000-000001',
		company: 'hapoalim',
		identifier: '51',
		bookedDate: '2024-02-01',
		chargeDate: '2024-02-01',
		amount: -120.5,
		currency: 'ILS',
		description: 'עמלת ניהול',
		memo: undefined,
		status: 'posted',
		installmentNumber: undefined,
		installmentTotal: undefined,
		originalAmount: -120.5,
		originalCurrency: 'ILS',
		category: undefined,
		synthetic: false,
		firstSeen: '2024-02-02T03:00:00.000Z',
		lastSeen: '2024-02-02T03:00:00.000Z',
		idSchemeVersion: ID_SCHEME_VERSION,
		raw: undefined,
		...overrides,
	};
}

describe('normalizeIdentifier', () => {
	it('rejects missing and unusable values', () => {
		for (const value of [undefined, null, '', ' '.repeat(3), 0, '0', '000', NaN, 'undefined', 'undefined_3', 'undefinedX', true, {}]) {
			expect(normalizeIdentifier(value), JSON.stringify(value)).toBeUndefined();
		}
	});

	it('keeps usable values as trimmed strings', () => {
		expect(normalizeIdentifier(51)).toBe('51');
		expect(normalizeIdentifier(987_654_321)).toBe('987654321');
		expect(normalizeIdentifier(' ARN123 ')).toBe('ARN123');
		expect(normalizeIdentifier('12345_2')).toBe('12345_2');
	});
});

describe('accountId', () => {
	it('joins company and account number', () => {
		expect(accountId('hapoalim', '00-000-000001')).toBe('hapoalim:00-000-000001');
		expect(accountId('visaCal', ' 1234 ')).toBe('visaCal:1234');
	});

	it('percent-encodes separators and non-ASCII and round-trips', () => {
		const id = accountId('leumi', 'חשבון:1/2');
		expect(id).toMatch(/^leumi:[\w%\-.]+$/);
		expect(id).not.toContain('חשבון');
		expect(accountNumberFromAccountId(id)).toBe('חשבון:1/2');
	});
});

describe('transactionFingerprint', () => {
	it('is deterministic and 16 hex chars', () => {
		const a = transactionFingerprint(baseParts);
		expect(a).toMatch(/^[\da-f]{16}$/);
		expect(transactionFingerprint({...baseParts})).toBe(a);
	});

	it('ignores memo whitespace and treats missing memo as empty', () => {
		const a = transactionFingerprint(baseParts);
		expect(transactionFingerprint({...baseParts, memo: undefined})).toBe(a);
		expect(transactionFingerprint({...baseParts, memo: '  '})).toBe(a);
		expect(transactionFingerprint({...baseParts, description: ' עמלת ניהול '})).toBe(a);
	});

	it('changes with every frozen field', () => {
		const a = transactionFingerprint(baseParts);
		expect(transactionFingerprint({...baseParts, bookedDate: '2024-02-02'})).not.toBe(a);
		expect(transactionFingerprint({...baseParts, amount: -120.51})).not.toBe(a);
		expect(transactionFingerprint({...baseParts, description: 'x'})).not.toBe(a);
		expect(transactionFingerprint({...baseParts, memo: 'm'})).not.toBe(a);
		expect(transactionFingerprint({...baseParts, installmentNumber: 1, installmentTotal: 3})).not.toBe(a);
		expect(transactionFingerprint({...baseParts, installmentNumber: 1, installmentTotal: 3}))
			.not.toBe(transactionFingerprint({...baseParts, installmentNumber: 2, installmentTotal: 3}));
	});

	it('rounds the amount to two decimals', () => {
		expect(transactionFingerprint({...baseParts, amount: -120.504})).toBe(transactionFingerprint({...baseParts, amount: -120.5}));
	});
});

describe('transactionId', () => {
	const fingerprint = 'abcdef0123456789';

	it('builds the documented shape', () => {
		expect(transactionId({company: 'hapoalim', accountNumber: '00-000-000001', identifier: '51', fingerprint}))
			.toBe(`hapoalim:00-000-000001:51:${fingerprint}`);
		expect(transactionId({company: 'visaCal', accountNumber: '1234', identifier: undefined, fingerprint}))
			.toBe(`visaCal:1234:-:${fingerprint}`);
	});

	it('adds ordinals from 2 on', () => {
		const base = transactionId({company: 'visaCal', accountNumber: '1234', identifier: 'x', fingerprint});
		expect(transactionId({company: 'visaCal', accountNumber: '1234', identifier: 'x', fingerprint, ordinal: 1})).toBe(base);
		expect(transactionId({company: 'visaCal', accountNumber: '1234', identifier: 'x', fingerprint, ordinal: 2})).toBe(`${base}#2`);
	});

	it('is ASCII even for Hebrew/colon identifiers', () => {
		const id = transactionId({company: 'max', accountNumber: '5678', identifier: 'א:ב#1', fingerprint});
		expect([...id].every(character => (character.codePointAt(0) ?? 0) < 0x7F)).toBe(true);
		expect(id.split(':')).toHaveLength(4);
	});

	it('refuses ids longer than 255 characters', () => {
		expect(() => transactionId({company: 'max', accountNumber: '5678', identifier: 'x'.repeat(MAX_ID_LENGTH), fingerprint})).toThrow(/255/);
	});
});

describe('assignTransactionIds', () => {
	it('gives identical rows stable ordinals and keeps input order', () => {
		const rows = [row(), row(), row({amount: -35})];
		const assigned = assignTransactionIds(rows);
		expect(assigned).toHaveLength(3);
		expect(assigned[0]!.id).toMatch(/^hapoalim:00-000-000001:51:[\da-f]{16}$/);
		expect(assigned[1]!.id).toBe(`${assigned[0]!.id}#2`);
		expect(assigned[2]!.id).not.toBe(assigned[0]!.id);
		expect(assigned[2]!.amount).toBe(-35);
		expect(assignTransactionIds(rows).map(item => item.id)).toEqual(assigned.map(item => item.id));
	});

	it('orders ordinals by chargeDate, identifier, then scraper order', () => {
		const late = row({chargeDate: '2024-02-05'});
		const early = row({chargeDate: '2024-02-01'});
		const assigned = assignTransactionIds([late, early]);
		expect(assigned[1]!.id).not.toContain('#');
		expect(assigned[0]!.id).toMatch(/#2$/);
	});

	it('uses "-" for rows without a usable identifier', () => {
		const [assigned] = assignTransactionIds([row({identifier: undefined})]);
		expect(assigned!.id).toContain(':-:');
	});

	it('handles an empty batch', () => {
		expect(assignTransactionIds([])).toEqual([]);
	});
});

describe('syntheticPaymentId / holdingId', () => {
	it('builds payment ids', () => {
		expect(syntheticPaymentId('visaCal', '1234', '2024-03-02')).toBe('visaCal:1234:payment:2024-03-02');
	});

	it('slugs holding descriptions and prefers symbols', () => {
		expect(holdingId('hapoalim:1', 'AAPL')).toBe('hapoalim:1:aapl');
		expect(holdingId('hapoalim:1', ' S&P 500 ETF  (Acc) ')).toBe('hapoalim:1:s-p-500-etf-acc');
		const hebrew = holdingId('hapoalim:1', 'תל אביב 35');
		expect(hebrew).toMatch(/^hapoalim:1:[\d\-a-z]+$/);
		expect(holdingId('hapoalim:1', 'תל אביב 35')).toBe(hebrew);
	});
});
