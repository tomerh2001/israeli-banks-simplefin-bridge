import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {expect, it, vi} from 'vitest';
import {serve} from '../src/serve.js';
import type {InvestmentCollector, InvestmentCollectionStatus} from '../src/investments/runtime.js';
import type {InvestmentFeed, InvestmentProvider, InvestmentSnapshot} from '../src/investments/types.js';
import {silentLogger} from './helpers/seed.js';

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const {port} = server.address() as {port: number};
			server.close(() => {
				resolve(port);
			});
		});
	});
}

function snapshot(provider: InvestmentProvider): InvestmentSnapshot {
	const observedAt = '2026-09-09T00:00:00.000Z';
	const id = `${provider}:SHARED-EXAMPLE-POLICY`;
	const valuationId = `${id}:valuation:2026-09-08`;
	return {
		observedAt, complete: true, inventoryComplete: true,
		products: [{
			id, provider, providerProductId: 'SHARED-EXAMPLE-POLICY', kind: 'investment',
			name: 'Synthetic investment', currency: 'ILS', currentValuationId: valuationId,
			liquidity: {status: 'unknown', availableFrom: null, availableAmount: null},
			coverage: {valuations: 'partial', activities: 'unavailable', tracks: 'unavailable'},
			forecast: null,
		}],
		valuations: [{id: valuationId, productId: id, asOf: '2026-09-08', observedAt, amount: '1000.00', currency: 'ILS'}],
		activities: [], tracks: [],
	};
}

it('mounts both provider feeds without startup collection and aborts both runtimes on shutdown', async () => {
	const dataDir = mkdtempSync(path.join(os.tmpdir(), 'bridge-both-providers-'));
	const configPath = path.join(dataDir, 'config.json');
	const port = await freePort();
	const base = `http://127.0.0.1:${port}`;
	const clalToken = 'synthetic-clal-read-token-longer-than-32';
	const bestToken = 'synthetic-best-invest-token-longer-than-32';
	const collectorConfig = {enabled: true, schedule: '0 0 29 2 *', sessionKeepAliveMinutes: 0};
	writeFileSync(configPath, JSON.stringify({
		companies: {}, timezone: 'Asia/Jerusalem', server: {publicUrl: base, host: '127.0.0.1', port},
		investments: {...collectorConfig, readToken: clalToken},
		bestInvest: {...collectorConfig, readToken: bestToken},
	}));
	vi.stubEnv('CONFIG_PATH', configPath);
	vi.stubEnv('DATA_DIR', dataDir);
	vi.stubEnv('OP_DISABLED', '1');
	vi.stubEnv('SCHEDULE', '');
	const clalCollect = vi.fn<InvestmentCollector>(async ({store}) => {
		store.applySnapshot(snapshot('clal'));
		return 'ok';
	});
	const bestCollect = vi.fn<InvestmentCollector>(async ({store}) => {
		store.applySnapshot(snapshot('hachshara_best_invest'));
		return 'ok';
	});
	const running = await serve({
		logger: silentLogger(), investmentCollector: clalCollect, bestInvestCollector: bestCollect,
	});
	const request = async (route: string, token: string) => fetch(base + route, {headers: {authorization: `Bearer ${token}`}});
	try {
		expect(running.scheduler.isRunning()).toBe(false);
		expect(running.investments).toBeDefined();
		expect(running.bestInvest).toBeDefined();
		const clalCached = await request('/investments/v1', clalToken);
		const bestCached = await request('/investments/best-invest/v1', bestToken);
		expect(clalCached.status).toBe(200);
		expect(bestCached.status).toBe(200);
		expect(await clalCached.json()).toMatchObject({source: {provider: 'clal', status: 'never_synced'}, products: []});
		expect(await bestCached.json()).toMatchObject({source: {provider: 'hachshara_best_invest', status: 'never_synced'}, products: []});
		expect(clalCollect).not.toHaveBeenCalled();
		expect(bestCollect).not.toHaveBeenCalled();
		const clalForbidden = await request('/investments/v1', bestToken);
		const bestForbidden = await request('/investments/best-invest/v1', clalToken);
		expect(clalForbidden.status).toBe(403);
		expect(bestForbidden.status).toBe(403);

		await Promise.all([running.investments!.runNow(), running.bestInvest!.runNow()]);
		const clalResponse = await request('/investments/v1', clalToken);
		const bestResponse = await request('/investments/best-invest/v1', bestToken);
		const clal = await clalResponse.json() as InvestmentFeed;
		const best = await bestResponse.json() as InvestmentFeed;
		expect(clal.source.status).toBe('ok');
		expect(best.source.status).toBe('ok');
		expect(clal.products[0]?.id).toBe('clal:SHARED-EXAMPLE-POLICY');
		expect(best.products[0]?.id).toBe('hachshara_best_invest:SHARED-EXAMPLE-POLICY');
		expect(clalCollect).toHaveBeenCalledTimes(1);
		expect(bestCollect).toHaveBeenCalledTimes(1);

		const waitForAbort: InvestmentCollector = async ({signal}) => new Promise<InvestmentCollectionStatus>(resolve => {
			signal.addEventListener('abort', () => {
				resolve('error');
			}, {once: true});
		});
		clalCollect.mockImplementation(waitForAbort);
		bestCollect.mockImplementation(waitForAbort);
		const pending = [running.investments!.runNow(), running.bestInvest!.runNow()];
		await vi.waitFor(() => {
			expect(clalCollect).toHaveBeenCalledTimes(2);
			expect(bestCollect).toHaveBeenCalledTimes(2);
		});
		const clalClose = vi.spyOn(running.investments!, 'close');
		const bestClose = vi.spyOn(running.bestInvest!, 'close');
		await running.shutdown();
		await running.shutdown();
		await Promise.all(pending);
		expect(clalCollect.mock.calls[1]?.[0].signal.aborted).toBe(true);
		expect(bestCollect.mock.calls[1]?.[0].signal.aborted).toBe(true);
		expect(clalClose).toHaveBeenCalledTimes(1);
		expect(bestClose).toHaveBeenCalledTimes(1);
		await expect(fetch(base + '/healthz')).rejects.toThrow();
	} finally {
		await running.shutdown();
		vi.unstubAllEnvs();
		rmSync(dataDir, {recursive: true, force: true});
	}
});
