/**
 * Cron scheduler and per-company orchestration: credential resolution and
 * fingerprinting, parking/backoff/daily-attempt guards, the scrape window,
 * ledger upserts (accounts, transactions, holdings, synthetic payments) and run
 * records. Companies run sequentially; an in-process guard prevents overlap.
 */

import {randomUUID} from 'node:crypto';
import cronstrue from 'cronstrue';
import {schedule as cronSchedule, validate as cronValidate, type ScheduledTask} from 'node-cron';
import type {Logger} from '../log.js';
import {credentialFingerprint} from '../secrets/onepassword.js';
import type {
	CompanyConfig,
	CompanyId,
	Config,
	IsoDate,
	Ledger,
	RunRecord,
	RunStatus,
	RuntimeEnv,
	ScrapeErrorType,
	SecretsResolver,
	Source,
	SourceFetchResult,
	SourceRunContext,
	SourceRunOutcome,
	SourceState,
} from '../types.js';
import {addDays, calendarDate, maxDate} from './dates.js';
import {SCRAPE_ERROR_MESSAGES} from './errors.js';
import {ensureProfileDir} from './profile.js';
import {createScraperSource} from './runner.js';
import {computeSyntheticPayments} from './synthetic.js';

export type SchedulerOptions = {
	config: Config;
	env: RuntimeEnv;
	ledger: Ledger;
	secrets: SecretsResolver;
	logger: Logger;
	/** Override the scraper (tests, dry runs). Used for every company. */
	source?: Source;
	/** Clock override (tests). */
	now?: () => Date;
};

export type RunNowOptions = {
	company?: CompanyId;
	/** Lower bound override for the scrape window (`YYYY-MM-DD`). */
	from?: IsoDate;
	/** Ignore parking and backoff. The per-day login cap still applies (`bridge unpark` resets it). */
	force?: boolean;
};

export type Scheduler = {
	start(): void;
	stop(): void;
	runNow(options?: RunNowOptions): Promise<RunRecord[]>;
	isRunning(): boolean;
};

/** Backoff after transient failures, indexed by consecutiveFailures - 1; beyond the list = wait for the next slot. */
const BACKOFF_HOURS = [1, 3];
/** Errors that park the company until the credentials change or `bridge unpark`. */
const PARKING_ERRORS = new Set<ScrapeErrorType>(['INVALID_PASSWORD', 'CHANGE_PASSWORD', 'ACCOUNT_BLOCKED', 'OTP_REQUIRED', 'TWO_FACTOR_RETRIEVER_MISSING']);
/** Fallback lower bound when neither config.startDate nor a previous success exists. */
const DEFAULT_LOOKBACK_DAYS = 365;

export function defaultSourceState(company: CompanyId): SourceState {
	return {
		company,
		lastRunAt: undefined,
		lastSuccessAt: undefined,
		lastErrorAt: undefined,
		lastErrorType: undefined,
		lastErrorMessage: undefined,
		consecutiveFailures: 0,
		parked: false,
		parkedReason: undefined,
		parkedAt: undefined,
		credentialFingerprint: undefined,
		nextAllowedAt: undefined,
		loginAttemptsDate: undefined,
		loginAttempts: 0,
		earliestScrapedDate: undefined,
	};
}

/** Clear parking, backoff and the daily attempt counter. Returns false when the company has no state yet. */
export function unparkCompany(ledger: Ledger, company: CompanyId): boolean {
	const state = ledger.getSourceState(company);
	if (!state) {
		return false;
	}

	ledger.upsertSourceState({
		...state,
		parked: false,
		parkedReason: undefined,
		parkedAt: undefined,
		nextAllowedAt: undefined,
		consecutiveFailures: 0,
		loginAttempts: 0,
	});
	return true;
}

/** `max(config.startDate, lastSuccessAt - overlapDays, from)`, else `now - DEFAULT_LOOKBACK_DAYS`. */
export function computeWindowStart(input: {
	config: CompanyConfig;
	state: SourceState;
	overlapDays: number;
	from?: IsoDate;
	now: Date;
}): Date {
	const {config, state, overlapDays, from, now} = input;
	const configStart = config.startDate ? new Date(`${config.startDate}T00:00:00.000Z`) : undefined;
	const overlapStart = state.lastSuccessAt ? new Date(new Date(state.lastSuccessAt).getTime() - (overlapDays * 86_400_000)) : undefined;
	const fromStart = from ? new Date(`${from}T00:00:00.000Z`) : undefined;
	return maxDate(configStart, overlapStart, fromStart) ?? new Date(now.getTime() - (DEFAULT_LOOKBACK_DAYS * 86_400_000));
}

function statusForError(errorType: ScrapeErrorType): RunStatus {
	if (PARKING_ERRORS.has(errorType)) {
		return 'login_failed';
	}

	return errorType === 'TIMEOUT' ? 'timeout' : 'error';
}

function minDate(a: IsoDate | undefined, b: IsoDate | undefined): IsoDate | undefined {
	if (!a) {
		return b;
	}

	return b && b < a ? b : a;
}

type Counts = Pick<RunRecord, 'accountsSeen' | 'transactionsSeen' | 'transactionsNew' | 'anomalies'>;
const ZERO_COUNTS: Counts = {accountsSeen: 0, transactionsSeen: 0, transactionsNew: 0, anomalies: 0};

export function createScheduler(options: SchedulerOptions): Scheduler {
	const {config, env, ledger, secrets, logger} = options;
	const now = options.now ?? (() => new Date());
	let running = false;
	let task: ScheduledTask | undefined;

	const record = (company: CompanyId, startedAt: Date, status: RunStatus, error: {errorType?: ScrapeErrorType; message?: string}, counts: Counts = ZERO_COUNTS): RunRecord => {
		const run: RunRecord = {
			id: randomUUID(),
			company,
			startedAt: startedAt.toISOString(),
			finishedAt: now().toISOString(),
			status,
			errorType: error.errorType,
			message: error.message,
			...counts,
		};
		ledger.recordRun(run);
		return run;
	};

	/** Apply guards; returns the skip message when the company must not run now. */
	const guard = (state: SourceState, fingerprint: string, runOptions: RunNowOptions, log: Logger): string | undefined => {
		if (state.parked && state.credentialFingerprint && fingerprint !== state.credentialFingerprint) {
			log.info('credentials changed; unparking');
			state.parked = false;
			state.parkedReason = undefined;
			state.parkedAt = undefined;
			state.nextAllowedAt = undefined;
			state.consecutiveFailures = 0;
		}

		state.credentialFingerprint = fingerprint;
		if (state.parked && !runOptions.force) {
			return `Parked: ${state.parkedReason ?? 'unknown reason'}`;
		}

		const current = now();
		if (state.nextAllowedAt && new Date(state.nextAllowedAt) > current && !runOptions.force) {
			return `Backing off until ${state.nextAllowedAt}`;
		}

		const today = calendarDate(current, config.timezone);
		if (state.loginAttemptsDate !== today) {
			state.loginAttemptsDate = today;
			state.loginAttempts = 0;
		}

		if (state.loginAttempts >= config.maxLoginAttemptsPerDay) {
			return `Login attempt cap reached (${state.loginAttempts}/${config.maxLoginAttemptsPerDay} today)`;
		}

		return undefined;
	};

	/** Persist a successful result and refresh the state. Returns run counts. */
	const applySuccess = (company: CompanyId, companyConfig: CompanyConfig, state: SourceState, result: SourceFetchResult, log: Logger): Counts => {
		for (const account of result.accounts) {
			ledger.upsertAccount(account);
		}

		// Both ledger implementations append the anomalies to their log inside upsertTransactions.
		const summary = ledger.upsertTransactions(result.transactions);
		if (summary.anomalies.length > 0) {
			log.warn('frozen fields came back different; anomalies recorded, stored values kept', {anomalies: summary.anomalies.length});
		}

		ledger.upsertHoldings(result.holdings);
		const today = calendarDate(now(), config.timezone);
		let synthetic = 0;
		for (const account of result.accounts) {
			const stored = ledger.getAccount(account.id) ?? account;
			const rows = computeSyntheticPayments(ledger, stored, companyConfig, today, log);
			if (rows.length > 0) {
				ledger.upsertTransactions(rows);
				synthetic += rows.length;
			}
		}

		let earliest = state.earliestScrapedDate;
		for (const row of result.transactions) {
			earliest = minDate(earliest, row.bookedDate);
		}

		state.lastSuccessAt = now().toISOString();
		state.consecutiveFailures = 0;
		state.nextAllowedAt = undefined;
		state.lastErrorType = undefined;
		state.lastErrorMessage = undefined;
		state.earliestScrapedDate = earliest;
		log.info('run succeeded', {
			accounts: result.accounts.length,
			transactions: result.transactions.length,
			inserted: summary.inserted,
			updated: summary.updated,
			anomalies: summary.anomalies.length,
			synthetic,
		});
		return {accountsSeen: result.accounts.length, transactionsSeen: result.transactions.length, transactionsNew: summary.inserted, anomalies: summary.anomalies.length};
	};

	/** Record the failure on the state: park, or schedule a backoff. */
	const applyFailure = (company: CompanyId, state: SourceState, errorType: ScrapeErrorType, message: string, log: Logger): void => {
		const current = now();
		state.lastErrorAt = current.toISOString();
		state.lastErrorType = errorType;
		state.lastErrorMessage = message;
		state.consecutiveFailures++;
		if (PARKING_ERRORS.has(errorType)) {
			state.parked = true;
			state.parkedAt = current.toISOString();
			state.parkedReason = errorType === 'OTP_REQUIRED'
				? `${message}: run "bridge login ${company}", then "bridge unpark ${company}"`
				: message;
			state.nextAllowedAt = undefined;
			log.warn('company parked', {errorType, reason: state.parkedReason});
			return;
		}

		const hours = BACKOFF_HOURS[state.consecutiveFailures - 1];
		state.nextAllowedAt = hours === undefined ? undefined : new Date(current.getTime() + (hours * 3_600_000)).toISOString();
		log.warn('run failed', {errorType, consecutiveFailures: state.consecutiveFailures, nextAllowedAt: state.nextAllowedAt ?? 'next slot'});
	};

	const runOne = async (company: CompanyId, companyConfig: CompanyConfig, runOptions: RunNowOptions): Promise<RunRecord> => {
		const log = logger.child(company);
		const startedAt = now();
		const state = ledger.getSourceState(company) ?? defaultSourceState(company);

		let credentials: Record<string, string>;
		try {
			credentials = await secrets.resolveAll(companyConfig.credentials);
		} catch (error) {
			log.error('credential resolution failed', {error: (error as Error).message});
			applyFailure(company, state, 'BRIDGE_ERROR', 'Credential resolution failed', log);
			state.lastRunAt = startedAt.toISOString();
			ledger.upsertSourceState(state);
			return record(company, startedAt, 'error', {errorType: 'BRIDGE_ERROR', message: 'Credential resolution failed'});
		}

		const skip = guard(state, credentialFingerprint(credentials), runOptions, log);
		if (skip) {
			ledger.upsertSourceState(state);
			log.info('run skipped', {reason: skip});
			return record(company, startedAt, 'skipped', {message: skip});
		}

		state.loginAttempts++;
		state.lastRunAt = startedAt.toISOString();
		ledger.upsertSourceState(state);

		const context: SourceRunContext = {
			company,
			config: companyConfig,
			credentials,
			startDate: computeWindowStart({config: companyConfig, state, overlapDays: config.overlapDays, from: runOptions.from, now: startedAt}),
			env,
			timezone: config.timezone,
			defaultCurrency: config.currency,
			profileDir: ensureProfileDir(env, company),
		};
		const source = options.source ?? createScraperSource(company, logger);
		let outcome: SourceRunOutcome;
		try {
			outcome = await source.run(context);
		} catch (error) {
			log.error('source threw', {error: (error as Error).message});
			outcome = {ok: false, errorType: 'BRIDGE_ERROR', message: SCRAPE_ERROR_MESSAGES.BRIDGE_ERROR};
		}

		if (outcome.ok) {
			const counts = applySuccess(company, companyConfig, state, outcome.result, log);
			ledger.upsertSourceState(state);
			return record(company, startedAt, 'success', {}, counts);
		}

		applyFailure(company, state, outcome.errorType, outcome.message, log);
		ledger.upsertSourceState(state);
		return record(company, startedAt, statusForError(outcome.errorType), {errorType: outcome.errorType, message: outcome.message});
	};

	const runNow = async (runOptions: RunNowOptions = {}): Promise<RunRecord[]> => {
		if (running) {
			logger.warn('scrape run already in progress; skipping this trigger');
			return [];
		}

		running = true;
		const records: RunRecord[] = [];
		try {
			const companies = Object.entries(config.companies) as Array<[CompanyId, CompanyConfig]>;
			for (const [company, companyConfig] of companies) {
				if (!companyConfig.enabled || (runOptions.company && runOptions.company !== company)) {
					continue;
				}

				// Sequential by design: one Chrome at a time.
				// eslint-disable-next-line no-await-in-loop
				records.push(await runOne(company, companyConfig, runOptions));
			}
		} finally {
			running = false;
		}

		return records;
	};

	return {
		start() {
			if (!config.schedule) {
				logger.warn('no schedule configured; scheduler idle (use "bridge scrape" for one-shot runs)');
				return;
			}

			if (!cronValidate(config.schedule)) {
				throw new Error(`Invalid cron schedule: ${config.schedule}`);
			}

			void task?.stop();
			task = cronSchedule(config.schedule, async () => {
				try {
					await runNow();
				} catch (error) {
					logger.error('scheduled run failed', {error: (error as Error).message});
				}
			}, {timezone: config.timezone, name: 'scrape'});
			logger.info('scheduler started', {schedule: config.schedule, description: cronstrue.toString(config.schedule), timezone: config.timezone});
		},
		stop() {
			if (!task) {
				return;
			}

			void task.stop();
			void task.destroy();
			task = undefined;
		},
		runNow,
		isRunning: () => running,
	};
}
