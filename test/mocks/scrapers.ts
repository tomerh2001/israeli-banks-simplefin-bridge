/**
 * vi.mock replacement for 'israeli-bank-scrapers'.
 *
 * Use from a test file with:
 *   vi.mock('israeli-bank-scrapers', async () => import('./mocks/scrapers.js'));
 *   import {scraperMock} from './mocks/scrapers.js';
 *
 * `createScraper` records its options, calls `prepareBrowser`/`preparePage` with
 * fakes, emits the configured progress events and returns the configured
 * result. `hang: true` makes `scrape()` wait until the fake browser is closed
 * (what real puppeteer does when the deadline branch kills Chrome).
 */

import {vi} from 'vitest';
import {createGate} from './fixtures.js';

// Mirrors ChildProcess.exitCode, which puppeteer exposes and the runner checks against null.
// eslint-disable-next-line @typescript-eslint/no-restricted-types
export type FakeChild = {exitCode: number | null; killed: boolean; kill: ReturnType<typeof vi.fn>};

export type FakeBrowser = {
	connected: boolean;
	close: ReturnType<typeof vi.fn>;
	process: () => FakeChild;
	child: FakeChild;
	closedPromise: Promise<void>;
};

type FrameLike = {url(): string};
type FakeOtpHandle = {dispose: ReturnType<typeof vi.fn>};
type FakeWaitOptions = {visible?: boolean; timeout?: number; signal: AbortSignal};

export type FakePage = {
	handlers: Map<string, Array<(frame: FrameLike) => void>>;
	on(event: string, handler: (frame: FrameLike) => void): void;
	mainFrame(): FrameLike;
	navigate(url: string): void;
	waitForSelector: ReturnType<typeof vi.fn<(selector: string, options: FakeWaitOptions) => Promise<FakeOtpHandle>>>;
	otpHandle: FakeOtpHandle;
};

export type ScraperMockBehaviour = {
	/** Result returned by scrape(). */
	result?: {success: boolean; accounts?: unknown[]; errorType?: string; errorMessage?: string};
	/** Progress types emitted before the result. */
	progress?: string[];
	/** Delay before resolving, ms. */
	delayMs?: number;
	/** Never resolve until the fake browser is closed. */
	hang?: boolean;
	/** Error thrown by scrape(). */
	throwError?: Error;
	/** Main-frame URL to "navigate" to before returning the result. */
	pageUrl?: string;
	/** Whether a visible Hapoalim OTP form is present during login. */
	otpFormVisible?: boolean;
};

type ScraperMockState = {
	behaviour: ScraperMockBehaviour;
	calls: Array<Record<string, unknown>>;
	browsers: FakeBrowser[];
	pages: FakePage[];
	credentials: unknown[];
	reset(): void;
};

export const scraperMock: ScraperMockState = {
	behaviour: {},
	calls: [],
	browsers: [],
	pages: [],
	credentials: [],
	reset() {
		this.behaviour = {};
		this.calls = [];
		this.browsers = [];
		this.pages = [];
		this.credentials = [];
	},
};

function createFakeBrowser(): FakeBrowser {
	const closed = createGate();
	// Puppeteer reports `null` while the process is alive; keep the same shape the runner checks.
	const child: FakeChild = {exitCode: null, killed: false, kill: vi.fn()};
	const browser: FakeBrowser = {
		connected: true,
		child,
		process: () => child,
		closedPromise: closed.promise,
		close: vi.fn(async () => {
			browser.connected = false;
			child.exitCode = 0;
			closed.open();
		}),
	};
	return browser;
}

function createFakePage(browser: FakeBrowser | undefined, behaviour: ScraperMockBehaviour): FakePage {
	let currentUrl = 'about:blank';
	const frame: FrameLike = {url: () => currentUrl};
	const page: FakePage = {
		otpHandle: {dispose: vi.fn(async () => undefined)},
		waitForSelector: vi.fn(async (_selector: string, options: FakeWaitOptions) => {
			if (behaviour.otpFormVisible) {
				return page.otpHandle;
			}

			return new Promise<never>((_resolve, reject) => {
				options.signal.addEventListener('abort', () => {
					reject(new Error('selector wait aborted'));
				}, {once: true});
				void browser?.closedPromise.then(() => {
					reject(new Error('page closed'));
				});
			});
		}),
		handlers: new Map(),
		on(event, handler) {
			const list = page.handlers.get(event) ?? [];
			list.push(handler);
			page.handlers.set(event, list);
		},
		mainFrame: () => frame,
		navigate(url) {
			currentUrl = url;
			for (const handler of page.handlers.get('framenavigated') ?? []) {
				handler(frame);
			}
		},
	};
	return page;
}

export const CompanyTypes = {
	hapoalim: 'hapoalim',
	leumi: 'leumi',
	visaCal: 'visaCal',
	max: 'max',
	isracard: 'isracard',
	amex: 'amex',
	discount: 'discount',
	mizrahi: 'mizrahi',
} as const;

export function createScraper(options: Record<string, unknown>) {
	scraperMock.calls.push(options);
	const listeners: Array<(companyId: string, payload: {type: string}) => void> = [];
	return {
		onProgress(listener: (companyId: string, payload: {type: string}) => void) {
			listeners.push(listener);
		},
		async scrape(credentials: unknown) {
			scraperMock.credentials.push(credentials);
			const {behaviour} = scraperMock;
			let browser: FakeBrowser | undefined;
			if (typeof options.prepareBrowser === 'function') {
				browser = createFakeBrowser();
				scraperMock.browsers.push(browser);
				await (options.prepareBrowser as (browser: FakeBrowser) => Promise<void>)(browser);
			}

			if (typeof options.preparePage === 'function') {
				const page = createFakePage(browser, behaviour);
				scraperMock.pages.push(page);
				await (options.preparePage as (page: FakePage) => Promise<void>)(page);
				if (behaviour.pageUrl) {
					page.navigate(behaviour.pageUrl);
				}
			}

			for (const type of behaviour.progress ?? []) {
				for (const listener of listeners) {
					listener(String(options.companyId), {type});
				}
			}

			if (behaviour.throwError) {
				throw behaviour.throwError;
			}

			if (behaviour.hang && browser) {
				await browser.closedPromise;
				return {success: false, errorType: 'GENERIC', errorMessage: 'browser closed'};
			}

			if (behaviour.delayMs) {
				await new Promise(resolve => {
					setTimeout(resolve, behaviour.delayMs);
				});
			}

			if (browser) {
				await browser.close();
			}

			return behaviour.result ?? {success: true, accounts: []};
		},
	};
}
