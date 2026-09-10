// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- Read requests execute inside the already authenticated bank origin.
/// <reference lib="dom" />
/* eslint-disable @typescript-eslint/no-restricted-types -- The bank cursor explicitly distinguishes null from a live cursor. */
// eslint-disable-next-line import-x/no-extraneous-dependencies, n/no-extraneous-import
import type {Browser, HTTPRequest, Page} from 'puppeteer';
import type {InvestmentErrorCode} from '../types.js';

/** Protocol reference: Urigo/accounter-fullstack@88568d9b9be1cf17a44ac070ef330de1dd3dda21, modern-poalim-scraper. */
export const HAPOALIM_ORIGIN = 'https://login.bankhapoalim.co.il';
export const HAPOALIM_HISTORY_MAX_PAGES = 100;
const metadataFields = [
	'EngName',
	'EngSymbol',
	'HebName',
	'HebSymbol',
	'Symbol',
	'ExpirationDate',
	'ItemType',
	'StockType',
	'IsEtf',
	'IsForeign',
	'CurrencyCode',
	'Exchange',
	'CreationEquityNum',
	'EquityType',
	'ContractType',
	'AllowedOrderDirection',
	'EquitySubType',
];

export class HapoalimInvestmentError extends Error {
	constructor(readonly code: InvestmentErrorCode) {
		super(code);
	}
}

/** Derive the REST prefix from a real checking request, never from guessed gateway paths. */
export function hapoalimApiBase(requestUrl: string): string | undefined {
	try {
		const url = new URL(requestUrl);
		const suffix = '/current-account/transactions';
		if (url.origin !== HAPOALIM_ORIGIN || !url.pathname.endsWith(suffix)) {
			return undefined;
		}

		const prefix = url.pathname.slice(0, -suffix.length);
		return /^\/[\w\-/]+$/.test(prefix) ? `${url.origin}${prefix}` : undefined;
	} catch {
		return undefined;
	}
}

export function allowedMytradeRequest(requestUrl: string, method: string): boolean {
	const pathname = new URL(requestUrl).pathname.toLowerCase();
	if (!pathname.includes('/mytrade/api/')) {
		return true;
	}

	const history = method === 'GET' && pathname.endsWith('/mytrade/api/v2/json2/order/executions/history');
	const order = /\/mytrade\/api\/.*\/(?:orders?|trades?)(?:\/|$)/.test(pathname);
	const action = /\/mytrade\/api\/.*\/(?:buy|sell|cancel|create|submit|execute|transfer|withdraw|deposit)(?:\/|$)/.test(pathname);
	if ((order && !history) || action) {
		return false;
	}

	return ['GET', 'HEAD', 'OPTIONS'].includes(method)
		|| (method === 'POST' && pathname.endsWith('/mytrade/api/v2/json2/account/view'));
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new HapoalimInvestmentError('INVALID_RESPONSE');
	}

	const result = value as Record<string, unknown>;
	if (result.Exception || (result.messageCode === 0 && result.severity === 'E')) {
		const exception = result.Exception as {'-ExceptionType'?: unknown} | undefined;
		throw new HapoalimInvestmentError(exception?.['-ExceptionType'] === 'InvalidSessionException' ? 'COLLECTION_FAILED' : 'INVALID_RESPONSE');
	}

	return result;
}

export function historyPage(value: unknown): {executions: unknown[]; cursor: string | null} {
	const account = record(record(value).Account);
	if ((account.Execution !== undefined && !Array.isArray(account.Execution))
		|| (account.PageState !== undefined && account.PageState !== null && typeof account.PageState !== 'string')) {
		throw new HapoalimInvestmentError('INVALID_RESPONSE');
	}

	return {
		executions: (account.Execution as unknown[] | undefined) ?? [],
		cursor: typeof account.PageState === 'string' && account.PageState.trim() ? account.PageState : null,
	};
}

export type HapoalimSecuritiesRead = {
	portfolio: unknown;
	executions: unknown[];
	/** Only proves that the returned cursor chain ended for the requested window. */
	paginationComplete: boolean;
	historyPages: number;
};

/** Do not deduplicate here: identical natural keys may represent separate real executions. */
export async function readExecutionPages(fetchPage: (cursor?: string) => Promise<unknown>, signal: AbortSignal): Promise<Omit<HapoalimSecuritiesRead, 'portfolio'>> {
	const executions: unknown[] = [];
	const seenCursors = new Set<string>();
	let cursor: string | undefined;
	for (let number = 1; number <= HAPOALIM_HISTORY_MAX_PAGES; number++) {
		signal.throwIfAborted();
		// eslint-disable-next-line no-await-in-loop -- Follow the bank's opaque cursor sequentially without retries.
		const page = historyPage(await fetchPage(cursor));
		executions.push(...page.executions);
		if (page.cursor === null) {
			return {executions, paginationComplete: true, historyPages: number};
		}

		if (seenCursors.has(page.cursor) || number === HAPOALIM_HISTORY_MAX_PAGES) {
			return {executions, paginationComplete: false, historyPages: number};
		}

		seenCursors.add(page.cursor);
		cursor = page.cursor;
	}

	throw new HapoalimInvestmentError('INCOMPLETE_RESPONSE');
}

type Session = {session: string; csession?: string};

const executionDecimalFields = new Set(['NV', 'TradePrice', 'NetValueTradeCurrency', 'NetValueSettlementCurrency']);

/** Preserve exact financial number tokens before JavaScript converts them to binary floats. */
export function parseMytradeJson(text: string): unknown {
	try {
		return JSON.parse(text, (key: string, value: unknown, context?: {source?: string}): unknown => {
			if (typeof value !== 'number' || !executionDecimalFields.has(key)) {
				return value;
			}

			// Fail closed on a runtime without source-token support instead of silently rounding.
			if (typeof context?.source !== 'string') {
				throw new HapoalimInvestmentError('INVALID_RESPONSE');
			}

			return context.source;
		}) as unknown;
	} catch {
		throw new HapoalimInvestmentError('INVALID_RESPONSE');
	}
}

async function bootMytrade(page: Page): Promise<Session> {
	let onRequest: (request: HTTPRequest) => void;
	let timer: ReturnType<typeof setTimeout>;
	const sessionPromise = new Promise<Session>((resolve, reject) => {
		timer = setTimeout(() => reject(new HapoalimInvestmentError('COLLECTION_FAILED')), 30_000);
		onRequest = request => {
			const url = new URL(request.url());
			const headers = request.headers();
			if (url.origin === HAPOALIM_ORIGIN && url.pathname.includes('/mytrade/api/') && headers.session) {
				resolve({session: headers.session, csession: headers.csession});
			}
		};

		page.on('request', onRequest);
	});
	void sessionPromise.catch(() => undefined);
	try {
		await page.goto(`${HAPOALIM_ORIGIN}/mytrade/app`, {waitUntil: 'domcontentloaded', timeout: 45_000});
		const otpVisible = await page.evaluate(() => {
			const form = globalThis.document.querySelector('form.auth-otp-login');
			return Boolean(form?.getClientRects().length && globalThis.getComputedStyle(form).visibility !== 'hidden');
		});
		if (otpVisible) {
			throw new HapoalimInvestmentError('OTP_REQUIRED');
		}

		const url = new URL(page.url());
		if (url.origin !== HAPOALIM_ORIGIN || !url.pathname.startsWith('/mytrade/')) {
			throw new HapoalimInvestmentError('COLLECTION_FAILED');
		}

		return await sessionPromise;
	} finally {
		clearTimeout(timer!);
		page.off('request', onRequest!);
	}
}

async function requestMytrade(page: Page, requestUrl: string, requestMethod: 'GET' | 'POST', sessionHeaders: Session, captureRaw: (text: string) => void): Promise<unknown> {
	const cookies = await page.browserContext().cookies();
	const {hostname} = new URL(HAPOALIM_ORIGIN);
	const xsrf = cookies.find(cookie => {
		const domain = cookie.domain.replace(/^\./, '');
		return cookie.name === 'XSRF-TOKEN' && (hostname === domain || hostname.endsWith(`.${domain}`));
	});
	if (!xsrf || new URL(page.url()).origin !== HAPOALIM_ORIGIN) {
		throw new HapoalimInvestmentError('COLLECTION_FAILED');
	}

	const result = await page.evaluate(async ({url, method, session, token, origin}) => {
		if (globalThis.location.origin !== origin) {
			return {error: 'COLLECTION_FAILED' as const};
		}

		const otp = globalThis.document.querySelector('form.auth-otp-login');
		if (otp?.getClientRects().length && globalThis.getComputedStyle(otp).visibility !== 'hidden') {
			return {error: 'OTP_REQUIRED' as const};
		}

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 30_000);
		try {
			const headers: Record<string, string> = {'Content-Type': 'application/json; charset=utf-8', 'X-XSRF-TOKEN': token, session: session.session};
			if (session.csession) {
				headers.csession = session.csession;
			}

			const response = await fetch(url, {
				method, headers, credentials: 'include', redirect: 'error', signal: controller.signal,
			});
			if (response.status === 401 || response.status === 403) {
				return {error: 'COLLECTION_FAILED' as const};
			}

			if (response.status !== 200 || response.redirected || response.url !== url) {
				return {error: 'INVALID_RESPONSE' as const};
			}

			const reader = response.body?.getReader();
			if (!reader) {
				return {error: 'INVALID_RESPONSE' as const};
			}

			let text = '';
			let bytes = 0;
			const decoder = new TextDecoder('utf-8', {fatal: true});
			for (;;) {
				// eslint-disable-next-line no-await-in-loop -- Bound memory while receiving private financial data.
				const chunk = await reader.read();
				if (chunk.done) {
					break;
				}

				bytes += chunk.value.byteLength;
				if (bytes > 20_971_520) {
					controller.abort();
					return {error: 'INVALID_RESPONSE' as const};
				}

				text += decoder.decode(chunk.value, {stream: true});
			}

			return {text: text + decoder.decode()};
		} catch {
			return {error: controller.signal.aborted ? 'TIMEOUT' as const : 'INVALID_RESPONSE' as const};
		} finally {
			clearTimeout(timer);
		}
	}, {url: requestUrl, method: requestMethod, session: sessionHeaders, token: xsrf.value, origin: HAPOALIM_ORIGIN});
	if (result.error || result.text === undefined) {
		throw new HapoalimInvestmentError(result.error ?? 'INVALID_RESPONSE');
	}

	captureRaw(result.text);
	return parseMytradeJson(result.text);
}

export async function readHapoalimSecurities(options: {
	browser: Browser;
	apiBase: string;
	accountSelector: string;
	from: string;
	to: string;
	signal: AbortSignal;
	/** Must persist privately before parsing; never send the payload to a logger. */
	capture(name: string, value: unknown): void;
}): Promise<HapoalimSecuritiesRead> {
	const {browser, apiBase, accountSelector, from, to, signal, capture} = options;
	if (hapoalimApiBase(`${apiBase}/current-account/transactions`) !== apiBase
		|| !/^\d+-\d+-\d+$/.test(accountSelector) || from > to
		|| !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
		throw new HapoalimInvestmentError('INVALID_RESPONSE');
	}

	signal.throwIfAborted();
	const page = await browser.newPage();
	const close = async () => page.close().catch(() => undefined);
	const onAbort = () => {
		void close();
	};

	signal.addEventListener('abort', onAbort, {once: true});
	try {
		await page.setBypassServiceWorker(true);
		await page.setRequestInterception(true);
		page.on('request', request => {
			const allowed = !signal.aborted && allowedMytradeRequest(request.url(), request.method());
			void (allowed ? request.continue() : request.abort('blockedbyclient')).catch(() => undefined);
		});
		const session = await bootMytrade(page);
		const tradeAccount = accountSelector.split('-').slice(1).join('-');
		const portfolioUrl = new URL(`${apiBase}/mytrade/api/v2/json2/account/view`);
		portfolioUrl.searchParams.set('account', tradeAccount);
		portfolioUrl.searchParams.set('fields', metadataFields.join(','));
		signal.throwIfAborted();
		const portfolio = await requestMytrade(page, portfolioUrl.href, 'POST', session, rawBody => capture('portfolio', {rawBody}));
		record(portfolio);
		let pageNumber = 0;
		const history = await readExecutionPages(async cursor => {
			signal.throwIfAborted();
			const url = new URL(`${apiBase}/mytrade/api/v2/json2/order/executions/history`);
			url.searchParams.set('account', tradeAccount);
			url.searchParams.set('fromDate', from.slice(8) + from.slice(5, 7) + from.slice(0, 4));
			url.searchParams.set('toDate', to.slice(8) + to.slice(5, 7) + to.slice(0, 4));
			if (cursor) {
				url.searchParams.set('pageState', cursor);
			}

			const captureName = `history-${String(++pageNumber).padStart(3, '0')}`;
			return requestMytrade(page, url.href, 'GET', session, rawBody => capture(captureName, {rawBody}));
		}, signal);
		return {portfolio, ...history};
	} finally {
		signal.removeEventListener('abort', onAbort);
		await close();
	}
}
