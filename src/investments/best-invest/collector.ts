// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- Requests execute inside the owned portal origin.
/// <reference lib="dom" />
// eslint-disable-next-line import-x/no-extraneous-dependencies, n/no-extraneous-import
import type {Page} from 'puppeteer';
import {redact} from '../../log.js';
import {investmentErrorCodeSchema} from '../schema.js';
import {createGoogleMessagesOtpSource} from '../otp.js';
import type {InvestmentCollectionContext, InvestmentCollector} from '../runtime.js';
import type {InvestmentSnapshot} from '../types.js';
import {BEST_INVEST_LOGIN_URL, BEST_INVEST_ORIGIN, BestInvestCollectionError, BestInvestProfileBusyError, withBestInvestBrowser} from './browser.js';
import {buildBestInvestSnapshot, parseBestInvestJson} from './parser.js';

const endpoints = {
	policies: '/Services/api/BestInvestPoliciesQuery/GetCustomerBestInvestPolicies',
	details: '/Services/api/BestInvestPoliciesQuery/GetPolicyFullDetailsById',
	deposits: '/Services/api/BestInvestPoliciesQuery/GetDepositsByYear',
} as const;
const otpEndpoint = 'https://authservice.go-ins.co.il/Hcsra.Infrastructure.AuthorizationServer/api/Authentication/GenerateOneTimePassword';

export type BestInvestOtpRequest = {read(signal: AbortSignal): Promise<string>; cancel(): Promise<void>};
export type BestInvestOtpSource = {prepare(signal: AbortSignal): Promise<BestInvestOtpRequest>};
export type BestInvestCollectorOptions = {
	readOtp?(signal: AbortSignal): Promise<string>;
	otpSource?: BestInvestOtpSource;
	delivery?: 'SMS' | 'Email';
	/** Reserve a persistent automatic request budget after receiver readiness, before the sole send click. */
	beforeOtpRequest?(signal: AbortSignal): Promise<void>;
};

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new BestInvestCollectionError('INVALID_RESPONSE');
	}

	return value as Record<string, unknown>;
}

function identifier(value: unknown): string {
	if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
		return String(value);
	}

	if (typeof value !== 'string' || !/^\d{1,30}$/.test(value)) {
		throw new BestInvestCollectionError('INVALID_RESPONSE');
	}

	return value;
}

/** Fixed read endpoints only. Bearer tokens and customer identity remain inside the browser. */
export async function requestBestInvest(page: Page, endpoint: keyof typeof endpoints, parameters: Record<string, string | number> = {}): Promise<unknown> {
	if (new URL(page.url()).origin !== BEST_INVEST_ORIGIN) {
		throw new BestInvestCollectionError('INVALID_RESPONSE');
	}

	const result = await page.evaluate(async ({origin, pathname, values}) => {
		if (globalThis.location.origin !== origin) {
			return {errorCode: 'INVALID_RESPONSE' as const};
		}

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 30_000);
		try {
			const user = JSON.parse(sessionStorage.getItem('currentUser') ?? 'null') as {token?: unknown; username?: unknown; expireAt?: unknown} | undefined;
			if (!user || typeof user.token !== 'string' || typeof user.username !== 'string'
				|| !/^\d{9}$/.test(user.username) || typeof user.expireAt !== 'string'
				|| !Number.isFinite(Date.parse(user.expireAt)) || Date.parse(user.expireAt) <= Date.now()) {
				return {errorCode: 'OTP_REQUIRED' as const};
			}

			const url = new URL(pathname, origin).href;
			const response = await fetch(url, {
				method: 'POST', headers: {'Content-Type': 'application/json', Authorization: `Bearer ${user.token}`},
				body: JSON.stringify({...values, CustomerID: user.username}),
				// eslint-disable-next-line unicorn/no-unnecessary-fetch-options -- Explicit scope for an authenticated request.
				credentials: 'same-origin', redirect: 'error', signal: controller.signal,
			});
			if (response.status === 401 || response.status === 403) {
				return {errorCode: 'OTP_REQUIRED' as const};
			}

			if (response.status !== 200 || response.url !== url || response.redirected
				|| !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')
				|| Number(response.headers.get('content-length') ?? 0) > 16_777_216) {
				return {errorCode: 'INVALID_RESPONSE' as const};
			}

			const reader = response.body?.getReader();
			if (!reader) {
				return {errorCode: 'INVALID_RESPONSE' as const};
			}

			const decoder = new TextDecoder('utf-8', {fatal: true});
			let bytes = 0;
			let text = '';
			for (;;) {
				// eslint-disable-next-line no-await-in-loop -- Bound a streaming response before accepting its financial data.
				const chunk = await reader.read();
				if (chunk.done) {
					break;
				}

				bytes += chunk.value.byteLength;
				if (bytes > 16_777_216) {
					controller.abort();
					return {errorCode: 'INVALID_RESPONSE' as const};
				}

				text += decoder.decode(chunk.value, {stream: true});
			}

			text += decoder.decode();
			return {text};
		} catch {
			return {errorCode: controller.signal.aborted ? 'TIMEOUT' as const : 'INVALID_RESPONSE' as const};
		} finally {
			clearTimeout(timer);
		}
	}, {origin: BEST_INVEST_ORIGIN, pathname: endpoints[endpoint], values: parameters});
	if (result.errorCode || typeof result.text !== 'string') {
		throw new BestInvestCollectionError(result.errorCode ?? 'INVALID_RESPONSE');
	}

	try {
		return parseBestInvestJson(result.text);
	} catch {
		throw new BestInvestCollectionError('INVALID_RESPONSE');
	}
}

/** Native customer OTP only; account registration and financial actions are never submitted. */
export async function loginBestInvest(page: Page, context: InvestmentCollectionContext, options: BestInvestCollectorOptions, signal: AbortSignal): Promise<void> {
	if (!options.otpSource && !options.readOtp) {
		throw new BestInvestCollectionError('OTP_REQUIRED');
	}

	let credentials: Record<string, string>;
	try {
		credentials = await context.secrets.resolveAll(context.config.credentials);
	} catch {
		throw new BestInvestCollectionError('CREDENTIAL_RESOLUTION_FAILED');
	}

	const delivery = options.delivery ?? 'SMS';
	const {id} = credentials;
	const destination = delivery === 'Email' ? credentials.email : credentials.phone;
	if (!id || !/^\d{9}$/.test(id) || !destination
		|| (delivery === 'SMS' ? !/^0\d{8,9}$/.test(destination) : !/^[^\s@]+@[^\s@][^\s.@]*\.[^\s@]+$/.test(destination))) {
		throw new BestInvestCollectionError('INVALID_CREDENTIALS');
	}

	redact(id);
	redact(destination);
	await page.goto(BEST_INVEST_LOGIN_URL, {waitUntil: 'domcontentloaded'});
	await page.waitForSelector('app-identity-login-user #userIdNumber', {visible: true});
	if (await page.$('app-identity-login-user input[type="checkbox"]')) {
		throw new BestInvestCollectionError('OTP_REQUIRED');
	}

	await page.locator(`app-identity-login-user .action-${delivery === 'Email' ? 'email' : 'sms'}`).click();
	await page.locator('#userIdNumber').fill(id);
	await page.locator('#phoneOrEmail').fill(destination);
	let request: BestInvestOtpRequest | undefined;
	try {
		request = await options.otpSource?.prepare(signal);
		signal.throwIfAborted();
		await options.beforeOtpRequest?.(signal);
		signal.throwIfAborted();
		// Observe the actual OTP endpoint. A form transition alone does not prove a successful request.
		const responsePromise = page.waitForResponse(response => response.url() === otpEndpoint
			&& response.request().method() === 'POST', {timeout: 45_000});
		// Attach a rejection handler before clicking so cancellation cannot produce an unhandled rejection.
		void responsePromise.catch(() => undefined);
		await page.locator('app-identity-login-user button[type="submit"]').click();
		const response = await responsePromise;
		if (response.status() !== 200) {
			throw new BestInvestCollectionError('OTP_REQUIRED');
		}

		const sent = object(parseBestInvestJson(await response.text()));
		// The current authorization server returns only Message. The frontend's
		// IsSuccess flag is synthesized locally and is absent from the wire response.
		if (Object.keys(sent).length !== 1 || typeof sent.Message !== 'string' || !sent.Message.trim() || sent.Message.length > 4096) {
			throw new BestInvestCollectionError('OTP_REQUIRED');
		}

		await page.waitForSelector('#userAuthCode', {visible: true});
		let code = await (request ? request.read(signal) : options.readOtp!(signal));
		if (!/^\d{6}$/.test(code)) {
			throw new BestInvestCollectionError('OTP_REQUIRED');
		}

		try {
			signal.throwIfAborted();
			await page.locator('#userAuthCode').fill(code);
		} finally {
			code = '';
		}

		await page.locator('app-identity-login-auth-input button[type="submit"]').click();
		await page.waitForFunction(() => {
			try {
				const session = JSON.parse(sessionStorage.getItem('currentUser') ?? 'null') as {token?: unknown; expireAt?: string} | undefined;
				return Boolean(session?.token && session.expireAt && Date.parse(session.expireAt) > Date.now());
			} catch {
				return false;
			}
		});
		signal.throwIfAborted();
	} finally {
		await request?.cancel();
	}
}

export async function readBestInvestSnapshot(page: Page, policyResponse: unknown, observedAt: string, signal: AbortSignal): Promise<InvestmentSnapshot> {
	const response = object(policyResponse);
	if (!Array.isArray(response.Policies) || response.Policies.length > 200 || response.IsSuccess === false) {
		throw new BestInvestCollectionError('INVALID_RESPONSE');
	}

	const seen = new Set<string>();
	const policies = [];
	const year = Number(new Intl.DateTimeFormat('en', {year: 'numeric', timeZone: 'Asia/Jerusalem'}).format(new Date(observedAt)));
	for (const raw of response.Policies) {
		signal.throwIfAborted();
		const policy = object(raw);
		const policyNumber = identifier(policy.PolicyNumber);
		if (seen.has(policyNumber)) {
			throw new BestInvestCollectionError('INVALID_RESPONSE');
		}

		const productId = identifier(policy.TemplateId);
		seen.add(policyNumber);
		// eslint-disable-next-line no-await-in-loop -- Keep provider requests sequential and within the owned session.
		const details = object(await requestBestInvest(page, 'details', {PolicyNumber: policyNumber, ProductId: productId}));
		if (identifier(details.PolicyId) !== policyNumber) {
			throw new BestInvestCollectionError('INVALID_RESPONSE');
		}

		let deposits: unknown;
		try {
			// eslint-disable-next-line no-await-in-loop -- Deposits are ancillary to this policy's validated balance.
			deposits = await requestBestInvest(page, 'deposits', {PolicyNumber: policyNumber, Year: year});
		} catch (error) {
			if (!(error instanceof BestInvestCollectionError) || error.code === 'OTP_REQUIRED' || signal.aborted) {
				throw error;
			}
		}

		policies.push({details, deposits, depositsYear: year, expectedPolicyId: policyNumber});
	}

	signal.throwIfAborted();
	return buildBestInvestSnapshot({policies, observedAt, inventoryComplete: true});
}

/** Each source owns its profile, store, request budget and freshness status. */
export function createBestInvestCollector(options: BestInvestCollectorOptions = {}): InvestmentCollector {
	return async context => {
		if (context.signal.aborted) {
			return 'error';
		}

		const attemptedAt = new Date().toISOString();
		try {
			let expectedIdentity: string;
			try {
				expectedIdentity = await context.secrets.resolve(context.config.credentials.id);
			} catch {
				throw new BestInvestCollectionError('CREDENTIAL_RESOLUTION_FAILED');
			}

			if (!/^\d{9}$/.test(expectedIdentity)) {
				throw new BestInvestCollectionError('INVALID_CREDENTIALS');
			}

			redact(expectedIdentity);
			const automatic = !options.readOtp && Boolean(options.otpSource ?? context.config.googleMessagesOtpSocket);
			const loginOptions: BestInvestCollectorOptions = {
				...options,
				otpSource: options.otpSource ?? (automatic && context.config.googleMessagesOtpSocket
					? createGoogleMessagesOtpSource(context.config.googleMessagesOtpSocket, 'best-invest')
					: undefined),
				async beforeOtpRequest(signal) {
					if (automatic && !context.store.consumeAutomaticSmsAttempt(new Date().toISOString())) {
						throw new BestInvestCollectionError('OTP_REQUIRED');
					}

					await options.beforeOtpRequest?.(signal);
				},
			};
			const snapshot = await withBestInvestBrowser({...context, timeoutMinutes: context.config.timeoutMinutes}, async (page, signal) => {
				const identityMatches = await page.evaluate(expected => {
					try {
						const session = JSON.parse(sessionStorage.getItem('currentUser') ?? 'null') as {username?: unknown} | undefined;
						return !session || session.username === expected;
					} catch {
						return false;
					}
				}, expectedIdentity);
				if (!identityMatches) {
					throw new BestInvestCollectionError('INVALID_CREDENTIALS');
				}

				let policies: unknown;
				try {
					policies = await requestBestInvest(page, 'policies');
				} catch (error) {
					if (!(error instanceof BestInvestCollectionError) || error.code !== 'OTP_REQUIRED') {
						throw error;
					}

					await loginBestInvest(page, context, loginOptions, signal);
					policies = await requestBestInvest(page, 'policies');
				}

				return readBestInvestSnapshot(page, policies, attemptedAt, signal);
			});
			if (context.signal.aborted) {
				return 'error';
			}

			const result = context.store.applySnapshot(snapshot);
			context.logger.info('Best Invest collection completed', {status: result.applied ? 'ok' : 'partial', products: snapshot.products.length});
			return result.applied ? 'ok' : 'partial';
		} catch (error) {
			if (context.signal.aborted) {
				return 'error';
			}

			if (error instanceof BestInvestProfileBusyError) {
				context.logger.info('Best Invest collection skipped; profile is in use');
				return 'skipped';
			}

			const parsedCode = investmentErrorCodeSchema.safeParse(error instanceof Error && 'code' in error ? error.code : undefined);
			const errorCode = parsedCode.success ? parsedCode.data : 'INVALID_RESPONSE';
			const status = errorCode === 'OTP_REQUIRED' ? 'auth_required' : 'error';
			context.store.recordFailure({status, attemptedAt, errorCode});
			context.logger.warn('Best Invest collection needs attention', {status, errorCode});
			return status;
		}
	};
}
