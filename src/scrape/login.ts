/**
 * Assisted (visible) login: `bridge login <company>`.
 *
 * Runs the company's Chrome profile headed under Xvfb, exposes it over noVNC,
 * lets the library do the form login and, when the library gives up (SMS
 * one-time code on an untrusted device), keeps the browser open so the operator
 * finishes by hand. Chrome is then closed gracefully so the device-trust cookies
 * land in the profile, and an optional headless run confirms the fix.
 *
 * Helper processes are spawned with argument arrays (never a shell).
 */

import {type ChildProcess, spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {existsSync} from 'node:fs';
import {createScraper, type CompanyTypes, type ScraperCredentials, type ScraperOptions, type ScraperScrapingResult} from 'israeli-bank-scrapers';
// puppeteer is provided (and version-pinned) by israeli-bank-scrapers; we launch through the same copy.
// eslint-disable-next-line import-x/no-extraneous-dependencies, n/no-extraneous-import
import puppeteer, {type Browser} from 'puppeteer';
import type {Logger} from '../log.js';
import type {
	CompanyConfig,
	CompanyId,
	Config,
	Ledger,
	RuntimeEnv,
	SecretsResolver,
} from '../types.js';
import {buildLaunchArgs, resolveExecutablePath} from './browser.js';
import {mapScraperError} from './errors.js';
import {clearStaleLocks, ensureProfileDir} from './profile.js';
import {computeWindowStart, createScheduler, defaultSourceState, unparkCompany} from './scheduler.js';

export type AssistedLoginOptions = {
	company: CompanyId;
	config: Config;
	env: RuntimeEnv;
	ledger: Ledger;
	secrets: SecretsResolver;
	logger: Logger;
	/** noVNC HTTP port (websockify). Default 6080. */
	novncPort?: number;
	/** VNC password; default `NOVNC_PASSWORD`, else random (printed once). */
	password?: string;
	/** X display number for Xvfb. Default 99. */
	display?: number;
	/** After the browser closes, run a forced headless scrape to confirm the login sticks. Default true. */
	confirm?: boolean;
	/** Maximum time to wait for the operator, minutes. Default 20. */
	waitMinutes?: number;
};

const WINDOW_SIZE = '1280,900';
const VNC_PORT = 5900;
const POLL_MS = 2000;

/** Internal runtime lifecycle exposed by the pinned scraper version. */
type LoginScraper = ReturnType<typeof createScraper> & {
	initialize(): Promise<void>;
	login(credentials: ScraperCredentials): Promise<ScraperScrapingResult>;
};

function createLoginScraper(options: ScraperOptions): LoginScraper {
	const scraper = createScraper(options);
	// These methods exist on the runtime base class; its declarations hide login
	// behind protected. Fail clearly if a dependency update changes that contract.
	if (!('initialize' in scraper) || typeof scraper.initialize !== 'function'
		|| !('login' in scraper) || typeof scraper.login !== 'function') {
		throw new Error('Scraper does not expose the lifecycle required for assisted login');
	}

	return scraper as LoginScraper;
}

/** URL patterns that prove the operator reached the post-login area. */
const POST_LOGIN_PATTERNS: Partial<Record<CompanyId, RegExp>> = {
	hapoalim: /\/ng-portals(?:-bt)?\/rb\//i,
	visaCal: /\/dashboard/i,
};

/** Anything that still looks like an authentication step (generic companies only). */
const AUTH_LIKE = /login|logon|signin|sign-in|auth|otp|sms|password/i;

/**
 * Build the predicate that tells whether a page URL means "logged in".
 * Known companies match their portal path; others need a URL that changed
 * since the library gave up and no longer looks like an auth step.
 */
export function createPostLoginDetector(company: CompanyId, urlsWhenLibraryGaveUp: string[]): (url: string) => boolean {
	const pattern = POST_LOGIN_PATTERNS[company];
	if (pattern) {
		return url => pattern.test(url);
	}

	const seen = new Set(urlsWhenLibraryGaveUp);
	return url => url !== 'about:blank' && !seen.has(url) && !AUTH_LIKE.test(url);
}

type Helper = {name: string; child: ChildProcess; stderr: string[]};

/** Spawn a helper process (no shell), collecting the tail of its stderr for diagnostics. */
async function spawnHelper(name: string, args: string[], env: NodeJS.ProcessEnv, logger: Logger): Promise<Helper> {
	return new Promise((resolve, reject) => {
		const child = spawn(name, args, {stdio: ['ignore', 'ignore', 'pipe'], env});
		const helper: Helper = {name, child, stderr: []};
		child.stderr?.setEncoding('utf8');
		child.stderr?.on('data', (chunk: string) => {
			helper.stderr.push(chunk);
			helper.stderr.splice(0, Math.max(0, helper.stderr.length - 50));
		});
		child.once('error', error => {
			reject(new Error(`Could not start ${name}: ${error.message}`));
		});
		child.once('spawn', () => {
			logger.info('helper started', {name, pid: child.pid});
			resolve(helper);
		});
		child.once('exit', (code, signal) => {
			logger.debug('helper exited', {name, code, signal, stderr: helper.stderr.join('').slice(-1000)});
		});
	});
}

/** SIGTERM each helper (newest first), SIGKILL stragglers after a short grace period. */
async function stopHelpers(helpers: Helper[]): Promise<void> {
	for (const helper of helpers.toReversed()) {
		if (helper.child.exitCode === null) {
			helper.child.kill('SIGTERM');
		}
	}

	await new Promise(resolve => {
		setTimeout(resolve, 1500);
	});
	for (const helper of helpers) {
		if (helper.child.exitCode === null) {
			helper.child.kill('SIGKILL');
		}
	}
}

/** Wait until the X display socket exists (or give up after a few seconds). */
async function waitForDisplay(display: number, timeoutMs = 5000): Promise<void> {
	const socket = `/tmp/.X11-unix/X${display}`;
	const deadline = Date.now() + timeoutMs;
	while (!existsSync(socket) && Date.now() < deadline) {
		// eslint-disable-next-line no-await-in-loop
		await new Promise(resolve => {
			setTimeout(resolve, 200);
		});
	}
}

/** Start Xvfb, x11vnc and websockify; returns the helpers in start order. */
async function startDisplayStack(display: number, novncPort: number, password: string, logger: Logger): Promise<Helper[]> {
	const env = {...process.env, DISPLAY: `:${display}`};
	const helpers: Helper[] = [];
	const start = async (name: string, args: string[]) => {
		helpers.push(await spawnHelper(name, args, env, logger));
	};

	try {
		await start('Xvfb', [`:${display}`, '-screen', '0', '1280x900x24']);
		await waitForDisplay(display);
		await start('x11vnc', ['-display', `:${display}`, '-rfbport', String(VNC_PORT), '-localhost', '-forever', '-shared', '-passwd', password]);
		await start('websockify', ['--web', '/usr/share/novnc', `0.0.0.0:${novncPort}`, `localhost:${VNC_PORT}`]);
	} catch (error) {
		await stopHelpers(helpers);
		throw error;
	}

	return helpers;
}

/** All open page URLs; an empty list when the browser is gone. */
async function pageUrls(browser: Browser): Promise<string[]> {
	try {
		const pages = await browser.pages();
		return pages.map(page => page.url());
	} catch {
		return [];
	}
}

/**
 * Wait until a page reaches the post-login area, the operator presses Enter,
 * the browser disconnects, or the cap elapses. Returns how it ended.
 */
async function waitForOperator(browser: Browser, isPostLogin: (url: string) => boolean, capMs: number): Promise<'post-login' | 'enter' | 'disconnected' | 'cap'> {
	return new Promise(resolve => {
		let done = false;
		const finish = (reason: 'post-login' | 'enter' | 'disconnected' | 'cap') => {
			if (done) {
				return;
			}

			done = true;
			clearInterval(poll);
			clearTimeout(cap);
			process.stdin.off('data', onStdin);
			process.stdin.pause();
			resolve(reason);
		};

		const onStdin = () => {
			finish('enter');
		};

		const tick = async () => {
			if (!browser.connected) {
				finish('disconnected');
				return;
			}

			const urls = await pageUrls(browser);
			if (urls.some(url => isPostLogin(url))) {
				finish('post-login');
			}
		};

		const poll = setInterval(() => {
			void tick();
		}, POLL_MS);
		const cap = setTimeout(() => finish('cap'), capMs);
		process.stdin.on('data', onStdin);
		process.stdin.resume();
	});
}

function loginScraperOptions(company: CompanyId, config: CompanyConfig, env: RuntimeEnv, browser: Browser, startDate: Date): ScraperOptions {
	const base = {
		companyId: company as CompanyTypes,
		startDate,
		browser,
		skipCloseBrowser: true,
		showBrowser: true,
		verbose: env.verbose,
		defaultTimeout: 60_000,
		additionalTransactionInformation: config.additionalTransactionInformation,
		futureMonthsToScrape: config.futureMonthsToScrape,
		combineInstallments: false,
		outputData: {enableTransactionsFilterByDate: true},
	};
	const options: ScraperOptions = {...base, ...config.scraperOptions};
	return options;
}

/** Run the assisted login end to end. Resolves when the browser and helpers are gone. */
export async function assistedLogin(options: AssistedLoginOptions): Promise<void> {
	const {company, config, env, ledger, secrets, logger} = options;
	const companyConfig = config.companies[company];
	if (!companyConfig) {
		throw new Error(`Company ${company} is not configured`);
	}

	const log = logger.child(`login:${company}`);
	const novncPort = options.novncPort ?? 6080;
	const display = options.display ?? 99;
	const password = options.password ?? process.env.NOVNC_PASSWORD ?? randomBytes(6).toString('base64url').slice(0, 8);
	const capMs = (options.waitMinutes ?? 20) * 60_000;

	const helpers = await startDisplayStack(display, novncPort, password, log);
	console.log(`noVNC: http://127.0.0.1:${novncPort}/vnc.html?autoconnect=1`);
	console.log(`VNC password: ${password}`);

	let browser: Browser | undefined;
	const cleanup = async () => {
		if (browser?.connected) {
			try {
				await browser.close();
			} catch (error) {
				log.debug('browser.close failed', {error: (error as Error).message});
			}
		}

		await stopHelpers(helpers);
	};

	const onSigint = () => {
		log.warn('interrupted; cleaning up');
		// This is the CLI path: exit once the browser and helpers are gone.
		// eslint-disable-next-line unicorn/no-process-exit
		void cleanup().finally(() => process.exit(130));
	};

	process.once('SIGINT', onSigint);
	try {
		const credentials = await secrets.resolveAll(companyConfig.credentials);
		const profileDir = ensureProfileDir(env, company);
		clearStaleLocks(profileDir);
		browser = await puppeteer.launch({
			headless: false,
			executablePath: resolveExecutablePath(env),
			args: [...buildLaunchArgs(profileDir), `--window-size=${WINDOW_SIZE}`],
			env: {...process.env, DISPLAY: `:${display}`},
			timeout: 120_000,
		});

		const state = ledger.getSourceState(company) ?? defaultSourceState(company);
		const startDate = computeWindowStart({config: companyConfig, state, overlapDays: config.overlapDays, now: new Date()});
		const scraper = createLoginScraper(loginScraperOptions(company, companyConfig, env, browser, startDate));
		scraper.onProgress((_company, payload) => {
			log.info('progress', {type: payload.type});
		});

		// scrape() always terminates its page, even with skipCloseBrowser. Keep the
		// authentication page alive for the operator by owning this login lifecycle.
		await scraper.initialize();
		let result: ScraperScrapingResult;
		try {
			result = await scraper.login(credentials as Parameters<typeof scraper.login>[0]);
		} catch (error) {
			// OTP redirects can make a scraper's post-login wait throw. The page is
			// still usable, so hand it to the operator just like a rejected login.
			result = {success: false, errorMessage: (error as Error).message};
		}

		if (result.success) {
			log.info('library login succeeded; closing the browser to save the profile');
		} else {
			const urls = await pageUrls(browser);
			const mapped = mapScraperError(result.errorType, [result.errorMessage, ...urls].join(' '));
			log.warn('library gave up; finish the login in noVNC, then press Enter here', {errorType: mapped.errorType, message: mapped.message});
			const reason = await waitForOperator(browser, createPostLoginDetector(company, urls), capMs);
			log.info('assisted login finished', {reason});
			if (reason === 'cap' || reason === 'disconnected') {
				log.warn('assisted login was not completed; company remains parked');
				return;
			}
		}
	} finally {
		process.off('SIGINT', onSigint);
		await cleanup();
	}

	if (options.confirm ?? true) {
		unparkCompany(ledger, company);
		const records = await createScheduler({config, env, ledger, secrets, logger}).runNow({company, force: true});
		for (const run of records) {
			log.info('confirmation run', {status: run.status, errorType: run.errorType, message: run.message, transactions: run.transactionsSeen});
		}
	}
}
