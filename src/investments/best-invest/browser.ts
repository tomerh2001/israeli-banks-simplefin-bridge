// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- Session storage is evaluated in the browser.
/// <reference lib="dom" />
import {spawn, type ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {chmodSync, closeSync, existsSync, fchmodSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync} from 'node:fs';
import {hostname} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
// Reuse the driver pinned by israeli-bank-scrapers and the matching container browser.
// eslint-disable-next-line import-x/no-extraneous-dependencies, n/no-extraneous-import
import puppeteer, {type Browser, type Page} from 'puppeteer';
import {buildLaunchArgs, resolveExecutablePath} from '../../scrape/browser.js';
import type {RuntimeEnv} from '../../types.js';
import type {InvestmentErrorCode} from '../types.js';
import {investmentErrorCodeSchema} from '../schema.js';

export const BEST_INVEST_ORIGIN = 'https://customers.hcsra.co.il';
export const BEST_INVEST_LOGIN_URL = `${BEST_INVEST_ORIGIN}/#/login`;

export class BestInvestCollectionError extends Error {
	constructor(readonly code: InvestmentErrorCode) {
		super(code);
	}
}

export class BestInvestProfileBusyError extends Error {
	constructor() {
		super('BEST_INVEST_PROFILE_BUSY');
	}
}

export function acquireBestInvestProfile(env: RuntimeEnv): {profileDir: string; release(): void} {
	const profileDir = path.resolve(env.chromeDir, 'best-invest');
	mkdirSync(profileDir, {recursive: true, mode: 0o700});
	chmodSync(profileDir, 0o700);
	const lock = `${profileDir}.collector-lock`;
	try {
		mkdirSync(lock, {mode: 0o700});
		chmodSync(lock, 0o700);
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
			throw new BestInvestProfileBusyError();
		}

		throw new BestInvestCollectionError('COLLECTION_FAILED');
	}

	const ownerFile = path.join(lock, 'owner.json');
	const ownershipToken = randomUUID();
	try {
		writeFileSync(ownerFile, JSON.stringify({version: 1, ownershipToken, hostname: hostname(), processId: process.pid}), {mode: 0o600, flag: 'wx'});
		chmodSync(ownerFile, 0o600);
	} catch {
		try {
			rmdirSync(lock);
		} catch {}

		throw new BestInvestCollectionError('COLLECTION_FAILED');
	}

	let released = false;
	return {profileDir, release() {
		if (released) {
			return;
		}

		try {
			const owner = JSON.parse(readFileSync(ownerFile, 'utf8')) as {ownershipToken?: unknown};
			if (owner.ownershipToken !== ownershipToken) {
				throw new BestInvestCollectionError('COLLECTION_FAILED');
			}

			rmSync(lock, {recursive: true});
			released = true;
		} catch {
			throw new BestInvestCollectionError('COLLECTION_FAILED');
		}
	}};
}

/** Only the portal's existing user session is retained. Invalid/expired tokens are never restored. */
export function validBestInvestSession(value: unknown, now = Date.now()): value is string {
	if (typeof value !== 'string' || value.length > 65_536) {
		return false;
	}

	try {
		const session = JSON.parse(value) as Record<string, unknown>;
		return session !== null && typeof session === 'object' && !Array.isArray(session)
			&& typeof session.token === 'string' && session.token.length > 20
			&& typeof session.username === 'string' && /^\d{9}$/.test(session.username)
			&& typeof session.expireAt === 'string' && Date.parse(session.expireAt) > now + 30_000;
	} catch {
		return false;
	}
}

export type BestInvestBrowserOptions = {env: RuntimeEnv; timeoutMinutes: number; signal?: AbortSignal};

/** Explicit descriptor permissions defeat inherited ACLs before any token bytes are written. */
export function saveBestInvestSession(profileDir: string, session: unknown): boolean {
	if (!validBestInvestSession(session)) {
		return false;
	}

	const sessionFile = path.join(profileDir, 'portal-session.json');
	const temporary = `${sessionFile}.${randomUUID()}.tmp`;
	try {
		const descriptor = openSync(temporary, 'wx', 0o600);
		try {
			fchmodSync(descriptor, 0o600);
			writeFileSync(descriptor, session);
		} finally {
			closeSync(descriptor);
		}

		renameSync(temporary, sessionFile);
		return true;
	} finally {
		rmSync(temporary, {force: true});
	}
}

async function stopProcess(child: ChildProcess | undefined): Promise<void> {
	if (!child?.pid || child.exitCode !== null || child.signalCode !== null) {
		return;
	}

	await new Promise<void>(resolve => {
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
		}, 5000);
		child.once('exit', () => {
			clearTimeout(timer);
			resolve();
		});
		child.kill('SIGTERM');
	});
}

/** Native headed Chromium was required by the portal. CDP stays on a random loopback port. */
export async function withBestInvestBrowser<T>(options: BestInvestBrowserOptions, work: (page: Page, signal: AbortSignal) => Promise<T>): Promise<T> {
	const lease = acquireBestInvestProfile(options.env);
	const controller = new AbortController();
	const abort = () => controller.abort();
	const timeout = setTimeout(abort, options.timeoutMinutes * 60_000);
	options.signal?.addEventListener('abort', abort, {once: true});
	if (options.signal?.aborted) {
		abort();
	}

	let native: ChildProcess | undefined;
	let browser: Browser | undefined;
	let page: Page | undefined;
	let closing: Promise<void> | undefined;
	const close = async () => {
		closing ??= (async () => {
			if (browser?.connected) {
				await Promise.race([browser.close().catch(() => undefined), delay(5000)]);
			}

			await stopProcess(native);
		})();
		await closing;
	};

	controller.signal.addEventListener('abort', () => {
		void close();
	}, {once: true});
	const sessionFile = path.join(lease.profileDir, 'portal-session.json');
	try {
		controller.signal.throwIfAborted();
		if (!process.env.DISPLAY) {
			throw new BestInvestCollectionError('COLLECTION_FAILED');
		}

		const portFile = path.join(lease.profileDir, 'DevToolsActivePort');
		rmSync(portFile, {force: true});
		native = spawn(resolveExecutablePath(options.env) ?? puppeteer.executablePath(), [
			...buildLaunchArgs(lease.profileDir), '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', 'about:blank',
		], {stdio: 'ignore'});
		let launchFailed = false;
		native.once('error', () => {
			launchFailed = true;
		});
		const deadline = Date.now() + 30_000;
		while (!existsSync(portFile)) {
			controller.signal.throwIfAborted();
			if (launchFailed || native.exitCode !== null || Date.now() >= deadline) {
				throw new BestInvestCollectionError('COLLECTION_FAILED');
			}

			// eslint-disable-next-line no-await-in-loop -- Wait for this exclusively owned browser's CDP port.
			await delay(100, undefined, {signal: controller.signal});
		}

		const port = readFileSync(portFile, 'utf8').split('\n', 1)[0];
		if (!port || !/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65_535) {
			throw new BestInvestCollectionError('COLLECTION_FAILED');
		}

		browser = await puppeteer.connect({browserURL: `http://127.0.0.1:${port}`, defaultViewport: {width: 1440, height: 1000}});
		controller.signal.throwIfAborted();
		page = await browser.newPage();
		page.setDefaultTimeout(30_000);
		page.setDefaultNavigationTimeout(45_000);
		let restored: string | undefined;
		if (existsSync(sessionFile)) {
			chmodSync(sessionFile, 0o600);
			const saved = readFileSync(sessionFile, 'utf8');
			if (validBestInvestSession(saved)) {
				restored = saved;
			} else {
				rmSync(sessionFile, {force: true});
			}
		}

		let restoreScript: string | undefined;
		if (restored) {
			// Runs before application initialization; the token never enters another origin.
			const script = await page.evaluateOnNewDocument((origin, session) => {
				if (location.origin === origin && !sessionStorage.getItem('currentUser')) {
					sessionStorage.setItem('currentUser', session);
				}
			}, BEST_INVEST_ORIGIN, restored);
			restoreScript = script.identifier;
		}

		await page.goto(`${BEST_INVEST_ORIGIN}/#/`, {waitUntil: 'domcontentloaded'});
		if (restoreScript) {
			await page.removeScriptToEvaluateOnNewDocument(restoreScript);
		}

		const result = await work(page, controller.signal);
		controller.signal.throwIfAborted();
		if (new URL(page.url()).origin !== BEST_INVEST_ORIGIN) {
			throw new BestInvestCollectionError('INVALID_RESPONSE');
		}

		const session = await page.evaluate(() => sessionStorage.getItem('currentUser'));
		if (!saveBestInvestSession(lease.profileDir, session)) {
			rmSync(sessionFile, {force: true});
		}

		return result;
	} catch (error) {
		const parsedCode = investmentErrorCodeSchema.safeParse(error instanceof Error && 'code' in error ? error.code : undefined);
		if (parsedCode.success && parsedCode.data === 'OTP_REQUIRED') {
			rmSync(sessionFile, {force: true});
		} else if (!controller.signal.aborted && page && new URL(page.url()).origin === BEST_INVEST_ORIGIN) {
			try {
				// A parser/backend failure must not discard a newly authenticated
				// session and force another OTP. Preserve the original collection error.
				const session = await page.evaluate(() => sessionStorage.getItem('currentUser'));
				saveBestInvestSession(lease.profileDir, session);
			} catch {}
		}

		if (controller.signal.aborted || (error instanceof Error && error.name === 'TimeoutError')) {
			throw new BestInvestCollectionError('TIMEOUT');
		}

		throw new BestInvestCollectionError(parsedCode.success ? parsedCode.data : 'COLLECTION_FAILED');
	} finally {
		clearTimeout(timeout);
		options.signal?.removeEventListener('abort', abort);
		await close();
		lease.release();
	}
}
