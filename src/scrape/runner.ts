/**
 * Per-company scrape runner: builds the israeli-bank-scrapers options, races
 * the scrape against a wall-clock deadline, maps failures to the bridge's fixed
 * error vocabulary and normalises successes into ledger rows.
 *
 * Info-level logs carry progress types and counts only.
 */

import {chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync} from 'node:fs';
import path from 'node:path';
import {createScraper, type CompanyTypes, type ScraperOptions, type ScraperScrapingResult} from 'israeli-bank-scrapers';
// puppeteer is provided (and version-pinned) by israeli-bank-scrapers; types only here.
// eslint-disable-next-line import-x/no-extraneous-dependencies, n/no-extraneous-import
import type {Browser, Page} from 'puppeteer';
import type {Logger} from '../log.js';
import {normalizeScrapeResult} from '../normalize.js';
import type {
	CompanyId,
	RuntimeEnv,
	Source,
	SourceRunContext,
	SourceRunOutcome,
} from '../types.js';
import {buildLaunchArgs, resolveExecutablePath} from './browser.js';
import {mapScraperError, SCRAPE_ERROR_MESSAGES} from './errors.js';
import {clearStaleLocks} from './profile.js';

/** Failure screenshots older than this are deleted before every run. */
export const SCREENSHOT_RETENTION_DAYS = 30;
/** puppeteer.launch timeout. */
const LAUNCH_TIMEOUT_MS = 120_000;
/** page.setDefaultTimeout for every navigation/selector wait. */
const DEFAULT_TIMEOUT_MS = 60_000;
/** How long a graceful browser.close() may take before the process is killed. */
const CLOSE_GRACE_MS = 5000;

/** `<screenshotsDir>/<company>-<YYYYMMDDTHHmmssZ>.png` */
export function screenshotPath(env: RuntimeEnv, company: CompanyId, now: Date): string {
	const stamp = now.toISOString().replaceAll(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
	return path.join(env.screenshotsDir, `${company}-${stamp}.png`);
}

/** Create the screenshots directory (0700) and delete files older than the retention window. Returns the number pruned. */
export function pruneScreenshots(dir: string, now: Date, logger: Logger): number {
	mkdirSync(dir, {recursive: true, mode: 0o700});
	const cutoff = now.getTime() - (SCREENSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
	let pruned = 0;
	for (const name of readdirSync(dir)) {
		const file = path.join(dir, name);
		try {
			if (statSync(file).mtimeMs < cutoff) {
				rmSync(file, {force: true});
				pruned++;
			}
		} catch (error) {
			logger.debug('could not prune screenshot', {file, error: (error as Error).message});
		}
	}

	return pruned;
}

type RunnerHooks = {
	onBrowser(browser: Browser): void;
	onPage(page: Page): void;
	screenshot: string;
};

/** Library options for one run. `config.scraperOptions` is spread last so the operator can override anything. */
export function buildScraperOptions(ctx: SourceRunContext, hooks: RunnerHooks): ScraperOptions {
	const {config, env} = ctx;
	const base = {
		companyId: ctx.company as CompanyTypes,
		startDate: ctx.startDate,
		executablePath: resolveExecutablePath(env),
		args: buildLaunchArgs(ctx.profileDir),
		timeout: LAUNCH_TIMEOUT_MS,
		defaultTimeout: DEFAULT_TIMEOUT_MS,
		additionalTransactionInformation: config.additionalTransactionInformation,
		futureMonthsToScrape: config.futureMonthsToScrape,
		combineInstallments: false,
		showBrowser: env.showBrowser,
		verbose: env.verbose,
		storeFailureScreenShotPath: hooks.screenshot,
		outputData: {enableTransactionsFilterByDate: true},
		async prepareBrowser(browser: Browser) {
			hooks.onBrowser(browser);
		},
		async preparePage(page: Page) {
			hooks.onPage(page);
		},
	};
	const options: ScraperOptions = {...base, ...config.scraperOptions};
	return options;
}

/** Track the main frame's URL so an OTP page can be recognised after the library closed the page. */
function trackMainFrameUrl(page: Page, onUrl: (url: string) => void): void {
	page.on('framenavigated', frame => {
		if (frame === page.mainFrame()) {
			onUrl(frame.url());
		}
	});
}

/** Close the browser gracefully; SIGKILL the Chrome process if it lingers. */
async function killBrowser(browser: Browser | undefined, logger: Logger): Promise<void> {
	if (!browser) {
		return;
	}

	try {
		await Promise.race([browser.close(), new Promise(resolve => {
			setTimeout(resolve, CLOSE_GRACE_MS).unref();
		})]);
	} catch (error) {
		logger.debug('browser.close failed', {error: (error as Error).message});
	}

	const child = browser.process();
	if (child?.exitCode === null && !child.killed) {
		child.kill('SIGKILL');
	}
}

type Deadline<T> = {expired: true} | {expired: false; value: T};

/** Resolve with the promise's value, or `{expired: true}` once `ms` elapse first. */
async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<Deadline<T>> {
	let timer: NodeJS.Timeout | undefined;
	const expiry = new Promise<Deadline<T>>(resolve => {
		timer = setTimeout(() => resolve({expired: true}), ms);
	});
	try {
		return await Promise.race([promise.then((value): Deadline<T> => ({expired: false, value})), expiry]);
	} finally {
		clearTimeout(timer);
	}
}

/** Run one scrape of `ctx.company` and return either normalised rows or a fixed error. */
export async function runCompany(ctx: SourceRunContext, logger: Logger): Promise<SourceRunOutcome> {
	const log = logger.child(ctx.company);
	const startedAt = new Date();
	let browser: Browser | undefined;
	let lastUrl: string | undefined;

	clearStaleLocks(ctx.profileDir);
	const pruned = pruneScreenshots(ctx.env.screenshotsDir, startedAt, log);
	if (pruned > 0) {
		log.info('pruned old failure screenshots', {pruned});
	}

	const screenshot = screenshotPath(ctx.env, ctx.company, startedAt);
	const options = buildScraperOptions(ctx, {
		screenshot,
		onBrowser(instance) {
			browser = instance;
		},
		onPage(page) {
			trackMainFrameUrl(page, url => {
				lastUrl = url;
			});
		},
	});

	try {
		const scraper = createScraper(options);
		scraper.onProgress((_company, payload) => {
			log.info('progress', {type: payload.type});
		});

		log.info('scrape started', {startDate: ctx.startDate.toISOString().slice(0, 10), timeoutMinutes: ctx.config.timeoutMinutes});
		const scrapePromise = scraper.scrape(ctx.credentials as Parameters<typeof scraper.scrape>[0]);
		scrapePromise.catch(() => undefined); // The deadline branch may abandon it; never let it become unhandled.
		const outcome = await withDeadline(scrapePromise, ctx.config.timeoutMinutes * 60_000);
		if (outcome.expired) {
			log.warn('scrape timed out; killing browser', {timeoutMinutes: ctx.config.timeoutMinutes});
			await killBrowser(browser, log);
			return {ok: false, errorType: 'TIMEOUT', message: SCRAPE_ERROR_MESSAGES.TIMEOUT};
		}

		return finishRun(ctx, outcome.value, lastUrl, log);
	} catch (error) {
		log.error('scrape threw', {error: (error as Error).message});
		return {ok: false, errorType: 'BRIDGE_ERROR', message: SCRAPE_ERROR_MESSAGES.BRIDGE_ERROR};
	} finally {
		if (existsSync(screenshot)) {
			chmodSync(screenshot, 0o600);
		}

		if (browser?.connected) {
			await killBrowser(browser, log);
		}
	}
}

/** Map a finished library result to the run outcome. */
function finishRun(ctx: SourceRunContext, result: ScraperScrapingResult, lastUrl: string | undefined, log: Logger): SourceRunOutcome {
	if (!result.success) {
		const mapped = mapScraperError(result.errorType, [result.errorMessage, lastUrl].filter(Boolean).join(' '));
		log.warn('scrape failed', {errorType: mapped.errorType, message: mapped.message});
		log.debug('scrape failure detail', {libraryErrorType: result.errorType, libraryMessage: result.errorMessage, lastUrl});
		return {ok: false, errorType: mapped.errorType, message: mapped.message};
	}

	const normalized = normalizeScrapeResult({
		company: ctx.company,
		config: ctx.config,
		result,
		scrapedAt: new Date().toISOString(),
		timezone: ctx.timezone,
		defaultCurrency: ctx.defaultCurrency,
	});
	log.info('scrape succeeded', {
		accounts: normalized.accounts.length,
		transactions: normalized.transactions.length,
		holdings: normalized.holdings.length,
	});
	return {ok: true, result: normalized};
}

/** `Source` wrapper around `runCompany` for one company. */
export function createScraperSource(company: CompanyId, logger: Logger): Source {
	return {
		company,
		run: async context => runCompany(context, logger),
	};
}
