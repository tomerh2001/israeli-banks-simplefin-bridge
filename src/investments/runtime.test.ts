import {mkdtempSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {parseConfig, readRuntimeEnv} from '../config.js';
import {createMemoryLedger} from '../ledger/memory.js';
import type {Logger} from '../log.js';
import {createApp} from '../simplefin/app.js';
import type {SecretsResolver} from '../types.js';
import {ClalCollectionError, ClalProfileBusyError} from './browser.js';
import {investmentConfigSchema} from './config.js';
import {createInvestmentRuntime, type InvestmentRuntime, type InvestmentRuntimeOptions, type InvestmentCollectionStatus} from './runtime.js';
import {createInvestmentStore} from './store.js';

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
	vi.useRealTimers();
	cron.validate.mockReturnValue(true);
});

const sessionConfig = investmentConfigSchema.parse({enabled: true, readToken: 'op://example/read/token', sessionKeepAliveMinutes: 5});

function useSessionClock(): void {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-09-08T06:00:00.000Z'));
}

function scheduledCallback(): () => Promise<void> {
	const calls = cron.schedule.mock.calls as unknown as Array<[string, () => Promise<void>]>;
	return calls.at(-1)![1];
}

describe('scheduled Clal collection retries', () => {
	it('retries an occupied profile after thirty seconds without changing financial or session health', async () => {
		useSessionClock();
		const collect = vi.fn<() => Promise<InvestmentCollectionStatus>>(async () => 'ok').mockResolvedValueOnce('skipped');
		const runtime = await start({collect, now: () => new Date()});
		const beforeFeed = runtime.store!.getFeed(new Date(), 192);
		const beforeSession = runtime.store!.getSessionState();
		runtime.start();
		await scheduledCallback()();
		expect(collect).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(29_999);
		expect(collect).toHaveBeenCalledTimes(1);
		expect(runtime.store!.getFeed(new Date(beforeFeed.generatedAt), 192)).toEqual(beforeFeed);
		expect(runtime.store!.getSessionState()).toEqual(beforeSession);
		await vi.advanceTimersByTimeAsync(1);
		expect(collect).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(600_000);
		expect(collect).toHaveBeenCalledTimes(2);
	});

	it('bounds a persistently busy occurrence to ten minutes and retains source health', async () => {
		useSessionClock();
		const collect = vi.fn(async () => 'skipped' as const);
		const runtime = await start({collect, now: () => new Date()});
		const beforeFeed = runtime.store!.getFeed(new Date(), 192);
		runtime.start();
		await scheduledCallback()();
		await vi.advanceTimersByTimeAsync(600_000);
		expect(collect).toHaveBeenCalledTimes(21);
		await vi.advanceTimersByTimeAsync(1_200_000);
		expect(collect).toHaveBeenCalledTimes(21);
		expect(logger.warn).toHaveBeenCalledExactlyOnceWith('Clal scheduled collection retry window expired');
		expect(runtime.store!.getFeed(new Date(beforeFeed.generatedAt), 192)).toEqual(beforeFeed);
	});

	it.each(['stop', 'close'] as const)('cancels pending retries on %s', async action => {
		useSessionClock();
		const collect = vi.fn(async () => 'skipped' as const);
		const runtime = await start({collect});
		runtime.start();
		await scheduledCallback()();
		await runtime[action]();
		await vi.advanceTimersByTimeAsync(900_000);
		expect(collect).toHaveBeenCalledTimes(1);
	});

	it('coalesces repeated scheduled callbacks during collection and the retry delay', async () => {
		useSessionClock();
		let finish: (status: InvestmentCollectionStatus) => void = () => undefined;
		const collect = vi.fn<() => Promise<InvestmentCollectionStatus>>(async () => 'ok')
			// eslint-disable-next-line unicorn/prefer-promise-with-resolvers
			.mockImplementationOnce(async () => new Promise(resolve => {
				finish = resolve;
			}));
		const runtime = await start({collect});
		runtime.start();
		const scheduled = scheduledCallback();
		const pending = scheduled();
		await Promise.all([scheduled(), scheduled()]);
		expect(collect).toHaveBeenCalledTimes(1);
		finish('skipped');
		await pending;
		await Promise.all([scheduled(), scheduled()]);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(collect).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(600_000);
		expect(collect).toHaveBeenCalledTimes(2);
	});

	it('defers a scheduled occurrence overlapping a manual collection and leaves manual retries unchanged', async () => {
		useSessionClock();
		let finish: (status: InvestmentCollectionStatus) => void = () => undefined;
		const collect = vi.fn<() => Promise<InvestmentCollectionStatus>>(async () => 'ok')
			// eslint-disable-next-line unicorn/prefer-promise-with-resolvers
			.mockImplementationOnce(async () => new Promise(resolve => {
				finish = resolve;
			}));
		const runtime = await start({collect});
		runtime.start();
		const manual = runtime.runNow();
		await scheduledCallback()();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(collect).toHaveBeenCalledTimes(1);
		finish('ok');
		await manual;
		await vi.advanceTimersByTimeAsync(30_000);
		expect(collect).toHaveBeenCalledTimes(2);
		collect.mockResolvedValueOnce('skipped');
		expect(await runtime.runNow()).toBe('skipped');
		await vi.advanceTimersByTimeAsync(600_000);
		expect(collect).toHaveBeenCalledTimes(3);
	});

	it('does not reschedule an in-flight busy result after stop and restart', async () => {
		useSessionClock();
		let finish: (status: InvestmentCollectionStatus) => void = () => undefined;
		// eslint-disable-next-line unicorn/prefer-promise-with-resolvers
		const collect = vi.fn(async () => new Promise<InvestmentCollectionStatus>(resolve => {
			finish = resolve;
		}));
		const runtime = await start({collect});
		runtime.start();
		const pending = scheduledCallback()();
		runtime.stop();
		runtime.start();
		finish('skipped');
		await pending;
		await vi.advanceTimersByTimeAsync(600_000);
		expect(collect).toHaveBeenCalledTimes(1);
	});

	it('ignores callbacks queued by an earlier scheduler after stop and restart', async () => {
		useSessionClock();
		const collect = vi.fn(async () => 'ok' as const);
		const runtime = await start({collect});
		runtime.start();
		const oldCallback = scheduledCallback();
		runtime.stop();
		await oldCallback();
		runtime.start();
		await oldCallback();
		expect(collect).not.toHaveBeenCalled();
		await scheduledCallback()();
		expect(collect).toHaveBeenCalledTimes(1);
	});

	it.each(['partial', 'auth_required', 'error'] as const)('does not retry a genuine %s collection outcome', async status => {
		useSessionClock();
		const collect = vi.fn(async () => status);
		const runtime = await start({collect});
		runtime.start();
		await scheduledCallback()();
		await vi.advanceTimersByTimeAsync(900_000);
		expect(collect).toHaveBeenCalledTimes(1);
	});
});

describe('Clal session maintenance', () => {
	it('is opt in and accepts only whole intervals from zero through ten minutes', async () => {
		useSessionClock();
		expect(investmentConfigSchema.parse({}).sessionKeepAliveMinutes).toBe(0);
		for (const sessionKeepAliveMinutes of [-1, 0.5, 11]) {
			expect(investmentConfigSchema.safeParse({sessionKeepAliveMinutes}).success).toBe(false);
		}

		const maintainSession = vi.fn<NonNullable<InvestmentRuntimeOptions['maintainSession']>>(async () => 1199);
		const runtime = await start({maintainSession});
		runtime.start();
		await vi.advanceTimersByTimeAsync(600_000);
		expect(maintainSession).not.toHaveBeenCalled();
		const disabled = await start({config: {...sessionConfig, enabled: false}, maintainSession});
		disabled.start();
		await vi.advanceTimersByTimeAsync(600_000);
		expect(maintainSession).not.toHaveBeenCalled();
	});

	it('renews on startup and interval without collecting or changing source freshness', async () => {
		useSessionClock();
		const maintainSession = vi.fn<NonNullable<InvestmentRuntimeOptions['maintainSession']>>(async () => 1199);
		const collect = vi.fn(async () => 'ok' as const);
		const runtime = await start({config: sessionConfig, maintainSession, collect, now: () => new Date()});
		runtime.store!.recordFailure({status: 'partial', attemptedAt: new Date().toISOString(), errorCode: 'INCOMPLETE_RESPONSE'});
		const before = runtime.store!.getFeed(new Date(), 192);
		runtime.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(maintainSession).toHaveBeenCalledTimes(1);
		expect(maintainSession.mock.calls[0]![0].timeoutMinutes).toBe(1);
		expect(maintainSession.mock.calls[0]![0].signal).toBeInstanceOf(AbortSignal);
		expect(runtime.store!.getSessionState()).toEqual({
			status: 'active', lastCheckedAt: '2026-09-08T06:00:00.000Z', lastRenewedAt: '2026-09-08T06:00:00.000Z',
			expiresAt: '2026-09-08T06:19:59.000Z', errorCode: null,
		});
		await vi.advanceTimersByTimeAsync(300_000);
		expect(maintainSession).toHaveBeenCalledTimes(2);
		expect(runtime.store!.getSessionState().lastRenewedAt).toBe('2026-09-08T06:05:00.000Z');
		expect(runtime.store!.getFeed(new Date(before.generatedAt), 192)).toEqual(before);
		expect(collect).not.toHaveBeenCalled();
	});

	it('retains a due collection while maintenance finishes and prevents every overlap', async () => {
		let finishRenewal: (seconds: number) => void = () => undefined;
		let finishCollection: (status: InvestmentCollectionStatus) => void = () => undefined;
		// The project's ES2023 library target does not expose Promise.withResolvers.
		// eslint-disable-next-line unicorn/prefer-promise-with-resolvers
		const maintainSession = vi.fn(async () => new Promise<number>(resolve => {
			finishRenewal = resolve;
		}));
		// eslint-disable-next-line unicorn/prefer-promise-with-resolvers
		const collect = vi.fn(async () => new Promise<InvestmentCollectionStatus>(resolve => {
			finishCollection = resolve;
		}));
		const runtime = await start({config: sessionConfig, maintainSession, collect});
		const maintenance = runtime.maintainSessionNow();
		const collection = runtime.runNow();
		expect(collect).not.toHaveBeenCalled();
		expect(await runtime.runNow()).toBeUndefined();
		expect(await runtime.maintainSessionNow()).toBeUndefined();
		finishRenewal(1199);
		await maintenance;
		expect(collect).toHaveBeenCalledTimes(1);
		expect(await runtime.maintainSessionNow()).toBeUndefined();
		finishCollection('ok');
		expect(await collection).toBe('ok');
		expect(maintainSession).toHaveBeenCalledTimes(1);
	});

	it('preserves financial and session health when another process owns the profile', async () => {
		const runtime = await start({
			async maintainSession() {
				throw new ClalProfileBusyError();
			},
		});
		runtime.store!.setSessionState({
			status: 'active', lastCheckedAt: '2026-09-08T05:58:00.000Z', lastRenewedAt: '2026-09-08T05:58:00.000Z',
			expiresAt: '2026-09-08T06:18:00.000Z', errorCode: null,
		});
		const beforeSession = runtime.store!.getSessionState();
		const beforeFeed = runtime.store!.getFeed(new Date(), 192);
		expect(await runtime.maintainSessionNow()).toBeUndefined();
		expect(runtime.store!.getSessionState()).toEqual(beforeSession);
		expect(runtime.store!.getFeed(new Date(beforeFeed.generatedAt), 192)).toEqual(beforeFeed);
	});

	it('pauses browser attempts after authentication expires and resumes after an external login', async () => {
		useSessionClock();
		const maintainSession = vi.fn(async () => 1199)
			.mockRejectedValueOnce(new ClalCollectionError('OTP_REQUIRED'));
		const runtime = await start({config: sessionConfig, maintainSession, now: () => new Date()});
		runtime.start();
		await vi.advanceTimersByTimeAsync(900_000);
		expect(maintainSession).toHaveBeenCalledTimes(1);
		expect(runtime.store!.getSessionState()).toMatchObject({status: 'auth_required', errorCode: 'OTP_REQUIRED'});
		const externalStore = createInvestmentStore(path.join(directories.at(-1)!, 'investments.sqlite'));
		externalStore.setSessionState({
			status: 'active', lastCheckedAt: new Date().toISOString(), lastRenewedAt: null,
			expiresAt: '2026-09-08T06:35:00.000Z', errorCode: null,
		});
		externalStore.close();
		await vi.advanceTimersByTimeAsync(300_000);
		expect(maintainSession).toHaveBeenCalledTimes(2);
		expect(runtime.store!.getSessionState()).toMatchObject({status: 'active', errorCode: null});
	});

	it('retries transient errors only on the bounded interval', async () => {
		useSessionClock();
		const maintainSession = vi.fn(async () => 1199)
			.mockRejectedValueOnce(new ClalCollectionError('TIMEOUT'))
			.mockRejectedValueOnce(new Error('private provider response'));
		const runtime = await start({config: sessionConfig, maintainSession, now: () => new Date()});
		runtime.start();
		await vi.advanceTimersByTimeAsync(299_999);
		expect(maintainSession).toHaveBeenCalledTimes(1);
		expect(runtime.store!.getSessionState()).toMatchObject({status: 'error', errorCode: 'TIMEOUT'});
		await vi.advanceTimersByTimeAsync(1);
		expect(maintainSession).toHaveBeenCalledTimes(2);
		expect(runtime.store!.getSessionState()).toMatchObject({status: 'error', errorCode: 'COLLECTION_FAILED'});
		await vi.advanceTimersByTimeAsync(300_000);
		expect(maintainSession).toHaveBeenCalledTimes(3);
		expect(runtime.store!.getSessionState().status).toBe('active');
		expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain('private provider response');
	});

	it('stops interval renewal and permits an explicit authentication retry while paused', async () => {
		useSessionClock();
		const maintainSession = vi.fn(async () => 1199)
			.mockRejectedValueOnce(new ClalCollectionError('OTP_REQUIRED'));
		const runtime = await start({config: sessionConfig, maintainSession, now: () => new Date()});
		runtime.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(runtime.store!.getSessionState().status).toBe('auth_required');
		expect(await runtime.maintainSessionNow()).toMatchObject({status: 'active'});
		runtime.stop();
		await vi.advanceTimersByTimeAsync(900_000);
		expect(maintainSession).toHaveBeenCalledTimes(2);
	});

	it('does not overwrite a newer login that completed while an older attempt was closing', async () => {
		useSessionClock();
		let finish: (seconds: number) => void = () => undefined;
		// eslint-disable-next-line unicorn/prefer-promise-with-resolvers
		const maintainSession = async () => new Promise<number>(resolve => {
			finish = resolve;
		});
		const runtime = await start({config: sessionConfig, maintainSession, now: () => new Date()});
		const pending = runtime.maintainSessionNow();
		await vi.advanceTimersByTimeAsync(1000);
		const newerState = {
			status: 'active' as const, lastCheckedAt: new Date().toISOString(), lastRenewedAt: null,
			expiresAt: '2026-09-08T06:20:01.000Z', errorCode: null,
		};
		runtime.store!.setSessionState(newerState);
		finish(1199);
		expect(await pending).toEqual(newerState);
	});

	it.each([0, -1, NaN, Infinity, 1.5])('does not accept malformed renewed lifetime %s', async remaining => {
		const runtime = await start({maintainSession: async () => remaining});
		expect(await runtime.maintainSessionNow()).toMatchObject({status: 'error', errorCode: 'INVALID_RESPONSE'});
		expect(runtime.store!.getFeed(new Date(), 192).source.status).toBe('never_synced');
	});

	it('cancels maintenance and a waiting collection without late state writes', async () => {
		useSessionClock();
		let canceled = false;
		const maintainSession = vi.fn<NonNullable<InvestmentRuntimeOptions['maintainSession']>>(async ({signal}) => new Promise<number>(resolve => {
			signal!.addEventListener('abort', () => {
				canceled = true;
				resolve(1199);
			}, {once: true});
		}));
		const collect = vi.fn(async () => 'ok' as const);
		const runtime = await start({config: sessionConfig, maintainSession, collect});
		const write = vi.spyOn(runtime.store!, 'setSessionState');
		runtime.start();
		const collection = runtime.runNow();
		await runtime.close();
		expect(canceled).toBe(true);
		expect(await collection).toBeUndefined();
		expect(collect).not.toHaveBeenCalled();
		expect(write).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(900_000);
		expect(maintainSession).toHaveBeenCalledTimes(1);
		expect(await runtime.maintainSessionNow()).toBeUndefined();
	});

	it('protects session status and marks historical active observations overdue and expired', async () => {
		useSessionClock();
		const maintainSession = vi.fn<NonNullable<InvestmentRuntimeOptions['maintainSession']>>(async () => 1199);
		const runtime = await start({config: sessionConfig, maintainSession, now: () => new Date()});
		const url = '/investments/v1/session-status';
		await Promise.all([undefined, 'Bearer wrong', `Basic ${readToken}`].map(async authorization => {
			const response = await runtime.router.request(url, {headers: authorization ? {authorization} : {}});
			expect(response.status).toBe(403);
		}));

		await runtime.maintainSessionNow();
		const readStatus = async () => {
			const response = await runtime.router.request(url, {headers: {authorization: `Bearer ${readToken}`}});
			expect(response.headers.get('cache-control')).toBe('no-store');
			return response.json() as Promise<unknown>;
		};

		expect(await readStatus()).toMatchObject({status: 'active', verifiedActive: true, overdue: false, expired: false});
		await vi.advanceTimersByTimeAsync(300_001);
		expect(await readStatus()).toMatchObject({status: 'active', verifiedActive: false, overdue: true, expired: false});
		await vi.advanceTimersByTimeAsync(900_000);
		expect(await readStatus()).toMatchObject({verifiedActive: false, overdue: true, expired: true});
		expect(maintainSession).toHaveBeenCalledTimes(1);
	});
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
