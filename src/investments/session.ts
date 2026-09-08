// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- Requests execute inside the owned browser origin.
/// <reference lib="dom" />

// eslint-disable-next-line import-x/no-extraneous-dependencies, n/no-extraneous-import
import type {Page} from 'puppeteer';
import {ClalCollectionError, withClalBrowser, type ClalBrowserOptions} from './browser.js';

const CLAL_ORIGIN = 'https://www.clalbit.co.il';
const ENDPOINTS = {
	expiration: '/umbraco/api/sessionmanagerapi/GetSessionExpiration',
	renewal: '/umbraco/surface/general/KeepSessionAlive',
	portfolio: '/umbraco/surface/PersonalAccountSurface/GetPortfolioHomeData',
} as const;
type SessionEndpoint = keyof typeof ENDPOINTS;

/** Fixed same-origin requests only. No token, cookie, response body or URL escapes the browser. */
async function requestClalSession(page: Page, endpoint: SessionEndpoint): Promise<number | undefined> {
	if (new URL(page.url()).origin !== CLAL_ORIGIN) {
		throw new ClalCollectionError('INVALID_RESPONSE');
	}

	const result = await page.evaluate(async ({origin, path, endpoint: operation}) => {
		if (globalThis.location.origin !== origin) {
			return {errorCode: 'INVALID_RESPONSE' as const};
		}

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 15_000);
		try {
			const post = operation !== 'renewal';
			const headers: Record<string, string> = post ? {'Content-Type': 'application/json'} : {};
			const token = sessionStorage.getItem('RequestVerificationToken');
			if (token) {
				headers['X-XSRF-Token'] = token;
			}

			const url = new URL(path, origin).href;
			const response = await fetch(url, {
				method: post ? 'POST' : 'GET',
				headers,
				body: post ? JSON.stringify(operation === 'portfolio' ? {txtIsExpired: false} : {}) : undefined,
				// eslint-disable-next-line unicorn/no-unnecessary-fetch-options -- Explicitly constrain authenticated cookie scope.
				credentials: 'same-origin',
				redirect: 'error',
				signal: controller.signal,
			});
			if (response.status === 401 || response.status === 403) {
				return {errorCode: 'OTP_REQUIRED' as const};
			}

			if (response.status !== 200 || response.redirected || response.url !== url) {
				return {errorCode: 'INVALID_RESPONSE' as const};
			}

			if (operation === 'renewal') {
				// Native KeepSessionAlive need not return JSON. The subsequent expiration
				// and protected-session checks establish whether the session remains usable.
				return {};
			}

			if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
				return {errorCode: 'INVALID_RESPONSE' as const};
			}

			const value: unknown = await response.json();
			if (operation === 'portfolio') {
				if (!value || typeof value !== 'object' || Array.isArray(value)) {
					return {errorCode: 'INVALID_RESPONSE' as const};
				}

				const data = value as Record<string, unknown>;
				if (data.IsSuccess !== true) {
					return {errorCode: 'INVALID_RESPONSE' as const};
				}

				const containers = ['PortfolioDataPensionFundation', 'PortfolioDataGemelHichudList', 'PortfolioDataGemelList'];
				if (containers.every(key => !Array.isArray(data[key]))
					|| containers.some(key => data[key] !== undefined && data[key] !== null && !Array.isArray(data[key]))) {
					return {errorCode: 'INVALID_RESPONSE' as const};
				}

				return {};
			}

			if (typeof value !== 'number' || !Number.isSafeInteger(value) || value > 86_400) {
				return {errorCode: 'INVALID_RESPONSE' as const};
			}

			return value > 0 ? {remainingSeconds: value} : {errorCode: 'OTP_REQUIRED' as const};
		} catch {
			return {errorCode: controller.signal.aborted ? 'TIMEOUT' as const : 'INVALID_RESPONSE' as const};
		} finally {
			clearTimeout(timeout);
		}
	}, {origin: CLAL_ORIGIN, path: ENDPOINTS[endpoint], endpoint});
	if (result.errorCode) {
		throw new ClalCollectionError(result.errorCode);
	}

	return result.remainingSeconds;
}

/** This timer is ancillary: a positive value alone does not prove portal authentication. */
export async function readClalSessionRemaining(page: Page): Promise<number> {
	const remainingSeconds = await requestClalSession(page, 'expiration');
	if (remainingSeconds === undefined) {
		throw new ClalCollectionError('INVALID_RESPONSE');
	}

	return remainingSeconds;
}

/** The native protected portfolio call proves authentication; its data never leaves the browser. */
export async function assertClalSessionAuthenticated(page: Page): Promise<void> {
	await requestClalSession(page, 'portfolio');
}

/** Renew only an already authenticated session. This function cannot resolve credentials or send an OTP. */
export async function renewClalSession(options: ClalBrowserOptions): Promise<number> {
	return withClalBrowser(options, async (page, signal) => {
		const originUrl = `${CLAL_ORIGIN}/robots.txt`;
		const response = await page.goto(originUrl, {waitUntil: 'domcontentloaded', timeout: 30_000});
		if (response?.status() !== 200 || response.url() !== originUrl
			|| response.request().redirectChain().length > 0 || page.url() !== originUrl) {
			throw new ClalCollectionError('INVALID_RESPONSE');
		}

		signal.throwIfAborted();
		await readClalSessionRemaining(page);
		signal.throwIfAborted();
		await assertClalSessionAuthenticated(page);
		signal.throwIfAborted();
		await requestClalSession(page, 'renewal');
		signal.throwIfAborted();
		await assertClalSessionAuthenticated(page);
		signal.throwIfAborted();
		const remainingSeconds = await readClalSessionRemaining(page);
		signal.throwIfAborted();
		return remainingSeconds;
	});
}
