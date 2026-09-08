/**
 * Hono application serving the SimpleFIN protocol, health and CSV export.
 *
 * Routes (never redirect; trailing slashes are accepted via non-strict routing):
 * - POST /simplefin/claim/:claimId   text/plain Access URL | 403 | 404
 * - GET  /simplefin/accounts         Basic auth (403 on failure), JSON account set
 * - GET  /simplefin/info             {"versions":["1","2"]}
 * - GET  /healthz                    200/503 + HealthReport
 * - GET  /export/transactions.csv    Basic auth, Securo CSV
 *
 * Errors are sanitized JSON; request logs carry method, path, status and duration
 * only (never query values, credentials or bank data).
 */

import {Hono, type Context, type MiddlewareHandler} from 'hono';
import {getConnInfo} from '@hono/node-server/conninfo';
import {exportCsv} from '../export/csv.js';
import {buildHealthReport} from '../health.js';
import type {Logger} from '../log.js';
import type {Config, Consumer, Ledger} from '../types.js';
import {DUMMY_SECRET_HASH, parseBasicAuth, verifySecret} from './auth.js';
import {handleClaim, isClaimOpen} from './claim.js';
import {buildAccountsResponse, parseAccountsQuery} from './payload.js';

export type AppOptions = {
	config: Config;
	ledger: Ledger;
	logger: Logger;
	/** Clock override for tests. */
	now?: () => Date;
	/** Separately authenticated investment routes, absent unless explicitly enabled. */
	investmentRouter?: Hono;
};

type Variables = {
	consumer: Consumer;
};

export type BridgeApp = Hono<{Variables: Variables}>;

const wwwAuthenticate = 'Basic realm="simplefin", charset="UTF-8"';
const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;

/** Remote address of the current request; 'unknown' outside the node-server adapter (tests). */
export function remoteIp(c: Context): string {
	try {
		return getConnInfo(c).remote.address ?? 'unknown';
	} catch {
		return 'unknown';
	}
}

/**
 * Authentication failure. The SimpleFIN protocol defines 403 for `/accounts`
 * ("Authentication failed"), and Actual's sync-server only recognises 403 as an
 * auth problem (any other status is parsed as a payload); Securo treats 401 and
 * 403 alike. The WWW-Authenticate header is kept for plain HTTP clients.
 */
function forbidden(c: Context, logger: Logger, reason: string, user?: string): Response {
	logger.info('auth failed', {reason, user, remoteIp: remoteIp(c), path: loggablePath(c.req.path)});
	c.header('WWW-Authenticate', wwwAuthenticate);
	return c.json({error: 'forbidden'}, 403);
}

/**
 * Mark the consumer as seen. The plain secret is kept while the claim is still
 * open (a consumer whose connect failed half-way can re-paste the same token
 * until the TTL or maxClaims is reached) and wiped on the first request after that.
 */
function touchConsumer(ledger: Ledger, consumer: Consumer, now: Date): void {
	const nowIso = now.toISOString();
	ledger.updateConsumer({
		...consumer,
		lastSeenAt: nowIso,
		firstAuthenticatedAt: consumer.firstAuthenticatedAt ?? nowIso,
		secretPlain: isClaimOpen(consumer, now) ? consumer.secretPlain : undefined,
	});
}

/**
 * Basic-auth middleware: looks the consumer up by basicUser and verifies the scrypt hash.
 * The hash is always verified (against a dummy when the user is unknown or revoked) so
 * response time does not reveal whether a basic user exists.
 */
function basicAuth(options: AppOptions): MiddlewareHandler<{Variables: Variables}> {
	return async (c, next) => {
		const credentials = parseBasicAuth(c.req.header('authorization'));
		if (!credentials) {
			return forbidden(c, options.logger, 'missing_credentials');
		}

		const consumer = options.ledger.getConsumerByBasicUser(credentials.user);
		const secretOk = verifySecret(consumer?.secretHash ?? DUMMY_SECRET_HASH, credentials.secret);
		if (!consumer || consumer.revokedAt) {
			return forbidden(c, options.logger, consumer ? 'revoked' : 'unknown_user', credentials.user);
		}

		if (!secretOk) {
			return forbidden(c, options.logger, 'bad_secret', credentials.user);
		}

		touchConsumer(options.ledger, consumer, (options.now ?? (() => new Date()))());
		c.set('consumer', consumer);
		await next();
	};
}

/** Request path for logs: the claim id is a one-time secret, so it is masked. */
function loggablePath(path: string): string {
	return path.replace(/^\/simplefin\/claim\/[^/]+/, '/simplefin/claim/:claimId');
}

function requestLogger(logger: Logger): MiddlewareHandler {
	return async (c, next) => {
		const started = performance.now();
		await next();
		const ms = Math.round(performance.now() - started);
		logger.info('request', {method: c.req.method, path: loggablePath(c.req.path), status: c.res.status, ms});
	};
}

function parseDateParameter(value: string | undefined): string | undefined {
	return value && isoDatePattern.test(value) ? value : undefined;
}

/** Create the Hono app. `startServer` binds it; tests call `app.request()` directly. */
export function createApp(options: AppOptions): BridgeApp {
	const {config, ledger, logger} = options;
	const now = options.now ?? (() => new Date());
	const app = new Hono<{Variables: Variables}>({strict: false});

	app.use('*', requestLogger(logger));
	app.notFound(c => c.json({error: 'not_found'}, 404));
	app.onError((error, c) => {
		logger.error('unhandled error', {method: c.req.method, path: loggablePath(c.req.path), message: error.message});
		return c.json({error: 'internal_error'}, 500);
	});
	if (options.investmentRouter) {
		app.route('/', options.investmentRouter);
	}

	app.post('/simplefin/claim/:claimId', c => {
		const result = handleClaim(ledger, config, c.req.param('claimId'), now(), remoteIp(c), logger);
		if (result.status === 200) {
			return c.text(result.body, 200);
		}

		return c.json({error: result.status === 404 ? 'not_found' : 'claim_refused'}, result.status);
	});

	app.get('/simplefin/info', c => c.json({versions: ['1', '2']}));

	app.get('/simplefin/accounts', basicAuth(options), c => {
		const query = parseAccountsQuery(new URL(c.req.url).searchParams);
		return c.json(buildAccountsResponse(ledger, config, query, now(), logger));
	});

	app.get('/healthz', c => {
		const report = buildHealthReport(ledger, config, now());
		return c.json(report, report.ok ? 200 : 503);
	});

	app.get('/export/transactions.csv', basicAuth(options), c => {
		const accountIds = c.req.queries('account')?.filter(Boolean);
		const csv = exportCsv(ledger, config, {
			accountIds: accountIds && accountIds.length > 0 ? accountIds : undefined,
			from: parseDateParameter(c.req.query('from')),
			to: parseDateParameter(c.req.query('to')),
		});
		c.header('Content-Type', 'text/csv; charset=utf-8');
		c.header('Content-Disposition', 'attachment; filename="transactions.csv"');
		return c.body(csv, 200);
	});

	return app;
}
