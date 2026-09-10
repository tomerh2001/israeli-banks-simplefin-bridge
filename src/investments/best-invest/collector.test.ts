import {afterEach, describe, expect, it, vi} from 'vitest';
import {readRuntimeEnv} from '../../config.js';
import type {Logger} from '../../log.js';
import {investmentConfigSchema} from '../config.js';
import {createInvestmentStore} from '../store.js';
import type {InvestmentCollectionContext} from '../runtime.js';
import type {InvestmentStore} from '../types.js';
import * as browserModule from './browser.js';
import {createBestInvestCollector, loginBestInvest, readBestInvestSnapshot, requestBestInvest} from './collector.js';
import {buildBestInvestSnapshot} from './parser.js';

vi.mock('./browser.js', async importOriginal => ({
	...await importOriginal<typeof browserModule>(), withBestInvestBrowser: vi.fn(),
}));
const {BestInvestCollectionError, BestInvestProfileBusyError, withBestInvestBrowser} = browserModule;
const logger: Logger = {info: vi.fn<Logger['info']>(), warn: vi.fn<Logger['warn']>(), error: vi.fn<Logger['error']>(), debug: vi.fn<Logger['debug']>(), child: () => logger};
const stores: InvestmentStore[] = [];
const observedAt = '2026-09-08T06:00:00.000Z';
const snapshot = {observedAt, complete: true, inventoryComplete: true, products: [], valuations: [], activities: [], tracks: []};

function context(signal = new AbortController().signal): InvestmentCollectionContext {
	const store = createInvestmentStore(':memory:', 'hachshara_best_invest');
	stores.push(store);
	store.applySnapshot(snapshot);
	return {store, signal, logger, env: readRuntimeEnv(),
		config: investmentConfigSchema.parse({enabled: true, credentials: {id: '123456782', phone: '0500000000'}}),
		secrets: {resolve: async reference => reference, resolveAll: async values => values}};
}

afterEach(() => {
	for (const store of stores) {
		store.close();
	}

	stores.length = 0;
	vi.resetAllMocks();
});

describe('Best Invest collection isolation and cancellation', () => {
	it('logs each fixed incomplete reason once while retaining all previously verified financial rows', async () => {
		const input = context();
		input.store.applySnapshot(buildBestInvestSnapshot({observedAt, inventoryComplete: true, policies: [{details: {
			PolicyId: '123', ProductName: 'Synthetic private policy', TotalSavings: '27.50',
			PidyonTzvira: {AppraislDate: '2026-09-07', TotalTzviraMaslulim: '27.50', Pidyon: [{TotalTzvira: '27.50', BeitHashkaot: 'Synthetic house', Maslul: 'Synthetic route'}]},
			InvestmentPolicy: {Investments: [{BeitHashkaotName: 'Synthetic house', Maslul: 'Synthetic route', BeitHashkaotId: '1', MaslulId: '2'}]},
		}}]}));
		const before = input.store.getFeed(new Date(observedAt), 72);
		const page = {url: () => browserModule.BEST_INVEST_ORIGIN, evaluate: vi.fn()
			.mockResolvedValueOnce(true)
			.mockResolvedValueOnce({text: '{"Policies":[{"PolicyNumber":"123","TemplateId":"8"},{"PolicyNumber":"456","TemplateId":"8"}]}'})
			.mockResolvedValueOnce({text: '{"PolicyId":"123","ProductName":"Synthetic private policy","TotalSavings":null}'})
			.mockResolvedValueOnce({text: '{"Deposits":[],"TotalAmount":"0"}'})
			.mockResolvedValueOnce({text: '{"PolicyId":"456","ProductName":"Other synthetic private policy","TotalSavings":null}'})
			.mockResolvedValueOnce({text: '{"Deposits":[],"TotalAmount":"0"}'})};
		vi.mocked(withBestInvestBrowser).mockImplementation(async (_options, work) => work(page as never, input.signal));
		expect(await createBestInvestCollector()(input)).toBe('partial');
		const after = input.store.getFeed(new Date(), 72);
		expect(after.products).toEqual(before.products);
		expect(after.valuations).toEqual(before.valuations);
		expect(after.tracks).toEqual(before.tracks);
		expect(after.source).toMatchObject({status: 'partial', errorCode: 'INCOMPLETE_RESPONSE', lastSuccessAt: observedAt});
		expect(logger.warn).toHaveBeenCalledExactlyOnceWith('Best Invest snapshot incomplete', {reason: 'VALUATION_AMOUNT_MISSING'});
		const logs = JSON.stringify([...vi.mocked(logger.warn).mock.calls, ...vi.mocked(logger.info).mock.calls]);
		for (const privateValue of ['Synthetic private policy', 'Other synthetic private policy', '123', '456', '27.50', 'Synthetic house', 'Synthetic route']) {
			expect(logs).not.toContain(privateValue);
		}
	});

	it('does not open a browser or update source health after shutdown', async () => {
		const controller = new AbortController();
		controller.abort();
		const input = context(controller.signal);
		expect(await createBestInvestCollector()(input)).toBe('error');
		expect(withBestInvestBrowser).not.toHaveBeenCalled();
		expect(input.store.getFeed(new Date(observedAt), 72).source.status).toBe('ok');
	});

	it('preserves last successful data and reports authentication failure without exposing the cause', async () => {
		const input = context();
		vi.mocked(withBestInvestBrowser).mockRejectedValue(new BestInvestCollectionError('OTP_REQUIRED'));
		expect(await createBestInvestCollector()(input)).toBe('auth_required');
		expect(input.store.getFeed(new Date(observedAt), 72).source).toMatchObject({provider: 'hachshara_best_invest', status: 'auth_required', lastSuccessAt: observedAt});
		expect(logger.warn).toHaveBeenCalledWith('Best Invest collection needs attention', {status: 'auth_required', errorCode: 'OTP_REQUIRED'});
	});

	it('skips an owned profile without changing health', async () => {
		const input = context();
		vi.mocked(withBestInvestBrowser).mockRejectedValue(new BestInvestProfileBusyError());
		expect(await createBestInvestCollector()(input)).toBe('skipped');
		expect(input.store.getFeed(new Date(observedAt), 72).source.status).toBe('ok');
	});

	it('rejects financial results arriving after cancellation', async () => {
		const controller = new AbortController();
		const input = context(controller.signal);
		vi.mocked(withBestInvestBrowser).mockImplementation(async () => {
			controller.abort();
			return {...snapshot, observedAt: '2026-09-09T06:00:00.000Z'};
		});
		expect(await createBestInvestCollector()(input)).toBe('error');
		expect(input.store.getFeed(new Date(observedAt), 72).source.lastSuccessAt).toBe(observedAt);
	});

	it('uses only redacted stable error codes for unexpected browser failures', async () => {
		const input = context();
		vi.mocked(withBestInvestBrowser).mockRejectedValue(new Error('synthetic private response'));
		expect(await createBestInvestCollector()(input)).toBe('error');
		expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain('synthetic private response');
	});
});

describe('Best Invest portal reads', () => {
	it('refuses to send authenticated requests from any other origin', async () => {
		const page = {url: () => 'https://example.com', evaluate: vi.fn()};
		await expect(requestBestInvest(page as never, 'policies')).rejects.toThrow('INVALID_RESPONSE');
		expect(page.evaluate).not.toHaveBeenCalled();
	});

	it('keeps numeric JSON lexemes exact instead of rounding them through JavaScript numbers', async () => {
		const page = {url: () => browserModule.BEST_INVEST_ORIGIN, evaluate: async () => ({text: '{"TotalSavings":9007199254740993.12}'})};
		expect(await requestBestInvest(page as never, 'details')).toEqual({TotalSavings: '9007199254740993.12'});
	});

	it('rejects malformed inventories instead of treating them as empty success', async () => {
		await expect(readBestInvestSnapshot({} as never, {Unexpected: []}, observedAt, new AbortController().signal)).rejects.toThrow('INVALID_RESPONSE');
	});

	it('rejects conflicting policy identities before applying a snapshot', async () => {
		const page = {url: () => browserModule.BEST_INVEST_ORIGIN, evaluate: async () => ({text: '{"PolicyId":"999"}'})};
		await expect(readBestInvestSnapshot(page as never, {Policies: [{PolicyNumber: '123', TemplateId: '8'}]}, observedAt, new AbortController().signal)).rejects.toThrow('INVALID_RESPONSE');
	});
});

describe('Best Invest OTP request boundaries', () => {
	function page() {
		const actions: string[] = [];
		return {actions, goto: vi.fn(), waitForSelector: vi.fn(), $: async () => null,
			locator: (selector: string) => ({fill: vi.fn(), async click() {
				actions.push(selector);
			}}),
			waitForResponse: vi.fn(async () => ({status: () => 200, text: async () => '{"Message":"Synthetic OTP request accepted"}'})),
			waitForFunction: vi.fn()};
	}

	it('never requests an OTP without an explicitly configured reader', async () => {
		const browser = page();
		const input = context();
		await expect(loginBestInvest(browser as never, input, {}, input.signal)).rejects.toThrow('OTP_REQUIRED');
		expect(browser.goto).not.toHaveBeenCalled();
	});

	it('does not send when receiver readiness fails', async () => {
		const browser = page();
		const input = context();
		const beforeOtpRequest = vi.fn();
		await expect(loginBestInvest(browser as never, input, {beforeOtpRequest, otpSource: {async prepare() {
			throw new BestInvestCollectionError('OTP_REQUIRED');
		}}}, input.signal)).rejects.toThrow('OTP_REQUIRED');
		expect(browser.actions).not.toContain('app-identity-login-user button[type="submit"]');
		expect(beforeOtpRequest).not.toHaveBeenCalled();
	});

	it('cancels an armed request when the automatic request budget is exhausted', async () => {
		const browser = page();
		const input = context();
		const cancel = vi.fn(async () => undefined);
		const read = vi.fn();
		await expect(loginBestInvest(browser as never, input, {
			otpSource: {prepare: async () => ({read, cancel})},
			async beforeOtpRequest() {
				throw new BestInvestCollectionError('OTP_REQUIRED');
			},
		}, input.signal)).rejects.toThrow('OTP_REQUIRED');
		expect(cancel).toHaveBeenCalledOnce();
		expect(read).not.toHaveBeenCalled();
		expect(browser.actions).not.toContain('app-identity-login-user button[type="submit"]');
	});

	it('requests once only after receiver readiness and consumes the code only after server confirmation', async () => {
		const browser = page();
		const input = context();
		const events: string[] = [];
		const cancel = vi.fn(async () => {
			events.push('cancel');
		});
		await loginBestInvest(browser as never, input, {
			otpSource: {async prepare() {
				events.push('ready');
				return {cancel, async read() {
					expect(browser.actions.filter(action => action === 'app-identity-login-user button[type="submit"]')).toHaveLength(1);
					events.push('read');
					return '111111';
				}};
			}},
			async beforeOtpRequest() {
				events.push('budget');
			},
		}, input.signal);
		expect(events).toEqual(['ready', 'budget', 'read', 'cancel']);
		expect(browser.actions.filter(action => action === 'app-identity-login-auth-input button[type="submit"]')).toHaveLength(1);
	});

	it('does not consume a message or submit a code after an explicit OTP generation failure', async () => {
		const browser = page();
		browser.waitForResponse.mockResolvedValue({status: () => 200, text: async () => '{"IsSuccess":false}'});
		const input = context();
		const readOtp = vi.fn(async () => '111111');
		await expect(loginBestInvest(browser as never, input, {readOtp}, input.signal)).rejects.toThrow('OTP_REQUIRED');
		expect(readOtp).not.toHaveBeenCalled();
		expect(browser.actions).not.toContain('app-identity-login-auth-input button[type="submit"]');
	});

	it.each(['{}', '{"Message":null}', '{"Message":""}', '{"Message":"sent","Error":"failure"}'])('rejects a malformed generation response %s before reading a code', async body => {
		const browser = page();
		browser.waitForResponse.mockResolvedValue({status: () => 200, text: async () => body});
		const input = context();
		const readOtp = vi.fn(async () => '111111');
		await expect(loginBestInvest(browser as never, input, {readOtp}, input.signal)).rejects.toThrow('OTP_REQUIRED');
		expect(readOtp).not.toHaveBeenCalled();
	});
});
