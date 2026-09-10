import {createHash, timingSafeEqual} from 'node:crypto';
import {Hono} from 'hono';
import type {Logger} from '../log.js';
import type {ClalSessionState, InvestmentStore} from './types.js';

export type InvestmentRouterOptions = {
	store?: InvestmentStore;
	readToken?: string;
	staleHours: number;
	sessionKeepAliveMinutes?: number;
	logger: Logger;
	now?: () => Date;
	feedPath?: '/investments/v1' | '/investments/best-invest/v1' | '/investments/hapoalim/v1';
	/** Only providers with the Clal-style session contract expose this optional route. */
	sessionStatus?: boolean;
};

function digest(value: string): Uint8Array {
	return createHash('sha256').update(value).digest();
}

/** A historical active observation is never presented as a currently verified session. */
export function getClalSessionStatus(state: ClalSessionState, now: Date, intervalMinutes: number) {
	const expired = state.expiresAt !== null && Date.parse(state.expiresAt) <= now.getTime();
	const overdue = intervalMinutes > 0
		&& (state.lastCheckedAt === null || now.getTime() - Date.parse(state.lastCheckedAt) > intervalMinutes * 60_000);
	const checked = state.lastCheckedAt !== null && Date.parse(state.lastCheckedAt) <= now.getTime();
	return {
		...state, observedAt: now.toISOString(), keepAliveEnabled: intervalMinutes > 0,
		keepAliveMinutes: intervalMinutes, expired, overdue,
		verifiedActive: state.status === 'active' && checked && state.expiresAt !== null && !expired && !overdue,
	};
}

/** Dedicated read capability: SimpleFIN Basic credentials never authorize investments. */
export function createInvestmentRouter(options: InvestmentRouterOptions): Hono {
	const router = new Hono({strict: false});
	const tokenHash = digest(options.readToken ?? '');
	const configured = Boolean(options.readToken && options.readToken.length >= 32 && !/\s/.test(options.readToken));
	const now = options.now ?? (() => new Date());
	const feedPath = options.feedPath ?? '/investments/v1';
	for (const route of options.sessionStatus === false ? [feedPath] : [feedPath, `${feedPath}/session-status`]) {
		router.get(route, c => {
			c.header('Cache-Control', 'no-store');
			const match = /^bearer (?<token>\S+)$/i.exec(c.req.header('authorization') ?? '');
			// Always digest and compare, including malformed credentials and unavailable feeds.
			// eslint-disable-next-line unicorn/no-declarations-before-early-exit
			const authorized = timingSafeEqual(digest(match?.groups?.token ?? ''), tokenHash) && Boolean(match);
			if (!configured || !options.store) {
				return c.json({error: 'investment_feed_unavailable'}, 503);
			}

			if (!authorized) {
				c.header('WWW-Authenticate', 'Bearer realm="investments"');
				return c.json({error: 'forbidden'}, 403);
			}

			try {
				return c.json(route.endsWith('/session-status')
					? getClalSessionStatus(options.store.getSessionState(), now(), options.sessionKeepAliveMinutes ?? 0)
					: options.store.getFeed(now(), options.staleHours));
			} catch {
				options.logger.error('investment feed read failed');
				return c.json({error: 'investment_feed_unavailable'}, 503);
			}
		});
	}

	return router;
}
