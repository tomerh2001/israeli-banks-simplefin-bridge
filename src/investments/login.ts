// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- Login controls are evaluated in the browser.
/// <reference lib="dom" />
/* eslint-disable unicorn/isolated-functions -- document is the browser global inside page.evaluate. */
// eslint-disable-next-line import-x/no-extraneous-dependencies, n/no-extraneous-import
import type {Page} from 'puppeteer';
import type {SecretsResolver} from '../types.js';
import {redact} from '../log.js';
import type {InvestmentConfig} from './config.js';
import {CLAL_LOGIN_URL, CLAL_PORTFOLIO_URL, ClalCollectionError, isClalLogin, withClalBrowser, type ClalBrowserOptions} from './browser.js';
import {assertClalSessionAuthenticated, readClalSessionRemaining} from './session.js';

export type ClalLoginOptions = ClalBrowserOptions & {
	config: InvestmentConfig;
	secrets: SecretsResolver;
	/** Called only after the portal confirms that it is waiting for an SMS code. Never persist the code. */
	readOtp(signal: AbortSignal): Promise<string>;
	/** Runs while the profile is owned, only after protected access and lifetime are verified. */
	onSessionVerified?(remainingSeconds: number): void;
};

/** Material inputs are visually hidden; preserve selected values instead of toggling them. */
export async function configureClalLoginDelivery(page: Page): Promise<void> {
	const configured = await page.evaluate(() => {
		const radios = [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
		const sms = radios.filter(input => [...(input.labels ?? [])].some(label => label.textContent?.trim() === 'סמס'));
		const checkboxes = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
		if (sms.length !== 1 || checkboxes.length !== 1 || sms[0]!.disabled || checkboxes[0]!.disabled) {
			return false;
		}

		for (const input of [sms[0]!, checkboxes[0]!]) {
			if (!input.checked) {
				input.click();
			}
		}

		return sms[0]!.checked && checkboxes[0]!.checked;
	});
	if (!configured) {
		throw new ClalCollectionError('INVALID_RESPONSE');
	}
}

/** Explicit operator command only: scheduled collection must never call this function. */
export async function assistedClalLogin(options: ClalLoginOptions): Promise<void> {
	await withClalBrowser(options, async (page, signal) => {
		await page.goto(CLAL_PORTFOLIO_URL, {waitUntil: 'domcontentloaded'});
		if (!await isClalLogin(page)) {
			try {
				await assertClalSessionAuthenticated(page);
				const remainingSeconds = await readClalSessionRemaining(page);
				signal.throwIfAborted();
				options.onSessionVerified?.(remainingSeconds);
				return;
			} catch (error) {
				if (!(error instanceof ClalCollectionError) || error.code !== 'OTP_REQUIRED') {
					throw error;
				}
			}
		}

		let credentials: Record<string, string>;
		try {
			credentials = await options.secrets.resolveAll(options.config.credentials);
		} catch {
			throw new ClalCollectionError('CREDENTIAL_RESOLUTION_FAILED');
		}

		const {id, phone} = credentials;
		if (!id || !phone || !/^\d{9}$/.test(id) || !/^0\d{8,9}$/.test(phone)) {
			throw new ClalCollectionError('INVALID_CREDENTIALS');
		}

		redact(id);
		redact(phone);
		await page.goto(CLAL_LOGIN_URL, {waitUntil: 'domcontentloaded'});
		await page.locator('[formcontrolname="tz"]').fill(id);
		await page.locator('[formcontrolname="mobile"]').fill(phone);
		await configureClalLoginDelivery(page);
		await page.locator('::-p-aria(שליחה)').click();
		await page.waitForSelector('[formcontrolname="otp"]', {visible: true});
		let code = await options.readOtp(signal);
		if (!/^\d{6}$/.test(code)) {
			throw new ClalCollectionError('OTP_REQUIRED');
		}

		try {
			await page.locator('[formcontrolname="otp"]').fill(code);
		} finally {
			code = '';
		}

		await page.locator('::-p-aria(כניסה לחשבון)').click();
		await page.waitForSelector('[formcontrolname="otp"]', {hidden: true});
		await page.goto(CLAL_PORTFOLIO_URL, {waitUntil: 'domcontentloaded'});
		if (await isClalLogin(page)) {
			throw new ClalCollectionError('OTP_REQUIRED');
		}

		await assertClalSessionAuthenticated(page);
		const remainingSeconds = await readClalSessionRemaining(page);
		signal.throwIfAborted();
		options.onSessionVerified?.(remainingSeconds);
	});
}
