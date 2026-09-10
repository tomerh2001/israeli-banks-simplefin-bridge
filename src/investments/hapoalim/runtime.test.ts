import {mkdtempSync, readdirSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {expect, it, vi} from 'vitest';
import {parseConfig, readRuntimeEnv} from '../../config.js';
import type {Logger} from '../../log.js';
import {hapoalimInvestmentsConfigSchema} from '../config.js';
import {createHapoalimInvestmentRuntime, HAPOALIM_INVESTMENTS_DATABASE} from './runtime.js';

const logger: Logger = {info: vi.fn<Logger['info']>(), warn: vi.fn<Logger['warn']>(), error: vi.fn<Logger['error']>(), debug: vi.fn<Logger['debug']>(), child: () => logger};
const secrets = {resolve: async (value: string) => value, resolveAll: async (values: Record<string, string>) => values};

it('keeps Hapoalim independent and disabled by default without a schedule or extra credentials', () => {
	const config = parseConfig({companies: {}, hapoalimInvestments: {}});
	expect(config.hapoalimInvestments).toEqual({enabled: false, readToken: '', controlToken: '', staleHours: 30, historyStartDate: '2023-01-01'});
	expect(() => hapoalimInvestmentsConfigSchema.parse({schedule: '* * * * *'})).toThrow();
});

it('serves only its authenticated cached feed and never exposes Clal session or refresh controls', async () => {
	const dataDir = mkdtempSync(path.join(os.tmpdir(), 'hapoalim-runtime-'));
	const token = 'example-hapoalim-token-with-at-least-32-characters';
	const runtime = await createHapoalimInvestmentRuntime({
		config: hapoalimInvestmentsConfigSchema.parse({enabled: true, readToken: token}),
		env: {...readRuntimeEnv(), dataDir}, secrets, logger,
	});
	try {
		expect(readdirSync(dataDir)).toContain(HAPOALIM_INVESTMENTS_DATABASE);
		expect(readdirSync(dataDir)).not.toContain('investments.sqlite');
		const route = '/investments/hapoalim/v1';
		const forbidden = await runtime.router.request(route);
		expect(forbidden.status).toBe(403);
		const response = await runtime.router.request(route, {headers: {authorization: `Bearer ${token}`}});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({source: {provider: 'hapoalim', status: 'never_synced'}, products: [], executions: []});
		const session = await runtime.router.request(`${route}/session-status`);
		const refresh = await runtime.router.request(`${route}/control/refresh`, {method: 'POST'});
		expect(session.status).toBe(404);
		expect(refresh.status).toBe(404);
	} finally {
		runtime.close();
		rmSync(dataDir, {recursive: true, force: true});
	}
});
