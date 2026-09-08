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
import type {ClalOtpRequest, ClalOtpSource} from './otp.js';

export type ClalLoginOptions = ClalBrowserOptions & {
	config: InvestmentConfig;
	secrets: SecretsResolver;
	/** Called only after the portal confirms that it is waiting for an SMS code. Never persist the code. */
	readOtp?(signal: AbortSignal): Promise<string>;
	/** Optional receiver must become ready before requesting a new SMS. */
	otpSource?: ClalOtpSource;
	/** Reserve the persistent SMS budget after receiver readiness, before the sole Send click. */
	beforeSmsRequest?(signal: AbortSignal): Promise<void>;
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

/** Request SMS only through explicit login or the configured bounded recovery flow. */
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

		if (!options.otpSource && !options.readOtp) {
			throw new ClalCollectionError('OTP_REQUIRED');
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
		await page.waitForSelector('[formcontrolname="tz"]', {visible: true});
		// Changing delivery recreates Clal's mobile control with an empty value.
		await configureClalLoginDelivery(page);
		await page.locator('[formcontrolname="tz"]').fill(id);
		await page.locator('[formcontrolname="mobile"]').fill(phone);
		let otpRequest: ClalOtpRequest | undefined;
		try {
			otpRequest = await options.otpSource?.prepare(signal);
			signal.throwIfAborted();
			await options.beforeSmsRequest?.(signal);
			signal.throwIfAborted();
			await page.locator('::-p-aria(שליחה)').click();
			await page.waitForSelector('[formcontrolname="otp"]', {visible: true});
			let code = await (otpRequest ? otpRequest.read(signal) : options.readOtp!(signal));
			if (!/^\d{6}$/.test(code)) {
				throw new ClalCollectionError('OTP_REQUIRED');
			}

			try {
				signal.throwIfAborted();
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
		} finally {
			await otpRequest?.cancel();
		}
	});
}
