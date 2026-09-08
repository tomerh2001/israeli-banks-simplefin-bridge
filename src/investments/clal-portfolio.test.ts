import {describe, expect, it} from 'vitest';
import {clalProductIdentity, parseClalDate, parseClalMoney, parseClalPortfolioSnapshot, requireClalSuccess} from './clal-portfolio.js';
import {investmentValuationId} from './ids.js';

const observedAt = '2026-09-08T10:00:00.000Z';
const success = {IsSuccess: true, IsGeneralError: false};

function gemelDetail(account: string, amount: string) {
	return {status: 200, data: {
		...success, IsHishtalmut: true, IsGemelDailyBalanceSuccess: true,
		FundDetails: {FundNumber: account, Balance: amount, ProfitUpdateDate: '07.09.2026', DateNazil1: '01/01/2028', DateNazil2: '', DateNazil3: ''},
		MaslulimTab: {BalanceSum: amount, Maslulim: [
			{Name: 'Example equity track', ConfirmationCode: 'CONFIRMATION-EXAMPLE', ProductCode: 'PRODUCT-EXAMPLE', KupaCode: 'FUND-EXAMPLE', CurrentBalance: amount, ValidateDate: '06/09/26', Percent: '99.9'},
			{Name: 'Inactive example track', ConfirmationCode: 'CONFIRMATION-INACTIVE', ProductCode: 'PRODUCT-INACTIVE', KupaCode: 'FUND-INACTIVE', CurrentBalance: '0.00', ValidateDate: '01/01/14', Percent: '0'},
		]},
	}};
}

function fixture() {
	return {
		observedAt,
		portfolio: {status: 200, data: {
			...success,
			PortfolioDataPensionFundation: [{PolicyId: 'ACCOUNT-EXAMPLE', PensionPlanName: 'Example pension', BalanceTotal: '  12,345.67', BalanceTotalSum: 12_345.67, ValidationDate: '31.08.2026'}],
			PortfolioDataGemelHichudList: [
				{InsuranceNumber: 'ACCOUNT-EXAMPLE', InsuranceName: 'Example study fund A', IsHishtalmut: true, Balance: null},
				{InsuranceNumber: 'SECOND-EXAMPLE', InsuranceName: 'Example study fund B', IsHishtalmut: true, Balance: null},
			],
			PortfolioDataGemelList: [],
		}},
		dailyBalances: {status: 200, data: {
			...success, AllPoliciesFoundInCache: true,
			GemelDailyBalanceData: {...success, GetDailyBalanceItemFailed: false, Items: [
				{InsuranceNumber: 'ACCOUNT-EXAMPLE', Balance: '1,234.56', ProfitUpdateDate: '07.09.2026', Paths: [{MOFCode: 'UNVERIFIED-EXAMPLE', Ammount: -123.12345678}]},
				{InsuranceNumber: 'SECOND-EXAMPLE', Balance: '678.90', ProfitUpdateDate: '07.09.2026', Paths: []},
			]},
		}},
		pensionDetails: [{status: 200, data: {
			...success,
			PolicyDetails: {PolicyId: 'ACCOUNT-EXAMPLE', BalanceTotal: '12,345.67'},
			PeriodBalance: {Date: '31/08/2026'},
			hasPolicyInsCoverages: true, PolicyInsCoverages: {PensiaPrisha: '1,234.50'},
			InvestmentTracks: {InvestmentTracksRows: [{TrackNum: 'TRACK-EXAMPLE', TrackName: 'Example pension track'}]},
		}}],
		gemelDetails: [gemelDetail('ACCOUNT-EXAMPLE', '1,234.56'), gemelDetail('SECOND-EXAMPLE', '678.90')],
	};
}

describe('Clal source field parsing', () => {
	it('preserves exact formatted monetary strings and normalizes cents without rounding', () => {
		expect(parseClalMoney('  12,345.67 ')).toBe('12345.67');
		expect(parseClalMoney('12345678901234567890.01')).toBe('12345678901234567890.01');
		expect(parseClalMoney('-1,234.5')).toBe('-1234.50');
		expect(parseClalMoney('00012')).toBe('12.00');
		expect(parseClalMoney('-0.00')).toBe('0.00');
	});

	it.each([null, undefined, '', 0, 123.45, '1.001', '1e3', '12,34.56', '₪1.00', 'NaN', 'Infinity'])('rejects missing or inexact money %s', value => {
		expect(() => parseClalMoney(value)).toThrow('INVALID_RESPONSE');
	});

	it('parses real source dates and never supplies missing days, years or valuation dates', () => {
		expect(parseClalDate('31.08.2026')).toBe('2026-08-31');
		expect(parseClalDate('31/08/2026')).toBe('2026-08-31');
		expect(parseClalDate('2026-08-31')).toBe('2026-08-31');
		expect(parseClalDate(null)).toBeNull();
		expect(parseClalDate(' ')).toBeNull();
		for (const value of ['31/08/26', '2026-08', '31.02.2026', '31/08.2026', 'unavailable']) {
			expect(() => parseClalDate(value)).toThrow('INVALID_RESPONSE');
		}
	});

	it('rejects failed envelopes without leaking their error text', () => {
		expect(() => requireClalSuccess({IsSuccess: false, ErrorMessage: 'private example diagnostic'})).toThrow(/^INVALID_RESPONSE$/);
		expect(() => requireClalSuccess({...success, ResponseIsAppErrorIsAppError: true})).toThrow('INVALID_RESPONSE');
	});
});

describe('verified Clal portfolio snapshots', () => {
	it('maps all target products to distinct family identities and authoritative current valuations', () => {
		const result = parseClalPortfolioSnapshot(fixture());
		expect(result).toMatchObject({observedAt, complete: true, inventoryComplete: true, activities: []});
		expect(result.products.map(row => row.kind)).toEqual(['pension', 'keren_hishtalmut', 'keren_hishtalmut']);
		expect(new Set(result.products.map(row => row.id)).size).toBe(3);
		expect(result.valuations.map(row => row.amount)).toEqual(['12345.67', '1234.56', '678.90']);
		expect(result.valuations.map(row => row.asOf)).toEqual(['2026-08-31', '2026-09-07', '2026-09-07']);
		for (const item of result.products) {
			const value = result.valuations.find(row => row.id === item.currentValuationId)!;
			expect(value.productId).toBe(item.id);
			expect(value.id).toBe(investmentValuationId(item.id, value.asOf));
			expect(item.coverage).toMatchObject({valuations: 'partial', activities: 'unavailable'});
		}
	});

	it('uses provider IDs, not names, ordering, or balances to identify products', () => {
		const input = fixture();
		const before = parseClalPortfolioSnapshot(input);
		input.portfolio.data.PortfolioDataPensionFundation[0]!.PensionPlanName = 'Renamed example pension';
		input.gemelDetails.reverse();
		input.dailyBalances.data.GemelDailyBalanceData.Items.reverse();
		const after = parseClalPortfolioSnapshot(input);
		expect(after.products.map(row => row.id)).toEqual(before.products.map(row => row.id));
		expect(clalProductIdentity('pension', 'ACCOUNT-EXAMPLE').id).not.toBe(clalProductIdentity('hishtalmut', 'ACCOUNT-EXAMPLE').id);
	});

	it('uses only identified detail tracks; ignores unverified daily path amounts and inactive routes', () => {
		const result = parseClalPortfolioSnapshot(fixture());
		expect(result.tracks).toHaveLength(3);
		expect(result.tracks[0]).toMatchObject({name: 'Example pension track', amount: null, allocationPercent: null, asOf: null});
		expect(result.tracks[1]).toMatchObject({name: 'Example equity track', amount: '1234.56', allocationPercent: null, asOf: '2026-09-06'});
		expect(result.tracks.every(row => !row.id.includes('UNVERIFIED') && !row.id.includes('INACTIVE'))).toBe(true);
	});

	it('keeps forecast estimates separate from the actual value and does not invent forecast dates', () => {
		const result = parseClalPortfolioSnapshot(fixture());
		expect(result.products[0]!.forecast).toEqual({monthlyPension: '1234.50', currency: 'ILS', asOf: null});
		expect(result.valuations).toHaveLength(3);
		expect(result.products[0]!.liquidity.status).toBe('unknown');
	});

	it('uses the verified all-funds liquidity field and does not invent available amounts', () => {
		const input = fixture();
		input.gemelDetails[1]!.data.FundDetails.DateNazil1 = '01/01/2020';
		const result = parseClalPortfolioSnapshot(input);
		expect(result.products[1]!.liquidity).toEqual({status: 'restricted', availableFrom: '2028-01-01', availableAmount: null});
		expect(result.products[2]!.liquidity).toEqual({status: 'available', availableFrom: '2020-01-01', availableAmount: null});
		input.gemelDetails[0]!.data.FundDetails.DateNazil1 = '';
		input.gemelDetails[0]!.data.FundDetails.DateNazil3 = '01/01/2020';
		expect(parseClalPortfolioSnapshot(input).products[1]!.liquidity.status).toBe('unknown');
	});

	it('keeps a track date unknown when its abbreviated year cannot be verified from the product source year', () => {
		const input = fixture();
		input.gemelDetails[0]!.data.MaslulimTab.Maslulim[0]!.ValidateDate = '06/09/25';
		expect(parseClalPortfolioSnapshot(input).tracks[1]!.asOf).toBeNull();
	});

	it('retains unknown valuation dates without replacing them with observation dates', () => {
		const input = fixture();
		Object.assign(input.portfolio.data.PortfolioDataPensionFundation[0]!, {ValidationDate: null});
		Object.assign(input.pensionDetails[0]!.data.PeriodBalance, {Date: null});
		const result = parseClalPortfolioSnapshot(input);
		expect(result.complete).toBe(true);
		expect(result.valuations[0]!.asOf).toBeNull();
		expect(result.valuations[0]!.id).toMatch(/:undated$/);
	});

	it('marks the entire result incomplete when any target detail response is missing', () => {
		const input = fixture();
		input.gemelDetails.pop();
		const result = parseClalPortfolioSnapshot(input);
		expect(result).toMatchObject({complete: false, inventoryComplete: false});
		expect(result.products).toHaveLength(3);
	});

	it('does not turn missing provider balances into zero or use numeric homepage aggregates', () => {
		const input = fixture();
		Object.assign(input.portfolio.data.PortfolioDataPensionFundation[0]!, {BalanceTotal: null, BalanceTotalSum: 0});
		input.dailyBalances.data.GemelDailyBalanceData.Items.pop();
		const result = parseClalPortfolioSnapshot(input);
		expect(result.complete).toBe(false);
		expect(result.products[0]!.currentValuationId).toBeNull();
		expect(result.products[2]!.currentValuationId).toBeNull();
		expect(result.valuations.map(row => row.amount)).toEqual(['1234.56']);
	});

	it('requires successful home, cache, and detail envelopes', () => {
		for (const mutate of [
			(input: ReturnType<typeof fixture>) => Object.assign(input.portfolio, {status: 500}),
			(input: ReturnType<typeof fixture>) => Object.assign(input.dailyBalances.data.GemelDailyBalanceData, {IsSuccess: false}),
			(input: ReturnType<typeof fixture>) => Object.assign(input.gemelDetails[1]!.data, {IsSuccess: false}),
			(input: ReturnType<typeof fixture>) => Object.assign(input.pensionDetails[0]!.data, {IsGeneralError: true}),
		]) {
			const input = fixture();
			mutate(input);
			expect(() => parseClalPortfolioSnapshot(input)).toThrow('INVALID_RESPONSE');
		}
	});

	it('rejects duplicate identities and detail responses belonging to another account', () => {
		const duplicate = fixture();
		duplicate.portfolio.data.PortfolioDataPensionFundation.push({...duplicate.portfolio.data.PortfolioDataPensionFundation[0]!});
		expect(() => parseClalPortfolioSnapshot(duplicate)).toThrow('INVALID_RESPONSE');
		const unrelated = fixture();
		unrelated.gemelDetails[0]!.data.FundDetails.FundNumber = 'UNRELATED-EXAMPLE';
		expect(() => parseClalPortfolioSnapshot(unrelated)).toThrow('INVALID_RESPONSE');
	});

	it('does not apply inconsistent cache, headline, or track balances', () => {
		for (const mutate of [
			(input: ReturnType<typeof fixture>) => Object.assign(input.dailyBalances.data, {AllPoliciesFoundInCache: false}),
			(input: ReturnType<typeof fixture>) => Object.assign(input.pensionDetails[0]!.data.PolicyDetails, {BalanceTotal: '1.00'}),
			(input: ReturnType<typeof fixture>) => Object.assign(input.gemelDetails[0]!.data.MaslulimTab.Maslulim[0]!, {CurrentBalance: '1.00'}),
			(input: ReturnType<typeof fixture>) => Object.assign(input.gemelDetails[0]!.data.MaslulimTab, {BalanceSum: '1.00'}),
		]) {
			const input = fixture();
			mutate(input);
			expect(parseClalPortfolioSnapshot(input)).toMatchObject({complete: false, inventoryComplete: false});
		}
	});
});
