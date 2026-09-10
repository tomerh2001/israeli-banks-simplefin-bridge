import {readdirSync, statSync} from 'node:fs';
import path from 'node:path';
// eslint-disable-next-line import-x/no-extraneous-dependencies, n/no-extraneous-import
import type {Browser} from 'puppeteer';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {companyConfig, createCapturingLogger, createTemporaryEnv} from '../../../test/mocks/fixtures.js';
import type {SourceRunContext} from '../../types.js';
import {createInvestmentStore} from '../store.js';
import {HapoalimInvestmentError, type readHapoalimSecurities} from './browser.js';
import {collectHapoalimInvestments, HAPOALIM_INVESTMENT_TIMEOUT_MS} from './collector.js';

function setup() {
	const env = createTemporaryEnv();
	const store = createInvestmentStore(path.join(env.dataDir, 'investments.sqlite'), 'hapoalim');
	const context: SourceRunContext = {
		company: 'hapoalim', config: companyConfig({accounts: ['00-111-222222']}), credentials: {},
		startDate: new Date('2026-09-01T00:00:00Z'), env, timezone: 'Asia/Jerusalem', defaultCurrency: 'ILS', profileDir: '/unused',
		hapoalimInvestments: {store, config: {enabled: true, readToken: 'synthetic-read', controlToken: 'synthetic-control', historyStartDate: '2023-01-01', staleHours: 30}},
	};
	return {store, context, browser: {} as unknown as Browser, apiBase: 'https://login.bankhapoalim.co.il/ServerServices', logger: createCapturingLogger()};
}

afterEach(() => {
	vi.useRealTimers();
});

describe('same-session Hapoalim investment collection', () => {
	it('stores an unknown current portfolio as partial, with private source captures', async () => {
		const input = setup();
		try {
			const read: typeof readHapoalimSecurities = async options => {
				const portfolio = {View: {Meta: {}}};
				options.capture('portfolio', portfolio);
				return {portfolio, executions: [], paginationComplete: true, historyPages: 1};
			};

			await collectHapoalimInvestments({...input, read});
			const feed = input.store.getFeed(new Date(), 30);
			expect(feed.source).toMatchObject({status: 'partial', lastSuccessAt: null});
			expect(feed.products[0]?.currentValuationId).toBeNull();
			const root = path.join(input.context.env.dataDir, 'hapoalim-investments', 'captures');
			const capture = path.join(root, readdirSync(root)[0]!, 'portfolio.json');
			// eslint-disable-next-line no-bitwise -- Verify private financial evidence permissions.
			expect(statSync(capture).mode & 0o777).toBe(0o600);
		} finally {
			input.store.close();
		}
	});
	it('does not describe a Mytrade session error as a manual OTP requirement', async () => {
		const input = setup();
		try {
			await collectHapoalimInvestments({...input, async read() {
				throw new HapoalimInvestmentError('COLLECTION_FAILED');
			}});
			expect(input.store.getFeed(new Date(), 30).source).toMatchObject({status: 'partial', errorCode: 'COLLECTION_FAILED', lastSuccessAt: null});
		} finally {
			input.store.close();
		}
	});
	it('cancels a hung investment read at three minutes without recording financial success', async () => {
		vi.useFakeTimers();
		const input = setup();
		let signal: AbortSignal | undefined;
		try {
			const run = collectHapoalimInvestments({...input, async read(options) {
				signal = options.signal;
				return new Promise(() => {/* Simulate a provider read that never settles. */});
			}});
			await vi.advanceTimersByTimeAsync(HAPOALIM_INVESTMENT_TIMEOUT_MS);
			await run;
			expect(signal?.aborted).toBe(true);
			expect(input.store.getFeed(new Date(), 30).source).toMatchObject({status: 'partial', errorCode: 'TIMEOUT', lastSuccessAt: null});
			expect(input.store.getFeed(new Date(), 30).products).toEqual([]);
		} finally {
			input.store.close();
		}
	});
});
