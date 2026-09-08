import {afterEach, describe, expect, it, vi} from 'vitest';
import {readRuntimeEnv} from '../config.js';
import type {Logger} from '../log.js';
import * as browserModule from './browser.js';
import {createClalCollector} from './collector.js';
import {investmentConfigSchema} from './config.js';
import {createInvestmentStore} from './store.js';
import type {InvestmentCollectionContext} from './runtime.js';
import type {InvestmentStore} from './types.js';

vi.mock('./browser.js', async importOriginal => ({
	...await importOriginal<typeof browserModule>(),
	withClalBrowser: vi.fn(),
}));

const {ClalCollectionError, withClalBrowser} = browserModule;
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
});
