import {describe, expect, it} from 'vitest';
import {enrichClalActivities} from './clal-activities.js';
import {clalProductIdentity, type ClalApiResponse} from './clal-portfolio.js';
import type {InvestmentSnapshot} from './types.js';

const observedAt = '2026-09-08T10:00:00.000Z';
const pensionId = clalProductIdentity('pension', 'PENSION-EXAMPLE').id;
const gemelId = clalProductIdentity('hishtalmut', 'FUND-EXAMPLE').id;

function snapshot(): InvestmentSnapshot {
	return {
		observedAt, complete: true, inventoryComplete: true,
		products: [
			{...clalProductIdentity('pension', 'PENSION-EXAMPLE'), kind: 'pension' as const},
			{...clalProductIdentity('hishtalmut', 'FUND-EXAMPLE'), kind: 'keren_hishtalmut' as const},
		].map(item => ({
			...item, provider: 'clal' as const, name: 'Example savings', currency: 'ILS',
			currentValuationId: null, liquidity: {status: 'unknown' as const, availableFrom: null, availableAmount: null},
			coverage: {valuations: 'unavailable' as const, activities: 'unavailable' as const, tracks: 'unavailable' as const}, forecast: null,
		})),
		valuations: [], activities: [], tracks: [],
	};
}

function pensionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		CompanyName: 'Example Employer', DepositingDate: '01/03/2026', SalaryDate: '02/2026',
		Salary: '1,000.00', TigmulimAmit: '20.00', TigmulimMaasik: '30.00', Compensation: '40.00', Total: '90.00',
		...overrides,
	};
}

function pensionResponse(rows = [pensionRow(), pensionRow()]): ClalApiResponse {
	return {status: 200, data: {
		IsSuccess: true, PolicyDetails: {PolicyId: 'PENSION-EXAMPLE'},
		NDepositingList: [{BeginYear: '2026', Total: '180.00', TransactionsData: {
			IsSuccess: true, DepositingPerMonthList: [...rows, pensionRow({CompanyName: 'all', DepositingDate: '', SalaryDate: '', TigmulimAmit: '40.00', TigmulimMaasik: '60.00', Compensation: '80.00', Total: '180.00'})],
		}}],
	}};
}

function gemelRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		TransactionDate: '01/03/26', TransactionDescription: 'הפקדה',
		TotalSumEmployee: '10.00', TotalSumEmployer: '30.00', TotalSumCompensation: '0.00', TotalSumSelfEmployed: '0.00',
		TotalSum: '40.00', Maslul: 'EXAMPLE-TRACK', SalaryMonth: '02/2026', ...overrides,
	};
}

function gemelResponse(): ClalApiResponse {
	return {status: 200, data: {
		IsSuccess: true, IsHishtalmut: true,
		FundDetails: {FundNumber: 'FUND-EXAMPLE', EmployerNum: 'EMPLOYER-EXAMPLE', EmployerName: 'Example Employer'},
		TransactionsTab: {TransactionsList: [
			{Year: '2026', Sum: '40.00', TransactionsData: {IsSuccess: true, GetFundTransPerYearList: [gemelRow(), gemelRow({TransactionDate: null, TransactionDescription: 'Total', Maslul: null, SalaryMonth: null})], GetFundTransPerYearNotIncludedList: []}},
			{Year: null, Sum: '888.88', TransactionsData: {IsSuccess: false, GetFundTransPerYearList: [], GetFundTransPerYearNotIncludedList: []}},
		]},
	}};
}

function pensionYears(response: ClalApiResponse): Array<{Total: string; TransactionsData: {DepositingPerMonthList: Array<Record<string, unknown>>}}> {
	return (response.data as {NDepositingList: Array<{Total: string; TransactionsData: {DepositingPerMonthList: Array<Record<string, unknown>>}}>}).NDepositingList;
}

function gemelYears(response: ClalApiResponse): Array<{Sum: string; TransactionsData: {GetFundTransPerYearList: Array<Record<string, unknown>>}}> {
	return (response.data as {TransactionsTab: {TransactionsList: Array<{Sum: string; TransactionsData: {GetFundTransPerYearList: Array<Record<string, unknown>>}}>}}).TransactionsTab.TransactionsList;
}

describe('Clal deposit source groups', () => {
	it('sums every same-dimension source row instead of deduplicating equal payments', () => {
		const result = enrichClalActivities(snapshot(), {pensionDetails: [pensionResponse()]});
		expect(result.activities).toHaveLength(3);
		expect(result.activities.find(row => row.kind === 'employee_contribution')?.amount).toBe('40.00');
		expect(result.activities.find(row => row.kind === 'employer_contribution')?.amount).toBe('60.00');
		expect(result.activities.find(row => row.kind === 'severance_contribution')?.amount).toBe('80.00');
		expect(result.activities.every(row => row.sourceId.startsWith('source-group-v1:') && row.description.includes('Source group'))).toBe(true);
		expect(result.products.find(row => row.id === pensionId)?.coverage.activities).toBe('partial');
		expect(result.valuations).toEqual([]);
	});

	it('uses actual booking dates and salary months independently, with a source-backed century', () => {
		const result = enrichClalActivities(snapshot(), {gemelDetails: [gemelResponse()]});
		expect(result.activities.every(row => row.date === '2026-03-01' && row.dateKind === 'booking')).toBe(true);
		expect(result.activities.every(row => row.description.includes('Salary month 2026-02'))).toBe(true);
		expect(result.activities.filter(row => row.amount !== '0.00')).toHaveLength(2);
		expect(result.products.find(row => row.id === gemelId)?.coverage.activities).toBe('partial');
	});

	it('excludes only proven annual subtotals and ignores the non-year footer', () => {
		const result = enrichClalActivities(snapshot(), {gemelDetails: [gemelResponse()]});
		expect(result.activities.map(row => row.amount).sort()).toEqual(['0.00', '0.00', '10.00', '30.00']);
		expect(result.activities.every(row => !row.description.includes('Total'))).toBe(true);
	});

	it('retains explicit zero groups so later source corrections can clear previous amounts', () => {
		const response = gemelResponse();
		const before = enrichClalActivities(snapshot(), {gemelDetails: [response]});
		const year = gemelYears(response)[0]!;
		year.Sum = '0.00';
		for (const row of year.TransactionsData.GetFundTransPerYearList) {
			row.TotalSumEmployee = '0.00';
			row.TotalSumEmployer = '0.00';
			row.TotalSum = '0.00';
		}

		const after = enrichClalActivities(snapshot(), {gemelDetails: [response]});
		expect(after.activities.map(row => row.id)).toEqual(before.activities.map(row => row.id));
		expect(after.activities.every(row => row.amount === '0.00')).toBe(true);
	});

	it('changes a grouped amount without changing its identity and ignores source row order', () => {
		const response = pensionResponse();
		const before = enrichClalActivities(snapshot(), {pensionDetails: [response]});
		const block = pensionYears(response)[0]!;
		block.Total = '190.00';
		block.TransactionsData.DepositingPerMonthList[0]!.TigmulimAmit = '30.00';
		block.TransactionsData.DepositingPerMonthList[0]!.Total = '100.00';
		block.TransactionsData.DepositingPerMonthList[2]!.TigmulimAmit = '50.00';
		block.TransactionsData.DepositingPerMonthList[2]!.Total = '190.00';
		block.TransactionsData.DepositingPerMonthList.reverse();
		const after = enrichClalActivities(snapshot(), {pensionDetails: [response]});
		expect(after.activities.map(row => row.id)).toEqual(before.activities.map(row => row.id));
		expect(after.activities.find(row => row.kind === 'employee_contribution')?.amount).toBe('50.00');
	});

	it('keeps distinct employer, salary month and track dimensions even when amounts and booking dates match', () => {
		const response = pensionResponse([pensionRow(), pensionRow({CompanyName: 'Other Example Employer'})]);
		expect(enrichClalActivities(snapshot(), {pensionDetails: [response]}).activities).toHaveLength(6);
		const gemel = gemelResponse();
		const block = gemelYears(gemel)[0]!;
		block.Sum = '80.00';
		block.TransactionsData.GetFundTransPerYearList = [gemelRow(), gemelRow({Maslul: 'SECOND-EXAMPLE-TRACK'})];
		expect(enrichClalActivities(snapshot(), {gemelDetails: [gemel]}).activities).toHaveLength(8);
	});

	it('preserves month-only dates without inventing a booking day', () => {
		const response = pensionResponse([pensionRow({DepositingDate: ''}), pensionRow({DepositingDate: ''})]);
		const result = enrichClalActivities(snapshot(), {pensionDetails: [response]});
		expect(result.activities.every(row => row.date === '2026-02' && row.dateKind === 'contribution_month')).toBe(true);
	});

	it('is idempotent when enriching an existing snapshot', () => {
		const input = {pensionDetails: [pensionResponse()], gemelDetails: [gemelResponse()]};
		const once = enrichClalActivities(snapshot(), input);
		expect(enrichClalActivities(once, input)).toEqual(once);
	});

	it('does not turn period costs, period returns or placeholder historical balances into activity', () => {
		const response = gemelResponse();
		Object.assign(response.data as Record<string, unknown>, {
			PastYearsTransactions: [{DeposDate: '01/01/2005', Total: '99999.00'}],
			DeposMonthlyBalance: {DeposMonthlyList: [{Title: 'Period fee', Total: '-999.00'}]},
		});
		const result = enrichClalActivities(snapshot(), {gemelDetails: [response]});
		expect(result.activities).toHaveLength(4);
		expect(result.valuations).toHaveLength(0);
	});

	it.each(['row-components', 'year-total', 'subtotal', 'unknown-transaction', 'ambiguous-year', 'imprecise-money', 'duplicate-product'])('rejects %s without changing the input snapshot', problem => {
		const base = snapshot();
		const copy = structuredClone(base);
		const response = gemelResponse();
		const year = gemelYears(response)[0]!;
		const rows = year.TransactionsData.GetFundTransPerYearList;
		switch (problem) {
			case 'row-components': {
				rows[0]!.TotalSum = '41.00';
				break;
			}

			case 'year-total': {
				year.Sum = '41.00';
				break;
			}

			case 'subtotal': {
				rows[1]!.TotalSumEmployee = '11.00';
				rows[1]!.TotalSum = '41.00';
				break;
			}

			case 'unknown-transaction': {
				rows[0]!.TransactionDescription = 'העברה';
				break;
			}

			case 'ambiguous-year': {
				rows[0]!.TransactionDate = '01/03/25';
				break;
			}

			case 'imprecise-money': {
				rows[0]!.TotalSumEmployee = '10.001';
				break;
			}

			default: {
				break;
			}
		}

		expect(() => enrichClalActivities(base, {gemelDetails: problem === 'duplicate-product' ? [response, response] : [response]})).toThrow('INVALID_RESPONSE');
		expect(base).toEqual(copy);
	});
});
