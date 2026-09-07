import type * as NodeFs from 'node:fs';
import type * as Scrapers from 'israeli-bank-scrapers';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createMemoryLedger} from '../src/ledger/memory.js';
import {assistedLogin} from '../src/scrape/login.js';
import {defaultSourceState} from '../src/scrape/scheduler.js';
import type * as Scheduler from '../src/scrape/scheduler.js';
import {bridgeConfig, companyConfig, createCapturingLogger, createTemporaryEnv} from './mocks/fixtures.js';

const mock = vi.hoisted(() => ({
	pageOpen: false,
	connected: true,
	url: 'https://login.bankhapoalim.co.il/ng-portals/auth/otp',
	throwDuringLogin: false,
	loginCalls: 0,
	closed: vi.fn(),
	helpersStopped: vi.fn(),
	runNow: vi.fn(async () => []),
	resolveAll: vi.fn(async () => ({userCode: 'test-user', password: 'test-password'})),
}));

vi.mock('node:fs', async importOriginal => {
	const actual = await importOriginal<typeof NodeFs>();
	return {...actual, existsSync: (file: Parameters<typeof actual.existsSync>[0]) => String(file).startsWith('/tmp/.X11-unix/') || actual.existsSync(file)};
});

vi.mock('node:child_process', async () => {
	const {EventEmitter} = await import('node:events');
	return {
		spawn: vi.fn(() => {
			// ChildProcess streams and lifecycle events use EventEmitter.
			// eslint-disable-next-line unicorn/prefer-event-target
			const child = Object.assign(new EventEmitter(), {
				pid: 123,
				// eslint-disable-next-line @typescript-eslint/no-restricted-types
				exitCode: null as number | null,
				// eslint-disable-next-line unicorn/prefer-event-target
				stderr: Object.assign(new EventEmitter(), {setEncoding: vi.fn()}),
				kill: vi.fn(() => {
					child.exitCode = 0;
					mock.helpersStopped();
					return true;
				}),
			});
			queueMicrotask(() => {
				child.emit('spawn');
			});
			return child;
		}),
	};
});

vi.mock('puppeteer', () => {
	const page = {
		setCacheEnabled: vi.fn(),
		setDefaultTimeout: vi.fn(),
		setViewport: vi.fn(),
		on: vi.fn(),
		url: () => mock.url,
		async close() {
			mock.pageOpen = false;
		},
	};
	const browser = {
		get connected() {
			return mock.connected;
		},
		async newPage() {
			mock.pageOpen = true;
			return page;
		},
		async pages() {
			return mock.pageOpen ? [page] : [];
		},
		async close() {
			mock.connected = false;
			mock.pageOpen = false;
			mock.closed();
		},
	};
	return {default: {launch: vi.fn(async () => browser)}};
});

vi.mock('israeli-bank-scrapers', async importOriginal => {
	const actual = await importOriginal<typeof Scrapers>();
	return {
		...actual,
		createScraper(options: Parameters<typeof actual.createScraper>[0]) {
			// Keep the upstream initialize/scrape/terminate lifecycle intact. Only
			// replace the bank-facing login so this catches its real page cleanup.
			const scraper = actual.createScraper(options) as Scrapers.Scraper<Scrapers.ScraperCredentials> & {
				login(credentials: Scrapers.ScraperCredentials): Promise<Scrapers.ScraperScrapingResult>;
			};
			vi.spyOn(scraper, 'login').mockImplementation(async () => {
				mock.loginCalls++;
				if (mock.throwDuringLogin) {
					throw new Error('Timed out waiting for OTP redirect');
				}

				return {success: false, errorMessage: 'OTP required'};
			});
			return scraper;
		},
	};
});

vi.mock('../src/scrape/scheduler.js', async importOriginal => ({
	...await importOriginal<typeof Scheduler>(),
	createScheduler: vi.fn(() => ({runNow: mock.runNow})),
}));

describe('assisted login lifecycle', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
		mock.pageOpen = false;
		mock.connected = true;
		mock.url = 'https://login.bankhapoalim.co.il/ng-portals/auth/otp';
		mock.throwDuringLogin = false;
		mock.loginCalls = 0;
		vi.spyOn(console, 'log').mockImplementation(() => undefined);
		vi.spyOn(process.stdin, 'resume').mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, 'pause').mockReturnValue(process.stdin);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	function startLogin() {
		const ledger = createMemoryLedger();
		ledger.upsertSourceState({...defaultSourceState('hapoalim'), parked: true, parkedReason: 'OTP required'});
		const logger = createCapturingLogger();
		const pending = assistedLogin({
			company: 'hapoalim',
			config: bridgeConfig({companies: {hapoalim: companyConfig()}}),
			env: createTemporaryEnv(),
			ledger,
			secrets: {resolve: async value => value, resolveAll: mock.resolveAll},
			logger,
			password: 'test-vnc',
			waitMinutes: 1,
		});
		return {pending, ledger, logger};
	}

	it.each([false, true])('preserves the actual auth page after login failure (throws=%s), then closes it before confirmation', async throws => {
		mock.throwDuringLogin = throws;
		const {pending, ledger, logger} = startLogin();
		await vi.advanceTimersByTimeAsync(0);

		expect(mock.loginCalls).toBe(1);
		expect(logger.lines.some(line => line.message === 'library gave up; finish the login in noVNC, then press Enter here')).toBe(true);
		expect(mock.pageOpen).toBe(true);
		expect(mock.closed).not.toHaveBeenCalled();
		expect(mock.runNow).not.toHaveBeenCalled();
		expect(ledger.getSourceState('hapoalim')?.parked).toBe(true);

		// Simulate the operator completing OTP in the preserved browser tab.
		mock.url = 'https://login.bankhapoalim.co.il/ng-portals/rb/he/homepage';
		await vi.advanceTimersByTimeAsync(4000);
		await pending;

		expect(mock.pageOpen).toBe(false);
		expect(mock.closed).toHaveBeenCalledOnce();
		expect(mock.helpersStopped).toHaveBeenCalledTimes(3);
		expect(mock.runNow).toHaveBeenCalledWith({company: 'hapoalim', force: true});
		expect(mock.closed.mock.invocationCallOrder[0]).toBeLessThan(mock.runNow.mock.invocationCallOrder[0]!);
	});

	it('keeps the source parked and avoids another bank attempt when the operator times out', async () => {
		const {pending, ledger} = startLogin();
		await vi.advanceTimersByTimeAsync(62_000);
		await pending;

		expect(mock.loginCalls).toBe(1);
		expect(mock.runNow).not.toHaveBeenCalled();
		expect(ledger.getSourceState('hapoalim')?.parked).toBe(true);
		expect(mock.closed).toHaveBeenCalledOnce();
		expect(mock.helpersStopped).toHaveBeenCalledTimes(3);
	});
});
