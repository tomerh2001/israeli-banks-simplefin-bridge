import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {InvestmentStore} from '../src/investments/types.js';
import {ensureProfileDir} from '../src/scrape/profile.js';
import {runCompany} from '../src/scrape/runner.js';
import type {SourceRunContext} from '../src/types.js';
import {companyConfig, createCapturingLogger, createTemporaryEnv, fetchResult} from './mocks/fixtures.js';

const mocks = vi.hoisted(() => ({
	launch: vi.fn(), scrape: vi.fn<(credentials: unknown) => Promise<{success: boolean; accounts?: unknown[]; errorType?: string}>>(), collect: vi.fn(), create: vi.fn(),
}));
vi.mock('puppeteer', () => ({default: {launch: mocks.launch}}));
vi.mock('../src/investments/hapoalim/collector.js', () => ({collectHapoalimInvestments: mocks.collect}));
vi.mock('../src/normalize.js', () => ({normalizeScrapeResult: () => fetchResult()}));
vi.mock('israeli-bank-scrapers', () => ({
	createScraper: mocks.create,
}));

function context(): SourceRunContext {
	const env = createTemporaryEnv({puppeteerExecutablePath: '/synthetic/chrome'});
	return {
		company: 'hapoalim', config: companyConfig({accounts: ['00-111-222222']}), credentials: {userCode: 'synthetic', password: 'synthetic'},
		startDate: new Date('2026-09-01T00:00:00Z'), env, timezone: 'Asia/Jerusalem', defaultCurrency: 'ILS',
		profileDir: ensureProfileDir(env, 'hapoalim'),
		hapoalimInvestments: {
			config: {enabled: true, readToken: 'synthetic-read', controlToken: 'synthetic-control', historyStartDate: '2023-01-01', staleHours: 30}, store: {} as unknown as InvestmentStore,
		},
	};
}

describe('Hapoalim investment hook preserves the native checking scrape', () => {
	const browser = {connected: true, close: vi.fn(async () => {
		browser.connected = false;
	}), process: () => undefined};
	beforeEach(() => {
		vi.clearAllMocks();
		browser.connected = true;
		mocks.launch.mockResolvedValue(browser);
		mocks.scrape.mockResolvedValue({success: true, accounts: []});
		mocks.collect.mockResolvedValue(undefined);
		mocks.create.mockImplementation((options: Record<string, unknown>) => ({
			onProgress: vi.fn(),
			async scrape(credentials: unknown) {
				const page = {
					on(event: string, handler: (request: {url(): string}) => void) {
						if (event === 'request') {
							handler({url: () => 'https://login.bankhapoalim.co.il/ServerServices/current-account/transactions'});
						}
					},
					waitForSelector: async () => new Promise(() => {/* No OTP form appears in this fixture. */}),
				};
				await (options.preparePage as (page: unknown) => Promise<void>)(page);
				return mocks.scrape(credentials);
			},
		}));
	});
	it('shares the same headed browser and runs exactly one native login', async () => {
		const ctx = context();
		const outcome = await runCompany(ctx, createCapturingLogger());
		expect(outcome).toEqual({ok: true, result: fetchResult()});
		expect(mocks.launch).toHaveBeenCalledWith(expect.objectContaining({headless: false, executablePath: '/synthetic/chrome'}));
		expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({browser, skipCloseBrowser: true}));
		expect(mocks.scrape).toHaveBeenCalledExactlyOnceWith(ctx.credentials);
		expect(mocks.collect).toHaveBeenCalledWith(expect.objectContaining({browser, apiBase: 'https://login.bankhapoalim.co.il/ServerServices'}));
		expect(mocks.scrape.mock.invocationCallOrder[0]).toBeLessThan(mocks.collect.mock.invocationCallOrder[0]!);
		expect(mocks.collect.mock.invocationCallOrder[0]).toBeLessThan(browser.close.mock.invocationCallOrder[0]!);
	});
	it.each(['Mytrade bootstrap failed', 'Malformed execution', 'Investment timeout'])('retains successful checking after %s', async message => {
		mocks.collect.mockRejectedValue(new Error(message));
		const outcome = await runCompany(context(), createCapturingLogger());
		expect(outcome).toEqual({ok: true, result: fetchResult()});
		expect(mocks.scrape).toHaveBeenCalledOnce();
		expect(browser.connected).toBe(false);
	});
	it('does not enter Mytrade after an unsuccessful native bank login', async () => {
		mocks.scrape.mockResolvedValue({success: false, errorType: 'INVALID_PASSWORD'});
		const outcome = await runCompany(context(), createCapturingLogger());
		expect(outcome).toMatchObject({ok: false, errorType: 'INVALID_PASSWORD'});
		expect(mocks.collect).not.toHaveBeenCalled();
	});
	it('does not take external browser ownership when the integration is disabled', async () => {
		const ctx = context();
		ctx.hapoalimInvestments!.config.enabled = false;
		await runCompany(ctx, createCapturingLogger());
		expect(mocks.launch).not.toHaveBeenCalled();
		expect(mocks.collect).not.toHaveBeenCalled();
		expect(mocks.create.mock.calls[0]![0]).not.toHaveProperty('skipCloseBrowser');
	});
});
