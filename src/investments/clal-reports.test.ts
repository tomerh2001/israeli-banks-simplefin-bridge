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
