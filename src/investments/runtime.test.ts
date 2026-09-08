import {mkdtempSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {parseConfig, readRuntimeEnv} from '../config.js';
import {createMemoryLedger} from '../ledger/memory.js';
import type {Logger} from '../log.js';
import {createApp} from '../simplefin/app.js';
import type {SecretsResolver} from '../types.js';
import {investmentConfigSchema} from './config.js';
import {createInvestmentRuntime, type InvestmentRuntime, type InvestmentRuntimeOptions, type InvestmentCollectionStatus} from './runtime.js';

const cron = vi.hoisted(() => ({
	schedule: vi.fn(() => ({stop: vi.fn(), destroy: vi.fn()})),
	validate: vi.fn(() => true),
}));
vi.mock('node-cron', () => cron);

const readToken = 'example-investment-read-token-with-32-characters';
const logger: Logger = {info: vi.fn<Logger['info']>(), warn: vi.fn<Logger['warn']>(), error: vi.fn<Logger['error']>(), debug: vi.fn<Logger['debug']>(), child: () => logger};
const directories: string[] = [];
const runtimes: InvestmentRuntime[] = [];

async function start(overrides: Partial<InvestmentRuntimeOptions> = {}): Promise<InvestmentRuntime> {
	const dataDir = mkdtempSync(path.join(os.tmpdir(), 'investment-runtime-test-'));
	directories.push(dataDir);
	const secrets: SecretsResolver = {resolve: async () => readToken, resolveAll: async values => values};
	const runtime = await createInvestmentRuntime({
		config: investmentConfigSchema.parse({enabled: true, readToken: 'op://example/read/token'}),
		env: {...readRuntimeEnv(), dataDir}, secrets, logger, timezone: 'Asia/Jerusalem',
		now: () => new Date('2026-09-08T06:00:00.000Z'), ...overrides,
	});
	runtimes.push(runtime);
	return runtime;
}

afterEach(async () => {
	await Promise.all(runtimes.map(async runtime => runtime.close()));
	runtimes.length = 0;
	for (const directory of directories) {
		rmSync(directory, {recursive: true, force: true});
	}

	directories.length = 0;
	vi.clearAllMocks();
	cron.validate.mockReturnValue(true);
});

describe('investment runtime and feed', () => {
	it('leaves investment collection disabled when omitted and has an independent weekly schedule', () => {
		expect(parseConfig({companies: {}}).investments).toBeUndefined();
		const config = parseConfig({companies: {}, schedule: '0 6,18 * * *', investments: {enabled: true}});
		expect(config.schedule).toBe('0 6,18 * * *');
		expect(config.investments).toMatchObject({schedule: '0 7 * * 1', staleHours: 192, timeoutMinutes: 10, readToken: ''});
	});

	it('requires the separate bearer capability and does not collect when the feed is read', async () => {
		const collect = vi.fn(async () => 'ok' as const);
		const runtime = await start({collect});
		await Promise.all([undefined, 'Bearer wrong', `Basic ${readToken}`].map(async authorization => {
			const response = await runtime.router.request('/investments/v1', {headers: authorization ? {authorization} : {}});
			expect(response.status).toBe(403);
		}));

		const response = await runtime.router.request('/investments/v1', {headers: {authorization: `Bearer ${readToken}`}});
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(await response.json()).toMatchObject({schemaVersion: 1, products: [], source: {status: 'never_synced'}});
		expect(collect).not.toHaveBeenCalled();
	});

	it('mounts its route beside bank routes and keeps bank service available when token resolution fails', async () => {
		const runtime = await start({secrets: {
			async resolve() {
				throw new Error('example secret must not be logged');
			},
			resolveAll: async values => values,
		}});
		const ledger = createMemoryLedger();
		const app = createApp({config: parseConfig({companies: {}}), ledger, logger, investmentRouter: runtime.router});
		const bankResponse = await app.request('/simplefin/info');
		const investmentResponse = await app.request('/investments/v1');
		expect(bankResponse.status).toBe(200);
		expect(investmentResponse.status).toBe(503);
		expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain('example secret');
		ledger.close();
	});

	it('treats a missing read token as an unavailable investment feed', async () => {
		const runtime = await start({config: investmentConfigSchema.parse({enabled: true})});
		const response = await runtime.router.request('/investments/v1');
		expect(response.status).toBe(503);
	});

	it('does not collect on startup and prevents overlapping triggers', async () => {
		let finish: (status: InvestmentCollectionStatus) => void = () => undefined;
		// The project's ES2023 library target does not expose Promise.withResolvers.
		// eslint-disable-next-line unicorn/prefer-promise-with-resolvers
		const collect = vi.fn(async () => new Promise<InvestmentCollectionStatus>(resolve => {
			finish = resolve;
		}));
		const runtime = await start({collect});
		runtime.start();
		expect(collect).not.toHaveBeenCalled();
		expect(cron.schedule).toHaveBeenCalledWith('0 7 * * 1', expect.any(Function), {timezone: 'Asia/Jerusalem', name: 'clal-investments'});
		const first = runtime.runNow();
		expect(await runtime.runNow()).toBeUndefined();
		expect(collect).toHaveBeenCalledTimes(1);
		finish('ok');
		expect(await first).toBe('ok');
	});

	it('records a sanitized collection failure without exposing its exception', async () => {
		const runtime = await start({
			async collect() {
				throw new Error('private provider response example');
			},
		});
		expect(await runtime.runNow()).toBe('error');
		expect(runtime.store!.getFeed(new Date(), 192).source).toMatchObject({status: 'error', errorCode: 'COLLECTION_FAILED'});
		expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain('private provider');
	});

	it('cancels an active collector before closing its database', async () => {
		let canceled = false;
		const runtime = await start({
			collect: async ({signal, store}) => new Promise<InvestmentCollectionStatus>(resolve => {
				signal.addEventListener('abort', () => {
					canceled = true;
					expect(store.getFeed(new Date(), 192).source.status).toBe('never_synced');
					resolve('error');
				}, {once: true});
			}),
		});
		const collection = runtime.runNow();
		await runtime.close();
		expect(canceled).toBe(true);
		expect(await collection).toBe('error');
		expect(await runtime.runNow()).toBeUndefined();
	});

	it('leaves invalid investment schedules idle', async () => {
		cron.validate.mockReturnValue(false);
		const runtime = await start({collect: async () => 'ok'});
		runtime.start();
		expect(cron.schedule).not.toHaveBeenCalled();
	});
});
