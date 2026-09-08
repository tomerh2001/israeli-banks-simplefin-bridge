import {createHash, timingSafeEqual} from 'node:crypto';
import {Hono} from 'hono';
import type {Logger} from '../log.js';
import type {InvestmentStore} from './types.js';

export type InvestmentRouterOptions = {
	store?: InvestmentStore;
	readToken?: string;
	staleHours: number;
	logger: Logger;
	now?: () => Date;
};

function digest(value: string): Uint8Array {
	return createHash('sha256').update(value).digest();
}

/** Dedicated read capability: SimpleFIN Basic credentials never authorize investments. */
export function createInvestmentRouter(options: InvestmentRouterOptions): Hono {
	const router = new Hono({strict: false});
	const tokenHash = digest(options.readToken ?? '');
	const configured = Boolean(options.readToken && options.readToken.length >= 32 && !/\s/.test(options.readToken));
	const now = options.now ?? (() => new Date());
	router.get('/investments/v1', c => {
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
			return c.json(options.store.getFeed(now(), options.staleHours));
		} catch {
			options.logger.error('investment feed read failed');
			return c.json({error: 'investment_feed_unavailable'}, 503);
		}
	});
	return router;
}
