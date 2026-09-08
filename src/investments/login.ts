import type {SecretsResolver} from '../types.js';
import {redact} from '../log.js';
import type {InvestmentConfig} from './config.js';
import {CLAL_LOGIN_URL, CLAL_PORTFOLIO_URL, ClalCollectionError, isClalLogin, withClalBrowser, type ClalBrowserOptions} from './browser.js';

export type ClalLoginOptions = ClalBrowserOptions & {
	config: InvestmentConfig;
	secrets: SecretsResolver;
	/** Called only after the portal confirms that it is waiting for an SMS code. Never persist the code. */
	readOtp(signal: AbortSignal): Promise<string>;
};

/** Explicit operator command only: scheduled collection must never call this function. */
export async function assistedClalLogin(options: ClalLoginOptions): Promise<void> {
	await withClalBrowser(options, async (page, signal) => {
		await page.goto(CLAL_PORTFOLIO_URL, {waitUntil: 'networkidle2'});
		if (!await isClalLogin(page)) {
			return;
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
		// The verified Clal login form has SMS first and exactly one terms checkbox.
		await page.locator('input[type="radio"]').click();
		const checkboxes = await page.$$('input[type="checkbox"]');
		if (checkboxes.length !== 1) {
			throw new ClalCollectionError('INVALID_RESPONSE');
		}

		await page.locator('input[type="checkbox"]').click();
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
		await page.goto(CLAL_PORTFOLIO_URL, {waitUntil: 'networkidle2'});
		if (await isClalLogin(page)) {
			throw new ClalCollectionError('OTP_REQUIRED');
		}
	});
}
