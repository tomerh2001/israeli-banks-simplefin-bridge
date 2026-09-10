import {describe, expect, it} from 'vitest';
import {parseMytradeJson} from './browser.js';
import {buildHapoalimSnapshot, parseHapoalimExecution, sourceDecimal} from './parser.js';

const input = {accountSelector: '00-111-222222', from: '2023-01-01', to: '2026-09-10', observedAt: '2026-09-10T12:00:00Z'};
function fixture() {
	return {
		Branch: 111, Account: 222_222, Security: '1234567', ISIN: 'US0000000000', Symbol: 'EXAMPLE', EngName: 'Synthetic security',
		TradeDate: '2026-09-01T00:00:00.0000000+03:00', ValueDate: null, SettlementDate: '2026-09-02T00:00:00.0000000+03:00',
		CancelDate: null, IsCancelTransaction: 'לא', TradeType: 'קניה', TransactionType: 'קניה', PaymentType: null,
		PaymentDate: null, ExDate: null, NV: 0.125, TradePrice: 20.1234, NetValueTradeCurrency: -2.52,
		TradeCurrency: 'דולר ארה"ב', NetValueSettlementCurrency: -2.52, SettlementCurrency: 'דולר ארה"ב',
	};
}

function snapshot(executions: unknown[] = [fixture()]) {
	return buildHapoalimSnapshot({...input, read: {
		portfolio: {View: {Meta: {}}}, executions, paginationComplete: true, historyPages: 1,
	}});
}

describe('Hapoalim securities semantics', () => {
	it('carries high precision JSON number literals into the feed without binary rounding', () => {
		const decoded = parseMytradeJson(JSON.stringify(fixture()).replace('"NV":0.125', '"NV":123456789.123456789012'));
		expect(parseHapoalimExecution(decoded, input).quantity).toBe('123456789.123456789012');
		const tooPrecise = parseMytradeJson(JSON.stringify(fixture()).replace('"NV":0.125', '"NV":123456789.1234567890123'));
		expect(() => parseHapoalimExecution(tooPrecise, input)).toThrow('INVALID_RESPONSE');
		const exponent = parseMytradeJson(JSON.stringify(fixture()).replace('"NV":0.125', '"NV":1E-7'));
		expect(parseHapoalimExecution(exponent, input).quantity).toBe('0.0000001');
	});
	it('preserves source dates, original currency, fractional quantity and price', () => {
		const row = parseHapoalimExecution(fixture(), input);
		expect(row).toMatchObject({tradeDate: '2026-09-01', settlementDate: '2026-09-02', kind: 'buy', currency: 'USD',
			quantity: '0.125', unitPrice: '20.1234', netCashAmount: '-2.52', sourceIdKind: 'natural_key'});
		expect(row.sourceId).toMatch(/^natural-key-v1:[\da-f]{64}$/);
		expect(row.id).toContain('natural-key-v1%3A');
		expect(row.productId).toBe('hapoalim:00-111-222222%3Asecurities');
	});
	it('preserves an empty current metadata list as unknown current value with independent history', () => {
		const result = snapshot();
		expect(result.products[0]).toMatchObject({currentValuationId: null, coverage: {executions: 'partial', tracks: 'unavailable'}});
		expect(result.valuations).toEqual([]);
		expect(result.activities).toEqual([]);
		expect(result.tracks).toEqual([]);
		expect(result.executions).toHaveLength(1);
		expect(result.inventoryComplete).toBe(false);
		expect(snapshot([]).products).toHaveLength(1);
	});
	it('does not collapse potentially distinct identical executions', () => {
		expect(() => snapshot([fixture(), fixture()])).toThrow('INCOMPLETE_RESPONSE');
	});
	it('keeps unknown source vocabulary and reported cash sign without inventing an effect', () => {
		const row = parseHapoalimExecution({...fixture(), TradeType: 'Unrecognised action', TransactionType: 'Provider category', NetValueTradeCurrency: 1.25}, input);
		expect(row).toMatchObject({kind: 'other', sourceTradeType: 'Unrecognised action', sourceTransactionType: 'Provider category', netCashAmount: '1.25'});
	});
	it('distinguishes cancellations and preserves raw financial identity when a name changes', () => {
		const first = parseHapoalimExecution(fixture(), input);
		expect(parseHapoalimExecution({...fixture(), EngName: 'Renamed'}, input).sourceId).toBe(first.sourceId);
		const cancelled = parseHapoalimExecution({...fixture(), IsCancelTransaction: 'כן', CancelDate: '2026-09-03T00:00:00.0000000+03:00'}, input);
		expect(cancelled.cancelled).toBe(true);
		expect(cancelled.sourceId).not.toBe(first.sourceId);
	});
	it('rejects wrong accounts, out-of-window rows, missing fields and unknown currencies', () => {
		for (const change of [{Account: 333_333},
			{TradeDate: '2022-01-01T00:00:00.0000000+02:00'},
			{NetValueTradeCurrency: undefined},
			{TradeCurrency: 'unknown'},
			{IsCancelTransaction: 'כן'},
			{NV: -2}]) {
			expect(() => parseHapoalimExecution({...fixture(), ...change}, input)).toThrow();
		}
	});
	it('retains small decimal precision and rejects accidental rounding', () => {
		expect(sourceDecimal(1e-7)).toBe('0.0000001');
		expect(sourceDecimal('12.3400')).toBe('12.34');
		expect(sourceDecimal(-0)).toBe('0');
		expect(() => sourceDecimal('0.0000000000001')).toThrow('INVALID_RESPONSE');
		expect(() => parseHapoalimExecution({...fixture(), NetValueTradeCurrency: 1.001}, input)).toThrow('INVALID_RESPONSE');
	});
});
