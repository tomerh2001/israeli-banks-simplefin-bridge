import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
// eslint-disable-next-line import-x/no-extraneous-dependencies, n/no-extraneous-import
import type {Page} from 'puppeteer';
import {readRuntimeEnv} from '../config.js';
import * as browserModule from './browser.js';
import {assertClalSessionAuthenticated, readClalSessionRemaining, renewClalSession} from './session.js';

vi.mock('./browser.js', async importOriginal => ({
	...await importOriginal<typeof browserModule>(),
	withClalBrowser: vi.fn(),
}));

const origin = 'https://www.clalbit.co.il';
const expiration = `${origin}/umbraco/api/sessionmanagerapi/GetSessionExpiration`;
const renewal = `${origin}/umbraco/surface/general/KeepSessionAlive`;
const portfolio = `${origin}/umbraco/surface/PersonalAccountSurface/GetPortfolioHomeData`;
const authenticated = {IsSuccess: true, PortfolioDataPensionFundation: [], PortfolioDataGemelHichudList: []};
const fetchMock = vi.fn<typeof fetch>();
const getItem = vi.fn<Storage['getItem']>();
const navigation = {status: () => 200, url: () => `${origin}/robots.txt`, request: () => ({redirectChain: () => []})};
const page = {
	url: vi.fn(() => `${origin}/robots.txt`),
	goto: vi.fn(async () => navigation),
	// Execute the actual protocol callback against synthetic browser globals and fetch.
	evaluate: vi.fn(async (callback: (input: unknown) => Promise<unknown>, input: unknown) => callback(input)),
} as unknown as Page;

function reply(url: string, value: unknown, options: {status?: number; contentType?: string; redirected?: boolean} = {}): Response {
	const response = Response.json(value, {status: options.status ?? 200, headers: {'content-type': options.contentType ?? 'application/json; charset=utf-8'}});
	Object.defineProperties(response, {
		url: {value: url},
		redirected: {value: options.redirected ?? false},
	});
	return response;
}

beforeEach(() => {
	vi.stubGlobal('location', {origin});
	vi.stubGlobal('sessionStorage', {getItem});
	vi.stubGlobal('fetch', fetchMock);
	vi.mocked(page.url).mockReturnValue(`${origin}/robots.txt`);
	vi.mocked(page.goto).mockResolvedValue(navigation as never);
	vi.mocked(browserModule.withClalBrowser).mockImplementation(async (options, work) => work(page, options.signal ?? new AbortController().signal));
});

afterEach(() => {
	vi.clearAllMocks();
	fetchMock.mockReset();
	getItem.mockReset();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('Clal native session protocol', () => {
	it('uses only fixed native requests and verifies protected access before and after renewal', async () => {
		getItem.mockReturnValue('synthetic-xsrf-token');
		fetchMock
			.mockResolvedValueOnce(reply(expiration, 300))
			.mockResolvedValueOnce(reply(portfolio, authenticated))
			.mockResolvedValueOnce(reply(renewal, null, {contentType: 'text/html'}))
			.mockResolvedValueOnce(reply(portfolio, authenticated))
			.mockResolvedValueOnce(reply(expiration, 1199));
		await expect(renewClalSession({env: readRuntimeEnv(), timeoutMinutes: 2})).resolves.toBe(1199);
		expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([expiration, portfolio, renewal, portfolio, expiration]);
		for (const [url, options] of fetchMock.mock.calls) {
			expect(options).toMatchObject({credentials: 'same-origin', redirect: 'error', headers: {'X-XSRF-Token': 'synthetic-xsrf-token'}});
			expect(options?.method).toBe(url === renewal ? 'GET' : 'POST');
			expect(options?.body).toBe(url === renewal ? undefined : (url === portfolio ? '{"txtIsExpired":false}' : '{}'));
		}
	});

	it('never renews an expired session even though the public keepalive would create a fresh timer', async () => {
		fetchMock.mockResolvedValue(reply(expiration, 0));
		await expect(renewClalSession({env: readRuntimeEnv(), timeoutMinutes: 2})).rejects.toThrow('OTP_REQUIRED');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('rejects a stale auth cookie with a positive generic timer and cannot call renewal', async () => {
		fetchMock.mockResolvedValueOnce(reply(expiration, 1199)).mockResolvedValueOnce(reply(portfolio, {}, {status: 401}));
		await expect(renewClalSession({env: readRuntimeEnv(), timeoutMinutes: 2})).rejects.toThrow('OTP_REQUIRED');
		expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([expiration, portfolio]);
	});

	it('cannot report active if protected access expires during renewal', async () => {
		fetchMock
			.mockResolvedValueOnce(reply(expiration, 300))
			.mockResolvedValueOnce(reply(portfolio, authenticated))
			.mockResolvedValueOnce(reply(renewal, null))
			.mockResolvedValueOnce(reply(portfolio, {}, {status: 403}));
		await expect(renewClalSession({env: readRuntimeEnv(), timeoutMinutes: 2})).rejects.toThrow('OTP_REQUIRED');
		expect(fetchMock).toHaveBeenCalledTimes(4);
	});

	it.each(['1200', null, {}, [], true])('rejects a malformed expiration value (%j)', async value => {
		fetchMock.mockResolvedValue(reply(expiration, value));
		await expect(readClalSessionRemaining(page)).rejects.toThrow('INVALID_RESPONSE');
	});

	it.each([NaN, Infinity, -Infinity])('rejects a nonfinite decoded number', async value => {
		const response = reply(expiration, 1);
		vi.spyOn(response, 'json').mockResolvedValue(value);
		fetchMock.mockResolvedValue(response);
		await expect(readClalSessionRemaining(page)).rejects.toThrow('INVALID_RESPONSE');
	});

	it.each([1.5, 86_401, Number.MAX_SAFE_INTEGER])('rejects a fractional or implausibly long expiration (%d)', async value => {
		fetchMock.mockResolvedValue(reply(expiration, value));
		await expect(readClalSessionRemaining(page)).rejects.toThrow('INVALID_RESPONSE');
	});

	it.each([0, -1])('requires a positive expiration (%d)', async value => {
		fetchMock.mockResolvedValue(reply(expiration, value));
		await expect(readClalSessionRemaining(page)).rejects.toThrow('OTP_REQUIRED');
	});

	it.each([
		{status: 500}, {status: 204}, {contentType: 'text/html'}, {redirected: true},
	])('rejects an invalid session response (%j)', async options => {
		if (options.status === 204) {
			const response = new Response(null, {status: 204});
			Object.defineProperty(response, 'url', {value: expiration});
			fetchMock.mockResolvedValue(response);
		} else {
			fetchMock.mockResolvedValue(reply(expiration, 1199, options));
		}

		await expect(readClalSessionRemaining(page)).rejects.toThrow('INVALID_RESPONSE');
	});

	it('rejects a login HTML payload carrying HTTP 200', async () => {
		fetchMock.mockResolvedValue(reply(portfolio, '<html>login</html>', {contentType: 'text/html'}));
		await expect(assertClalSessionAuthenticated(page)).rejects.toThrow('INVALID_RESPONSE');
	});

	it.each([{IsSuccess: true}, {IsSuccess: true, PortfolioDataPensionFundation: 'invalid'}])('rejects an unrecognized protected payload', async value => {
		fetchMock.mockResolvedValue(reply(portfolio, value));
		await expect(assertClalSessionAuthenticated(page)).rejects.toThrow('INVALID_RESPONSE');
	});

	it('does not classify a generic protected API failure as expired authentication', async () => {
		fetchMock.mockResolvedValue(reply(portfolio, {IsSuccess: false}));
		await expect(assertClalSessionAuthenticated(page)).rejects.toThrow('INVALID_RESPONSE');
	});

	it('cannot return verified health after cancellation during the final expiration check', async () => {
		const controller = new AbortController();
		fetchMock
			.mockResolvedValueOnce(reply(expiration, 300))
			.mockResolvedValueOnce(reply(portfolio, authenticated))
			.mockResolvedValueOnce(reply(renewal, null))
			.mockResolvedValueOnce(reply(portfolio, authenticated))
			.mockImplementationOnce(async () => {
				controller.abort();
				return reply(expiration, 1199);
			});
		await expect(renewClalSession({env: readRuntimeEnv(), timeoutMinutes: 2, signal: controller.signal})).rejects.toThrow();
	});

	it('does not expose protected response data to its caller', async () => {
		fetchMock.mockResolvedValue(reply(portfolio, {...authenticated, PortfolioDataPensionFundation: [{privateField: 'synthetic-only'}]}));
		await expect(assertClalSessionAuthenticated(page)).resolves.toBeUndefined();
	});

	it('omits the optional anti-forgery header when no token exists', async () => {
		getItem.mockReturnValue(null);
		fetchMock.mockResolvedValue(reply(expiration, 1199));
		await expect(readClalSessionRemaining(page)).resolves.toBe(1199);
		expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({'Content-Type': 'application/json'});
	});

	it('refuses requests from an unrelated origin', async () => {
		vi.mocked(page.url).mockReturnValue('https://example.invalid/login');
		await expect(readClalSessionRemaining(page)).rejects.toThrow('INVALID_RESPONSE');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('rejects an origin-resource redirect before making API requests', async () => {
		vi.mocked(page.goto).mockResolvedValue({...navigation, request: () => ({redirectChain: () => [{}]})} as never);
		await expect(renewClalSession({env: readRuntimeEnv(), timeoutMinutes: 2})).rejects.toThrow('INVALID_RESPONSE');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('aborts a stalled native request and returns only a sanitized timeout', async () => {
		vi.useFakeTimers();
		fetchMock.mockImplementation(async (_url, options) => new Promise((_resolve, reject) => {
			options?.signal?.addEventListener('abort', () => {
				reject(new Error('synthetic sensitive network details'));
			}, {once: true});
		}));
		const assertion = expect(readClalSessionRemaining(page)).rejects.toThrow('TIMEOUT');
		await vi.advanceTimersByTimeAsync(15_000);
		await assertion;
	});
});
