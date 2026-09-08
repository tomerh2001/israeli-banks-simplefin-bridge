import {mkdtempSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {expect, it, vi} from 'vitest';
import {parseConfig, readRuntimeEnv} from '../config.js';
import type {Logger} from '../log.js';
import {bestInvestConfigSchema, investmentConfigSchema} from './config.js';
import {investmentProductId, investmentValuationId} from './ids.js';
import {createInvestmentRuntime} from './runtime.js';
import {createInvestmentStore} from './store.js';
import type {InvestmentProvider, InvestmentSnapshot} from './types.js';

const observedAt = '2026-09-08T06:00:00.000Z';
const logger: Logger = {info: vi.fn<Logger['info']>(), warn: vi.fn<Logger['warn']>(), error: vi.fn<Logger['error']>(), debug: vi.fn<Logger['debug']>(), child: () => logger};

function snapshot(provider: InvestmentProvider): InvestmentSnapshot {
	const id = investmentProductId('EXAMPLE-POLICY', provider);
	const valuationId = investmentValuationId(id, '2026-09-07');
	return {
		observedAt, complete: true, inventoryComplete: true,
		products: [{
			id, provider, providerProductId: 'EXAMPLE-POLICY', kind: 'investment', name: 'Example investment', currency: 'ILS',
			currentValuationId: valuationId, liquidity: {status: 'unknown', availableFrom: null, availableAmount: null},
			coverage: {valuations: 'partial', activities: 'unavailable', tracks: 'unavailable'}, forecast: null,
		}],
		valuations: [{id: valuationId, productId: id, asOf: '2026-09-07', observedAt, amount: '1234.56', currency: 'ILS'}],
		activities: [], tracks: [],
	};
}

it('isolates identical policy numbers, failures, and automatic OTP allowances by provider', () => {
	const clal = createInvestmentStore(':memory:');
	const best = createInvestmentStore(':memory:', 'hachshara_best_invest');
	try {
		clal.applySnapshot(snapshot('clal'));
		best.applySnapshot(snapshot('hachshara_best_invest'));
		expect(() => clal.applySnapshot(snapshot('hachshara_best_invest'))).toThrow('provider identity');
		expect(() => best.applySnapshot(snapshot('clal'))).toThrow('provider identity');
		expect(best.consumeAutomaticSmsAttempt(observedAt)).toBe(true);
		expect(best.consumeAutomaticSmsAttempt(observedAt)).toBe(true);
		expect(best.consumeAutomaticSmsAttempt(observedAt)).toBe(false);
		expect(clal.consumeAutomaticSmsAttempt(observedAt)).toBe(true);
		best.recordFailure({status: 'auth_required', attemptedAt: observedAt, errorCode: 'OTP_REQUIRED'});
		const feed = best.getFeed(new Date(observedAt), 72);
		expect(feed.source.status).toBe('auth_required');
		expect(feed.valuations[0]?.amount).toBe('1234.56');
		expect(clal.getFeed(new Date(observedAt), 192).source.status).toBe('ok');
	} finally {
		clal.close();
		best.close();
	}
});

it('serves independent bearer tokens and databases when both runtimes share a data directory', async () => {
	const dataDir = mkdtempSync(path.join(os.tmpdir(), 'investment-providers-'));
	const env = {...readRuntimeEnv(), dataDir};
	const secrets = {resolve: async (value: string) => value, resolveAll: async (values: Record<string, string>) => values};
	const clalToken = 'example-clal-token-with-at-least-32-characters';
	const bestToken = 'example-best-token-with-at-least-32-characters';
	const clal = await createInvestmentRuntime({config: investmentConfigSchema.parse({readToken: clalToken}), env, secrets, logger, timezone: 'Asia/Jerusalem'});
	const best = await createInvestmentRuntime({config: bestInvestConfigSchema.parse({readToken: bestToken}), provider: 'hachshara_best_invest', env, secrets, logger, timezone: 'Asia/Jerusalem'});
	try {
		clal.store!.applySnapshot(snapshot('clal'));
		best.store!.applySnapshot(snapshot('hachshara_best_invest'));
		const request = async (token: string) => best.router.request('/investments/best-invest/v1', {headers: {authorization: `Bearer ${token}`}});
		const forbidden = await request(clalToken);
		expect(forbidden.status).toBe(403);
		const response = await request(bestToken);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({source: {provider: 'hachshara_best_invest'}, products: [{id: 'hachshara_best_invest:EXAMPLE-POLICY'}]});
		const wrongRoute = await best.router.request('/investments/v1');
		expect(wrongRoute.status).toBe(404);
		expect(clal.store!.getFeed(new Date(observedAt), 192).source.provider).toBe('clal');
	} finally {
		await Promise.all([clal.close(), best.close()]);
		rmSync(dataDir, {recursive: true, force: true});
	}
});

it('keeps Best Invest defaults independent and rejects unverified keep-alive configuration', () => {
	const config = parseConfig({companies: {}, bestInvest: {enabled: true}, investments: {enabled: true}});
	expect(config.bestInvest).toMatchObject({schedule: '30 3 * * *', staleHours: 72, sessionKeepAliveMinutes: 0});
	expect(config.investments).toMatchObject({schedule: '0 7 * * 1', staleHours: 192});
	expect(() => parseConfig({companies: {}, bestInvest: {sessionKeepAliveMinutes: 5}})).toThrow();
});
