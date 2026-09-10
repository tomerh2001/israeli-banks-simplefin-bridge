import {describe, expect, it, vi} from 'vitest';
import {allowedMytradeRequest, hapoalimApiBase, HAPOALIM_ORIGIN, historyPage, parseMytradeJson, readExecutionPages} from './browser.js';

const prefix = `${HAPOALIM_ORIGIN}/ServerServices`;
const api = `${prefix}/mytrade/api/v2/json2`;

describe('Hapoalim existing-session read boundaries', () => {
	it('retains exact numeric financial tokens without changing error or account field types', () => {
		const parsed = parseMytradeJson('{"Account":{"Branch":111,"Execution":[{"NV":123456789.123456789012,"TradePrice":8.123456789012,'
			+ '"NetValueTradeCurrency":-123456789.12,"NetValueSettlementCurrency":null}]},"messageCode":0,"severity":"E"}');
		expect(parsed).toEqual({Account: {Branch: 111, Execution: [{NV: '123456789.123456789012', TradePrice: '8.123456789012',
			NetValueTradeCurrency: '-123456789.12', NetValueSettlementCurrency: null}]}, messageCode: 0, severity: 'E'});
		expect(() => historyPage(parsed)).toThrow('INVALID_RESPONSE');
		expect(() => parseMytradeJson('{')).toThrow('INVALID_RESPONSE');
	});
	it('derives a gateway only from the real bank checking endpoint', () => {
		expect(hapoalimApiBase(`${prefix}/current-account/transactions?accountId=synthetic`)).toBe(prefix);
		expect(hapoalimApiBase('https://example.com/ServerServices/current-account/transactions')).toBeUndefined();
		expect(hapoalimApiBase(`${prefix}/mytrade/api/v2/json2/account/view`)).toBeUndefined();
		expect(hapoalimApiBase('invalid')).toBeUndefined();
	});
	it('permits the two financial reads while blocking unknown writes and order actions', () => {
		expect(allowedMytradeRequest(`${api}/account/view`, 'POST')).toBe(true);
		expect(allowedMytradeRequest(`${api}/order/executions/history`, 'GET')).toBe(true);
		for (const endpoint of ['order', 'order/create', 'orders/cancel', 'trade/submit', 'account/transfer', 'unknown']) {
			expect(allowedMytradeRequest(`${api}/${endpoint}`, 'POST')).toBe(false);
			expect(allowedMytradeRequest(`${api}/${endpoint}`, 'DELETE')).toBe(false);
		}

		expect(allowedMytradeRequest(`${api}/order`, 'GET')).toBe(false);
	});
	it('follows short and empty pages when their opaque cursor is still open', async () => {
		const fetch = vi.fn()
			.mockResolvedValueOnce({Account: {Execution: [{value: 'first'}], PageState: 'opaque+/='}})
			.mockResolvedValueOnce({Account: {Execution: [], PageState: 'next'}})
			.mockResolvedValueOnce({Account: {Execution: [{value: 'last'}], PageState: null}});
		const result = await readExecutionPages(fetch, new AbortController().signal);
		expect(fetch.mock.calls).toEqual([[undefined], ['opaque+/='], ['next']]);
		expect(result).toEqual({executions: [{value: 'first'}, {value: 'last'}], paginationComplete: true, historyPages: 3});
	});
	it('preserves duplicate raw rows and marks a repeated cursor incomplete', async () => {
		const row = {value: 'identical'};
		const fetch = vi.fn().mockResolvedValue({Account: {Execution: [row], PageState: 'unchanged'}});
		const result = await readExecutionPages(fetch, new AbortController().signal);
		expect(result).toEqual({executions: [row, row], paginationComplete: false, historyPages: 2});
	});
	it('bounds nonterminating cursors at 100 pages', async () => {
		let number = 0;
		const fetch = vi.fn(async () => ({Account: {Execution: [], PageState: String(++number)}}));
		const result = await readExecutionPages(fetch, new AbortController().signal);
		expect(fetch).toHaveBeenCalledTimes(100);
		expect(result.paginationComplete).toBe(false);
	});
	it('rejects malformed/error responses rather than declaring an empty portfolio', () => {
		expect(historyPage({Account: {}})).toEqual({executions: [], cursor: null});
		expect(() => historyPage(null)).toThrow('INVALID_RESPONSE');
		expect(() => historyPage({Account: {Execution: {}}})).toThrow('INVALID_RESPONSE');
		expect(() => historyPage({Exception: {'-ExceptionType': 'InvalidSessionException'}})).toThrow('COLLECTION_FAILED');
		expect(() => historyPage({messageCode: 0, severity: 'E'})).toThrow('INVALID_RESPONSE');
	});
	it('does not request another page after cancellation or a failed page', async () => {
		const controller = new AbortController();
		controller.abort();
		const fetch = vi.fn();
		await expect(readExecutionPages(fetch, controller.signal)).rejects.toThrow();
		expect(fetch).not.toHaveBeenCalled();
		fetch.mockResolvedValueOnce({Account: {PageState: 'next'}}).mockResolvedValueOnce(null);
		await expect(readExecutionPages(fetch, new AbortController().signal)).rejects.toThrow('INVALID_RESPONSE');
		expect(fetch).toHaveBeenCalledTimes(2);
	});
});
