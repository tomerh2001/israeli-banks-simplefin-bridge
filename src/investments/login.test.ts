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
	function fixture(initiallyAuthenticated: boolean, events: string[] = []) {
		let authenticated = initiallyAuthenticated;
		const click = vi.fn(async (selector: string) => {
			if (selector === '::-p-aria(כניסה לחשבון)') {
				events.push('submit');
				authenticated = true;
			} else {
				events.push('send');
			}
		});
		const page = {
			url: () => authenticated ? browserModule.CLAL_PORTFOLIO_URL : browserModule.CLAL_LOGIN_URL,
			$: async () => null,
			goto: vi.fn(async () => undefined),
			evaluate: async () => true,
			waitForSelector: vi.fn(async (_selector: string, options: {visible?: boolean; hidden?: boolean}) => {
				if (options.visible) {
					events.push('otp-form');
				}
			}),
			locator: (selector: string) => ({
				fill: vi.fn(async () => undefined),
				async click() {
					await click(selector);
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
		return {page, options, click};
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

	it('prepares the receiver before reserving one SMS and reads only after the OTP form appears', async () => {
		const events: string[] = [];
		const {options} = fixture(false, events);
		const prepared = {
			read: vi.fn(async () => {
				events.push('read');
				return '123456';
			}),
			cancel: vi.fn(async () => {
				events.push('cancel');
			}),
		};
		const otpSource = {prepare: vi.fn(async () => {
			events.push('prepare');
			return prepared;
		})};
		const beforeSmsRequest = vi.fn(async () => {
			events.push('reserve');
		});
		vi.mocked(assertClalSessionAuthenticated).mockImplementation(async () => {
			events.push('verified');
		});
		await assistedClalLogin({...options, readOtp: undefined, otpSource, beforeSmsRequest});
		expect(events).toEqual(['prepare', 'reserve', 'send', 'otp-form', 'read', 'submit', 'verified', 'cancel']);
		expect(options.readOtp).not.toHaveBeenCalled();
		expect(options.onSessionVerified).toHaveBeenCalledWith(1199);
	});

	it('does not prepare a receiver or reserve an SMS when protected access already works', async () => {
		const {options} = fixture(true);
		const otpSource = {prepare: vi.fn()};
		const beforeSmsRequest = vi.fn();
		await assistedClalLogin({...options, otpSource, beforeSmsRequest});
		expect(otpSource.prepare).not.toHaveBeenCalled();
		expect(beforeSmsRequest).not.toHaveBeenCalled();
	});

	it('never sends SMS or consumes a budget while the receiver is unavailable', async () => {
		const {options, click} = fixture(false);
		const otpSource = {prepare: vi.fn(async () => {
			throw new browserModule.ClalCollectionError('OTP_REQUIRED');
		})};
		const beforeSmsRequest = vi.fn();
		await expect(assistedClalLogin({...options, otpSource, beforeSmsRequest})).rejects.toThrow('OTP_REQUIRED');
		expect(beforeSmsRequest).not.toHaveBeenCalled();
		expect(click).not.toHaveBeenCalled();
		expect(options.readOtp).not.toHaveBeenCalled();
	});

	it.each(['budget', 'send', 'read', 'invalid-code', 'protected-check'] as const)('cancels the prepared lease after %s failure without resending', async failure => {
		const {options, click} = fixture(false);
		const prepared = {read: vi.fn(async () => '123456'), cancel: vi.fn(async () => undefined)};
		const otpSource = {prepare: vi.fn(async () => prepared)};
		const beforeSmsRequest = vi.fn(async () => undefined);
		const error = new browserModule.ClalCollectionError('OTP_REQUIRED');
		switch (failure) {
			case 'budget': {
				beforeSmsRequest.mockRejectedValue(error);

				break;
			}

			case 'send': {
				click.mockRejectedValueOnce(error);

				break;
			}

			case 'read': {
				prepared.read.mockRejectedValue(error);

				break;
			}

			case 'invalid-code': {
				prepared.read.mockResolvedValue('wrong');

				break;
			}

			case 'protected-check': {
				vi.mocked(assertClalSessionAuthenticated).mockRejectedValue(error);
				break;
			}
		}

		await expect(assistedClalLogin({...options, otpSource, beforeSmsRequest})).rejects.toThrow('OTP_REQUIRED');
		expect(prepared.cancel).toHaveBeenCalledOnce();
		expect(click.mock.calls.filter(([selector]) => selector === '::-p-aria(שליחה)')).toHaveLength(failure === 'budget' ? 0 : 1);
		expect(options.readOtp).not.toHaveBeenCalled();
		expect(options.onSessionVerified).not.toHaveBeenCalled();
	});

	it('cancels without sending when shutdown begins after the receiver became ready', async () => {
		const {options, click} = fixture(false);
		const controller = new AbortController();
		const prepared = {read: vi.fn(async () => '123456'), cancel: vi.fn(async () => undefined)};
		const otpSource = {prepare: vi.fn(async () => prepared)};
		await expect(assistedClalLogin({...options, otpSource, signal: controller.signal, async beforeSmsRequest() {
			controller.abort();
		}})).rejects.toThrow();
		expect(click).not.toHaveBeenCalled();
		expect(prepared.read).not.toHaveBeenCalled();
		expect(prepared.cancel).toHaveBeenCalledOnce();
	});

	it('rejects missing OTP sources before requesting credentials or sending SMS', async () => {
		const {options, click} = fixture(false);
		await expect(assistedClalLogin({...options, readOtp: undefined})).rejects.toThrow('OTP_REQUIRED');
		expect(options.secrets.resolveAll).not.toHaveBeenCalled();
		expect(click).not.toHaveBeenCalled();
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
