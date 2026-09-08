import {describe, expect, it} from 'vitest';
import {
	BestInvestParseError,
	buildBestInvestSnapshot,
	parseBestInvestDate,
	parseBestInvestJson,
	parseBestInvestMoney,
} from './parser.js';

const observedAt = '2026-09-08T10:00:00.000Z';

/** Entirely synthetic examples; never substitute captured account values in this file. */
function fixture() {
	return {
		observedAt, inventoryComplete: true,
		policies: [{
			expectedPolicyId: 'SYNTHETIC-POLICY-01',
			details: {
				PolicyId: 'SYNTHETIC-POLICY-01', ProductName: 'Example investment policy',
				TotalSavings: '1,250.25', UpdatedToDate: '2026-09-08T00:00:00',
				ManagementFeeTzviraPercentage: '0.75', ManagementFeePremiumPercentage: '0',
				PidyonTzvira: {
					AppraislDate: '2026-09-07T00:00:00', TotalTzviraMaslulim: '1250.25',
					Pidyon: [
						{BeitHashkaot: 'Example house A', Maslul: 'Example route A', TotalTzvira: '1000.10'},
						{BeitHashkaot: 'Example house B', Maslul: 'Example route B', TotalTzvira: '250.15'},
					],
				},
				InvestmentPolicy: {
					Investments: [
						{BeitHashkaotName: 'Example house A', Maslul: 'Example route A', BeitHashkaotId: 'HOUSE-A', MaslulId: 'ROUTE-A', TagmulimPrat: '90'},
						{BeitHashkaotName: 'Example house B', Maslul: 'Example route B', BeitHashkaotId: 'HOUSE-B', MaslulId: 'ROUTE-B', TagmulimPrat: '10'},
					],
				},
				PolicyRouteAnnualCosts: [{InvestmentCode: 'ROUTE-A', TotalAnnualCost: '1.25'}],
			},
			depositsYear: 2026,
			deposits: {
				PolicyStartYear: '2020',
				Deposits: [
					{Amount: '100.25', ErechDate: '2026-01-02T00:00:00'},
					{Amount: '100.25', ErechDate: '2026-01-02T00:00:00'},
					{Amount: '-0.50', ErechDate: '2026-01-03T00:00:00'},
				],
				TotalAmount: '200.00',
			},
		}],
	};
}

describe('Best Invest exact source parsing', () => {
	it('preserves original JSON number tokens before binary conversion', () => {
		const value = parseBestInvestJson('{"integer":9007199254740993,"decimal":0.123456789012345678901,"exponent":1e-3,"negative":-0.00}');
		expect(value).toEqual({integer: '9007199254740993', decimal: '0.123456789012345678901', exponent: '1e-3', negative: '-0.00'});
		const ordinary = {text: '12.30 and "quoted" with a slash \\', enabled: true, absent: null};
		expect(parseBestInvestJson(JSON.stringify(ordinary))).toEqual(ordinary);
	});

	it.each(['{"amount":01}', '{"amount":1.}', '{"amount":NaN}', '{"amount":Infinity}', '{"amount":-}', '{"private-example":'])('rejects malformed JSON without exposing its contents', input => {
		expect(() => parseBestInvestJson(input)).toThrow(/^INVALID_RESPONSE$/);
	});

	it('normalizes signed locale money using integer cents, without rounding', () => {
		expect(parseBestInvestMoney('  +1,234.5 ')).toBe('1234.50');
		expect(parseBestInvestMoney('-1,234.5')).toBe('-1234.50');
		expect(parseBestInvestMoney('00012')).toBe('12.00');
		expect(parseBestInvestMoney('-0.00')).toBe('0.00');
		expect(parseBestInvestMoney(12)).toBe('12.00');
		expect(parseBestInvestMoney('12345678901234567890.01')).toBe('12345678901234567890.01');
	});

	it.each([
		null, undefined, '', true, 0.1, Number.MAX_SAFE_INTEGER + 1, '1.001', '1e3', '12,34.56', '1.234,50', '₪1.00', 'NaN', 'Infinity', '--1',
	])('rejects ambiguous or already-rounded money %s', value => {
		expect(() => parseBestInvestMoney(value)).toThrow(/^INVALID_RESPONSE$/);
	});

	it('retains provider dates without timezone shifting or guessed abbreviated years', () => {
		expect(parseBestInvestDate('2026-08-31T23:30:00-02:00')).toBe('2026-08-31');
		expect(parseBestInvestDate('2026-08-31T00:00:00.000Z')).toBe('2026-08-31');
		expect(parseBestInvestDate('31.08.2026')).toBe('2026-08-31');
		expect(parseBestInvestDate('31/08/2026')).toBe('2026-08-31');
		expect(parseBestInvestDate(null)).toBeNull();
		expect(parseBestInvestDate('0001-01-01T00:00:00')).toBeNull();
		for (const value of ['31/08/26', '2026-08', '31.02.2026', '31/08.2026', '2026-08-31 garbage', '2026-08-31T25:00:00']) {
			expect(() => parseBestInvestDate(value)).toThrow(/^INVALID_RESPONSE$/);
		}
	});
});

describe('Best Invest snapshots', () => {
	it('imports a policy balance and reconciled identified tracks without double-counting', () => {
		const result = buildBestInvestSnapshot(fixture());
		expect(result).toMatchObject({complete: true, inventoryComplete: true, activities: []});
		expect(result.products).toHaveLength(1);
		expect(result.products[0]).toMatchObject({
			provider: 'hachshara_best_invest', kind: 'investment', currency: 'ILS',
			coverage: {valuations: 'partial', activities: 'unavailable', tracks: 'complete'},
			liquidity: {status: 'unknown', availableAmount: null},
		});
		expect(result.products[0]!.id).toMatch(/^hachshara_best_invest:/);
		expect(result.valuations).toHaveLength(1);
		expect(result.valuations[0]).toMatchObject({amount: '1250.25', asOf: '2026-09-07'});
		expect(result.products[0]!.currentValuationId).toBe(result.valuations[0]!.id);
		expect(result.tracks.map(track => track.amount)).toEqual(['1000.10', '250.15']);
		expect(result.tracks.every(track => track.allocationPercent === null && track.asOf === '2026-09-07')).toBe(true);
	});

	it('uses stable house/route codes even when names, order and balances change', () => {
		const input = fixture();
		const before = buildBestInvestSnapshot(input);
		const detail = input.policies[0]!.details;
		detail.ProductName = 'Renamed example policy';
		detail.TotalSavings = '1250.35';
		detail.PidyonTzvira.TotalTzviraMaslulim = '1250.35';
		detail.PidyonTzvira.Pidyon[0]!.TotalTzvira = '1000.20';
		detail.PidyonTzvira.Pidyon[0]!.Maslul = 'Renamed example route';
		detail.InvestmentPolicy.Investments[0]!.Maslul = 'Renamed example route';
		detail.PidyonTzvira.Pidyon.reverse();
		detail.InvestmentPolicy.Investments.reverse();
		const after = buildBestInvestSnapshot(input);
		expect(after.products[0]!.id).toBe(before.products[0]!.id);
		expect(after.valuations[0]!.id).toBe(before.valuations[0]!.id);
		expect(after.tracks.map(track => track.id).sort()).toEqual(before.tracks.map(track => track.id).sort());
	});

	it('uses UpdatedToDate only for the exact provider minimum-date fallback', () => {
		const input = fixture();
		input.policies[0]!.details.PidyonTzvira.AppraislDate = '0001-01-01T00:00:00';
		const result = buildBestInvestSnapshot(input);
		expect(result.valuations[0]!.asOf).toBe('2026-09-08');
		Object.assign(input.policies[0]!.details.PidyonTzvira, {AppraislDate: null});
		expect(buildBestInvestSnapshot(input).valuations[0]!.asOf).toBeNull();
	});

	it('preserves repeated payments and reversals only in a report total, never as ledger rows', () => {
		const result = buildBestInvestSnapshot(fixture());
		expect(result.activities).toEqual([]);
		expect(result.products[0]!.reportSummaries).toEqual([{
			id: `${result.products[0]!.id}:deposits:2026`,
			title: 'הפקדות שדווחו לשנת 2026', fromDate: null, toDate: null,
			lines: [{label: 'סך הפקדות שדווחו', amount: '200.00'}],
		}]);
		expect(result.products[0]!.coverage.activities).toBe('unavailable');
		expect(result.products[0]!.reportSummaries!.flatMap(report => report.lines)).toHaveLength(1);
	});

	it('does not require the optional deposits report to import verified balances', () => {
		const input = fixture();
		const {deposits: _deposits, depositsYear: _year, ...policy} = input.policies[0]!;
		const result = buildBestInvestSnapshot({...input, policies: [policy]});
		expect(result.complete).toBe(true);
		expect(result.products[0]!.reportSummaries).toEqual([]);
	});

	it('requires an explicit requested year and a reconciled supplied deposit response', () => {
		const input = fixture();
		Object.assign(input.policies[0]!, {depositsYear: undefined});
		expect(() => buildBestInvestSnapshot(input)).toThrow(BestInvestParseError);
		input.policies[0]!.depositsYear = 2026;
		input.policies[0]!.deposits.TotalAmount = '100.25';
		expect(buildBestInvestSnapshot(input)).toMatchObject({complete: false, inventoryComplete: false});
	});

	it('keeps missing and partial products from replacing any saved collection', () => {
		const input = fixture();
		expect(buildBestInvestSnapshot({...input, inventoryComplete: false})).toMatchObject({complete: false, inventoryComplete: false});
		expect(buildBestInvestSnapshot({...input, policies: []})).toMatchObject({complete: false, inventoryComplete: false});
		expect(buildBestInvestSnapshot({...input, policies: [...input.policies, {details: null}]})).toMatchObject({complete: false, inventoryComplete: false});
		Object.assign(input.policies[0]!.details, {TotalSavings: null});
		const result = buildBestInvestSnapshot(input);
		expect(result.complete).toBe(false);
		expect(result.valuations).toEqual([]);
		expect(result.products[0]!.currentValuationId).toBeNull();
	});

	it('rejects duplicate policy identities, wrong inventory identities, and negative balances', () => {
		const input = fixture();
		expect(() => buildBestInvestSnapshot({...input, policies: [...input.policies, ...input.policies]})).toThrow(/^INVALID_RESPONSE$/);
		input.policies[0]!.expectedPolicyId = 'OTHER-SYNTHETIC-POLICY';
		expect(() => buildBestInvestSnapshot(input)).toThrow(/^INVALID_RESPONSE$/);
		input.policies[0]!.expectedPolicyId = 'SYNTHETIC-POLICY-01';
		input.policies[0]!.details.TotalSavings = '-1.00';
		expect(() => buildBestInvestSnapshot(input)).toThrow(/^INVALID_RESPONSE$/);
	});

	it('marks unmatched, ambiguous, or unreconciled tracks incomplete', () => {
		for (const mutate of [
			(input: ReturnType<typeof fixture>) => Object.assign(input.policies[0]!.details.PidyonTzvira, {TotalTzviraMaslulim: '1250.24'}),
			(input: ReturnType<typeof fixture>) => Object.assign(input.policies[0]!.details.PidyonTzvira.Pidyon[0]!, {TotalTzvira: '1000.11'}),
			(input: ReturnType<typeof fixture>) => input.policies[0]!.details.InvestmentPolicy.Investments.pop(),
			(input: ReturnType<typeof fixture>) => {
				const rows = input.policies[0]!.details.InvestmentPolicy.Investments;
				rows.push({...rows[0]!});
			},
			(input: ReturnType<typeof fixture>) => Object.assign(input.policies[0]!.details.InvestmentPolicy.Investments[0]!, {MaslulId: null}),
		]) {
			const input = fixture();
			mutate(input);
			const result = buildBestInvestSnapshot(input);
			expect(result).toMatchObject({complete: false, inventoryComplete: false, tracks: []});
		}
	});

	it('uses lexical numeric balances from JSON and rejects direct fractional JS money', () => {
		const input = fixture();
		const response = JSON.stringify(input.policies[0]!.details).replace('"1000.10"', '1000.10').replace('"250.15"', '250.15');
		const policy = {...input.policies[0]!, details: parseBestInvestJson(response)};
		expect(buildBestInvestSnapshot({...input, policies: [policy]}).complete).toBe(true);
		policy.details = JSON.parse(response) as unknown;
		expect(() => buildBestInvestSnapshot({...input, policies: [policy]})).toThrow(/^INVALID_RESPONSE$/);
	});
});
