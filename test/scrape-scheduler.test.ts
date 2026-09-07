import {beforeEach, describe, expect, it, vi} from 'vitest';
import {createMemoryLedger} from '../src/ledger/memory.js';
import {computeWindowStart, createScheduler, defaultSourceState, unparkCompany} from '../src/scrape/scheduler.js';
import type {
	CompanyId,
	Config,
	Ledger,
	ScrapeErrorType,
	SecretsResolver,
	Source,
	SourceRunContext,
	SourceRunOutcome,
} from '../src/types.js';
import {
	account,
	bridgeConfig,
	companyConfig,
	createCapturingLogger,
	createGate,
	createTemporaryEnv,
	fetchResult,
	transaction,
} from './mocks/fixtures.js';

vi.mock('../src/ids.js', () => ({
	syntheticPaymentId: (company: string, accountNumber: string, chargeDate: string) => `${company}:${accountNumber}:payment:${chargeDate}`,
}));

const T0 = new Date('2026-09-05T06:00:00.000Z');
const HOUR = 3_600_000;

type FakeSource = Source & {
	outcomes: SourceRunOutcome[];
	contexts: SourceRunContext[];
	/** When set, run() waits for this promise (overlap tests). */
	gate?: Promise<void>;
};

function fakeSource(...outcomes: SourceRunOutcome[]): FakeSource {
	return fakeSourceFor('hapoalim', ...outcomes);
}

function fakeSourceFor(company: CompanyId, ...outcomes: SourceRunOutcome[]): FakeSource {
	const source: FakeSource = {
		company,
		outcomes,
		contexts: [],
		async run(context) {
			source.contexts.push(context);
			await source.gate;
			return source.outcomes.length > 1 ? source.outcomes.shift()! : source.outcomes[0] ?? {ok: true, result: fetchResult()};
		},
	};
	return source;
}

function literalSecrets(overrides: Record<string, string> = {}): SecretsResolver {
	const resolve = async (reference: string) => overrides[reference] ?? reference;
	return {
		resolve,
		async resolveAll(values) {
			const out: Record<string, string> = {};
			for (const [key, value] of Object.entries(values)) {
				// eslint-disable-next-line no-await-in-loop
				out[key] = await resolve(value);
			}

			return out;
		},
	};
}

type Harness = {
	ledger: Ledger;
	config: Config;
	source: FakeSource;
	clock: {now: Date};
	secrets: SecretsResolver;
	logger: ReturnType<typeof createCapturingLogger>;
	scheduler: ReturnType<typeof createScheduler>;
};

function harness(options: {config?: Partial<Config>; source?: FakeSource; secrets?: SecretsResolver} = {}): Harness {
	const ledger = createMemoryLedger();
	const config = bridgeConfig({
		companies: {hapoalim: companyConfig({startDate: '2026-01-01'})},
		...options.config,
	});
	const source = options.source ?? fakeSource();
	const clock = {now: new Date(T0)};
	const secrets = options.secrets ?? literalSecrets();
	const logger = createCapturingLogger();
	const scheduler = createScheduler({config, env: createTemporaryEnv(), ledger, secrets, logger, source, now: () => new Date(clock.now)});
	return {ledger, config, source, clock, secrets, logger, scheduler};
}

const failure = (errorType: ScrapeErrorType, message = 'fixed message'): SourceRunOutcome => ({ok: false, errorType, message});

describe('computeWindowStart', () => {
	const config = companyConfig({startDate: '2026-01-01'});

	it('uses config.startDate when there is no previous success', () => {
		const start = computeWindowStart({config, state: defaultSourceState('hapoalim'), overlapDays: 30, now: T0});
		expect(start.toISOString()).toBe('2026-01-01T00:00:00.000Z');
	});

	it('uses lastSuccessAt - overlapDays when that is later', () => {
		const state = {...defaultSourceState('hapoalim'), lastSuccessAt: '2026-08-31T06:00:00.000Z'};
		const start = computeWindowStart({config, state, overlapDays: 30, now: T0});
		expect(start.toISOString()).toBe('2026-08-01T06:00:00.000Z');
	});

	it('honours an explicit from when it is the latest bound', () => {
		const state = {...defaultSourceState('hapoalim'), lastSuccessAt: '2026-08-31T06:00:00.000Z'};
		expect(computeWindowStart({config, state, overlapDays: 30, from: '2026-08-20', now: T0}).toISOString()).toBe('2026-08-20T00:00:00.000Z');
		expect(computeWindowStart({config, state, overlapDays: 30, from: '2026-07-01', now: T0}).toISOString()).toBe('2026-08-01T06:00:00.000Z');
	});

	it('falls back to a year of lookback with no bounds at all', () => {
		const start = computeWindowStart({config: companyConfig(), state: defaultSourceState('hapoalim'), overlapDays: 30, now: T0});
		expect(start.getTime()).toBe(T0.getTime() - (365 * 24 * HOUR));
	});
});

describe('createScheduler.runNow', () => {
	let h: Harness;

	beforeEach(() => {
		h = harness();
	});

	it('runs enabled companies, persists rows and records the run', async () => {
		const records = await h.scheduler.runNow();

		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({company: 'hapoalim', status: 'success', accountsSeen: 1, transactionsSeen: 1, transactionsNew: 1, anomalies: 0, errorType: undefined});
		expect(h.ledger.listAccounts()).toHaveLength(1);
		expect(h.ledger.listTransactions({includePending: true, includeSynthetic: true})).toHaveLength(1);
		expect(h.ledger.listRuns()).toHaveLength(1);

		const state = h.ledger.getSourceState('hapoalim')!;
		expect(state.lastSuccessAt).toBe(T0.toISOString());
		expect(state.lastRunAt).toBe(T0.toISOString());
		expect(state.consecutiveFailures).toBe(0);
		expect(state.loginAttempts).toBe(1);
		expect(state.loginAttemptsDate).toBe('2026-09-05');
		expect(state.earliestScrapedDate).toBe('2026-08-20');
		expect(state.credentialFingerprint).toMatch(/^[0-9a-f]{64}$/);

		const context = h.source.contexts[0]!;
		expect(context.startDate.toISOString()).toBe('2026-01-01T00:00:00.000Z');
		expect(context.credentials).toEqual({userCode: 'user-1', password: 'pass-1234'});
		expect(context.profileDir.endsWith('/chrome/hapoalim')).toBe(true);
		expect(context.timezone).toBe('Asia/Jerusalem');
	});

	it('skips disabled companies and honours the company filter', async () => {
		h = harness({config: {companies: {hapoalim: companyConfig(), visaCal: companyConfig({enabled: false, kind: 'credit_card'})}}});
		const records = await h.scheduler.runNow();
		expect(records.map(run => run.company)).toEqual(['hapoalim']);
		expect(await h.scheduler.runNow({company: 'visaCal'})).toEqual([]);
	});

	it('computes the window from the last success and the overlap', async () => {
		await h.scheduler.runNow();
		h.clock.now = new Date(T0.getTime() + (24 * HOUR));
		await h.scheduler.runNow();
		const second = h.source.contexts[1]!;
		expect(second.startDate.toISOString()).toBe(new Date(T0.getTime() - (30 * 24 * HOUR)).toISOString());

		h.clock.now = new Date(T0.getTime() + (48 * HOUR));
		await h.scheduler.runNow({from: '2026-09-01'});
		expect(h.source.contexts[2]!.startDate.toISOString()).toBe('2026-09-01T00:00:00.000Z');
	});

	it('parks on INVALID_PASSWORD until the credential fingerprint changes', async () => {
		const secrets = {current: {userCode: 'user-1', password: 'pass-1234'}};
		h = harness({
			source: fakeSource(failure('INVALID_PASSWORD', 'Bank rejected the credentials'), {ok: true, result: fetchResult()}),
			secrets: {
				resolve: async reference => reference,
				resolveAll: async () => ({...secrets.current}),
			},
			config: {maxLoginAttemptsPerDay: 10},
		});

		const [first] = await h.scheduler.runNow();
		expect(first).toMatchObject({status: 'login_failed', errorType: 'INVALID_PASSWORD', message: 'Bank rejected the credentials'});
		let state = h.ledger.getSourceState('hapoalim')!;
		expect(state.parked).toBe(true);
		expect(state.parkedReason).toBe('Bank rejected the credentials');
		expect(state.parkedAt).toBe(T0.toISOString());
		expect(state.lastErrorType).toBe('INVALID_PASSWORD');

		const [skipped] = await h.scheduler.runNow();
		expect(skipped).toMatchObject({status: 'skipped'});
		expect(skipped!.message).toContain('Parked');
		expect(h.source.contexts).toHaveLength(1);

		secrets.current = {userCode: 'user-1', password: 'new-pass-5678'};
		const [after] = await h.scheduler.runNow();
		expect(after).toMatchObject({status: 'success'});
		state = h.ledger.getSourceState('hapoalim')!;
		expect(state.parked).toBe(false);
		expect(state.parkedReason).toBeUndefined();
		expect(h.logger.lines.some(line => line.message === 'credentials changed; unparking')).toBe(true);
	});

	it('force ignores parking and backoff', async () => {
		h = harness({source: fakeSource(failure('ACCOUNT_BLOCKED'), {ok: true, result: fetchResult()}), config: {maxLoginAttemptsPerDay: 10}});
		await h.scheduler.runNow();
		expect(h.ledger.getSourceState('hapoalim')!.parked).toBe(true);
		const [forced] = await h.scheduler.runNow({force: true});
		expect(forced).toMatchObject({status: 'success'});
	});

	it('parks OTP_REQUIRED with a hint to run bridge login', async () => {
		h = harness({source: fakeSource(failure('OTP_REQUIRED', 'Bank asked for a one-time code'))});
		const [run] = await h.scheduler.runNow();
		expect(run).toMatchObject({status: 'login_failed', errorType: 'OTP_REQUIRED'});
		const state = h.ledger.getSourceState('hapoalim')!;
		expect(state.parked).toBe(true);
		expect(state.parkedReason).toContain('bridge login hapoalim');
	});

	it('backs off 1h, then 3h, then waits for the next slot after transient failures', async () => {
		h = harness({source: fakeSource(failure('GENERIC')), config: {maxLoginAttemptsPerDay: 10}});

		const [first] = await h.scheduler.runNow();
		expect(first).toMatchObject({status: 'error', errorType: 'GENERIC'});
		let state = h.ledger.getSourceState('hapoalim')!;
		expect(state.consecutiveFailures).toBe(1);
		expect(state.nextAllowedAt).toBe(new Date(T0.getTime() + HOUR).toISOString());

		const [tooSoon] = await h.scheduler.runNow();
		expect(tooSoon).toMatchObject({status: 'skipped'});
		expect(tooSoon!.message).toContain('Backing off');

		h.clock.now = new Date(T0.getTime() + HOUR + 1);
		await h.scheduler.runNow();
		state = h.ledger.getSourceState('hapoalim')!;
		expect(state.consecutiveFailures).toBe(2);
		expect(state.nextAllowedAt).toBe(new Date(h.clock.now.getTime() + (3 * HOUR)).toISOString());

		h.clock.now = new Date(h.clock.now.getTime() + (3 * HOUR) + 1);
		const [third] = await h.scheduler.runNow();
		expect(third).toMatchObject({status: 'error'});
		state = h.ledger.getSourceState('hapoalim')!;
		expect(state.consecutiveFailures).toBe(3);
		expect(state.nextAllowedAt).toBeUndefined();
		expect(state.parked).toBe(false);

		// A TIMEOUT is recorded with its own status.
		h.source.outcomes = [failure('TIMEOUT')];
		const [timeout] = await h.scheduler.runNow();
		expect(timeout).toMatchObject({status: 'timeout', errorType: 'TIMEOUT'});
	});

	it('caps login attempts per bridge-timezone calendar day', async () => {
		await h.scheduler.runNow();
		h.clock.now = new Date(T0.getTime() + HOUR);
		await h.scheduler.runNow();
		h.clock.now = new Date(T0.getTime() + (2 * HOUR));
		const [capped] = await h.scheduler.runNow();
		expect(capped).toMatchObject({status: 'skipped'});
		expect(capped!.message).toContain('Login attempt cap');
		expect(h.source.contexts).toHaveLength(2);

		// 2026-09-05 21:30Z is already 2026-09-06 in Asia/Jerusalem (UTC+3).
		h.clock.now = new Date('2026-09-05T21:30:00.000Z');
		const [nextDay] = await h.scheduler.runNow();
		expect(nextDay).toMatchObject({status: 'success'});
		expect(h.ledger.getSourceState('hapoalim')).toMatchObject({loginAttemptsDate: '2026-09-06', loginAttempts: 1});

		// The cap holds even with --force; unpark resets it.
		await h.scheduler.runNow();
		const [forced] = await h.scheduler.runNow({force: true});
		expect(forced).toMatchObject({status: 'skipped'});
		expect(unparkCompany(h.ledger, 'hapoalim')).toBe(true);
		const [afterUnpark] = await h.scheduler.runNow();
		expect(afterUnpark).toMatchObject({status: 'success'});
	});

	it('refuses overlapping runs', async () => {
		const gate = createGate();
		h.source.gate = gate.promise;

		const first = h.scheduler.runNow();
		await vi.waitFor(() => {
			expect(h.source.contexts).toHaveLength(1);
		});
		expect(h.scheduler.isRunning()).toBe(true);
		expect(await h.scheduler.runNow()).toEqual([]);
		expect(h.logger.lines.some(line => line.level === 'warn' && line.message.includes('already in progress'))).toBe(true);

		gate.open();
		expect(await first).toHaveLength(1);
		expect(h.scheduler.isRunning()).toBe(false);
	});

	it('records anomalies when frozen fields change', async () => {
		h = harness({
			source: fakeSource(
				{ok: true, result: fetchResult()},
				{ok: true, result: fetchResult({transactions: [transaction({amount: -51})]})},
			),
			config: {maxLoginAttemptsPerDay: 10},
		});
		await h.scheduler.runNow();
		const [second] = await h.scheduler.runNow();

		expect(second).toMatchObject({status: 'success', transactionsNew: 0, anomalies: 1});
		expect(h.ledger.listAnomalies().some(anomaly => anomaly.field === 'amount' && anomaly.incoming === '-51.00')).toBe(true);
		expect(h.ledger.getTransaction(transaction().id)!.amount).toBe(-50);
	});

	it('records an error run when credentials cannot be resolved', async () => {
		h = harness({secrets: {
			async resolve() {
				throw new Error('1Password vault "x" not found');
			},
			async resolveAll() {
				throw new Error('1Password vault "x" not found');
			},
		}});
		const [run] = await h.scheduler.runNow();
		expect(run).toMatchObject({status: 'error', errorType: 'BRIDGE_ERROR', message: 'Credential resolution failed'});
		expect(h.source.contexts).toHaveLength(0);
		expect(h.ledger.getSourceState('hapoalim')).toMatchObject({consecutiveFailures: 1, lastErrorType: 'BRIDGE_ERROR'});
	});

	it('records BRIDGE_ERROR when the source throws', async () => {
		h.source.run = async () => {
			throw new Error('kaboom');
		};

		const [run] = await h.scheduler.runNow();
		expect(run).toMatchObject({status: 'error', errorType: 'BRIDGE_ERROR'});
	});

	it('emits synthetic card payments only when enabled for a credit card', async () => {
		const cardAccount = account({id: 'visaCal:1234', company: 'visaCal', accountNumber: '1234', kind: 'credit_card', balance: -300});
		const rows = [
			transaction({id: 'visaCal:1234:a:1', accountId: 'visaCal:1234', company: 'visaCal', bookedDate: '2026-05-20', chargeDate: '2026-06-10', amount: -100, description: 'A'}),
			transaction({id: 'visaCal:1234:b:1', accountId: 'visaCal:1234', company: 'visaCal', bookedDate: '2026-06-20', chargeDate: '2026-07-10', amount: -120.5, description: 'B'}),
			transaction({id: 'visaCal:1234:c:1', accountId: 'visaCal:1234', company: 'visaCal', bookedDate: '2026-06-25', chargeDate: '2026-07-10', amount: -79.5, description: 'C'}),
			transaction({id: 'visaCal:1234:d:1', accountId: 'visaCal:1234', company: 'visaCal', bookedDate: '2026-09-01', chargeDate: '2026-09-10', amount: -10, description: 'D'}),
		];
		const result = fetchResult({accounts: [cardAccount], transactions: rows});
		const enabled = harness({
			source: fakeSourceFor('visaCal', {ok: true, result}),
			config: {companies: {visaCal: companyConfig({label: 'Visa Cal', kind: 'credit_card', synthesizePayments: true})}},
		});
		const [run] = await enabled.scheduler.runNow();
		expect(run).toMatchObject({status: 'success', transactionsSeen: 4});

		const synthetic = enabled.ledger.listTransactions({includePending: false, includeSynthetic: true}).filter(row => row.synthetic);
		// 2026-06-10 is within 35 days of the earliest booked row (2026-05-20): partial-cycle guard.
		// 2026-09-10 is in the future. Only 2026-07-10 qualifies.
		expect(synthetic.map(row => [row.id, row.amount, row.bookedDate, row.description])).toEqual([
			['visaCal:1234:payment:2026-07-10', 200, '2026-07-10', 'Card payment Visa Cal 2026-07-10'],
		]);
		expect(enabled.ledger.listSyntheticPayments('visaCal:1234')).toHaveLength(1);

		const disabled = harness({
			source: fakeSourceFor('visaCal', {ok: true, result}),
			config: {companies: {visaCal: companyConfig({label: 'Visa Cal', kind: 'credit_card', synthesizePayments: false})}},
		});
		await disabled.scheduler.runNow();
		expect(disabled.ledger.listTransactions({includePending: false, includeSynthetic: true}).some(row => row.synthetic)).toBe(false);
	});
});

describe('createScheduler.start/stop', () => {
	it('rejects an invalid cron expression and schedules a valid one', () => {
		const bad = harness({config: {schedule: 'not a cron'}});
		expect(() => {
			bad.scheduler.start();
		}).toThrow(/Invalid cron schedule/);

		const good = harness({config: {schedule: '0 6,18 * * *'}});
		good.scheduler.start();
		expect(good.logger.lines.some(line => line.message === 'scheduler started' && line.extra?.schedule === '0 6,18 * * *')).toBe(true);
		good.scheduler.stop();
		good.scheduler.stop(); // Idempotent.
	});

	it('stays idle without a schedule', () => {
		const h = harness();
		h.scheduler.start();
		expect(h.logger.lines.some(line => line.level === 'warn' && line.message.includes('no schedule'))).toBe(true);
	});
});

describe('unparkCompany', () => {
	it('returns false for unknown companies and clears parking otherwise', () => {
		const ledger = createMemoryLedger();
		expect(unparkCompany(ledger, 'max')).toBe(false);
		ledger.upsertSourceState({...defaultSourceState('max'), parked: true, parkedReason: 'x', parkedAt: 'y', nextAllowedAt: 'z', consecutiveFailures: 4, loginAttempts: 2});
		expect(unparkCompany(ledger, 'max')).toBe(true);
		expect(ledger.getSourceState('max')).toMatchObject({parked: false, parkedReason: undefined, parkedAt: undefined, nextAllowedAt: undefined, consecutiveFailures: 0, loginAttempts: 0});
	});
});
