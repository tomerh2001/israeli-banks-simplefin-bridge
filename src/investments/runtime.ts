import path from 'node:path';
import {schedule as cronSchedule, validate as cronValidate, type ScheduledTask} from 'node-cron';
import type {Hono} from 'hono';
import {redact, type Logger} from '../log.js';
import type {RuntimeEnv, SecretsResolver} from '../types.js';
import type {InvestmentConfig} from './config.js';
import {createInvestmentRouter} from './router.js';
import {createInvestmentStore} from './store.js';
import type {InvestmentStore} from './types.js';

export type InvestmentCollectionContext = {
	config: InvestmentConfig;
	env: RuntimeEnv;
	secrets: SecretsResolver;
	logger: Logger;
	store: InvestmentStore;
	/** Collectors must close their browser when shutdown cancels the active collection. */
	signal: AbortSignal;
};

export type InvestmentCollectionStatus = 'ok' | 'partial' | 'auth_required' | 'error';
export type InvestmentCollector = (context: InvestmentCollectionContext) => Promise<InvestmentCollectionStatus>;

export type InvestmentRuntimeOptions = Omit<InvestmentCollectionContext, 'store' | 'signal'> & {
	timezone: string;
	collect?: InvestmentCollector;
	now?: () => Date;
};

export type InvestmentRuntime = {
	store?: InvestmentStore;
	router: Hono;
	/** Returns undefined for an overlapping trigger or an unconfigured collector. */
	runNow(): Promise<InvestmentCollectionStatus | undefined>;
	start(): void;
	stop(): void;
	close(): Promise<void>;
};

/** Independent lifecycle: no startup collection, bank ledger writes, or SimpleFIN credentials. */
export async function createInvestmentRuntime(options: InvestmentRuntimeOptions): Promise<InvestmentRuntime> {
	const {config, env, secrets, logger} = options;
	const now = options.now ?? (() => new Date());
	let store: InvestmentStore | undefined;
	try {
		store = createInvestmentStore(path.join(env.dataDir, 'investments.sqlite'));
	} catch {
		logger.error('investment database unavailable; bank service remains available');
	}

	let readToken: string | undefined;
	try {
		if (config.readToken) {
			readToken = await secrets.resolve(config.readToken);
			redact(readToken);
		}
	} catch {
		logger.error('investment read token unavailable; bank service remains available');
	}

	const router = createInvestmentRouter({store, readToken, staleHours: config.staleHours, logger, now});
	let task: ScheduledTask | undefined;
	let running: Promise<InvestmentCollectionStatus> | undefined;
	let controller: AbortController | undefined;
	let closed = false;
	const runNow = async (): Promise<InvestmentCollectionStatus | undefined> => {
		if (closed || running || !options.collect || !store) {
			return undefined;
		}

		const collectionStore = store;
		const {collect} = options;
		controller = new AbortController();
		const {signal} = controller;
		running = (async (): Promise<InvestmentCollectionStatus> => {
			try {
				return await collect({config, env, secrets, logger, store: collectionStore, signal});
			} catch {
				if (!signal.aborted) {
					collectionStore.recordFailure({status: 'error', attemptedAt: now().toISOString(), errorCode: 'COLLECTION_FAILED'});
					logger.error('investment collection failed');
				}

				return 'error';
			}
		})();
		try {
			return await running;
		} finally {
			running = undefined;
			controller = undefined;
		}
	};

	const stop = (): void => {
		void task?.stop();
		void task?.destroy();
		task = undefined;
	};

	return {
		store,
		router,
		runNow,
		start() {
			if (closed || !config.enabled || !options.collect || !store) {
				return;
			}

			if (!cronValidate(config.schedule)) {
				logger.error('investment schedule invalid; bank schedule remains available');
				return;
			}

			stop();
			task = cronSchedule(config.schedule, async () => {
				await runNow();
			}, {timezone: options.timezone, name: 'clal-investments'});
			logger.info('investment scheduler started', {schedule: config.schedule, timezone: options.timezone});
		},
		stop,
		async close() {
			if (closed) {
				return;
			}

			closed = true;
			stop();
			controller?.abort();
			await running;
			store?.close();
		},
	};
}
