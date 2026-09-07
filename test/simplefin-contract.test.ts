/**
 * Replays the exact request sequence Securo's SimpleFIN provider performs
 * (docs/securo-simplefin-contract.md) against the Hono app and asserts every
 * field name/type Securo reads, plus the claim/auth lifecycle rules.
 */

import {Buffer} from 'node:buffer';
import {describe, expect, it} from 'vitest';
import {createApp} from '../src/simplefin/app.js';
import {mintConsumerToken, revokeConsumer} from '../src/simplefin/consumers.js';
import type {Config, Ledger, SimpleFinResponse, SimpleFinTransaction} from '../src/types.js';
import {
	basicHeader,
	HAPOALIM_ACCOUNT,
	makeConfig,
	NOW,
	seedLedger,
	seedTransaction,
	shiftDate,
	silentLogger,
	TODAY,
	utcMidnight,
	VISACAL_ACCOUNT,
} from './helpers/seed.js';

type Harness = {
	app: ReturnType<typeof createApp>;
	ledger: Ledger;
	config: Config;
	clock: {now: Date};
	logLines: string[];
};

function harness(config = makeConfig()): Harness {
	const ledger = seedLedger();
	const clock = {now: NOW};
	const logLines: string[] = [];
	const app = createApp({config, ledger, logger: silentLogger(logLines), now: () => clock.now});
	return {app, ledger, config, clock, logLines};
}

/** What Securo does with the pasted token: strip whitespace, base64-decode, require http(s). */
function decodeSetupToken(token: string): string {
	const decoded = Buffer.from(token.replaceAll(/\s+/g, ''), 'base64').toString('utf8');
	expect(decoded.startsWith('http://') || decoded.startsWith('https://')).toBe(true);
	return decoded;
}

/** POST <claim url> exactly like Securo: Content-Length: 0, Accept json, no body, no auth. */
async function claim(h: Harness, claimUrl: string): Promise<Response> {
	return h.app.request(claimUrl, {
		method: 'POST',
		headers: {'content-length': '0', accept: 'application/json', 'user-agent': 'Securo/0.1 (+https://usesecuro.com)'},
	});
}

/** Securo: strip userinfo from the Access URL, send it as HTTP Basic, GET <access_url>/accounts. */
async function accountsRequest(h: Harness, accessUrl: string, parameters: Record<string, string>): Promise<Response> {
	const url = new URL(accessUrl.replace(/\/+$/, ''));
	const auth = basicHeader(decodeURIComponent(url.username), decodeURIComponent(url.password));
	url.username = '';
	url.password = '';
	url.pathname = `${url.pathname}/accounts`;
	for (const [key, value] of Object.entries({version: '2', ...parameters})) {
		url.searchParams.set(key, value);
	}

	return h.app.request(url.href, {headers: {authorization: auth, accept: 'application/json'}});
}

/** Status code of a pending request. */
async function statusOf(request: Response | Promise<Response>): Promise<number> {
	const response = await request;
	return response.status;
}

/** Trimmed text body of a response (what Securo does with the claim response). */
async function textOf(response: Response): Promise<string> {
	const body = await response.text();
	return body.trim();
}

async function mintAndClaim(h: Harness, label = 'securo'): Promise<{accessUrl: string; claimUrl: string}> {
	const minted = mintConsumerToken(h.ledger, h.config, {label, now: h.clock.now});
	const claimUrl = decodeSetupToken(minted.setupToken);
	const response = await claim(h, claimUrl);
	expect(response.status).toBe(200);
	return {accessUrl: await textOf(response), claimUrl};
}

/** Securo's initial backfill: today-365..today in 90-day chunks, end-date = chunk end + 1 day (exclusive). */
function securoChunks(): Array<{start: string; end: string}> {
	const chunks: Array<{start: string; end: string}> = [];
	let cursor = shiftDate(TODAY, -365);
	while (cursor <= TODAY) {
		const chunkEndMs = Math.min(Date.parse(`${shiftDate(cursor, 90)}T00:00:00Z`), Date.parse(`${TODAY}T00:00:00Z`));
		const chunkEnd = new Date(chunkEndMs).toISOString().slice(0, 10);
		chunks.push({start: cursor, end: shiftDate(chunkEnd, 1)});
		cursor = shiftDate(chunkEnd, 1);
	}

	return chunks;
}

function expectSecuroTransactionShape(transaction: SimpleFinTransaction): void {
	expect(typeof transaction.id).toBe('string');
	expect(transaction.id.length).toBeLessThanOrEqual(255);
	expect(Number.isSafeInteger(transaction.posted)).toBe(true);
	expect(Number.isSafeInteger(transaction.transacted_at)).toBe(true);
	expect(transaction.amount).toMatch(/^-?\d+\.\d{2}$/);
	expect(typeof transaction.description).toBe('string');
	expect(transaction.description.length).toBeLessThanOrEqual(500);
	expect(typeof transaction.payee).toBe('string');
	expect(typeof transaction.pending).toBe('boolean');
	expect(transaction.currency).toMatch(/^[A-Z]{3}$/);
	if (transaction.pending) {
		expect(transaction.posted).toBe(0);
	} else {
		expect(transaction.posted).toBeGreaterThan(0);
	}
}

describe('Securo connect + sync sequence', () => {
	it('mint -> claim -> account list -> chunked transaction pulls', async () => {
		const h = harness();
		const minted = mintConsumerToken(h.ledger, h.config, {label: 'Securo', now: h.clock.now});
		expect(minted.consumer.id).toBe('securo');
		expect(minted.consumer.basicUser).toMatch(/^securo-[0-9a-z]{6}$/);
		expect(minted.consumer.secretHash).toMatch(/^scrypt\$[^$]+\$[^$]+$/);
		expect(minted.consumer.secretPlain).toMatch(/^[\w-]{43}$/);
		expect(minted.consumer.claimId).toMatch(/^[\w-]{24}$/);
		expect(minted.consumer.claimExpiresAt).toBe(new Date(NOW.getTime() + (15 * 60_000)).toISOString());
		expect(minted.consumer.maxClaims).toBe(3);

		const claimUrl = decodeSetupToken(minted.setupToken);
		expect(claimUrl).toBe(`http://israeli-banks-bridge:8080/simplefin/claim/${minted.consumer.claimId}`);

		const claimResponse = await claim(h, claimUrl);
		expect(claimResponse.status).toBe(200);
		expect(claimResponse.headers.get('content-type')).toMatch(/^text\/plain/);
		const accessUrl = await textOf(claimResponse);
		const parsed = new URL(accessUrl);
		expect(parsed.protocol).toBe('http:');
		expect(parsed.username).toBe(minted.consumer.basicUser);
		expect(decodeURIComponent(parsed.password)).toBe(minted.consumer.secretPlain);
		expect(parsed.password).toMatch(/^[\w-]+$/);
		expect(parsed.host).toBe('israeli-banks-bridge:8080');
		expect(parsed.pathname).toBe('/simplefin');
		expect(h.logLines.some(line => line.includes(minted.consumer.secretPlain!))).toBe(false);

		// Account list call: version=2 only, no pending, no window -> accounts with [] transactions.
		const listResponse = await accountsRequest(h, accessUrl, {});
		expect(listResponse.status).toBe(200);
		expect(listResponse.headers.get('content-type')).toMatch(/^application\/json/);
		const list = await listResponse.json() as SimpleFinResponse;

		expect(Array.isArray(list.errlist)).toBe(true);
		expect(list.errlist).toEqual([]);
		expect(list.errors).toEqual([]);
		expect(list.connections).toHaveLength(2);
		for (const connection of list.connections) {
			expect(typeof connection.conn_id).toBe('string');
			expect(typeof connection.name).toBe('string');
			expect(connection.org_url).toMatch(/^https:\/\//);
			expect(connection.sfin_url).toBe('http://israeli-banks-bridge:8080/simplefin');
			expect(typeof connection.org_id).toBe('string');
		}

		expect(list.connections.map(connection => [connection.conn_id, connection.name])).toEqual([
			['hapoalim', 'Bank Hapoalim'],
			['visaCal', 'Visa Cal'],
		]);
		expect(list.accounts.map(account => account.id)).toEqual([HAPOALIM_ACCOUNT, VISACAL_ACCOUNT]);
		const connectionIds = new Set(list.connections.map(connection => connection.conn_id));
		for (const account of list.accounts) {
			expect(typeof account.name).toBe('string');
			expect(account.name.length).toBeLessThanOrEqual(255);
			expect(connectionIds.has(account.conn_id)).toBe(true);
			expect(account.currency).toBe('ILS');
			expect(account.balance).toMatch(/^-?\d+\.\d{2}$/);
			expect(Number.isSafeInteger(account['balance-date'])).toBe(true);
			expect(account.transactions).toEqual([]);
			expect(Array.isArray(account.holdings)).toBe(true);
			expect(account.org).toEqual({
				id: account.conn_id,
				name: expect.any(String) as string,
				domain: expect.any(String) as string,
				url: expect.stringMatching(/^https:\/\//) as string,
				'sfin-url': 'http://israeli-banks-bridge:8080/simplefin',
			});
		}

		expect(list.accounts[0]?.balance).toBe('1234.50');
		expect(list.accounts[1]?.balance).toBe('-2500.25');
		expect(list.accounts[0]?.['balance-date']).toBe(Date.parse('2026-09-05T03:00:00.000Z') / 1000);

		// Initial backfill: 5 chunks per account, 90-day windows, end exclusive.
		const chunks = securoChunks();
		expect(chunks).toHaveLength(5);
		const seen = new Map<string, SimpleFinTransaction>();
		const chunkResponses = await Promise.all(chunks.map(async chunk => {
			expect(Date.parse(`${chunk.end}T00:00:00Z`) - Date.parse(`${chunk.start}T00:00:00Z`)).toBeLessThanOrEqual(91 * 86_400_000);
			return accountsRequest(h, accessUrl, {
				pending: '1',
				account: HAPOALIM_ACCOUNT,
				'start-date': String(utcMidnight(chunk.start)),
				'end-date': String(utcMidnight(chunk.end)),
			});
		}));
		for (const [index, response] of chunkResponses.entries()) {
			expect(response.status).toBe(200);
			// eslint-disable-next-line no-await-in-loop
			const payload = await response.json() as SimpleFinResponse;
			expect(payload.accounts.map(account => account.id)).toEqual([HAPOALIM_ACCOUNT]);
			for (const transaction of payload.accounts[0]!.transactions) {
				expectSecuroTransactionShape(transaction);
				// A row is repeated only in the chunk where the bridge first saw it (all seeded rows were
				// first seen today, i.e. in the last chunk); Securo dedups by id and the copy is identical.
				if (seen.has(transaction.id)) {
					expect(index).toBe(chunks.length - 1);
					expect(transaction).toEqual(seen.get(transaction.id));
				}

				seen.set(transaction.id, transaction);
			}
		}

		// 13 posted rows over the last 365 days; the 366-day-old row is outside the backfill.
		expect(seen.size).toBe(13);
		expect([...seen.values()].some(transaction => transaction.description === 'Too old')).toBe(false);
		const newest = [...seen.values()].find(transaction => transaction.amount === '-1.00')!;
		expect(newest.posted).toBe(Date.parse(`${TODAY}T12:00:00Z`) / 1000);
		expect(new Date(newest.posted * 1000).toISOString().slice(0, 10)).toBe(TODAY);
		expect(newest.extra).toMatchObject({status: 'posted'});

		// Card account: pending row served (includePending on) with posted=0, synthetic payment positive.
		const cardResponse = await accountsRequest(h, accessUrl, {
			pending: '1',
			account: VISACAL_ACCOUNT,
			'start-date': String(utcMidnight(shiftDate(TODAY, -14))),
			'end-date': String(utcMidnight(shiftDate(TODAY, 1))),
		});
		const card = (await cardResponse.json() as SimpleFinResponse).accounts[0]!;
		const pending = card.transactions.find(transaction => transaction.pending)!;
		expect(pending.posted).toBe(0);
		expect(pending.transacted_at).toBe(Date.parse(`${shiftDate(TODAY, -2)}T12:00:00Z`) / 1000);
		expect(pending.amount).toBe('-45.50');
		expect(card.transactions.find(transaction => transaction.description === 'Card payment')?.amount).toBe('2500.00');

		// The first authenticated GET stamped the consumer but kept the plain secret while the claim is open.
		const consumer = h.ledger.getConsumer('securo')!;
		expect(consumer.secretPlain).toBe(minted.consumer.secretPlain);
		expect(consumer.firstAuthenticatedAt).toBe(NOW.toISOString());
		expect(consumer.lastSeenAt).toBe(NOW.toISOString());

		// Once the claim TTL has passed, the next authenticated request drops it.
		h.clock.now = new Date(NOW.getTime() + (16 * 60_000));
		expect(await statusOf(accountsRequest(h, accessUrl, {}))).toBe(200);
		expect(h.ledger.getConsumer('securo')!.secretPlain).toBeUndefined();
	});

	it('serves /simplefin/info and never redirects trailing-slash variants', async () => {
		const h = harness();
		const {accessUrl} = await mintAndClaim(h);
		const info = await h.app.request('http://israeli-banks-bridge:8080/simplefin/info');
		expect(info.status).toBe(200);
		expect(await info.json()).toEqual({versions: ['1', '2']});

		const withSlash = await accountsRequest(h, `${accessUrl}/`, {});
		expect(withSlash.status).toBe(200);
		const url = new URL(accessUrl);
		const slashAccounts = await h.app.request(`http://${url.host}/simplefin/accounts/?version=2`, {
			headers: {authorization: basicHeader(url.username, url.password)},
		});
		expect(slashAccounts.status).toBe(200);
		expect(slashAccounts.status).not.toBeGreaterThanOrEqual(300);
	});

	it('retries a partial backfill and delivers late arrivals with the same ids to independent consumers', async () => {
		const h = harness();
		const first = await mintAndClaim(h, 'securo');
		const second = await mintAndClaim(h, 'other');
		const window = {
			account: HAPOALIM_ACCOUNT,
			'start-date': String(utcMidnight(shiftDate(TODAY, -14))),
			'end-date': String(utcMidnight(shiftDate(TODAY, 1))),
		};
		const initial = await accountsRequest(h, first.accessUrl, window);
		const initialRows = (await initial.json() as SimpleFinResponse).accounts[0]!.transactions;
		const late = seedTransaction(h.ledger, {bookedDate: shiftDate(TODAY, -40), firstSeen: NOW.toISOString(), description: 'Late after first consumer pull'});
		// A failed connect rolls back in Securo; claiming again must yield the same credentials and history.
		expect(await textOf(await claim(h, first.claimUrl))).toBe(first.accessUrl);
		for (const accessUrl of [first.accessUrl, second.accessUrl]) {
			// eslint-disable-next-line no-await-in-loop
			const response = await accountsRequest(h, accessUrl, window);
			// eslint-disable-next-line no-await-in-loop
			const rows = (await response.json() as SimpleFinResponse).accounts[0]!.transactions;
			const seen = new Map(initialRows.map(row => [row.id, row]));
			for (const row of rows) {
				if (seen.has(row.id)) {
					expect(row).toEqual(seen.get(row.id));
				}

				seen.set(row.id, row);
			}

			expect(seen.size).toBe(initialRows.length + 1);
			expect(seen.get(late.id)?.posted).toBe(Date.parse(`${late.bookedDate}T12:00:00Z`) / 1000);
		}
	});
});

describe('claim lifecycle', () => {
	it('a second claim before the first authenticated GET returns the same Access URL', async () => {
		const h = harness();
		const {accessUrl, claimUrl} = await mintAndClaim(h);
		const again = await claim(h, claimUrl);
		expect(again.status).toBe(200);
		expect(await textOf(again)).toBe(accessUrl);
		expect(h.ledger.getConsumer('securo')?.claimCount).toBe(2);
	});

	it('accepts a re-claim after the first authenticated GET while the claim is open (failed Securo connect retry)', async () => {
		const h = harness();
		const {accessUrl, claimUrl} = await mintAndClaim(h);
		// Securo: claim, then the first authenticated GET, then a backfill that fails and is rolled back.
		expect(await statusOf(accountsRequest(h, accessUrl, {}))).toBe(200);
		const again = await claim(h, claimUrl);
		expect(again.status).toBe(200);
		expect(await textOf(again)).toBe(accessUrl);
		expect(await statusOf(accountsRequest(h, accessUrl, {}))).toBe(200);
	});

	it('refuses an expired claim and drops the plain secret', async () => {
		const h = harness();
		const minted = mintConsumerToken(h.ledger, h.config, {label: 'securo', now: h.clock.now});
		h.clock.now = new Date(NOW.getTime() + (16 * 60_000));
		expect(await statusOf(claim(h, decodeSetupToken(minted.setupToken)))).toBe(403);
		expect(h.ledger.getConsumer('securo')!.secretPlain).toBeUndefined();
		expect(h.ledger.getConsumer('securo')!.secretHash).toBe(minted.consumer.secretHash);
	});

	it('refuses more than maxClaims claims and drops the plain secret', async () => {
		const h = harness();
		const {accessUrl, claimUrl} = await mintAndClaim(h);
		expect(await statusOf(claim(h, claimUrl))).toBe(200);
		expect(await statusOf(claim(h, claimUrl))).toBe(200);
		expect(h.ledger.getConsumer('securo')!.secretPlain).toBeUndefined();
		expect(await statusOf(claim(h, claimUrl))).toBe(403);
		expect(h.ledger.getConsumer('securo')!.secretPlain).toBeUndefined();
		expect(await statusOf(accountsRequest(h, accessUrl, {}))).toBe(200);
	});

	it('does not log the claim id when the claim handler throws', async () => {
		const h = harness();
		const minted = mintConsumerToken(h.ledger, h.config, {label: 'securo', now: h.clock.now});
		h.ledger.updateConsumer = () => {
			throw new Error('SQLITE_BUSY');
		};

		const response = await claim(h, decodeSetupToken(minted.setupToken));
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({error: 'internal_error'});
		expect(h.logLines.some(line => line.includes('unhandled error'))).toBe(true);
		expect(h.logLines.some(line => line.includes(minted.consumer.claimId!))).toBe(false);
	});

	it('returns 404 for an unknown claim id and 403 for a revoked consumer', async () => {
		const h = harness();
		expect(await statusOf(claim(h, 'http://israeli-banks-bridge:8080/simplefin/claim/nope'))).toBe(404);
		const {claimUrl} = await mintAndClaim(h);
		revokeConsumer(h.ledger, 'securo');
		expect(await statusOf(claim(h, claimUrl))).toBe(403);
	});
});

describe('Basic auth', () => {
	// 403, not 401: the SimpleFIN protocol's auth-failure code, and the only status Actual's
	// sync-server recognises as INVALID_ACCESS_TOKEN (Securo treats 401 and 403 the same).
	it('rejects a wrong secret, a missing header, an unknown user and a revoked consumer with 403 + WWW-Authenticate', async () => {
		const h = harness();
		const {accessUrl} = await mintAndClaim(h);
		const url = new URL(accessUrl);
		const wrong = await h.app.request('http://israeli-banks-bridge:8080/simplefin/accounts?version=2', {
			headers: {authorization: basicHeader(url.username, 'not-the-secret')},
		});
		expect(wrong.status).toBe(403);
		expect(wrong.headers.get('www-authenticate')).toMatch(/^Basic /);
		expect(await wrong.json()).toEqual({error: 'forbidden'});
		expect(h.logLines.some(line => line.includes('auth failed') && line.includes('bad_secret'))).toBe(true);

		const missing = await h.app.request('http://israeli-banks-bridge:8080/simplefin/accounts?version=2');
		expect(missing.status).toBe(403);

		const unknown = await h.app.request('http://israeli-banks-bridge:8080/simplefin/accounts?version=2', {
			headers: {authorization: basicHeader('nobody-000000', url.password)},
		});
		expect(unknown.status).toBe(403);

		revokeConsumer(h.ledger, 'securo');
		expect(await statusOf(accountsRequest(h, accessUrl, {}))).toBe(403);
		expect(h.ledger.getConsumer('securo')?.secretPlain).toBeUndefined();
	});

	it('rotating a consumer invalidates the old secret and issues a new claim', async () => {
		const h = harness();
		const {accessUrl: oldAccessUrl} = await mintAndClaim(h);
		expect(await statusOf(accountsRequest(h, oldAccessUrl, {}))).toBe(200);

		expect(() => mintConsumerToken(h.ledger, h.config, {label: 'securo', now: h.clock.now})).toThrow(/rotate/);
		const rotated = mintConsumerToken(h.ledger, h.config, {label: 'securo', rotate: true, now: h.clock.now});
		expect(await statusOf(accountsRequest(h, oldAccessUrl, {}))).toBe(403);

		const response = await claim(h, decodeSetupToken(rotated.setupToken));
		expect(response.status).toBe(200);
		const newAccessUrl = await textOf(response);
		expect(newAccessUrl).not.toBe(oldAccessUrl);
		expect(await statusOf(accountsRequest(h, newAccessUrl, {}))).toBe(200);
	});
});

describe('non-SimpleFIN routes', () => {
	it('serves /healthz without auth and CSV export with auth', async () => {
		const h = harness();
		const health = await h.app.request('http://israeli-banks-bridge:8080/healthz');
		expect(health.status).toBe(200);
		expect(await health.json()).toMatchObject({ok: true, idSchemeVersion: 1});

		expect(await statusOf(h.app.request('http://israeli-banks-bridge:8080/export/transactions.csv'))).toBe(403);
		const {accessUrl} = await mintAndClaim(h);
		const url = new URL(accessUrl);
		const csv = await h.app.request(`http://israeli-banks-bridge:8080/export/transactions.csv?account=${encodeURIComponent(VISACAL_ACCOUNT)}`, {
			headers: {authorization: basicHeader(url.username, url.password)},
		});
		expect(csv.status).toBe(200);
		expect(csv.headers.get('content-type')).toMatch(/^text\/csv/);
		const text = await csv.text();
		expect(text.startsWith('date,description,amount,type,currency,external_id,payee,notes\r\n')).toBe(true);
		expect(text).toContain('Card payment');
	});

	it('returns sanitized JSON for unknown routes and logs requests without query values', async () => {
		const h = harness();
		const response = await h.app.request('http://israeli-banks-bridge:8080/nope?secret=1');
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({error: 'not_found'});
		const line = h.logLines.find(entry => entry.includes('"path":"/nope"'));
		expect(line).toBeDefined();
		expect(line).not.toContain('secret=1');

		const minted = mintConsumerToken(h.ledger, h.config, {label: 'securo', now: h.clock.now});
		await claim(h, decodeSetupToken(minted.setupToken));
		expect(h.logLines.some(entry => entry.includes(minted.consumer.claimId!))).toBe(false);
		expect(h.logLines.some(entry => entry.includes('/simplefin/claim/:claimId'))).toBe(true);
	});
});
