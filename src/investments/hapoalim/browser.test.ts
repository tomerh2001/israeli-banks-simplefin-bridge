import {EventEmitter} from 'node:events';
// eslint-disable-next-line import-x/no-extraneous-dependencies, n/no-extraneous-import
import type {Browser} from 'puppeteer';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {allowedMytradeRequest, hapoalimApiBase, HAPOALIM_ORIGIN, historyPage, parseMytradeJson, readExecutionPages, readHapoalimSecurities} from './browser.js';

const prefix = `${HAPOALIM_ORIGIN}/ServerServices`;
const api = `${prefix}/mytrade/api/v2/json2`;

afterEach(() => {
	vi.useRealTimers();
});

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
	it('permits only the existing bank session bootstrap POST endpoints', () => {
		expect(allowedMytradeRequest(`${api}/login/sso`, 'POST')).toBe(true);
		expect(allowedMytradeRequest(`${api}/account/init`, 'POST')).toBe(true);
		for (const endpoint of ['login', 'login/password', 'login/sso/submit', 'login/unknown', 'account/init/submit', 'account/unknown']) {
			expect(allowedMytradeRequest(`${api}/${endpoint}`, 'POST')).toBe(false);
		}

		for (const endpoint of ['login/sso', 'account/init']) {
			expect(allowedMytradeRequest(`${api}/${endpoint}`, 'DELETE')).toBe(false);
			expect(allowedMytradeRequest(`${api}/${endpoint}`, 'PUT')).toBe(false);
			expect(allowedMytradeRequest(`https://example.com/mytrade/api/v2/json2/${endpoint}`, 'POST')).toBe(false);
		}
	});
	it.each(['success', 'http_error', 'bank_error', 'missing'])('waits for successful SSO and account initialization before reading history (%s)', async initializationResult => {
		vi.useFakeTimers();
		const requests: Array<{url: string; method: string; continued: boolean}> = [];
		const responses = [
			{View: {Meta: {}}},
			{Account: {Execution: [{value: 'first'}], PageState: 'opaque+/='}},
			{Account: {Execution: [{value: 'last'}], PageState: null}},
		];
		type ReadInput = {url: string; method: string; session: {session: string; csession: string}; token: string};
		const reads: ReadInput[] = [];
		// eslint-disable-next-line unicorn/prefer-event-target -- Puppeteer exposes EventEmitter-style request listeners.
		const page = Object.assign(new EventEmitter(), {
			setBypassServiceWorker: vi.fn(async () => undefined),
			setRequestInterception: vi.fn(async () => undefined),
			url: () => `${HAPOALIM_ORIGIN}/mytrade/app`,
			browserContext: () => ({cookies: async () => [{name: 'XSRF-TOKEN', value: 'synthetic-xsrf', domain: 'login.bankhapoalim.co.il'}]}),
			close: vi.fn(async () => undefined),
			async goto() {
				// Real bootstrap sends csession alone; only a successful SSO exchange
				// enables the later request from which the collector learns session.
				const exchanged = await dispatch('/login/sso', 'POST', {csession: 'synthetic-client'});
				if (exchanged) {
					const headers = {csession: 'synthetic-client', session: 'synthetic-session'};
					await dispatch('/settings', 'GET', headers);
					const initializing = await dispatch('/account/init?account=111-222222', 'POST', headers);
					if (initializing && initializationResult !== 'missing') {
						setTimeout(() => {
							page.emit('response', {
								url: () => `${api}/account/init?account=111-222222`, request: () => ({method: () => 'POST'}),
								status: () => initializationResult === 'http_error' ? 503 : 200,
								json: async () => initializationResult === 'bank_error'
									? {Exception: {'-ExceptionType': 'InvalidSessionException'}}
									: {Account: {}},
							});
						}, 1000);
					}
				}
			},
			async evaluate(_function: unknown, input?: ReadInput) {
				if (input === undefined) {
					return false; // No visible OTP challenge.
				}

				reads.push(input);
				return {text: JSON.stringify(responses.shift())};
			},
		});
		async function dispatch(endpoint: string, method: string, headers: Record<string, string>): Promise<boolean> {
			return new Promise(resolve => {
				const request = {url: `${api}${endpoint}`, method, continued: false};
				requests.push(request);
				page.emit('request', {
					url: () => request.url, method: () => method, headers: () => headers,
					async continue() {
						request.continued = true;
						resolve(true);
					},
					async abort() {
						resolve(false);
					},
				});
			});
		}

		const newPage = vi.fn(async () => page);
		const capture = vi.fn<(name: string, value: unknown) => void>();
		const operation = readHapoalimSecurities({
			browser: {newPage} as unknown as Browser, apiBase: prefix, accountSelector: '00-111-222222',
			from: '2023-01-01', to: '2026-09-11', signal: new AbortController().signal, capture,
		});
		const result = initializationResult === 'success'
			? expect(operation).resolves.toEqual({
				portfolio: {View: {Meta: {}}}, executions: [{value: 'first'}, {value: 'last'}], paginationComplete: true, historyPages: 2,
			})
			: expect(operation).rejects.toThrow('COLLECTION_FAILED');
		await vi.advanceTimersByTimeAsync(500);
		expect(reads).toEqual([]);
		await vi.advanceTimersByTimeAsync(30_000);
		await result;
		expect(requests).toEqual([
			{url: `${api}/login/sso`, method: 'POST', continued: true},
			{url: `${api}/settings`, method: 'GET', continued: true},
			{url: `${api}/account/init?account=111-222222`, method: 'POST', continued: true},
		]);
		expect(newPage).toHaveBeenCalledOnce();
		expect(page.close).toHaveBeenCalledOnce();
		expect(page.listenerCount('response')).toBe(0);
		if (initializationResult !== 'success') {
			expect(reads).toEqual([]);
			expect(capture).not.toHaveBeenCalled();
			return;
		}

		expect(reads.map(({url, method}) => ({pathname: new URL(url).pathname, method}))).toEqual([
			{pathname: '/ServerServices/mytrade/api/v2/json2/account/view', method: 'POST'},
			{pathname: '/ServerServices/mytrade/api/v2/json2/order/executions/history', method: 'GET'},
			{pathname: '/ServerServices/mytrade/api/v2/json2/order/executions/history', method: 'GET'},
		]);
		expect(reads.every(({session, token}) => session.session === 'synthetic-session' && session.csession === 'synthetic-client' && token === 'synthetic-xsrf')).toBe(true);
		expect(Object.fromEntries(new URL(reads[1]!.url).searchParams)).toEqual({account: '111-222222', fromDate: '01012023', toDate: '11092026'});
		expect(new URL(reads[2]!.url).searchParams.get('pageState')).toBe('opaque+/=');
		expect(capture.mock.calls.map(([name]) => name)).toEqual(['portfolio', 'history-001', 'history-002']);
		expect(capture.mock.calls.every(([, value]) => typeof (value as {rawBody: unknown}).rawBody === 'string')).toBe(true);
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
