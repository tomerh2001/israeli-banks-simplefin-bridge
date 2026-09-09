import {mkdtempSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {Hono} from 'hono';
import {readRuntimeEnv} from '../config.js';
import type {Logger} from '../log.js';
import {investmentConfigSchema} from './config.js';
import type {InvestmentControlStatus} from './control.js';
import {createClalRecoveryCollector} from './recovery.js';
import {createInvestmentRuntime, type InvestmentRuntime, type InvestmentRuntimeOptions, type InvestmentCollectionStatus} from './runtime.js';

const cron = vi.hoisted(() => ({
	schedule: vi.fn(() => ({stop: vi.fn(), destroy: vi.fn(), getNextRun: () => new Date('2026-09-14T04:00:00.000Z')})),
	validate: vi.fn(() => true),
}));
vi.mock('node-cron', () => cron);
const logger: Logger = {info: vi.fn<Logger['info']>(), warn: vi.fn<Logger['warn']>(), error: vi.fn<Logger['error']>(), debug: vi.fn<Logger['debug']>(), child: () => logger};
const readToken = 'synthetic-financial-read-capability-123456789';
const controlToken = 'synthetic-collector-control-capability-987654321';
const config = investmentConfigSchema.parse({enabled: true, readToken: 'op://fixture/read', controlToken: 'op://fixture/control'});
const currentTime = '2026-09-09T06:00:00.000Z';
const directories: string[] = [];
const runtimes: InvestmentRuntime[] = [];
const authorization = {authorization: `Bearer ${controlToken}`};
const providerHeader = {'x-investment-provider': 'clal'};
const statusUrl = '/investments/v1/control/status';
const refreshUrl = '/investments/v1/control/refresh';

async function start(overrides: Partial<InvestmentRuntimeOptions> = {}): Promise<InvestmentRuntime> {
	const dataDir = mkdtempSync(path.join(os.tmpdir(), 'investment-control-test-'));
	directories.push(dataDir);
	const runtime = await createInvestmentRuntime({
		config, env: {...readRuntimeEnv(), dataDir},
		secrets: {resolve: async reference => reference === config.readToken ? readToken : controlToken, resolveAll: async values => values},
		logger, timezone: 'Asia/Jerusalem', now: () => new Date(currentTime), ...overrides,
	});
	runtimes.push(runtime);
	return runtime;
}

async function status(runtime: InvestmentRuntime): Promise<InvestmentControlStatus> {
	const response = await runtime.router.request(statusUrl, {headers: authorization});
	expect(response.status).toBe(200);
	expect(response.headers.get('cache-control')).toBe('no-store');
	return response.json() as Promise<InvestmentControlStatus>;
}

async function responseStatus(response: Response | Promise<Response>): Promise<number> {
	const result = await response;
	return result.status;
}

async function statusPart<K extends keyof InvestmentControlStatus>(runtime: InvestmentRuntime, key: K): Promise<InvestmentControlStatus[K]> {
	const result = await status(runtime);
	return result[key];
}

async function refresh(runtime: InvestmentRuntime) {
	return runtime.router.request(refreshUrl, {method: 'POST', headers: {...authorization, ...providerHeader}});
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

describe('independent investment control capability', () => {
	it.each([undefined, 'Bearer wrong', `Bearer ${readToken}`, `Basic ${controlToken}`])('denies status and refresh with credential %s', async credential => {
		const collect = vi.fn(async () => 'ok' as const);
		const runtime = await start({collect});
		await Promise.all([[statusUrl, 'GET'], [refreshUrl, 'POST']].map(async ([url, method]) => {
			const response = await runtime.router.request(url!, {method, headers: credential ? {authorization: credential, ...providerHeader} : providerHeader});
			expect(response.status).toBe(403);
		}));

		expect(collect).not.toHaveBeenCalled();
	});

	it.each(['', config.readToken, 'short', 'unavailable'])('fails closed for an absent, reused, malformed or unavailable control secret (%s)', async controlReference => {
		const collect = vi.fn(async () => 'ok' as const);
		const runtime = await start({config: {...config, controlToken: controlReference}, collect, secrets: {
			async resolve(reference) {
				if (reference === 'unavailable') {
					throw new Error('private secret details');
				}

				return reference === config.readToken ? readToken : reference;
			}, resolveAll: async values => values,
		}});
		expect(await responseStatus(refresh(runtime))).toBe(503);
		expect(await responseStatus(runtime.router.request('/investments/v1', {headers: {authorization: `Bearer ${readToken}`}}))).toBe(200);
		expect(collect).not.toHaveBeenCalled();
		expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain('private secret');
	});

	it('disables controls when failed read-secret resolution prevents checking capability independence', async () => {
		const runtime = await start({secrets: {
			async resolve(reference) {
				if (reference === config.readToken) {
					throw new Error('synthetic unresolved read capability');
				}

				return controlToken;
			}, resolveAll: async values => values,
		}});
		expect(await responseStatus(refresh(runtime))).toBe(503);
	});

	it('does not authorize the financial feed with the control token', async () => {
		const runtime = await start();
		expect(await responseStatus(runtime.router.request('/investments/v1', {headers: authorization}))).toBe(403);
		expect(await responseStatus(runtime.router.request('/investments/v1/session-status', {headers: authorization}))).toBe(403);
	});

	it('requires matching provider identity before mutation and rejects query, body and browser-origin input', async () => {
		const collect = vi.fn(async () => 'ok' as const);
		const runtime = await start({collect});
		await Promise.all(['', 'other'].map(async provider => {
			const response = await runtime.router.request(refreshUrl, {method: 'POST', headers: {...authorization, 'x-investment-provider': provider}});
			expect(response.status).toBe(409);
			expect(await response.json()).toEqual({error: 'source_identity_mismatch'});
		}));

		await Promise.all(['{"provider":"clal"}', '{"code":"123456"}', '[]', '{}{}', 'private'.repeat(100)].map(async body => {
			const response = await runtime.router.request(refreshUrl, {method: 'POST', headers: {...authorization, ...providerHeader}, body});
			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({error: 'invalid_request'});
		}));

		expect(await responseStatus(runtime.router.request(`${refreshUrl}?force=1`, {method: 'POST', headers: {...authorization, ...providerHeader}}))).toBe(400);
		expect(await responseStatus(runtime.router.request(refreshUrl, {method: 'POST', headers: {...authorization, ...providerHeader, origin: 'https://example.invalid'}}))).toBe(403);
		expect(collect).not.toHaveBeenCalled();
	});
});

describe('read-only source health and scheduling', () => {
	it('exposes the active schedule and receiver health before login without reserving SMS or collecting', async () => {
		const collect = vi.fn(async () => 'ok' as const);
		const otpHealth = vi.fn(async () => ({ready: false, reason: 'phone_unavailable' as const}));
		const runtime = await start({config: {...config, googleMessagesOtpSocket: '/private/receiver.sock'}, collect, otpHealth});
		expect(await statusPart(runtime, 'schedule')).toMatchObject({enabled: false});
		runtime.start();
		const result = await status(runtime);
		expect(result).toMatchObject({
			schemaVersion: 1, observedAt: currentTime,
			source: {provider: 'clal', status: 'never_synced', lastAttemptAt: null, lastSuccessAt: null},
			collection: {running: false, lastResult: null, lastStartedAt: null, lastFinishedAt: null},
			schedule: {enabled: true, expression: '0 7 * * 1', timezone: 'Asia/Jerusalem', nextRunAt: '2026-09-14T04:00:00.000Z'},
			automaticOtp: {enabled: true, ready: false, reason: 'phone_unavailable', nextAllowedAt: null},
			session: {status: 'unknown', verifiedActive: false},
		});
		expect(result.schedule.description).toContain('07:00');
		expect(otpHealth).toHaveBeenCalledWith('/private/receiver.sock', 'clal');
		expect(JSON.stringify(result)).not.toMatch(/private|op:\/\/|capability|products|activities/);
		expect(collect).not.toHaveBeenCalled();
		expect(runtime.store!.consumeAutomaticSmsAttempt(currentTime)).toBe(true);
		expect(runtime.store!.consumeAutomaticSmsAttempt(currentTime)).toBe(true);
		expect(await statusPart(runtime, 'automaticOtp')).toEqual({enabled: true, ready: false, reason: 'rate_limited', nextAllowedAt: '2026-09-10T06:00:00.000Z'});
		runtime.stop();
		expect(await statusPart(runtime, 'schedule')).toMatchObject({enabled: false, nextRunAt: null});
	});

	it('reports missing OTP configuration and invalid schedules honestly', async () => {
		cron.validate.mockReturnValue(false);
		const runtime = await start({config: {...config, schedule: 'invalid'}, collect: async () => 'ok'});
		runtime.start();
		expect(await status(runtime)).toMatchObject({
			schedule: {enabled: false, description: null, nextRunAt: null},
			automaticOtp: {enabled: false, ready: false, reason: 'not_configured', nextAllowedAt: null},
		});
	});
});

describe('asynchronous bounded collection requests', () => {
	it('returns 202 immediately, deduplicates every trigger, and exposes the completed result', async () => {
		let finish: (result: InvestmentCollectionStatus) => void = () => undefined;
		// eslint-disable-next-line unicorn/prefer-promise-with-resolvers
		const collect = vi.fn(async () => new Promise<InvestmentCollectionStatus>(resolve => {
			finish = resolve;
		}));
		const runtime = await start({collect});
		const responses = await Promise.all([refresh(runtime), refresh(runtime), refresh(runtime)]);
		expect(responses.every(response => response.status === 202)).toBe(true);
		expect(await Promise.all(responses.map(async (response): Promise<unknown> => response.json()))).toEqual([
			{result: 'started', retryAfterSeconds: 0}, {result: 'already_running', retryAfterSeconds: 0}, {result: 'already_running', retryAfterSeconds: 0},
		]);
		expect(await runtime.runNow()).toBeUndefined();
		expect(collect).toHaveBeenCalledOnce();
		expect(await statusPart(runtime, 'collection')).toMatchObject({running: true, lastStartedAt: currentTime, lastFinishedAt: null});
		finish('partial');
		await vi.waitFor(async () => expect(await statusPart(runtime, 'collection')).toMatchObject({running: false, lastResult: 'partial', lastFinishedAt: currentTime}));
	});

	it('limits completed refresh starts to two per rolling minute, including after restart', async () => {
		let now = new Date(currentTime);
		const collect = vi.fn(async () => 'ok' as const);
		const runtime = await start({collect, now: () => now});
		const dataDir = directories.at(-1)!;
		expect(await responseStatus(refresh(runtime))).toBe(202);
		expect(await responseStatus(refresh(runtime))).toBe(202);
		const denied = await refresh(runtime);
		expect(denied.status).toBe(429);
		expect(denied.headers.get('retry-after')).toBe('60');
		expect(await denied.json()).toEqual({error: 'refresh_rate_limited', retryAfterSeconds: 60});
		await runtime.close();
		const restarted = await start({env: {...readRuntimeEnv(), dataDir}, collect, now: () => now});
		expect(await responseStatus(refresh(restarted))).toBe(429);
		now = new Date(now.getTime() + 60_000);
		expect(await responseStatus(refresh(restarted))).toBe(202);
		expect(collect).toHaveBeenCalledTimes(3);
	});

	it('reports failed automatic authentication without inventing fresh data or leaking the receiver error', async () => {
		const login = vi.fn(async () => {
			throw new Error('private receiver 123456');
		});
		const collect = createClalRecoveryCollector(async context => {
			context.store.recordFailure({status: 'auth_required', errorCode: 'OTP_REQUIRED', attemptedAt: currentTime});
			return 'auth_required';
		}, {login});
		const runtime = await start({config: {...config, googleMessagesOtpSocket: '/private/receiver.sock'}, collect, otpHealth: async () => ({ready: false, reason: 'phone_unavailable'})});
		runtime.store!.applySnapshot({observedAt: '2026-09-08T06:00:00.000Z', complete: true, inventoryComplete: true, products: [], valuations: [], activities: [], tracks: []});
		expect(await responseStatus(refresh(runtime))).toBe(202);
		await vi.waitFor(async () => expect(await statusPart(runtime, 'collection')).toMatchObject({running: false, lastResult: 'auth_required'}));
		expect(await statusPart(runtime, 'source')).toMatchObject({status: 'auth_required', lastSuccessAt: '2026-09-08T06:00:00.000Z'});
		expect(login).toHaveBeenCalledOnce();
		expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain('123456');
	});
});

describe('provider control isolation in one application', () => {
	it('keeps provider routes, receiver readiness, and automatic SMS budgets independent', async () => {
		const clalCollect = vi.fn(async () => 'ok' as const);
		const bestCollect = vi.fn(async () => 'ok' as const);
		const socketPath = '/synthetic/shared-receiver.sock';
		const otpHealth = vi.fn<NonNullable<InvestmentRuntimeOptions['otpHealth']>>(async (_socket, provider) => provider === 'best-invest'
			? {ready: false, reason: 'unavailable'}
			: {ready: true, reason: 'ready'});
		const bestReadToken = 'synthetic-best-read-capability-0123456789';
		const bestControlToken = 'synthetic-best-control-capability-0123456789';
		const bestAuthorization = {authorization: `Bearer ${bestControlToken}`};
		const clal = await start({collect: clalCollect, config: {...config, googleMessagesOtpSocket: socketPath}, otpHealth});
		const best = await start({
			provider: 'hachshara_best_invest', collect: bestCollect,
			config: {...config, readToken: bestReadToken, controlToken: bestControlToken, googleMessagesOtpSocket: socketPath},
			secrets: {resolve: async reference => reference, resolveAll: async values => values},
			otpHealth,
		});
		const app = new Hono();
		app.route('/', clal.router);
		app.route('/', best.router);
		const bestStatus = '/investments/best-invest/v1/control/status';
		const bestRefresh = '/investments/best-invest/v1/control/refresh';
		const clalResponse = await app.request(statusUrl, {headers: authorization});
		expect(clalResponse.status).toBe(200);
		expect(await clalResponse.json()).toMatchObject({source: {provider: 'clal'}, automaticOtp: {enabled: true, ready: true, reason: 'ready'}});
		const bestResponse = await app.request(bestStatus, {headers: bestAuthorization});
		expect(bestResponse.status).toBe(200);
		expect(await bestResponse.json()).toMatchObject({
			source: {provider: 'hachshara_best_invest'},
			automaticOtp: {enabled: true, ready: false, reason: 'unavailable'},
		});
		expect(otpHealth).toHaveBeenCalledWith(socketPath, 'clal');
		expect(otpHealth).toHaveBeenCalledWith(socketPath, 'best-invest');
		otpHealth.mockResolvedValue({ready: true, reason: 'ready'});
		const readyResponse = await app.request(bestStatus, {headers: bestAuthorization});
		expect(await readyResponse.json()).toMatchObject({automaticOtp: {enabled: true, ready: true, reason: 'ready', nextAllowedAt: null}});
		expect(best.store!.consumeAutomaticSmsAttempt(currentTime)).toBe(true);
		expect(best.store!.consumeAutomaticSmsAttempt(currentTime)).toBe(true);
		const limitedResponse = await app.request(bestStatus, {headers: bestAuthorization});
		expect(await limitedResponse.json()).toMatchObject({automaticOtp: {enabled: true, ready: false, reason: 'rate_limited', nextAllowedAt: '2026-09-10T06:00:00.000Z'}});
		expect(await statusPart(clal, 'automaticOtp')).toEqual({enabled: true, ready: true, reason: 'ready', nextAllowedAt: null});
		expect(await responseStatus(app.request(bestStatus, {headers: authorization}))).toBe(403);
		expect(await responseStatus(app.request(bestRefresh, {method: 'POST', headers: {...bestAuthorization, ...providerHeader}}))).toBe(409);
		expect(await responseStatus(app.request(refreshUrl, {method: 'POST', headers: {...authorization, 'x-investment-provider': 'hachshara_best_invest'}}))).toBe(409);
		expect(clalCollect).not.toHaveBeenCalled();
		expect(bestCollect).not.toHaveBeenCalled();
		expect(await responseStatus(app.request(refreshUrl, {method: 'POST', headers: {...authorization, ...providerHeader}}))).toBe(202);
		expect(await responseStatus(app.request(bestRefresh, {method: 'POST', headers: {...bestAuthorization, 'x-investment-provider': 'hachshara_best_invest'}}))).toBe(202);
		expect(clalCollect).toHaveBeenCalledOnce();
		expect(bestCollect).toHaveBeenCalledOnce();
	});
});
