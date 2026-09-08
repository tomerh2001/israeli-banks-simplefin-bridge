// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- Puppeteer evaluation needs browser types without a runtime import.
/// <reference lib="dom" />
/* eslint-disable no-await-in-loop -- Navigate sequentially to associate each policy with its response. */
import {setTimeout as delay} from 'node:timers/promises';
// eslint-disable-next-line import-x/no-extraneous-dependencies, n/no-extraneous-import
import type {HTTPResponse, Page} from 'puppeteer';
import {CLAL_PORTFOLIO_URL, ClalCollectionError, isClalLogin} from './browser.js';
import {createClalCollector, type ClalSnapshotReader} from './collector.js';
import {parseClalPortfolioSnapshot} from './clal-portfolio.js';
import {enrichClalActivities} from './clal-activities.js';
import {enrichClalReports} from './clal-reports.js';

type CapturedResponse = {status: number; data: unknown; sequence: number};
const ENDPOINTS = {
	portfolio: '/umbraco/surface/PersonalAccountSurface/GetPortfolioHomeData',
	dailyBalances: '/umbraco/surface/PersonalAccountSurface/GetGemelAndLifeDailyBalanceFromCache',
	pension: '/umbraco/surface/PensionSurface/GetPensionPolicy',
	gemel: '/umbraco/surface/GemelSurface/GetFundationsData',
} as const;
type Endpoint = keyof typeof ENDPOINTS;

function asRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function portfolioSize(value: unknown): number {
	const data = asRecord(value);
	return ['PortfolioDataPensionFundation', 'PortfolioDataGemelHichudList', 'PortfolioDataGemelList']
		.reduce((sum, key) => sum + (Array.isArray(data[key]) ? data[key].length : 0), 0);
}

/** Captures only known read responses in memory; no cookies, headers or request bodies are retained. */
function captureResponses(page: Page, signal: AbortSignal) {
	const responses = new Map<Endpoint, CapturedResponse[]>();
	let sequence = 0;
	let closed = false;
	const pending = new Set<Promise<void>>();
	const capture = async (response: HTTPResponse) => {
		const url = new URL(response.url());
		if (url.origin !== 'https://www.clalbit.co.il') {
			return;
		}

		const endpoint = (Object.keys(ENDPOINTS) as Endpoint[]).find(key => ENDPOINTS[key] === url.pathname);
		if (!endpoint) {
			return;
		}

		const capturedSequence = ++sequence;
		const data: unknown = await response.json().catch(() => undefined);
		if (closed) {
			return;
		}

		const items = responses.get(endpoint) ?? [];
		items.push({status: response.status(), data, sequence: capturedSequence});
		responses.set(endpoint, items);
	};

	const onResponse = (response: HTTPResponse) => {
		const work = capture(response).catch(() => undefined);
		pending.add(work);
		void work.finally(() => {
			pending.delete(work);
		});
	};

	page.on('response', onResponse);
	return {
		checkpoint: () => sequence,
		async wait(endpoint: Endpoint, after: number, predicate: (data: unknown) => boolean = () => true): Promise<CapturedResponse> {
			const deadline = Date.now() + 60_000;
			while (Date.now() < deadline) {
				signal.throwIfAborted();
				const eligible = (responses.get(endpoint) ?? []).filter(item => item.sequence > after);
				if (eligible.some(item => item.status === 401 || item.status === 403)) {
					throw new ClalCollectionError('OTP_REQUIRED');
				}

				const result = eligible.find(item => item.status === 200 && asRecord(item.data).IsSuccess === true && predicate(item.data));
				if (result) {
					return result;
				}

				await delay(250, undefined, {signal});
			}

			throw new ClalCollectionError('INCOMPLETE_RESPONSE');
		},
		async close() {
			closed = true;
			page.off('response', onResponse);
			await Promise.allSettled(pending);
		},
	};
}

/** Actual portal navigation triggers its supported read APIs, including encrypted policy routing. */
export const readClalSnapshot: ClalSnapshotReader = async (page, observedAt, signal) => {
	const captured = captureResponses(page, signal);
	try {
		const initial = captured.checkpoint();
		await page.goto(CLAL_PORTFOLIO_URL, {waitUntil: 'networkidle2'});
		if (await isClalLogin(page)) {
			throw new ClalCollectionError('OTP_REQUIRED');
		}

		const portfolio = await captured.wait('portfolio', initial, data => portfolioSize(data) > 0);
		const count = portfolioSize(portfolio.data);
		const raw = asRecord(portfolio.data);
		const hasGemel = Array.isArray(raw.PortfolioDataGemelHichudList) && raw.PortfolioDataGemelHichudList.length > 0;
		const dailyBalances = hasGemel
			? await captured.wait('dailyBalances', initial, data => asRecord(data).AllPoliciesFoundInCache === true)
			: undefined;
		const pensionDetails: CapturedResponse[] = [];
		const gemelDetails: CapturedResponse[] = [];
		for (let index = 0; index < count; index++) {
			signal.throwIfAborted();
			if (index > 0) {
				const beforeHome = captured.checkpoint();
				await page.goto(CLAL_PORTFOLIO_URL, {waitUntil: 'networkidle2'});
				if (await isClalLogin(page)) {
					throw new ClalCollectionError('OTP_REQUIRED');
				}

				await captured.wait('portfolio', beforeHome, data => portfolioSize(data) === count);
			}

			await page.waitForSelector('h2.link-title');
			const cards = await page.$$('h2.link-title');
			const targets = [];
			for (const card of cards) {
				const title = await card.evaluate(element => element.textContent?.trim());
				if (title === 'קרן פנסיה' || title === 'קרן השתלמות') {
					targets.push({card, endpoint: title === 'קרן פנסיה' ? 'pension' as const : 'gemel' as const});
				}
			}

			const target = targets[index];
			if (targets.length !== count || !target) {
				throw new ClalCollectionError('INCOMPLETE_RESPONSE');
			}

			const beforeDetail = captured.checkpoint();
			await target.card.click();
			const detail = await captured.wait(target.endpoint, beforeDetail);
			(target.endpoint === 'pension' ? pensionDetails : gemelDetails).push(detail);
		}

		const input = {portfolio, dailyBalances, pensionDetails, gemelDetails, observedAt};
		return enrichClalReports(enrichClalActivities(parseClalPortfolioSnapshot(input), input), input);
	} finally {
		await captured.close();
	}
};

export const collectClal = createClalCollector(readClalSnapshot);
