import {expect, test} from 'vitest';
import {enrichClalReports} from './clal-reports.js';
import {clalProductIdentity} from './clal-portfolio.js';
import type {InvestmentSnapshot} from './types.js';

test('period totals retain source bounds and signs without creating transactions or wealth', () => {
	const product = {...clalProductIdentity('pension', 'example'), provider: 'clal' as const, kind: 'pension' as const,
		name: 'Example', currency: 'ILS', currentValuationId: null,
		liquidity: {status: 'unknown' as const, availableFrom: null, availableAmount: null},
		coverage: {valuations: 'unavailable' as const, activities: 'unavailable' as const, tracks: 'unavailable' as const}, forecast: null};
	const snapshot: InvestmentSnapshot = {observedAt: '2026-09-08T10:00:00Z', complete: true, inventoryComplete: true,
		products: [product], valuations: [], activities: [], tracks: []};
	const period = {Date: '31/08/2026', PeriodBalanceRows: [
		{Title: 'יתרה ל- 01/01/2026 (פתיחה)', Total: '1000'},
		{Title: 'Reported return', Total: '-12.50'},
		{Title: 'Unavailable cost', Total: ''},
		{Title: 'Zero fee', Total: '0'},
	]};
	const input = {pensionDetails: [{status: 200, data: {IsSuccess: true, PolicyDetails: {PolicyId: 'example'}, PeriodBalance: period}}]};
	const result = enrichClalReports(snapshot, input);
	expect(result.valuations).toEqual([]);
	expect(result.activities).toEqual([]);
	expect(result.products[0]?.reportSummaries?.[0]).toMatchObject({fromDate: '2026-01-01', toDate: '2026-08-31', lines: [
		{label: 'יתרה ל- 01/01/2026 (פתיחה)', amount: '1000.00'},
		{label: 'Reported return', amount: '-12.50'},
		{label: 'Zero fee', amount: '0.00'},
	]});
	expect(snapshot.products[0]?.reportSummaries).toBeUndefined();
	period.PeriodBalanceRows[1]!.Total = '-10.00';
	expect(enrichClalReports(snapshot, input).products[0]?.reportSummaries?.[0]?.id).toBe(result.products[0]?.reportSummaries?.[0]?.id);
});

function historicalFixture() {
	const product = {...clalProductIdentity('hishtalmut', 'synthetic-fund'), provider: 'clal' as const, kind: 'keren_hishtalmut' as const,
		name: 'Example Fund', currency: 'ILS', currentValuationId: 'verified-current',
		liquidity: {status: 'unknown' as const, availableFrom: null, availableAmount: null},
		coverage: {valuations: 'partial' as const, activities: 'unavailable' as const, tracks: 'unavailable' as const}, forecast: null};
	const snapshot: InvestmentSnapshot = {observedAt: '2026-09-08T10:00:00Z', complete: true, inventoryComplete: true,
		products: [product], valuations: [{id: 'verified-current', productId: product.id, amount: '1234.00', currency: 'ILS',
			asOf: '2026-09-07', observedAt: '2026-09-08T10:00:00Z'}], activities: [], tracks: []};
	const input = {gemelDetails: [{status: 200, data: {IsSuccess: true, FundDetails: {FundNumber: 'synthetic-fund'},
		DeposMonthlyBalance: {StartYear: '01/01/2026', EndYear: '31/08/2026', DeposMonthlyList: [
			{Title: 'יתרת הכספים בחשבון ל-01/01/2026 (פתיחה)', Total: '1000'},
			{Title: 'יתרת הכספים בחשבונך ל-31/08/2026', Total: '1200'},
			{Title: 'Reported investment return', Total: '200'},
			{Title: 'Reported fees', Total: '-20'},
		]}}}]};
	return {snapshot, input};
}

test('explicit annual balance dates extend history while preserving current wealth and period totals', () => {
	const {snapshot, input} = historicalFixture();
	const result = enrichClalReports(snapshot, input);
	expect(result.valuations.map(value => [value.asOf, value.amount])).toEqual([
		['2026-09-07', '1234.00'], ['2026-01-01', '1000.00'], ['2026-08-31', '1200.00'],
	]);
	expect(result.products[0]?.currentValuationId).toBe('verified-current');
	expect(result.activities).toEqual([]);
	expect(snapshot.valuations).toHaveLength(1);
	expect(enrichClalReports(result, input)).toEqual(result);
	expect(result.products[0]?.reportSummaries?.[0]?.lines).toHaveLength(4);
});

test('excludes template lifetime origins, mismatched dates, undated and negative report values', () => {
	const {snapshot, input} = historicalFixture();
	const report = input.gemelDetails[0]!.data.DeposMonthlyBalance;
	report.StartYear = '01/01/2005';
	report.DeposMonthlyList[0]!.Title = 'יתרת הכספים בחשבון ל-01/01/2005 (פתיחה)';
	report.DeposMonthlyList[0]!.Total = '0';
	expect(enrichClalReports(snapshot, input).valuations).toEqual(snapshot.valuations);
	report.StartYear = '01/01/2026';
	report.DeposMonthlyList[1]!.Title = 'יתרת הכספים בחשבונך ל-30/08/2026';
	expect(enrichClalReports(snapshot, input).valuations).toEqual(snapshot.valuations);
	report.DeposMonthlyList[0]!.Title = 'יתרה צבורה (פתיחה)';
	report.DeposMonthlyList[1]!.Title = 'יתרת הכספים בחשבונך ל-31/08/2026';
	report.DeposMonthlyList[1]!.Total = '-2';
	expect(enrichClalReports(snapshot, input).valuations).toEqual(snapshot.valuations);
});

test('preserves a directly reported valuation on the same date and a documented zero annual opening', () => {
	const {snapshot, input} = historicalFixture();
	snapshot.valuations[0]!.asOf = '2026-08-31';
	input.gemelDetails[0]!.data.DeposMonthlyBalance.DeposMonthlyList[0]!.Total = '0';
	const result = enrichClalReports(snapshot, input);
	expect(result.valuations.map(value => value.amount)).toEqual(['1234.00', '0.00']);
	expect(result.products[0]?.currentValuationId).toBe('verified-current');
});
