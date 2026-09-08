import {Buffer} from 'node:buffer';
import {mkdtempSync, rmSync} from 'node:fs';
import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {createGoogleMessagesOtpSource} from './otp.js';

const fixtures: Array<{server: Server; directory: string}> = [];
const requestId = 'synthetic-opaque-request-123456789';

function json(response: ServerResponse, status: number, value: unknown): void {
	response.writeHead(status, {'Content-Type': 'application/json'}).end(JSON.stringify(value));
}

async function receiver(handler: (request: IncomingMessage, response: ServerResponse) => void, provider: 'clal' | 'best-invest' = 'clal') {
	const directory = mkdtempSync(path.join(os.tmpdir(), 'clal-otp-test-'));
	const socketPath = path.join(directory, 'receiver.sock');
	const server = createServer(handler);
	fixtures.push({server, directory});
	await new Promise<void>(resolve => {
		server.listen(socketPath, resolve);
	});
	return createGoogleMessagesOtpSource(socketPath, provider);
}

function lease(lifetime = 180_000) {
	const now = Date.now();
	return {requestId, armedAt: new Date(now).toISOString(), expiresAt: new Date(now + lifetime).toISOString()};
}

afterEach(async () => {
	await Promise.all(fixtures.map(async ({server, directory}) => {
		server.closeAllConnections();
		await new Promise<void>(resolve => {
			server.close(() => resolve());
		});
		rmSync(directory, {recursive: true, force: true});
	}));

	fixtures.length = 0;
});

describe('Google Messages OTP Unix socket client', () => {
	it('routes Best Invest arming, consumption, and cancellation only to its provider', async () => {
		const current = lease();
		const operations: string[] = [];
		const source = await receiver((request, response) => {
			operations.push(`${request.method} ${request.url}`);
			if (request.url === '/v1/best-invest/arm') {
				json(response, 201, current);
			} else if (request.method === 'DELETE') {
				response.writeHead(204).end();
			} else {
				json(response, 200, {requestId, code: '654321', expiresAt: current.expiresAt});
			}
		}, 'best-invest');
		const prepared = await source.prepare(new AbortController().signal);
		expect(await prepared.read(new AbortController().signal)).toBe('654321');
		await prepared.cancel();
		expect(operations).toEqual(['POST /v1/best-invest/arm', `POST /v1/best-invest/${requestId}/wait`, `DELETE /v1/best-invest/${requestId}`]);
	});

	it('arms once, consumes a code once, and releases the same lease without inbox access', async () => {
		const current = lease();
		const operations: string[] = [];
		const bodies: string[] = [];
		const source = await receiver((request, response) => {
			operations.push(`${request.method} ${request.url}`);
			let body = '';
			request.on('data', (chunk: Uint8Array) => {
				body += Buffer.from(chunk).toString();
			});
			request.on('end', () => {
				bodies.push(body);
				if (request.url === '/v1/clal/arm') {
					json(response, 201, current);
				} else if (request.method === 'DELETE') {
					response.writeHead(204).end();
				} else {
					json(response, 200, {requestId, code: '123456', expiresAt: current.expiresAt});
				}
			});
		});
		const prepared = await source.prepare(new AbortController().signal);
		expect(await prepared.read(new AbortController().signal)).toBe('123456');
		await expect(prepared.read(new AbortController().signal)).rejects.toThrow('OTP_REQUIRED');
		await prepared.cancel();
		await prepared.cancel();
		expect(operations).toEqual(['POST /v1/clal/arm', `POST /v1/clal/${requestId}/wait`, `DELETE /v1/clal/${requestId}`]);
		expect(bodies).toEqual(['{}', '{}', '']);
	});

	it('polls only the armed request after pending and never requests another SMS', async () => {
		const current = lease();
		let arms = 0;
		let waits = 0;
		const source = await receiver((request, response) => {
			if (request.url === '/v1/clal/arm') {
				arms++;
				json(response, 201, current);
			} else if (request.method === 'DELETE') {
				response.writeHead(204).end();
			} else if (++waits === 1) {
				response.writeHead(202).end();
			} else {
				json(response, 200, {requestId, code: '123456', expiresAt: current.expiresAt});
			}
		});
		const prepared = await source.prepare(new AbortController().signal);
		expect(await prepared.read(new AbortController().signal)).toBe('123456');
		expect(arms).toBe(1);
		expect(waits).toBe(2);
		await prepared.cancel();
	});

	it.each([409, 410, 503])('sanitizes receiver refusal %d without exposing its body', async status => {
		const source = await receiver((_request, response) => json(response, status, {private: 'never expose message text'}));
		await expect(source.prepare(new AbortController().signal)).rejects.toThrow(/^OTP_REQUIRED$/);
	});

	it.each([
		{requestId: '../unexpected'},
		{armedAt: '2026-01-01T00:00:00Z'},
		{expiresAt: 'invalid'},
		{armedAt: '2026-02-31T00:00:00Z'},
		{extra: 'unexpected'},
	])('rejects an invalid or stale arm response (%j)', async override => {
		const source = await receiver((request, response) => {
			if (request.method === 'DELETE') {
				response.writeHead(204).end();
			} else {
				json(response, 201, {...lease(), ...override});
			}
		});
		await expect(source.prepare(new AbortController().signal)).rejects.toThrow(/^INVALID_RESPONSE$/);
	});

	it('rejects and cancels a receiver lease exceeding the maximum deadline', async () => {
		let cancellations = 0;
		const source = await receiver((request, response) => {
			if (request.method === 'DELETE') {
				cancellations++;
				response.writeHead(204).end();
			} else {
				json(response, 201, lease(180_001));
			}
		});
		await expect(source.prepare(new AbortController().signal)).rejects.toThrow('INVALID_RESPONSE');
		expect(cancellations).toBe(1);
	});

	it.each([
		{requestId: 'a-different-opaque-request'},
		{code: '12345'},
		{code: 123_456},
		{code: '１２３４５６'},
		{expiresAt: '2026-01-01T00:00:00Z'},
		{extra: 'unexpected'},
	])('refuses stale, mismatched or malformed delivered codes (%j)', async override => {
		const current = lease();
		const source = await receiver((request, response) => {
			if (request.url === '/v1/clal/arm') {
				json(response, 201, current);
			} else if (request.method === 'DELETE') {
				response.writeHead(204).end();
			} else {
				json(response, 200, {requestId, code: '123456', expiresAt: current.expiresAt, ...override});
			}
		});
		const prepared = await source.prepare(new AbortController().signal);
		await expect(prepared.read(new AbortController().signal)).rejects.toThrow('INVALID_RESPONSE');
		await prepared.cancel();
	});

	it('caps response bodies and does not follow redirects', async () => {
		const oversized = await receiver((_request, response) => json(response, 201, {content: 'private'.repeat(1000)}));
		await expect(oversized.prepare(new AbortController().signal)).rejects.toThrow(/^INVALID_RESPONSE$/);
		const redirect = await receiver((_request, response) => {
			response.writeHead(302, {Location: 'https://example.invalid'}).end();
		});
		await expect(redirect.prepare(new AbortController().signal)).rejects.toThrow(/^INVALID_RESPONSE$/);
	});

	it('bounds a stalled wait by the lease deadline', async () => {
		const current = lease(1000);
		const source = await receiver((request, response) => {
			if (request.url === '/v1/clal/arm') {
				json(response, 201, current);
			} else if (request.method === 'DELETE') {
				response.writeHead(204).end();
			}
		});
		const prepared = await source.prepare(new AbortController().signal);
		await expect(prepared.read(new AbortController().signal)).rejects.toThrow(/^TIMEOUT$/);
		await prepared.cancel();
	});

	it.each(['signal', 'cancel'] as const)('interrupts a pending wait through %s and forbids concurrent reads', async operation => {
		const current = lease();
		let waitStarted: () => void = () => undefined;
		// eslint-disable-next-line unicorn/prefer-promise-with-resolvers
		const started = new Promise<void>(resolve => {
			waitStarted = resolve;
		});
		const source = await receiver((request, response) => {
			if (request.url === '/v1/clal/arm') {
				json(response, 201, current);
			} else if (request.method === 'DELETE') {
				response.writeHead(204).end();
			} else {
				waitStarted();
			}
		});
		const prepared = await source.prepare(new AbortController().signal);
		const controller = new AbortController();
		const pending = expect(prepared.read(controller.signal)).rejects.toThrow(/^TIMEOUT$/);
		await started;
		await expect(prepared.read(controller.signal)).rejects.toThrow('OTP_REQUIRED');
		if (operation === 'signal') {
			controller.abort();
		} else {
			await prepared.cancel();
		}

		await pending;
		await prepared.cancel();
	});

	it('never connects when already aborted and rejects nonlocal socket configuration', async () => {
		const controller = new AbortController();
		controller.abort();
		const source = createGoogleMessagesOtpSource('/does-not-exist/receiver.sock');
		await expect(source.prepare(controller.signal)).rejects.toThrow('TIMEOUT');
		await expect(source.prepare(new AbortController().signal)).rejects.toThrow(/^OTP_REQUIRED$/);
		expect(() => createGoogleMessagesOtpSource('https://example.invalid')).toThrow('INVALID_RESPONSE');
	});
});
