import {afterEach, describe, expect, it, vi} from 'vitest';
import {readRuntimeEnv} from '../config.js';
import type {Logger} from '../log.js';
import {ClalCollectionError, ClalProfileBusyError} from './browser.js';
import {investmentConfigSchema} from './config.js';
import type {ClalLoginOptions} from './login.js';
import type {ClalOtpRequest, ClalOtpSource} from './otp.js';
import {automaticClalLogin, createClalRecoveryCollector} from './recovery.js';
import type {InvestmentCollectionContext, InvestmentCollector} from './runtime.js';
import {createInvestmentStore} from './store.js';
import type {InvestmentStore} from './types.js';

const observedAt = '2026-09-08T06:00:00.000Z';
const stores: InvestmentStore[] = [];
const logger: Logger = {info: vi.fn<Logger['info']>(), warn: vi.fn<Logger['warn']>(), error: vi.fn<Logger['error']>(), debug: vi.fn<Logger['debug']>(), child: () => logger};

function context(automatic = true, signal = new AbortController().signal): InvestmentCollectionContext {
	const store = createInvestmentStore(':memory:');
	stores.push(store);
	store.applySnapshot({observedAt, complete: true, inventoryComplete: true, products: [], valuations: [], activities: [], tracks: []});
	return {
		config: investmentConfigSchema.parse({enabled: true, ...(automatic && {googleMessagesOtpSocket: '/tmp/clal-recovery-fixture.sock'})}),
		env: readRuntimeEnv(), logger, signal, store,
		secrets: {resolve: async reference => reference, resolveAll: async values => values},
	};
}

function driver() {
	const request: ClalOtpRequest = {read: vi.fn(async () => '123456'), cancel: vi.fn(async () => undefined)};
	const source: ClalOtpSource = {prepare: vi.fn(async () => request)};
	const sms = vi.fn();
	// Exercise the login's contract with a fake portal, while the real recovery
	// code controls the persistent allowance, source selection, and retry policy.
	const login = vi.fn(async (options: ClalLoginOptions) => {
		const pending = await options.otpSource!.prepare(options.signal!);
		try {
			await options.beforeSmsRequest?.(options.signal!);
			options.signal!.throwIfAborted();
			sms();
			await pending.read(options.signal!);
			options.onSessionVerified?.(1199);
		} finally {
			await pending.cancel();
		}
	});
	return {request, source, sms, login, otpSource: vi.fn(() => source), now: () => new Date(observedAt)};
}

afterEach(() => {
	for (const store of stores) {
		store.close();
	}

	stores.length = 0;
	vi.clearAllMocks();
});

describe('Clal automatic recovery configuration', () => {
	it('is off by default and requires an absolute Unix socket path', () => {
		expect(investmentConfigSchema.parse({}).googleMessagesOtpSocket).toBeUndefined();
		for (const value of ['', 'relative.sock', 'https://receiver.test', '/bad\0socket', `/${'a'.repeat(107)}`]) {
			expect(investmentConfigSchema.safeParse({googleMessagesOtpSocket: value}).success).toBe(false);
		}
	});

	it('does not prepare a receiver or request SMS when recovery is disabled', async () => {
		const input = context(false);
		const fake = driver();
		const collect = vi.fn<InvestmentCollector>().mockResolvedValue('auth_required');
		expect(await createClalRecoveryCollector(collect, fake)(input)).toBe('auth_required');
		expect(collect).toHaveBeenCalledOnce();
		expect(fake.login).not.toHaveBeenCalled();
		expect(fake.otpSource).not.toHaveBeenCalled();
	});

	it.each(['ok', 'partial', 'error', 'skipped'] as const)('does not recover from collection status %s', async status => {
		const input = context();
		const fake = driver();
		expect(await createClalRecoveryCollector(vi.fn<InvestmentCollector>().mockResolvedValue(status), fake)(input)).toBe(status);
		expect(fake.login).not.toHaveBeenCalled();
	});
});

describe('one automatic login and collection retry', () => {
	it('recovers after actual authentication failure and preserves freshness until collection succeeds', async () => {
		const input = context();
		const before = input.store.getFeed(new Date(observedAt), 192);
		const fake = driver();
		const collect = vi.fn<InvestmentCollector>()
			.mockResolvedValueOnce('auth_required')
			.mockImplementationOnce(async () => {
				expect(fake.sms).toHaveBeenCalledOnce();
				expect(input.store.getFeed(new Date(observedAt), 192)).toEqual(before);
				return 'ok';
			});
		expect(await createClalRecoveryCollector(collect, fake)(input)).toBe('ok');
		expect(collect).toHaveBeenCalledTimes(2);
		expect(fake.login).toHaveBeenCalledOnce();
		expect(fake.request.cancel).toHaveBeenCalledOnce();
		expect(input.store.getSessionState()).toMatchObject({status: 'active', lastCheckedAt: observedAt, errorCode: null});
		expect(fake.login.mock.calls[0]![0].readOtp).toBeUndefined();
	});

	it('does not recursively request another SMS if the retry still needs authentication', async () => {
		const input = context();
		const fake = driver();
		const collect = vi.fn<InvestmentCollector>().mockResolvedValue('auth_required');
		expect(await createClalRecoveryCollector(collect, fake)(input)).toBe('auth_required');
		expect(collect).toHaveBeenCalledTimes(2);
		expect(fake.sms).toHaveBeenCalledOnce();
	});

	it.each(['OTP_REQUIRED', 'TIMEOUT'] as const)('ends this occurrence after %s without retrying or refunding an uncertain request', async code => {
		const input = context();
		const fake = driver();
		vi.mocked(fake.request.read).mockRejectedValue(new ClalCollectionError(code));
		const collect = vi.fn<InvestmentCollector>().mockResolvedValue('auth_required');
		expect(await createClalRecoveryCollector(collect, fake)(input)).toBe('auth_required');
		expect(collect).toHaveBeenCalledOnce();
		expect(fake.sms).toHaveBeenCalledOnce();
		expect(input.store.consumeAutomaticSmsAttempt(observedAt)).toBe(true);
		expect(input.store.consumeAutomaticSmsAttempt(observedAt)).toBe(false);
	});

	it('cannot enter the scheduled busy retry after a post-login collection becomes busy', async () => {
		const input = context();
		const fake = driver();
		const collect = vi.fn<InvestmentCollector>().mockResolvedValueOnce('auth_required').mockResolvedValueOnce('skipped');
		expect(await createClalRecoveryCollector(collect, fake)(input)).toBe('error');
		expect(fake.sms).toHaveBeenCalledOnce();
	});

	it('permits a busy retry only when no automatic SMS attempt was reserved', async () => {
		const input = context();
		const fake = driver();
		fake.login.mockRejectedValue(new ClalProfileBusyError());
		expect(await createClalRecoveryCollector(vi.fn<InvestmentCollector>().mockResolvedValue('auth_required'), fake)(input)).toBe('skipped');
		expect(fake.sms).not.toHaveBeenCalled();
		expect(input.store.consumeAutomaticSmsAttempt(observedAt)).toBe(true);
		expect(input.store.consumeAutomaticSmsAttempt(observedAt)).toBe(true);
	});

	it('does not report skipped if a failure resembling contention arrives after reserving an SMS', async () => {
		const input = context();
		const fake = driver();
		vi.mocked(fake.request.read).mockRejectedValue(new ClalProfileBusyError());
		expect(await createClalRecoveryCollector(vi.fn<InvestmentCollector>().mockResolvedValue('auth_required'), fake)(input)).toBe('auth_required');
		expect(fake.sms).toHaveBeenCalledOnce();
	});
});

describe('automatic SMS budget and receiver readiness', () => {
	it('reserves allowance only after the receiver confirms readiness and before the request', async () => {
		const input = context();
		const fake = driver();
		const consume = vi.spyOn(input.store, 'consumeAutomaticSmsAttempt');
		vi.mocked(fake.source.prepare).mockImplementation(async () => {
			expect(consume).not.toHaveBeenCalled();
			expect(fake.sms).not.toHaveBeenCalled();
			return fake.request;
		});
		fake.sms.mockImplementation(() => expect(consume).toHaveBeenCalledOnce());
		await automaticClalLogin(input, fake);
	});

	it('cannot send or consume allowance when the Unix socket is unavailable', async () => {
		const input = context();
		const fake = driver();
		// Use the real socket client with a nonexistent socket and only fake the portal.
		await expect(automaticClalLogin(input, {login: fake.login, now: fake.now})).rejects.toThrow('OTP_REQUIRED');
		expect(fake.sms).not.toHaveBeenCalled();
		expect(input.store.consumeAutomaticSmsAttempt(observedAt)).toBe(true);
		expect(input.store.consumeAutomaticSmsAttempt(observedAt)).toBe(true);
	});

	it('limits simultaneous automatic flows to two requests and cancels the refused receiver lease', async () => {
		const input = context();
		const fake = driver();
		const outcomes = await Promise.allSettled([
			automaticClalLogin(input, fake), automaticClalLogin(input, fake), automaticClalLogin(input, fake),
		]);
		expect(outcomes.filter(value => value.status === 'fulfilled')).toHaveLength(2);
		expect(outcomes.filter(value => value.status === 'rejected')).toHaveLength(1);
		expect(fake.sms).toHaveBeenCalledTimes(2);
		expect(fake.request.cancel).toHaveBeenCalledTimes(3);
	});

	it('does not log source errors or OTP contents on failure', async () => {
		const input = context();
		const fake = driver();
		vi.mocked(fake.request.read).mockRejectedValue(new Error('synthetic OTP 123456 and private receiver details'));
		await createClalRecoveryCollector(vi.fn<InvestmentCollector>().mockResolvedValue('auth_required'), fake)(input);
		expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain('123456');
		expect(logger.warn).toHaveBeenCalledWith('Clal automatic authentication did not complete', {errorCode: 'COLLECTION_FAILED'});
	});

	it('cancellation before login never prepares the receiver or consumes allowance', async () => {
		const controller = new AbortController();
		controller.abort();
		const input = context(true, controller.signal);
		const fake = driver();
		expect(await createClalRecoveryCollector(vi.fn<InvestmentCollector>().mockResolvedValue('auth_required'), fake)(input)).toBe('error');
		expect(fake.login).not.toHaveBeenCalled();
	});

	it('cancellation after receiver preparation cancels it before budget or SMS', async () => {
		const controller = new AbortController();
		const input = context(true, controller.signal);
		const fake = driver();
		vi.mocked(fake.source.prepare).mockImplementation(async () => {
			controller.abort();
			return fake.request;
		});
		await expect(automaticClalLogin(input, fake)).rejects.toThrow();
		expect(fake.sms).not.toHaveBeenCalled();
		expect(fake.request.cancel).toHaveBeenCalledOnce();
		expect(input.store.consumeAutomaticSmsAttempt(observedAt)).toBe(true);
		expect(input.store.consumeAutomaticSmsAttempt(observedAt)).toBe(true);
	});

	it('cancellation after an SMS prevents a late OTP result from changing health or starting another collection', async () => {
		const controller = new AbortController();
		const input = context(true, controller.signal);
		const original = input.store.getSessionState();
		const fake = driver();
		vi.mocked(fake.request.read).mockImplementation(async () => {
			controller.abort();
			return '123456';
		});
		const collect = vi.fn<InvestmentCollector>().mockResolvedValue('auth_required');
		expect(await createClalRecoveryCollector(collect, fake)(input)).toBe('error');
		expect(collect).toHaveBeenCalledOnce();
		expect(fake.sms).toHaveBeenCalledOnce();
		expect(input.store.getSessionState()).toEqual(original);
		expect(input.store.consumeAutomaticSmsAttempt(observedAt)).toBe(true);
		expect(input.store.consumeAutomaticSmsAttempt(observedAt)).toBe(false);
	});
});
