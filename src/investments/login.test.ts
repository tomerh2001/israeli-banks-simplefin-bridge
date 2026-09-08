// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- These regression tests run against actual browser controls.
/// <reference lib="dom" />
/* eslint-disable unicorn/isolated-functions -- document is the browser global inside page.evaluate. */
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest';
// eslint-disable-next-line import-x/no-extraneous-dependencies, n/no-extraneous-import
import puppeteer, {type Browser, type Page} from 'puppeteer';
import {readRuntimeEnv} from '../config.js';
import {assistedClalLogin, configureClalLoginDelivery} from './login.js';
import {investmentConfigSchema} from './config.js';
import * as browserModule from './browser.js';
import {assertClalSessionAuthenticated, readClalSessionRemaining} from './session.js';

vi.mock('./browser.js', async importOriginal => ({
	...await importOriginal<typeof browserModule>(), withClalBrowser: vi.fn(),
}));
vi.mock('./session.js', () => ({assertClalSessionAuthenticated: vi.fn(), readClalSessionRemaining: vi.fn()}));

afterEach(() => vi.resetAllMocks());

describe('Clal assisted login confirmation', () => {
	function fixture(initiallyAuthenticated: boolean) {
		let authenticated = initiallyAuthenticated;
		const page = {
			url: () => authenticated ? browserModule.CLAL_PORTFOLIO_URL : browserModule.CLAL_LOGIN_URL,
			$: async () => null,
			goto: vi.fn(async () => undefined),
			evaluate: async () => true,
			waitForSelector: vi.fn(async () => undefined),
			locator: (selector: string) => ({
				fill: vi.fn(async () => undefined),
				async click() {
					if (selector === '::-p-aria(כניסה לחשבון)') {
						authenticated = true;
					}
				},
			}),
		};
		vi.mocked(browserModule.withClalBrowser).mockImplementation(async (options, work) => work(page as never, options.signal ?? new AbortController().signal));
		vi.mocked(assertClalSessionAuthenticated).mockResolvedValue();
		vi.mocked(readClalSessionRemaining).mockResolvedValue(1199);
		const options = {
			env: readRuntimeEnv(), timeoutMinutes: 2, config: investmentConfigSchema.parse({enabled: true}),
			secrets: {resolve: vi.fn(async (reference: string) => reference), resolveAll: vi.fn(async () => ({id: '123456789', phone: '0501234567'}))},
			readOtp: vi.fn(async () => '123456'), onSessionVerified: vi.fn(),
		};
		return {page, options};
	}

	it('reuses protected authenticated access without requesting credentials or an OTP', async () => {
		const {options} = fixture(true);
		await assistedClalLogin(options);
		expect(assertClalSessionAuthenticated).toHaveBeenCalledOnce();
		expect(options.onSessionVerified).toHaveBeenCalledWith(1199);
		expect(options.secrets.resolveAll).not.toHaveBeenCalled();
		expect(options.readOtp).not.toHaveBeenCalled();
	});

	it('confirms an OTP login without requiring unrelated network traffic to become idle', async () => {
		const {page, options} = fixture(false);
		await assistedClalLogin(options);
		expect(options.readOtp).toHaveBeenCalledOnce();
		expect(assertClalSessionAuthenticated).toHaveBeenCalledOnce();
		expect(options.onSessionVerified).toHaveBeenCalledWith(1199);
		for (const call of vi.mocked(page.goto).mock.calls) {
			expect(call).toEqual([expect.any(String), {waitUntil: 'domcontentloaded'}]);
		}
	});

	it('does not report a positive generic timer as a successful OTP login', async () => {
		const {options} = fixture(false);
		vi.mocked(assertClalSessionAuthenticated).mockRejectedValue(new browserModule.ClalCollectionError('OTP_REQUIRED'));
		await expect(assistedClalLogin(options)).rejects.toThrow('OTP_REQUIRED');
		expect(readClalSessionRemaining).not.toHaveBeenCalled();
		expect(options.onSessionVerified).not.toHaveBeenCalled();
	});

	it('does not publish session health after cancellation', async () => {
		const {options} = fixture(true);
		const controller = new AbortController();
		vi.mocked(readClalSessionRemaining).mockImplementation(async () => {
			controller.abort();
			return 1199;
		});
		await expect(assistedClalLogin({...options, signal: controller.signal})).rejects.toThrow();
		expect(options.onSessionVerified).not.toHaveBeenCalled();
	});
});

// Opt in with the container's pinned Chrome; these tests never contact Clal.
describe.runIf(process.env.CLAL_BROWSER_TEST === '1')('Clal hidden Material controls', () => {
	let browser: Browser;
	let page: Page;
	beforeAll(async () => {
		browser = await puppeteer.launch({headless: true, args: ['--no-sandbox']});
		page = await browser.newPage();
	});
	afterAll(async () => browser?.close());

	async function fixture(selected: boolean) {
		await page.setContent(`
			<style>input { position:absolute; clip:rect(0,0,0,0); width:1px; height:1px; }</style>
			<label for="voice">הודעה קולית</label><input id="voice" name="delivery" type="radio" ${selected ? '' : 'checked'}>
			<label for="sms">סמס</label><input id="sms" name="delivery" type="radio" ${selected ? 'checked' : ''}>
			<label for="consent">Consent</label><input id="consent" type="checkbox" ${selected ? 'checked' : ''}>
		`);
	}

	it('preserves already selected SMS and consent without toggling either', async () => {
		await fixture(true);
		await page.evaluate(() => {
			for (const input of document.querySelectorAll('input')) {
				input.addEventListener('click', () => {
					input.dataset.clicked = 'true';
				});
			}
		});
		await configureClalLoginDelivery(page);
		expect(await page.$$eval('input:checked', elements => elements.map(element => element.id))).toEqual(['sms', 'consent']);
		expect(await page.$$('[data-clicked]')).toHaveLength(0);
	});

	it('selects SMS by its label when it is not first and enables unselected consent', async () => {
		await fixture(false);
		await configureClalLoginDelivery(page);
		expect(await page.$$eval('input:checked', elements => elements.map(element => element.id))).toEqual(['sms', 'consent']);
	});

	it('rejects an ambiguous form before changing any input', async () => {
		await fixture(false);
		await page.evaluate(() => {
			const input = document.createElement('input');
			input.type = 'checkbox';
			document.body.append(input);
		});
		await expect(configureClalLoginDelivery(page)).rejects.toThrow('INVALID_RESPONSE');
		expect(await page.$$eval('input:checked', elements => elements.map(element => element.id))).toEqual(['voice']);
	});
});
