import {randomUUID} from 'node:crypto';
import {chmodSync, mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync} from 'node:fs';
import {hostname} from 'node:os';
import path from 'node:path';
// Use the driver pinned by israeli-bank-scrapers and the matching container browser.
// eslint-disable-next-line import-x/no-extraneous-dependencies, n/no-extraneous-import
import puppeteer, {type Browser, type Page} from 'puppeteer';
import {buildLaunchArgs, resolveExecutablePath} from '../scrape/browser.js';
import type {RuntimeEnv} from '../types.js';
import type {InvestmentErrorCode} from './types.js';

export class ClalCollectionError extends Error {
	constructor(readonly code: InvestmentErrorCode) {
		super(code);
	}
}

/** Existing ownership is a benign skipped attempt; other filesystem errors remain failures. */
export class ClalProfileBusyError extends Error {
	constructor() {
		super('CLAL_PROFILE_BUSY');
	}
}

export const CLAL_PORTFOLIO_URL = 'https://www.clalbit.co.il/portfolio/';
export const CLAL_LOGIN_URL = 'https://www.clalbit.co.il/login/';

/** Never remove Chrome singleton files while another collector might own the profile. */
export function acquireClalProfile(env: RuntimeEnv): {profileDir: string; release(): void} {
	const profileDir = path.resolve(env.chromeDir, 'clal');
	mkdirSync(profileDir, {recursive: true, mode: 0o700});
	chmodSync(profileDir, 0o700);
	const lock = `${profileDir}.collector-lock`;
	try {
		mkdirSync(lock, {mode: 0o700});
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
			throw new ClalProfileBusyError();
		}

		throw new ClalCollectionError('COLLECTION_FAILED');
	}

	const ownerFile = path.join(lock, 'owner.json');
	const ownershipToken = randomUUID();
	try {
		writeFileSync(ownerFile, `${JSON.stringify({
			version: 1,
			ownershipToken,
			hostname: hostname(),
			processId: process.pid,
			acquiredAt: new Date().toISOString(),
		})}\n`, {mode: 0o600, flag: 'wx'});
	} catch {
		// Remove only the empty directory created by this attempt. Never clear a
		// nonempty or pre-existing lock on the assumption its PID is dead here.
		try {
			rmdirSync(lock);
		} catch {}

		throw new ClalCollectionError('COLLECTION_FAILED');
	}

	let released = false;
	return {profileDir, release() {
		if (released) {
			return;
		}

		try {
			const owner = JSON.parse(readFileSync(ownerFile, 'utf8')) as {ownershipToken?: unknown};
			if (owner.ownershipToken !== ownershipToken) {
				throw new ClalCollectionError('COLLECTION_FAILED');
			}

			rmSync(lock, {recursive: true});
			released = true;
		} catch {
			throw new ClalCollectionError('COLLECTION_FAILED');
		}
	}};
}

export type ClalBrowserOptions = {
	env: RuntimeEnv;
	timeoutMinutes: number;
	signal?: AbortSignal;
};

/** A bounded, exclusively owned session. Browser errors never expose authenticated URLs or DOM. */
export async function withClalBrowser<T>(options: ClalBrowserOptions, work: (page: Page, signal: AbortSignal) => Promise<T>): Promise<T> {
	const lock = acquireClalProfile(options.env);
	const controller = new AbortController();
	const abort = () => controller.abort();
	const timeout = setTimeout(abort, options.timeoutMinutes * 60_000);
	options.signal?.addEventListener('abort', abort, {once: true});
	if (options.signal?.aborted) {
		abort();
	}

	let browser: Browser | undefined;
	const close = async () => {
		if (browser?.connected) {
			await browser.close().catch(() => undefined);
		}
	};

	controller.signal.addEventListener('abort', () => {
		void close();
	}, {once: true});
	try {
		controller.signal.throwIfAborted();
		browser = await puppeteer.launch({
			headless: !options.env.showBrowser,
			defaultViewport: {width: 1440, height: 1000},
			executablePath: resolveExecutablePath(options.env),
			args: buildLaunchArgs(lock.profileDir),
			timeout: Math.min(60_000, options.timeoutMinutes * 60_000),
		});
		controller.signal.throwIfAborted();
		const pages = await browser.pages();
		const page = pages[0] ?? await browser.newPage();
		page.setDefaultTimeout(30_000);
		page.setDefaultNavigationTimeout(45_000);
		return await work(page, controller.signal);
	} catch (error) {
		if (controller.signal.aborted || (error instanceof Error && error.name === 'TimeoutError')) {
			throw new ClalCollectionError('TIMEOUT');
		}

		throw error instanceof ClalCollectionError ? error : new ClalCollectionError('COLLECTION_FAILED');
	} finally {
		clearTimeout(timeout);
		options.signal?.removeEventListener('abort', abort);
		await close();
		lock.release();
	}
}

/** A login form means expired authentication. Checking it never submits credentials or requests SMS. */
export async function isClalLogin(page: Page): Promise<boolean> {
	return /\/login\/?(?:[#?]|$)/i.test(page.url())
		|| Boolean(await page.$('[formcontrolname="tz"], [formcontrolname="otp"]'));
}
