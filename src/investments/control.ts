/* eslint-disable @typescript-eslint/no-restricted-types -- This JSON protocol uses explicit null for unobserved state. */
import {createHash, timingSafeEqual} from 'node:crypto';
import {Hono} from 'hono';
import {bodyLimit} from 'hono/body-limit';
import type {Logger} from '../log.js';
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
};

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
	return router;
}
