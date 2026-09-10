import path from 'node:path';
import type {Hono} from 'hono';
import {redact, type Logger} from '../../log.js';
import type {RuntimeEnv, SecretsResolver} from '../../types.js';
import type {HapoalimInvestmentsConfig} from '../config.js';
import {createInvestmentRouter} from '../router.js';
import {createInvestmentStore} from '../store.js';
import type {InvestmentStore} from '../types.js';

export const HAPOALIM_INVESTMENTS_DATABASE = 'hapoalim-investments.sqlite';

export type HapoalimInvestmentRuntime = {
	store?: InvestmentStore;
	router: Hono;
	close(): void;
};

/** Cached feed only. The bank scheduler injects this store into its existing guarded login. */
export async function createHapoalimInvestmentRuntime(options: {
	config: HapoalimInvestmentsConfig;
	env: RuntimeEnv;
	secrets: SecretsResolver;
	logger: Logger;
}): Promise<HapoalimInvestmentRuntime> {
	const {config, env, secrets, logger} = options;
	let store: InvestmentStore | undefined;
	let readToken: string | undefined;
	if (config.enabled) {
		try {
			store = createInvestmentStore(path.join(env.dataDir, HAPOALIM_INVESTMENTS_DATABASE), 'hapoalim');
		} catch {
			logger.error('Hapoalim investment database unavailable; checking collection remains available');
		}

		try {
			if (config.readToken) {
				readToken = await secrets.resolve(config.readToken);
				redact(readToken);
			}

			// Reserved for a future provider-specific control surface. Never use Clal controls.
			if (config.controlToken) {
				const controlToken = await secrets.resolve(config.controlToken);
				redact(controlToken);
				if (controlToken === readToken) {
					throw new Error('Control and read capabilities must be independent');
				}
			}
		} catch {
			readToken = undefined;
			logger.error('Hapoalim investment capability unavailable; checking collection remains available');
		}
	}

	let closed = false;
	return {
		store,
		router: createInvestmentRouter({
			store, readToken, staleHours: config.staleHours, logger,
			feedPath: '/investments/hapoalim/v1', sessionStatus: false,
		}),
		close() {
			if (closed) {
				return;
			}

			closed = true;
			store?.close();
		},
	};
}
