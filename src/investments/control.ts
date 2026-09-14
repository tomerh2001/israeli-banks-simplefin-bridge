/* eslint-disable @typescript-eslint/no-restricted-types -- This JSON protocol uses explicit null for unobserved state. */
import {createHash, timingSafeEqual} from 'node:crypto';
import {Hono} from 'hono';
import {bodyLimit} from 'hono/body-limit';
import {z} from 'zod';
import type {Logger} from '../log.js';
import type {ManualRecoveryResult, ManualRecoveryStatus} from './manual-recovery.js';
import type {GoogleMessagesHealth} from './otp.js';
import type {getClalSessionStatus} from './router.js';
import type {InvestmentCollectionStatus} from './runtime.js';
import type {InvestmentSourceState} from './types.js';

export type InvestmentControlStatus = {
	schemaVersion: 1;
	observedAt: string;
	source: InvestmentSourceState;
	collection: {running: boolean; lastResult: InvestmentCollectionStatus | null; lastStartedAt: string | null; lastFinishedAt: string | null};
	schedule: {enabled: boolean; expression: string; description: string | null; timezone: string; nextRunAt: string | null};
	automaticOtp: {enabled: boolean; ready: boolean; reason: GoogleMessagesHealth['reason'] | 'not_configured' | 'rate_limited'; nextAllowedAt: string | null};
	session: ReturnType<typeof getClalSessionStatus>;
	manualVerificationAvailable: boolean;
	recovery: ManualRecoveryStatus | null;
};

export type InvestmentRefreshResult =
	| {result: 'started' | 'already_running'; retryAfterSeconds: 0}
	| {error: 'refresh_rate_limited'; retryAfterSeconds: number}
	| {error: 'source_identity_mismatch' | 'investment_control_unavailable'};

type ControlOptions = {
	controlToken?: string;
	readToken?: string;
	logger: Logger;
	status(): Promise<InvestmentControlStatus>;
	refresh(provider: string): InvestmentRefreshResult;
	startRecovery(provider: string, requestId: string): RecoveryControlResult;
	submitRecovery(provider: string, challengeId: string, code: string): RecoveryControlResult;
	cancelRecovery(provider: string, challengeId: string): RecoveryControlResult;
};

export type RecoveryControlResult = ManualRecoveryResult | Exclude<InvestmentRefreshResult, {result: string}>;

function digest(value: string): Uint8Array {
	return createHash('sha256').update(value).digest();
}

/** Status and collection require a separate capability from the immutable financial feed. */
export function createInvestmentControlRouter(options: ControlOptions): Hono {
	const router = new Hono({strict: false});
	const tokenHash = digest(options.controlToken ?? '');
	const configured = Boolean(options.controlToken && options.controlToken.length >= 32
		&& !/\s/.test(options.controlToken) && !timingSafeEqual(tokenHash, digest(options.readToken ?? '')));
	router.use('*', async (c, next) => {
		c.header('Cache-Control', 'no-store');
		const match = /^bearer (?<token>\S+)$/i.exec(c.req.header('authorization') ?? '');
		// Compare even when the capability is unavailable.
		// eslint-disable-next-line unicorn/no-declarations-before-early-exit
		const authorized = timingSafeEqual(digest(match?.groups?.token ?? ''), tokenHash) && Boolean(match);
		if (!configured) {
			return c.json({error: 'investment_control_unavailable'}, 503);
		}

		if (!authorized) {
			c.header('WWW-Authenticate', 'Bearer realm="investment-control"');
			return c.json({error: 'forbidden'}, 403);
		}

		if (c.req.header('origin')) {
			return c.json({error: 'forbidden'}, 403);
		}

		if (new URL(c.req.url).search) {
			return c.json({error: 'invalid_request'}, 400);
		}

		await next();
	});
	router.get('/status', async c => {
		try {
			return c.json(await options.status());
		} catch {
			options.logger.error('investment control status unavailable');
			return c.json({error: 'investment_control_unavailable'}, 503);
		}
	});
	router.post('/refresh', bodyLimit({maxSize: 128, onError: c => c.json({error: 'invalid_request'}, 400)}), async c => {
		try {
			const body = await c.req.text();
			if (body && !/^\s*\{\s*\}\s*$/.test(body)) {
				return c.json({error: 'invalid_request'}, 400);
			}

			const provider = c.req.header('x-investment-provider') ?? '';
			const result = options.refresh(provider);
			if ('result' in result) {
				return c.json(result, 202);
			}

			if (result.error === 'refresh_rate_limited') {
				c.header('Retry-After', String(result.retryAfterSeconds));
				return c.json(result, 429);
			}

			return c.json(result, result.error === 'source_identity_mismatch' ? 409 : 503);
		} catch {
			options.logger.error('investment control refresh unavailable');
			return c.json({error: 'investment_control_unavailable'}, 503);
		}
	});
	for (const action of ['start', 'submit', 'cancel'] as const) {
		const route = action === 'start' ? '/recovery' : (action === 'submit' ? '/recovery/:challengeId/code' : '/recovery/:challengeId');
		router.on(action === 'cancel' ? 'DELETE' : 'POST', route, bodyLimit({maxSize: 128, onError: c => c.json({error: 'invalid_request'}, 400)}), async c => {
			try {
				const provider = c.req.header('x-investment-provider') ?? '';
				const raw = await c.req.text();
				let result: RecoveryControlResult;
				if (action === 'start') {
					const body = z.strictObject({requestId: z.uuid()}).safeParse(JSON.parse(raw));
					if (!body.success) {
						return c.json({error: 'invalid_request'}, 400);
					}

					result = options.startRecovery(provider, body.data.requestId.toLowerCase());
				} else {
					const identifier = z.uuid().safeParse(c.req.param('challengeId'));
					if (!identifier.success) {
						return c.json({error: 'invalid_request'}, 400);
					}

					if (action === 'submit') {
						// Exactly one literal six-digit field; no duplicate JSON keys or numeric coercion.
						const match = /^\s*\{\s*"code"\s*:\s*"(?<code>\d{6})"\s*\}\s*$/.exec(raw);
						if (!match) {
							return c.json({error: 'invalid_request'}, 400);
						}

						result = options.submitRecovery(provider, identifier.data.toLowerCase(), match.groups!.code!);
					} else {
						if (raw && !/^\s*\{\s*\}\s*$/.test(raw)) {
							return c.json({error: 'invalid_request'}, 400);
						}

						result = options.cancelRecovery(provider, identifier.data.toLowerCase());
					}
				}

				if ('recovery' in result) {
					return c.json(result, action === 'cancel' ? 200 : 202);
				}

				if (result.error === 'refresh_rate_limited') {
					c.header('Retry-After', String(result.retryAfterSeconds));
					return c.json(result, 429);
				}

				const status = ({investment_control_unavailable: 503, recovery_not_found: 404, recovery_expired: 410,
					source_identity_mismatch: 409, recovery_not_waiting: 409, recovery_in_progress: 409} as const)[result.error];
				return c.json(result, status);
			} catch (error) {
				if (error instanceof SyntaxError) {
					return c.json({error: 'invalid_request'}, 400);
				}

				options.logger.error('investment recovery control unavailable');
				return c.json({error: 'investment_control_unavailable'}, 503);
			}
		});
	}

	return router;
}
