/**
 * Process bootstrap shared by `node dist/index.js`, `bridge serve` and the other
 * CLI commands: runtime env, config, data directories, the SQLite ledger and the
 * 1Password resolver. `serve()` adds the SimpleFIN server, the cron scheduler and
 * graceful shutdown on SIGINT/SIGTERM.
 */

import {mkdirSync} from 'node:fs';
import path from 'node:path';
import cronstrue from 'cronstrue';
import {Hono} from 'hono';
import {loadConfig, readRuntimeEnv} from './config.js';
import {createLogger, setVerbose, type Logger} from './log.js';
import {suppressSqliteWarning} from './quiet-warnings.js';
import {createScheduler, type Scheduler} from './scrape/index.js';
import {createSecretsResolver} from './secrets/onepassword.js';
import {startServer} from './simplefin/server.js';
import {createInvestmentRuntime, type InvestmentCollector, type InvestmentRuntime} from './investments/runtime.js';
import {collectClal} from './investments/reader.js';
import {renewClalSession} from './investments/session.js';
import {createClalRecoveryCollector} from './investments/recovery.js';
import {createBestInvestCollector} from './investments/best-invest/collector.js';
import {createHapoalimInvestmentRuntime, type HapoalimInvestmentRuntime} from './investments/hapoalim/runtime.js';
import type {CompanyId, Config, Ledger, RunRecord, RuntimeEnv, SecretsResolver} from './types.js';

/** Everything a command needs to talk to the ledger and the banks. */
export type BridgeContext = {
	env: RuntimeEnv;
	config: Config;
	ledger: Ledger;
	secrets: SecretsResolver;
	logger: Logger;
	/** Close the ledger handle. Idempotent. */
	close(): void;
};

export type ServeOptions = {
	logger?: Logger;
	investmentCollector?: InvestmentCollector;
	bestInvestCollector?: InvestmentCollector;
	/**
	 * Process exit hook (`code => process.exit(code)` in the entry scripts). When given,
	 * SIGINT/SIGTERM trigger a graceful shutdown followed by exit, and ONE_SHOT mode
	 * exits after its run. Omit in tests: no signal handlers, never exits.
	 */
	exit?: (code: number) => void;
};

export type RunningBridge = {
	context: BridgeContext;
	scheduler: Scheduler;
	investments?: InvestmentRuntime;
	bestInvest?: InvestmentRuntime;
	hapoalimInvestments?: HapoalimInvestmentRuntime;
	/** Bound listen port. */
	port: number;
	/** Stop the scheduler, close the server and the ledger. Idempotent. */
	shutdown(): Promise<void>;
};

/** How long a graceful shutdown may wait for the HTTP listener before giving up. */
const SHUTDOWN_GRACE_MS = 5000;

/** Create every runtime directory the process writes to. */
export function ensureDataDirs(env: RuntimeEnv): void {
	for (const dir of [env.dataDir, env.chromeDir, env.screenshotsDir, path.dirname(env.ledgerPath)]) {
		mkdirSync(dir, {recursive: true});
	}
}

/** Read env + config and open the ledger. Throws before anything is opened when the config is invalid. */
export async function openContext(logger: Logger = createLogger('bridge')): Promise<BridgeContext> {
	const env = readRuntimeEnv();
	setVerbose(env.verbose);
	const config = await loadConfig(env.configPath);
	ensureDataDirs(env);
	suppressSqliteWarning();
	// Loaded here, not at the top: see quiet-warnings.ts.
	const {createSqliteLedger} = await import('./ledger/sqlite.js');
	const ledger = createSqliteLedger(env.ledgerPath);
	const secrets = createSecretsResolver(env, logger.child('secrets'));
	let closed = false;
	return {
		env,
		config,
		ledger,
		secrets,
		logger,
		close() {
			if (closed) {
				return;
			}

			closed = true;
			ledger.close();
		},
	};
}

/** Names of the companies that will be scraped. */
export function enabledCompanies(config: Config): CompanyId[] {
	return (Object.keys(config.companies) as CompanyId[]).filter(company => config.companies[company]?.enabled);
}

/** Human-readable cron description, or the raw expression when cronstrue cannot parse it. */
export function describeSchedule(schedule: string | undefined): string {
	if (!schedule) {
		return 'none (one-shot mode)';
	}

	try {
		return `${cronstrue.toString(schedule)} (${schedule})`;
	} catch {
		return schedule;
	}
}

/** True when the run did real work and failed (skips do not count). */
export function runFailed(run: RunRecord): boolean {
	return FAILED_STATUSES.has(run.status);
}

const FAILED_STATUSES = new Set<RunRecord['status']>(['error', 'timeout', 'login_failed']);

function logStartup(context: BridgeContext, port: number): void {
	const {config, env, logger} = context;
	logger.info('bridge started', {
		companies: enabledCompanies(config),
		schedule: describeSchedule(config.schedule),
		timezone: config.timezone,
		listen: `http://${config.server.host}:${port}`,
		publicUrl: config.server.publicUrl,
		ledger: env.ledgerPath,
		secrets: env.opDisabled ? 'literal (OP_DISABLED)' : '1Password Connect',
	});
}

/** Race the server close against a grace timer so a lingering keep-alive socket cannot block exit. */
async function closeWithGrace(close: () => Promise<void>, logger: Logger): Promise<void> {
	let timer: NodeJS.Timeout | undefined;
	const grace = new Promise<void>(resolve => {
		timer = setTimeout(() => {
			logger.warn('server did not close in time; continuing shutdown');
			resolve();
		}, SHUTDOWN_GRACE_MS);
	});
	try {
		await Promise.race([close(), grace]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Start the SimpleFIN server and the scheduler. With `ONE_SHOT=1` and no schedule the
 * process runs every enabled company once and exits (1 when any run failed).
 */
export async function serve(options: ServeOptions = {}): Promise<RunningBridge> {
	const logger = options.logger ?? createLogger('bridge');
	const context = await openContext(logger);
	const {config, env, ledger, secrets} = context;
	const hapoalimInvestments = config.hapoalimInvestments?.enabled
		? await createHapoalimInvestmentRuntime({config: config.hapoalimInvestments, env, secrets, logger: logger.child('hapoalim-investments')})
		: undefined;
	const scheduler = createScheduler({
		config, env, ledger, secrets, logger: logger.child('scrape'),
		hapoalimInvestments: hapoalimInvestments?.store && config.hapoalimInvestments
			? {config: config.hapoalimInvestments, store: hapoalimInvestments.store}
			: undefined,
	});
	const investments = config.investments?.enabled
		? await createInvestmentRuntime({
			config: config.investments, env, secrets, logger: logger.child('investments'), timezone: config.timezone,
			collect: createClalRecoveryCollector(options.investmentCollector ?? collectClal), maintainSession: renewClalSession,
		})
		: undefined;
	const bestInvest = config.bestInvest?.enabled
		? await createInvestmentRuntime({
			config: config.bestInvest, env, secrets, logger: logger.child('best-invest'), timezone: config.timezone,
			provider: 'hachshara_best_invest', collect: options.bestInvestCollector ?? createBestInvestCollector(),
		})
		: undefined;
	const investmentRouter = new Hono();
	for (const runtime of [investments, bestInvest, hapoalimInvestments]) {
		if (runtime) {
			investmentRouter.route('/', runtime.router);
		}
	}

	const server = await startServer({config, ledger, logger: logger.child('http'), investmentRouter});
	if (config.schedule) {
		scheduler.start();
	}

	investments?.start();
	bestInvest?.start();

	logStartup(context, server.port);

	let shuttingDown: Promise<void> | undefined;
	const shutdown = async (): Promise<void> => {
		shuttingDown ??= (async () => {
			logger.info('shutting down');
			scheduler.stop();
			investments?.stop();
			bestInvest?.stop();
			await closeWithGrace(async () => server.close(), logger);
			await Promise.all([investments?.close(), bestInvest?.close()]);
			hapoalimInvestments?.close();
			context.close();
		})();
		return shuttingDown;
	};

	const running: RunningBridge = {context, scheduler, investments, bestInvest, hapoalimInvestments, port: server.port, shutdown};
	if (options.exit) {
		installSignalHandlers(running, options.exit);
	}

	if (!config.schedule && process.env.ONE_SHOT === '1') {
		const code = await runOneShot(running);
		options.exit?.(code);
	}

	return running;
}

function installSignalHandlers(running: RunningBridge, exit: (code: number) => void): void {
	const {logger} = running.context;
	let received = false;
	const onSignal = (signal: NodeJS.Signals): void => {
		if (received) {
			logger.warn('second signal; exiting immediately', {signal});
			exit(130);
			return;
		}

		received = true;
		logger.info('signal received', {signal});
		running.shutdown().then(() => exit(0)).catch((error: unknown) => {
			logger.error('shutdown failed', {error: (error as Error).message});
			exit(1);
		});
	};

	process.on('SIGINT', onSignal);
	process.on('SIGTERM', onSignal);
}

/** One-shot mode: scrape everything once, shut down, and return 1 when any company failed. */
async function runOneShot(running: RunningBridge): Promise<number> {
	const {logger} = running.context;
	logger.info('ONE_SHOT=1: running every enabled company once');
	let runs: RunRecord[] = [];
	try {
		runs = await running.scheduler.runNow();
	} finally {
		await running.shutdown();
	}

	const failed = runs.filter(run => runFailed(run)).length;
	logger.info('one-shot run finished', {runs: runs.length, failed});
	return failed > 0 ? 1 : 0;
}
