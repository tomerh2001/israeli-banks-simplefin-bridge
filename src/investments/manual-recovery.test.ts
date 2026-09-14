/* eslint-disable no-await-in-loop, unicorn/no-await-expression-member -- Stateful HTTP sequences are clearer when each response is checked before the next request. */
import {Buffer} from 'node:buffer';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {readRuntimeEnv} from '../config.js';
import type {Logger} from '../log.js';
import {investmentConfigSchema} from './config.js';
import type {InvestmentControlStatus} from './control.js';
import {createManualRecovery} from './manual-recovery.js';
import {createInvestmentRuntime, type InvestmentCollector, type InvestmentRuntime, type InvestmentRuntimeOptions} from './runtime.js';

const readToken = 'synthetic-read-capability-with-32-characters';
const controlToken = 'synthetic-control-capability-with-32-characters';
const logger: Logger = {info: vi.fn<Logger['info']>(), warn: vi.fn<Logger['warn']>(), error: vi.fn<Logger['error']>(), debug: vi.fn<Logger['debug']>(), child: () => logger};
const directories: string[] = [];
const runtimes: InvestmentRuntime[] = [];
const config = investmentConfigSchema.parse({enabled: true, readToken: 'read', controlToken: 'control', credentials: {id: 'id-ref', phone: 'phone-ref'}});
const headers = {authorization: `Bearer ${controlToken}`, 'x-investment-provider': 'clal', 'content-type': 'application/json'};
const base = '/investments/v1/control';

async function start(overrides: Partial<InvestmentRuntimeOptions> = {}) {
	const dataDir = overrides.env?.dataDir ?? mkdtempSync(path.join(os.tmpdir(), 'manual-investment-'));
	directories.push(dataDir);
	const runtime = await createInvestmentRuntime({
		config, env: {...readRuntimeEnv(), dataDir}, logger, timezone: 'Asia/Jerusalem',
		secrets: {resolve: async value => value === 'read' ? readToken : controlToken, resolveAll: async values => values}, ...overrides,
	});
	runtimes.push(runtime);
	return {runtime, dataDir};
}

function collectCode() {
	const received = vi.fn<(code: string) => void>();
	const collect = vi.fn<InvestmentCollector>(async context => {
		const request = await context.manualOtpSource!.prepare(context.signal);
		try {
			received(await request.read(context.signal));
			return 'ok';
		} catch {
			return 'auth_required';
		} finally {
			await request.cancel();
		}
	});
	return {collect, received};
}

async function status(runtime: InvestmentRuntime, route = base): Promise<InvestmentControlStatus> {
	const result = await runtime.router.request(`${route}/status`, {headers});
	expect(result.status).toBe(200);
	return result.json() as Promise<InvestmentControlStatus>;
}

async function requestStart(runtime: InvestmentRuntime, requestId = randomUUID(), route = base, provider = 'clal') {
	return runtime.router.request(`${route}/recovery`, {method: 'POST', headers: {...headers, 'x-investment-provider': provider}, body: JSON.stringify({requestId})});
}

afterEach(async () => {
	await Promise.all(runtimes.map(async runtime => runtime.close()));
	runtimes.length = 0;
	for (const directory of directories) {
		rmSync(directory, {recursive: true, force: true});
	}

	directories.length = 0;
	vi.useRealTimers();
	vi.clearAllMocks();
});

describe('manual recovery capability boundaries', () => {
	it('requires the separate control credential and matching provider on every mutation', async () => {
		const fake = collectCode();
		const {runtime} = await start({collect: fake.collect});
		const id = randomUUID();
		for (const [route, method, body] of [['/recovery', 'POST', JSON.stringify({requestId: id})], [`/recovery/${id}/code`, 'POST', '{"code":"654321"}'], [`/recovery/${id}`, 'DELETE', '{}']]) {
			for (const credential of ['', `Bearer ${readToken}`, 'Bearer wrong']) {
				const response = await runtime.router.request(base + route, {method, body, headers: {...headers, authorization: credential}});
				expect(response.status).toBe(403);
			}

			const response = await runtime.router.request(base + route, {method, body, headers: {...headers, 'x-investment-provider': 'hachshara_best_invest'}});
			expect(response.status).toBe(409);
			expect(await response.json()).toEqual({error: 'source_identity_mismatch'});
		}

		expect(fake.collect).not.toHaveBeenCalled();
	});

	it('rejects malformed requests, browser origins, query strings and oversized bodies without starting collection', async () => {
		const fake = collectCode();
		const {runtime} = await start({collect: fake.collect});
		for (const body of ['', '{}', '{', '{"requestId":"invalid"}', JSON.stringify({requestId: randomUUID(), extra: true}), 'a'.repeat(129)]) {
			expect((await runtime.router.request(`${base}/recovery`, {method: 'POST', headers, body})).status).toBe(400);
		}

		const body = JSON.stringify({requestId: randomUUID()});
		expect((await runtime.router.request(`${base}/recovery?force=1`, {method: 'POST', headers, body})).status).toBe(400);
		expect((await runtime.router.request(`${base}/recovery`, {method: 'POST', headers: {...headers, origin: 'https://example.invalid'}, body})).status).toBe(403);
		expect(fake.collect).not.toHaveBeenCalled();
	});

	it('reports manual availability only when source credentials and a collector are configured', async () => {
		const {runtime} = await start();
		expect((await status(runtime)).manualVerificationAvailable).toBe(false);
		expect((await requestStart(runtime)).status).toBe(503);
		const unavailable = await start({collect: vi.fn<InvestmentCollector>(async () => 'ok'), config: {...config, credentials: {id: '', phone: ''}}});
		expect((await status(unavailable.runtime)).manualVerificationAvailable).toBe(false);
	});
});

describe('one-use manual SMS delivery', () => {
	it.each([['clal', base], ['hachshara_best_invest', '/investments/best-invest/v1/control']] as const)('injects only the requested %s collection and never publishes or persists its code', async (provider, route) => {
		const fake = collectCode();
		const {runtime, dataDir} = await start({provider, collect: fake.collect});
		const requestId = randomUUID();
		expect((await requestStart(runtime, requestId, route, provider)).status).toBe(202);
		const before = await status(runtime, route);
		expect(before.manualVerificationAvailable).toBe(true);
		expect(before.recovery).toMatchObject({challengeId: requestId, state: 'awaiting_code', errorCode: null});
		for (const body of ['{"code":654321}', '{"code":"12345"}', '{"code":"654321","extra":1}', '{"code":"654321","code":"654321"}']) {
			expect((await runtime.router.request(`${route}/recovery/${requestId}/code`, {method: 'POST', headers: {...headers, 'x-investment-provider': provider}, body})).status).toBe(400);
		}

		const response = await runtime.router.request(`${route}/recovery/${requestId}/code`, {method: 'POST', headers: {...headers, 'x-investment-provider': provider}, body: '{"code":"654321"}'});
		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({recovery: {challengeId: requestId, state: 'verifying', expiresAt: null, errorCode: null}});
		expect(fake.received).toHaveBeenCalledExactlyOnceWith('654321');
		expect((await status(runtime, route)).recovery?.state).toBe('complete');
		expect((await runtime.router.request(`${route}/recovery/${requestId}/code`, {method: 'POST', headers: {...headers, 'x-investment-provider': provider}, body: '{"code":"654321"}'})).status).toBe(409);
		expect(fake.collect).toHaveBeenCalledOnce();
		expect(JSON.stringify([await status(runtime, route), vi.mocked(logger.error).mock.calls, vi.mocked(logger.warn).mock.calls])).not.toContain('654321');
		expect(readFileSync(path.join(dataDir, provider === 'clal' ? 'investments.sqlite' : 'best-invest.sqlite')).includes(Buffer.from('654321'))).toBe(false);
	});

	it('makes the same request id idempotent during and after recovery and rejects a concurrent different request', async () => {
		const fake = collectCode();
		const {runtime} = await start({collect: fake.collect});
		const id = randomUUID();
		await requestStart(runtime, id);
		await Promise.all([requestStart(runtime, id), requestStart(runtime, id), status(runtime), status(runtime)]);
		expect((await requestStart(runtime)).status).toBe(409);
		expect(fake.collect).toHaveBeenCalledOnce();
		expect((await runtime.router.request(`${base}/recovery/${id}`, {method: 'DELETE', headers})).status).toBe(200);
		expect((await requestStart(runtime, id)).status).toBe(202);
		expect((await status(runtime)).recovery?.state).toBe('canceled');
		expect((await runtime.router.request(`${base}/recovery/${id}/code`, {method: 'POST', headers, body: '{"code":"654321"}'})).status).toBe(409);
		expect(fake.received).not.toHaveBeenCalled();
	});

	it('excludes another runtime for the same provider while allowing a separate provider', async () => {
		const fake = collectCode();
		const first = await start({collect: fake.collect});
		const second = await start({collect: fake.collect});
		const best = await start({collect: fake.collect, provider: 'hachshara_best_invest'});
		await requestStart(first.runtime);
		expect((await requestStart(second.runtime)).status).toBe(409);
		expect((await requestStart(best.runtime, randomUUID(), '/investments/best-invest/v1/control', 'hachshara_best_invest')).status).toBe(202);
		expect(fake.collect).toHaveBeenCalledTimes(2);
	});

	it('does not repeat an uncertain request after a process restart', async () => {
		const collect = vi.fn<InvestmentCollector>(async () => 'ok');
		const first = await start({collect});
		const id = randomUUID();
		first.runtime.store!.reserveManualRecoveryRequest(id, new Date().toISOString());
		await first.runtime.close();
		const second = await start({collect, env: {...readRuntimeEnv(), dataDir: first.dataDir}});
		const response = await requestStart(second.runtime, id);
		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({recovery: {challengeId: id, state: 'failed', expiresAt: null, errorCode: 'RECOVERY_INTERRUPTED'}});
		expect((await status(second.runtime)).recovery?.errorCode).toBe('RECOVERY_INTERRUPTED');
		expect(collect).not.toHaveBeenCalled();
	});

	it('expires waiting codes after 180 seconds and aborts the pending receiver', async () => {
		vi.useFakeTimers();
		const abort = vi.fn<() => void>();
		const persist = vi.fn<() => void>();
		const recovery = createManualRecovery({provider: 'clal', requestId: randomUUID(), now: () => new Date(), abort, persist})!;
		const {signal} = new AbortController();
		const request = await recovery.source.prepare(signal);
		const pending = request.read(signal).catch(() => 'expired');
		await vi.advanceTimersByTimeAsync(180_000);
		expect(await pending).toBe('expired');
		expect(recovery.status()).toMatchObject({state: 'expired', expiresAt: null, errorCode: 'OTP_EXPIRED'});
		expect(recovery.submit('654321')).toEqual({error: 'recovery_expired'});
		expect(abort).toHaveBeenCalledOnce();
		expect(persist).toHaveBeenCalledOnce();
	});
});
