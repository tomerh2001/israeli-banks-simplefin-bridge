import {afterEach, describe, expect, it, vi} from 'vitest';
import {readRuntimeEnv} from '../config.js';
import type {Logger} from '../log.js';
import * as browserModule from './browser.js';
import {createClalCollector} from './collector.js';
import {investmentConfigSchema} from './config.js';
import {createInvestmentStore} from './store.js';
import type {InvestmentCollectionContext} from './runtime.js';
import type {InvestmentStore} from './types.js';
import {readClalSessionRemaining} from './session.js';

vi.mock('./browser.js', async importOriginal => ({
	...await importOriginal<typeof browserModule>(),
	withClalBrowser: vi.fn(),
}));
vi.mock('./session.js', () => ({readClalSessionRemaining: vi.fn()}));

const {ClalCollectionError, ClalProfileBusyError, withClalBrowser} = browserModule;
const logger: Logger = {info: vi.fn<Logger['info']>(), warn: vi.fn<Logger['warn']>(), error: vi.fn<Logger['error']>(), debug: vi.fn<Logger['debug']>(), child: () => logger};
const stores: InvestmentStore[] = [];
const observedAt = '2026-09-08T06:00:00.000Z';
const snapshot = {observedAt, complete: true, inventoryComplete: true, products: [], valuations: [], activities: [], tracks: []};

function context(signal: AbortSignal): InvestmentCollectionContext {
	const store = createInvestmentStore(':memory:');
	stores.push(store);
	store.applySnapshot(snapshot);
	return {
		store, signal, logger, config: investmentConfigSchema.parse({enabled: true}), env: readRuntimeEnv(),
		secrets: {resolve: async reference => reference, resolveAll: async values => values},
	};
}

afterEach(() => {
	for (const store of stores) {
		store.close();
	}

	stores.length = 0;
	vi.resetAllMocks();
});

describe('Clal collection cancellation', () => {
	it('does not launch or change source health when shutdown has already started', async () => {
		const controller = new AbortController();
		controller.abort();
		const input = context(controller.signal);
		const collect = createClalCollector(async () => snapshot);
		expect(await collect(input)).toBe('error');
		expect(withClalBrowser).not.toHaveBeenCalled();
		expect(input.store.getFeed(new Date(observedAt), 192).source).toMatchObject({status: 'ok', lastSuccessAt: observedAt});
	});

	it('preserves source health when shutdown closes a running browser', async () => {
		const controller = new AbortController();
		const input = context(controller.signal);
		vi.mocked(withClalBrowser).mockImplementation(async () => {
			controller.abort();
			throw new ClalCollectionError('TIMEOUT');
		});
		expect(await createClalCollector(async () => snapshot)(input)).toBe('error');
		expect(input.store.getFeed(new Date(observedAt), 192).source).toMatchObject({status: 'ok', lastSuccessAt: observedAt, errorCode: null});
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it('still records a genuine collection timeout as a failure', async () => {
		const input = context(new AbortController().signal);
		vi.mocked(withClalBrowser).mockRejectedValue(new ClalCollectionError('TIMEOUT'));
		expect(await createClalCollector(async () => snapshot)(input)).toBe('error');
		expect(input.store.getFeed(new Date(observedAt), 192).source).toMatchObject({status: 'error', lastSuccessAt: observedAt, errorCode: 'TIMEOUT'});
	});

	it('does not apply a result that arrives after shutdown cancellation', async () => {
		const controller = new AbortController();
		const input = context(controller.signal);
		const later = {...snapshot, observedAt: '2026-09-15T06:00:00.000Z'};
		vi.mocked(withClalBrowser).mockResolvedValue(later);
		const collection = createClalCollector(async () => later)(input);
		controller.abort();
		expect(await collection).toBe('error');
		expect(input.store.getFeed(new Date(observedAt), 192).source.lastSuccessAt).toBe(observedAt);
	});

	it('skips an occupied profile without changing collection or session health', async () => {
		const input = context(new AbortController().signal);
		const {source} = input.store.getFeed(new Date(observedAt), 192);
		const session = input.store.getSessionState();
		vi.mocked(withClalBrowser).mockRejectedValue(new ClalProfileBusyError());
		expect(await createClalCollector(async () => snapshot)(input)).toBe('skipped');
		expect(input.store.getFeed(new Date(observedAt), 192).source).toEqual(source);
		expect(input.store.getSessionState()).toEqual(session);
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it('records authentication expiry independently as well as the failed collection attempt', async () => {
		const input = context(new AbortController().signal);
		vi.mocked(withClalBrowser).mockRejectedValue(new ClalCollectionError('OTP_REQUIRED'));
		expect(await createClalCollector(async () => snapshot)(input)).toBe('auth_required');
		expect(input.store.getSessionState()).toMatchObject({status: 'auth_required', expiresAt: null, errorCode: 'OTP_REQUIRED'});
		expect(input.store.getFeed(new Date(observedAt), 192).source.lastSuccessAt).toBe(observedAt);
	});

	it('cannot overwrite a newer successful login after the failed collector releases its profile', async () => {
		const input = context(new AbortController().signal);
		const checkedAt = new Date(Date.now() + 60_000).toISOString();
		const recovered = {status: 'active' as const, lastCheckedAt: checkedAt, lastRenewedAt: null, expiresAt: new Date(Date.now() + 1_260_000).toISOString(), errorCode: null};
		vi.mocked(withClalBrowser).mockImplementation(async () => {
			// Simulate another process completing assisted login immediately after
			// this collector closes its browser, before its outer catch resumes.
			input.store.setSessionState(recovered);
			throw new ClalCollectionError('OTP_REQUIRED');
		});
		expect(await createClalCollector(async () => snapshot)(input)).toBe('auth_required');
		expect(input.store.getSessionState()).toEqual(recovered);
	});
});

describe('Clal collection session verification', () => {
	function runBrowserCallback() {
		const page = {goto: vi.fn(), url: () => browserModule.CLAL_PORTFOLIO_URL, $: async () => null};
		vi.mocked(withClalBrowser).mockImplementation(async (options, work) => work(page as never, options.signal!));
	}

	it('updates independent session health only after a protected snapshot is read', async () => {
		runBrowserCallback();
		const input = context(new AbortController().signal);
		input.store.setSessionState({status: 'active', lastCheckedAt: observedAt, lastRenewedAt: observedAt, expiresAt: observedAt, errorCode: null});
		vi.mocked(readClalSessionRemaining).mockResolvedValue(1199);
		const reader = vi.fn(async () => {
			expect(readClalSessionRemaining).not.toHaveBeenCalled();
			return snapshot;
		});
		expect(await createClalCollector(reader)(input)).toBe('ok');
		const session = input.store.getSessionState();
		expect(session).toMatchObject({status: 'active', lastRenewedAt: observedAt, errorCode: null});
		expect(Date.parse(session.expiresAt!) - Date.parse(session.lastCheckedAt!)).toBe(1_199_000);
	});

	it('retains a valid collected snapshot when the ancillary timer endpoint is malformed', async () => {
		runBrowserCallback();
		const input = context(new AbortController().signal);
		vi.mocked(readClalSessionRemaining).mockRejectedValue(new ClalCollectionError('INVALID_RESPONSE'));
		const later = {...snapshot, observedAt: '2026-09-15T06:00:00.000Z'};
		expect(await createClalCollector(async () => later)(input)).toBe('ok');
		expect(input.store.getFeed(new Date(later.observedAt), 192).source).toMatchObject({status: 'ok', lastSuccessAt: later.observedAt});
		expect(input.store.getSessionState()).toMatchObject({status: 'error', expiresAt: null, errorCode: 'INVALID_RESPONSE'});
	});

	it('cannot update session health after shutdown interrupts the timer check', async () => {
		runBrowserCallback();
		const controller = new AbortController();
		const input = context(controller.signal);
		const original = input.store.getSessionState();
		vi.mocked(readClalSessionRemaining).mockImplementation(async () => {
			controller.abort();
			return 1199;
		});
		expect(await createClalCollector(async () => snapshot)(input)).toBe('error');
		expect(input.store.getSessionState()).toEqual(original);
	});
});
