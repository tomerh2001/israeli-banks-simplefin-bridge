import path from 'node:path';
import {schedule as cronSchedule, validate as cronValidate, type ScheduledTask} from 'node-cron';
import cronstrue from 'cronstrue';
import type {Hono} from 'hono';
import {redact, type Logger} from '../log.js';
import type {RuntimeEnv, SecretsResolver} from '../types.js';
import {ClalCollectionError, ClalProfileBusyError, type ClalBrowserOptions} from './browser.js';
import type {InvestmentConfig} from './config.js';
import {createInvestmentControlRouter, type InvestmentControlStatus, type InvestmentRefreshResult} from './control.js';
import {readGoogleMessagesHealth, type GoogleMessagesHealth, type GoogleMessagesProvider} from './otp.js';
import {createInvestmentRouter, getClalSessionStatus} from './router.js';
import {createInvestmentStore} from './store.js';
import type {ClalSessionState, InvestmentProvider, InvestmentStore} from './types.js';

export type InvestmentCollectionContext = {
	config: InvestmentConfig;
	env: RuntimeEnv;
	secrets: SecretsResolver;
	logger: Logger;
	store: InvestmentStore;
	/** Collectors must close their browser when shutdown cancels the active collection. */
	signal: AbortSignal;
};

export type InvestmentCollectionStatus = 'ok' | 'partial' | 'auth_required' | 'error' | 'skipped';
export type InvestmentCollector = (context: InvestmentCollectionContext) => Promise<InvestmentCollectionStatus>;

export type InvestmentRuntimeOptions = Omit<InvestmentCollectionContext, 'store' | 'signal'> & {
	timezone: string;
	collect?: InvestmentCollector;
	/** Renews an existing session and returns its verified remaining lifetime, without requesting an SMS. */
	maintainSession?: (options: ClalBrowserOptions) => Promise<number>;
	/** Read-only provider readiness; no login or SMS side effects. */
	otpHealth?: (socketPath: string, provider: GoogleMessagesProvider) => Promise<GoogleMessagesHealth>;
	now?: () => Date;
	provider?: InvestmentProvider;
};

export type InvestmentRuntime = {
	store?: InvestmentStore;
	router: Hono;
	/** Returns undefined for an overlapping collection trigger or an unconfigured collector. */
	runNow(): Promise<InvestmentCollectionStatus | undefined>;
	/** Explicit checks can retry paused authentication; scheduled checks wait for a new login. */
	maintainSessionNow(): Promise<ClalSessionState | undefined>;
	start(): void;
	stop(): void;
	close(): Promise<void>;
};

/** Independent lifecycle: no startup collection, bank ledger writes, or SimpleFIN credentials. */
export async function createInvestmentRuntime(options: InvestmentRuntimeOptions): Promise<InvestmentRuntime> {
	const {config, env, secrets, logger} = options;
	const provider = options.provider ?? 'clal';
	const isBestInvest = provider === 'hachshara_best_invest';
	const now = options.now ?? (() => new Date());
	let store: InvestmentStore | undefined;
	try {
		store = createInvestmentStore(path.join(env.dataDir, isBestInvest ? 'best-invest.sqlite' : 'investments.sqlite'), provider);
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

	let controlToken: string | undefined;
	try {
		// If configured read-secret resolution failed, independence cannot be verified.
		if (config.controlToken && (!config.readToken || readToken)) {
			controlToken = await secrets.resolve(config.controlToken);
			redact(controlToken);
		}
	} catch {
		logger.error('investment control token unavailable; financial feeds remain available');
	}

	const router = createInvestmentRouter({
		store, readToken, staleHours: config.staleHours,
		sessionKeepAliveMinutes: config.sessionKeepAliveMinutes, logger, now,
		feedPath: isBestInvest ? '/investments/best-invest/v1' : '/investments/v1',
	});
	let task: ScheduledTask | undefined;
	let sessionTimer: ReturnType<typeof setInterval> | undefined;
	let running: Promise<InvestmentCollectionStatus | undefined> | undefined;
	let lastResult: InvestmentControlStatus['collection']['lastResult'] = null;
	let lastStartedAt: InvestmentControlStatus['collection']['lastStartedAt'] = null;
	let lastFinishedAt: InvestmentControlStatus['collection']['lastFinishedAt'] = null;
	let maintaining: Promise<ClalSessionState | undefined> | undefined;
	let collectionController: AbortController | undefined;
	let maintenanceController: AbortController | undefined;
	let closed = false;
	let generation = 0;
	let scheduledCollection: {
		generation: number;
		deadline: number;
		timer?: ReturnType<typeof setTimeout>;
	} | undefined;

	const maintainSession = async (scheduled: boolean): Promise<ClalSessionState | undefined> => {
		if (closed || running || maintaining || !options.maintainSession || !store) {
			return undefined;
		}

		const sessionStore = store;
		const renew = options.maintainSession;
		// Use the attempt start as a conservative observation/expiry bound. A newer
		// login in another process must win even if this browser finishes closing later.
		const checkedAt = now();
		maintenanceController = new AbortController();
		const {signal} = maintenanceController;
		maintaining = (async () => {
			try {
				const previous = sessionStore.getSessionState();
				if (scheduled && previous.status === 'auth_required') {
					return previous;
				}

				// A short maintenance attempt must not hold a due collection for its full timeout.
				const remainingSeconds = await renew({env, timeoutMinutes: Math.min(1, config.timeoutMinutes), signal});
				if (signal.aborted || closed) {
					return undefined;
				}

				if (!Number.isSafeInteger(remainingSeconds) || remainingSeconds <= 0) {
					throw new ClalCollectionError('INVALID_RESPONSE');
				}

				sessionStore.setSessionState({
					status: 'active', lastCheckedAt: checkedAt.toISOString(), lastRenewedAt: checkedAt.toISOString(),
					expiresAt: new Date(checkedAt.getTime() + (remainingSeconds * 1000)).toISOString(), errorCode: null,
				});
				return sessionStore.getSessionState();
			} catch (error) {
				if (signal.aborted || closed || error instanceof ClalProfileBusyError) {
					return undefined;
				}

				const errorCode = error instanceof ClalCollectionError ? error.code : 'COLLECTION_FAILED';
				try {
					const previous = sessionStore.getSessionState();
					sessionStore.setSessionState({
						...previous, status: errorCode === 'OTP_REQUIRED' ? 'auth_required' : 'error',
						lastCheckedAt: checkedAt.toISOString(), errorCode,
						expiresAt: errorCode === 'OTP_REQUIRED' ? null : previous.expiresAt,
					});
					logger.warn('Clal session maintenance needs attention', {errorCode});
					return sessionStore.getSessionState();
				} catch {
					logger.error('Clal session state unavailable');
					return undefined;
				}
			}
		})();
		try {
			return await maintaining;
		} finally {
			maintaining = undefined;
			maintenanceController = undefined;
		}
	};

	const runNow = async (): Promise<InvestmentCollectionStatus | undefined> => {
		if (closed || running || !options.collect || !store) {
			return undefined;
		}

		const collectionStore = store;
		const {collect} = options;
		lastStartedAt = now().toISOString();
		const startedGeneration = generation;
		collectionController = new AbortController();
		const {signal} = collectionController;
		running = (async (): Promise<InvestmentCollectionStatus | undefined> => {
			// Reserve this collection before waiting so another maintenance tick cannot overtake it.
			if (maintaining) {
				await maintaining;
			}

			if (closed || signal.aborted || generation !== startedGeneration) {
				return undefined;
			}

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
			const result = await running;
			lastResult = result ?? null;
			return result;
		} finally {
			lastFinishedAt = now().toISOString();
			running = undefined;
			collectionController = undefined;
		}
	};

	const attemptScheduledCollection = async (attempt: NonNullable<typeof scheduledCollection>): Promise<void> => {
		if (closed || scheduledCollection !== attempt || generation !== attempt.generation) {
			return;
		}

		if (Date.now() > attempt.deadline) {
			scheduledCollection = undefined;
			logger.warn('investment scheduled collection retry window expired');
			return;
		}

		let status: InvestmentCollectionStatus | undefined;
		try {
			status = await runNow();
		} catch {
			if (scheduledCollection === attempt) {
				scheduledCollection = undefined;
				logger.error('investment scheduled collection failed');
			}

			return;
		}

		if (closed || scheduledCollection !== attempt || generation !== attempt.generation) {
			return;
		}

		// Busy profiles and overlapping work are deferred without changing source health.
		// Genuine collection outcomes finish this occurrence, including authentication errors.
		if (status !== 'skipped' && status !== undefined) {
			scheduledCollection = undefined;
			return;
		}

		if (Date.now() + 30_000 > attempt.deadline) {
			scheduledCollection = undefined;
			logger.warn('investment scheduled collection retry window expired');
			return;
		}

		attempt.timer = setTimeout(() => {
			attempt.timer = undefined;
			void attemptScheduledCollection(attempt);
		}, 30_000);
		attempt.timer.unref();
	};

	const runScheduledCollection = async (): Promise<void> => {
		if (closed || scheduledCollection || !options.collect || !store) {
			return;
		}

		const attempt = {generation, deadline: Date.now() + 600_000};
		scheduledCollection = attempt;
		await attemptScheduledCollection(attempt);
	};

	const stop = (): void => {
		generation++;
		void task?.stop();
		void task?.destroy();
		task = undefined;
		clearInterval(sessionTimer);
		sessionTimer = undefined;
		clearTimeout(scheduledCollection?.timer);
		scheduledCollection = undefined;
		maintenanceController?.abort();
		collectionController?.abort();
	};

	const controlStatus = async (): Promise<InvestmentControlStatus> => {
		if (closed || !store) {
			throw new Error('investment control unavailable');
		}

		const socketPath = config.googleMessagesOtpSocket;
		// The provider route verifies its own configured sender and matcher before
		// reporting shared receiver liveness.
		const health = socketPath
			? await (options.otpHealth ?? readGoogleMessagesHealth)(socketPath, isBestInvest ? 'best-invest' : 'clal')
			: {ready: false, reason: 'not_configured' as const};
		const observedAt = now();
		const nextAllowedAt = store.getAutomaticSmsNextAllowedAt(observedAt.toISOString());
		let description: InvestmentControlStatus['schedule']['description'] = null;
		try {
			description = cronstrue.toString(config.schedule).slice(0, 256);
		} catch {
			// Invalid expressions remain visible as a disabled schedule, without inferred dates.
		}

		return {
			schemaVersion: 1, observedAt: observedAt.toISOString(),
			source: store.getFeed(observedAt, config.staleHours).source,
			collection: {running: Boolean(running), lastResult, lastStartedAt, lastFinishedAt},
			schedule: {
				enabled: Boolean(task), expression: config.schedule.slice(0, 256), description,
				timezone: options.timezone.slice(0, 100), nextRunAt: task?.getNextRun()?.toISOString() ?? null,
			},
			automaticOtp: {
				enabled: Boolean(socketPath), ready: health.ready && nextAllowedAt === null,
				reason: socketPath && nextAllowedAt ? 'rate_limited' : health.reason,
				nextAllowedAt: socketPath ? nextAllowedAt : null,
			},
			session: getClalSessionStatus(store.getSessionState(), observedAt, config.sessionKeepAliveMinutes),
		};
	};

	const controlRefresh = (requestedProvider: string): InvestmentRefreshResult => {
		if (closed || !config.enabled || !store || !options.collect) {
			return {error: 'investment_control_unavailable'};
		}

		if (requestedProvider !== store.getFeed(now(), config.staleHours).source.provider) {
			return {error: 'source_identity_mismatch'};
		}

		if (running) {
			return {result: 'already_running', retryAfterSeconds: 0};
		}

		const allowance = store.consumeControlRefreshAttempt(now().toISOString());
		if (!allowance.allowed) {
			return {error: 'refresh_rate_limited', retryAfterSeconds: allowance.retryAfterSeconds};
		}

		// runNow reserves the same in-process lock as cron before returning its promise.
		void runNow().catch(() => logger.error('investment control collection failed'));
		return {result: 'started', retryAfterSeconds: 0};
	};

	router.route(isBestInvest ? '/investments/best-invest/v1/control' : '/investments/v1/control', createInvestmentControlRouter({
		controlToken, readToken, logger, status: controlStatus, refresh: controlRefresh,
	}));

	return {
		store,
		router,
		runNow,
		maintainSessionNow: async () => maintainSession(false),
		start() {
			if (closed || !config.enabled || !store) {
				return;
			}

			stop();
			if (options.collect) {
				if (cronValidate(config.schedule)) {
					const scheduledGeneration = generation;
					task = cronSchedule(config.schedule, async () => {
						if (generation === scheduledGeneration) {
							await runScheduledCollection();
						}
					}, {timezone: options.timezone, name: `${provider}-investments`});
					logger.info('investment scheduler started', {schedule: config.schedule, timezone: options.timezone});
				} else {
					logger.error('investment schedule invalid; bank schedule remains available');
				}
			}

			if (config.sessionKeepAliveMinutes > 0 && options.maintainSession) {
				void maintainSession(true);
				sessionTimer = setInterval(() => {
					void maintainSession(true);
				}, config.sessionKeepAliveMinutes * 60_000);
				sessionTimer.unref();
				logger.info('Clal session maintenance started', {intervalMinutes: config.sessionKeepAliveMinutes});
			}
		},
		stop,
		async close() {
			if (closed) {
				return;
			}

			closed = true;
			stop();
			await Promise.all([running, maintaining]);
			store?.close();
		},
	};
}
