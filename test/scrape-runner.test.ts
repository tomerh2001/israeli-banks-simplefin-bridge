import {existsSync, mkdirSync, readdirSync, statSync, utimesSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {buildLaunchArgs, resolveExecutablePath} from '../src/scrape/browser.js';
import {mapScraperError} from '../src/scrape/errors.js';
import {clearStaleLocks, ensureProfileDir, resetProfile} from '../src/scrape/profile.js';
import {pruneScreenshots, runCompany, screenshotPath} from '../src/scrape/runner.js';
import type {RuntimeEnv, SourceRunContext} from '../src/types.js';
import {companyConfig, createCapturingLogger, createTemporaryEnv, fetchResult} from './mocks/fixtures.js';
import {scraperMock} from './mocks/scrapers.js';

vi.mock('israeli-bank-scrapers', async () => import('./mocks/scrapers.js'));
vi.mock('../src/normalize.js', () => ({
	normalizeScrapeResult: vi.fn(() => fetchResult()),
}));

/** Permission bits of a file (the low nine mode bits). */
function permissions(file: string): number {
	// eslint-disable-next-line no-bitwise
	return statSync(file).mode & 0o777;
}

function context(env: RuntimeEnv, overrides: Partial<SourceRunContext> = {}): SourceRunContext {
	const company = overrides.company ?? 'hapoalim';
	return {
		company,
		config: companyConfig(),
		credentials: {userCode: 'user-1', password: 'pass-1234'},
		startDate: new Date('2026-08-01T00:00:00.000Z'),
		env,
		timezone: 'Asia/Jerusalem',
		defaultCurrency: 'ILS',
		profileDir: ensureProfileDir(env, company),
		...overrides,
	};
}

describe('runCompany', () => {
	let env: RuntimeEnv;

	beforeEach(() => {
		scraperMock.reset();
		env = createTemporaryEnv({puppeteerExecutablePath: '/opt/chrome/chrome'});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('maps context and config to library options', async () => {
		const logger = createCapturingLogger();
		scraperMock.behaviour = {progress: ['INITIALIZING', 'LOGIN_SUCCESS'], result: {success: true, accounts: []}};
		const ctx = context(env, {
			config: companyConfig({additionalTransactionInformation: true, futureMonthsToScrape: 2, scraperOptions: {viewportSize: {width: 1, height: 2}, navigationRetryCount: 3}}),
		});

		const outcome = await runCompany(ctx, logger);

		expect(outcome.ok).toBe(true);
		const options = scraperMock.calls[0]!;
		expect(options.companyId).toBe('hapoalim');
		expect(options.startDate).toEqual(ctx.startDate);
		expect(options.executablePath).toBe('/opt/chrome/chrome');
		expect(options.args).toContain(`--user-data-dir=${ctx.profileDir}`);
		expect(options.timeout).toBe(120_000);
		expect(options.defaultTimeout).toBe(60_000);
		expect(options.additionalTransactionInformation).toBe(true);
		expect(options.futureMonthsToScrape).toBe(2);
		expect(options.combineInstallments).toBe(false);
		expect(options.showBrowser).toBe(false);
		expect(options.verbose).toBe(false);
		expect(options.outputData).toEqual({enableTransactionsFilterByDate: true});
		expect(options.viewportSize).toEqual({width: 1, height: 2});
		expect(options.navigationRetryCount).toBe(3);
		expect(String(options.storeFailureScreenShotPath).startsWith(env.screenshotsDir)).toBe(true);
		expect(path.basename(String(options.storeFailureScreenShotPath))).toMatch(/^hapoalim-\d{8}T\d{6}Z\.png$/);
		expect(scraperMock.credentials[0]).toEqual(ctx.credentials);
		expect(scraperMock.browsers[0]!.close).toHaveBeenCalled();

		const progress = logger.lines.filter(line => line.message === 'progress').map(line => line.extra?.type);
		expect(progress).toEqual(['INITIALIZING', 'LOGIN_SUCCESS']);
		expect(logger.lines.some(line => JSON.stringify(line).includes('pass-1234'))).toBe(false);
	});

	it('returns the normalised result on success', async () => {
		scraperMock.behaviour = {result: {success: true, accounts: []}};
		const outcome = await runCompany(context(env), createCapturingLogger());
		expect(outcome).toEqual({ok: true, result: fetchResult()});
	});

	it('kills the browser and reports TIMEOUT when the deadline passes', async () => {
		scraperMock.behaviour = {hang: true};
		const ctx = context(env, {config: companyConfig({timeoutMinutes: 0.001})});

		const outcome = await runCompany(ctx, createCapturingLogger());

		expect(outcome).toEqual({ok: false, errorType: 'TIMEOUT', message: 'Scrape exceeded its time limit'});
		const browser = scraperMock.browsers[0]!;
		expect(browser.close).toHaveBeenCalled();
		expect(browser.connected).toBe(false);
	});

	it('SIGKILLs a Chrome process that survives browser.close()', async () => {
		scraperMock.behaviour = {hang: true};
		const ctx = context(env, {config: companyConfig({timeoutMinutes: 0.001})});
		const run = runCompany(ctx, createCapturingLogger());
		await vi.waitFor(() => {
			expect(scraperMock.browsers.length).toBe(1);
		});
		const browser = scraperMock.browsers[0]!;
		// close() resolves without the Chrome process exiting.
		browser.close.mockImplementation(async () => {
			browser.connected = false;
		});

		const outcome = await run;
		expect(outcome.ok).toBe(false);
		expect(browser.child.kill).toHaveBeenCalledWith('SIGKILL');
	});

	it('maps library errors to fixed messages without bank text', async () => {
		scraperMock.behaviour = {result: {success: false, errorType: 'INVALID_PASSWORD', errorMessage: 'Login failed with INVALID_PASSWORD error at https://login.bank/secret?acct=123'}};
		const logger = createCapturingLogger();

		const outcome = await runCompany(context(env), logger);

		expect(outcome).toEqual({ok: false, errorType: 'INVALID_PASSWORD', message: 'Bank rejected the credentials'});
		const info = logger.lines.filter(line => line.level !== 'debug');
		expect(info.some(line => JSON.stringify(line).includes('acct=123'))).toBe(false);
	});

	it('detects an OTP page from the last main-frame URL', async () => {
		scraperMock.behaviour = {
			result: {success: false, errorType: 'GENERAL_ERROR', errorMessage: 'Login failed with UNKNOWN_ERROR error'},
			pageUrl: 'https://login.bankhapoalim.co.il/ng-portals/auth/he/otp?x=1',
		};

		const outcome = await runCompany(context(env), createCapturingLogger());

		expect(outcome).toMatchObject({ok: false, errorType: 'OTP_REQUIRED'});
	});

	it('preserves a login timeout on the ordinary Hapoalim auth page', async () => {
		scraperMock.behaviour = {
			result: {success: false, errorType: 'TIMEOUT', errorMessage: 'Timed out waiting for the login form'},
			pageUrl: 'https://login.bankhapoalim.co.il/ng-portals/auth/he/',
		};

		const outcome = await runCompany(context(env), createCapturingLogger());

		expect(outcome).toEqual({ok: false, errorType: 'TIMEOUT', message: 'Scrape exceeded its time limit'});
	});

	it.each(['GENERIC', 'GENERAL_ERROR', 'TIMEOUT'])('recognizes a visible same-page OTP form after browser cleanup for %s', async errorType => {
		scraperMock.behaviour = {
			result: {success: false, errorType, errorMessage: 'Login did not finish'},
			pageUrl: 'https://login.bankhapoalim.co.il/ng-portals/auth/he/',
			otpFormVisible: true,
		};

		const outcome = await runCompany(context(env), createCapturingLogger());

		expect(outcome).toMatchObject({ok: false, errorType: 'OTP_REQUIRED'});
		expect(scraperMock.browsers[0]!.connected).toBe(false);
		const page = scraperMock.pages[0]!;
		expect(page.waitForSelector).toHaveBeenCalledWith('form.auth-otp-login', expect.objectContaining({visible: true, timeout: 0}));
		expect(page.otpHandle.dispose).toHaveBeenCalledOnce();
	});

	it.each(['INVALID_PASSWORD', 'CHANGE_PASSWORD', 'ACCOUNT_BLOCKED'])('preserves explicit %s despite an observed OTP form', async errorType => {
		scraperMock.behaviour = {result: {success: false, errorType, errorMessage: 'OTP login rejected'}, otpFormVisible: true};

		const outcome = await runCompany(context(env), createCapturingLogger());

		expect(outcome).toMatchObject({ok: false, errorType});
	});

	it('preserves a successful scrape after an observed OTP form', async () => {
		scraperMock.behaviour = {result: {success: true, accounts: []}, otpFormVisible: true};

		const outcome = await runCompany(context(env), createCapturingLogger());

		expect(outcome.ok).toBe(true);
	});

	it('does not watch another company for the Hapoalim form', async () => {
		scraperMock.behaviour = {result: {success: false, errorType: 'TIMEOUT'}, otpFormVisible: true};

		const outcome = await runCompany(context(env, {company: 'visaCal'}), createCapturingLogger());

		expect(outcome).toMatchObject({ok: false, errorType: 'TIMEOUT'});
		expect(scraperMock.pages[0]!.waitForSelector).not.toHaveBeenCalled();
	});

	it('cancels the watcher and tolerates page closure when no visible form appears', async () => {
		scraperMock.behaviour = {result: {success: false, errorType: 'GENERIC'}, otpFormVisible: false};

		const outcome = await runCompany(context(env), createCapturingLogger());

		expect(outcome).toMatchObject({ok: false, errorType: 'GENERIC'});
		const page = scraperMock.pages[0]!;
		expect(page.waitForSelector.mock.calls[0]![1].signal.aborted).toBe(true);
		expect(page.otpHandle.dispose).not.toHaveBeenCalled();
	});

	it('reports an observed OTP challenge when the overall scrape deadline expires', async () => {
		scraperMock.behaviour = {hang: true, otpFormVisible: true};

		const outcome = await runCompany(context(env, {config: companyConfig({timeoutMinutes: 0.001})}), createCapturingLogger());

		expect(outcome).toMatchObject({ok: false, errorType: 'OTP_REQUIRED'});
		expect(scraperMock.browsers[0]!.connected).toBe(false);
	});

	it('reports BRIDGE_ERROR when the library throws', async () => {
		scraperMock.behaviour = {throwError: new Error('boom')};
		const outcome = await runCompany(context(env), createCapturingLogger());
		expect(outcome).toEqual({ok: false, errorType: 'BRIDGE_ERROR', message: 'Bridge internal error'});
	});

	it('creates the screenshots dir, prunes old files and clears stale profile locks', async () => {
		const ctx = context(env);
		mkdirSync(env.screenshotsDir, {recursive: true});
		const old = path.join(env.screenshotsDir, 'hapoalim-old.png');
		const fresh = path.join(env.screenshotsDir, 'hapoalim-fresh.png');
		writeFileSync(old, 'x');
		writeFileSync(fresh, 'x');
		const fortyDaysAgo = (Date.now() - (40 * 86_400_000)) / 1000;
		utimesSync(old, fortyDaysAgo, fortyDaysAgo);
		for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
			writeFileSync(path.join(ctx.profileDir, name), '');
		}

		scraperMock.behaviour = {result: {success: true, accounts: []}};
		await runCompany(ctx, createCapturingLogger());

		expect(readdirSync(env.screenshotsDir)).toEqual(['hapoalim-fresh.png']);
		expect(readdirSync(ctx.profileDir)).toEqual([]);
		expect(permissions(ctx.profileDir)).toBe(0o700);
	});

	it('chmods a failure screenshot to 0600', async () => {
		const ctx = context(env);
		scraperMock.behaviour = {result: {success: false, errorType: 'GENERIC', errorMessage: 'x'}, delayMs: 100};
		// Simulate the library writing the screenshot while the scrape is still running.
		const run = runCompany(ctx, createCapturingLogger());
		await vi.waitFor(() => {
			expect(scraperMock.calls.length).toBe(1);
		});
		const file = String(scraperMock.calls[0]!.storeFailureScreenShotPath);
		writeFileSync(file, 'png', {mode: 0o644});
		await run;
		expect(permissions(file)).toBe(0o600);
	});
});

describe('screenshotPath / pruneScreenshots', () => {
	it('names files by company and UTC timestamp', () => {
		const env = createTemporaryEnv();
		expect(screenshotPath(env, 'visaCal', new Date('2026-09-05T18:25:03.123Z'))).toBe(path.join(env.screenshotsDir, 'visaCal-20260905T182503Z.png'));
	});

	it('returns the number of pruned files', () => {
		const env = createTemporaryEnv();
		const pruned = pruneScreenshots(env.screenshotsDir, new Date(), createCapturingLogger());
		expect(pruned).toBe(0);
		expect(existsSync(env.screenshotsDir)).toBe(true);
	});
});

describe('mapScraperError', () => {
	it('uses fixed messages per type and GENERIC for unknown types', () => {
		expect(mapScraperError('INVALID_PASSWORD', 'anything')).toEqual({errorType: 'INVALID_PASSWORD', message: 'Bank rejected the credentials'});
		expect(mapScraperError('CHANGE_PASSWORD')).toMatchObject({errorType: 'CHANGE_PASSWORD'});
		expect(mapScraperError('ACCOUNT_BLOCKED')).toMatchObject({errorType: 'ACCOUNT_BLOCKED'});
		expect(mapScraperError('TIMEOUT')).toMatchObject({errorType: 'TIMEOUT'});
		expect(mapScraperError('WHATEVER', 'page said hello')).toEqual({errorType: 'GENERIC', message: 'Scraper failed with a generic error'});
		expect(mapScraperError(undefined, undefined)).toMatchObject({errorType: 'GENERIC'});
	});

	it('detects OTP challenges from message or URL text', () => {
		expect(mapScraperError('GENERIC', 'waiting for url https://x/ng-portals/auth/he/otp')).toMatchObject({errorType: 'OTP_REQUIRED'});
		expect(mapScraperError('TIMEOUT', 'Enter the OTP code')).toMatchObject({errorType: 'OTP_REQUIRED'});
		expect(mapScraperError('GENERIC', 'we sent an SMS')).toMatchObject({errorType: 'OTP_REQUIRED'});
		expect(mapScraperError('GENERIC', 'transmission error')).toMatchObject({errorType: 'GENERIC'});
		expect(mapScraperError('GENERIC', 'bank said: OTP required').message).not.toContain('bank said');
	});

	it.each(['GENERIC', 'TIMEOUT', 'INVALID_PASSWORD', 'CHANGE_PASSWORD', 'ACCOUNT_BLOCKED'])('preserves %s when the only URL evidence is the ordinary auth page', errorType => {
		expect(mapScraperError(errorType, 'waiting for url https://login.bankhapoalim.co.il/ng-portals/auth/he/'))
			.toMatchObject({errorType});
	});
});

describe('browser helpers', () => {
	const savedSandbox = process.env.CHROME_NO_SANDBOX;
	const savedCache = process.env.PUPPETEER_CACHE_DIR;

	afterEach(() => {
		if (savedSandbox === undefined) {
			delete process.env.CHROME_NO_SANDBOX;
		} else {
			process.env.CHROME_NO_SANDBOX = savedSandbox;
		}

		if (savedCache === undefined) {
			delete process.env.PUPPETEER_CACHE_DIR;
		} else {
			process.env.PUPPETEER_CACHE_DIR = savedCache;
		}
	});

	it('builds launch args with the profile dir and sandbox flags only on request', () => {
		delete process.env.CHROME_NO_SANDBOX;
		expect(buildLaunchArgs('/data/chrome/hapoalim')).toEqual([
			'--user-data-dir=/data/chrome/hapoalim',
			'--disable-dev-shm-usage',
			'--disable-gpu',
			'--no-first-run',
			'--no-default-browser-check',
			'--password-store=basic',
		]);
		process.env.CHROME_NO_SANDBOX = '1';
		expect(buildLaunchArgs('/p')).toEqual(expect.arrayContaining(['--no-sandbox', '--disable-setuid-sandbox']));
	});

	it('resolves the executable from env, then the puppeteer cache, else undefined', () => {
		expect(resolveExecutablePath(createTemporaryEnv({puppeteerExecutablePath: '/x/chrome'}))).toBe('/x/chrome');

		const env = createTemporaryEnv();
		process.env.PUPPETEER_CACHE_DIR = env.dataDir;
		expect(resolveExecutablePath(env)).toBeUndefined();

		const chrome = path.join(env.dataDir, 'chrome', 'linux-131.0.0.0', 'chrome-linux64', 'chrome');
		mkdirSync(path.dirname(chrome), {recursive: true});
		writeFileSync(chrome, '');
		expect(resolveExecutablePath(env)).toBe(chrome);
	});

	it('creates, cleans and resets profiles', () => {
		const env = createTemporaryEnv();
		const dir = ensureProfileDir(env, 'visaCal');
		expect(dir).toBe(path.join(env.chromeDir, 'visaCal'));
		writeFileSync(path.join(dir, 'SingletonLock'), '');
		writeFileSync(path.join(dir, 'Cookies'), '');
		clearStaleLocks(dir);
		expect(readdirSync(dir)).toEqual(['Cookies']);
		clearStaleLocks(dir); // Idempotent when nothing is there.
		expect(resetProfile(env, 'visaCal')).toBe(dir);
		expect(existsSync(dir)).toBe(false);
	});
});
