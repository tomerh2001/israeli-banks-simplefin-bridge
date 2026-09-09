import {Buffer} from 'node:buffer';
import {request} from 'node:http';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {ClalCollectionError} from './browser.js';

export type ClalOtpRequest = {
	read(signal: AbortSignal): Promise<string>;
	/** Release the receiver lease even when the browser operation was canceled. */
	cancel(): Promise<void>;
};

export type ClalOtpSource = {
	/** Establish a live inbound cursor before the browser requests its SMS. */
	prepare(signal: AbortSignal): Promise<ClalOtpRequest>;
};

type ReceiverResponse = {status: number; body: string; contentType: string};
const maximumBodyBytes = 4096;
const maximumLeaseMilliseconds = 180_000;

/** Fixed local socket operations only; response content never enters exception messages. */
async function receiverRequest(socketPath: string, method: 'GET' | 'POST' | 'DELETE', route: string, timeoutMilliseconds: number, signal?: AbortSignal): Promise<ReceiverResponse> {
	if (signal?.aborted) {
		throw new ClalCollectionError('TIMEOUT');
	}

	return new Promise((resolve, reject) => {
		let settled = false;
		const request_ = request({socketPath, path: route, method, signal, headers: {
			'Content-Type': 'application/json', 'Content-Length': method === 'POST' ? 2 : 0,
		}});
		const finish = (error?: ClalCollectionError, response?: ReceiverResponse): void => {
			if (settled) {
				return;
			}

			settled = true;
			clearTimeout(timer);
			if (error) {
				request_.destroy();
				reject(error);
			} else {
				resolve(response!);
			}
		};

		const timer = setTimeout(() => finish(new ClalCollectionError('TIMEOUT')), timeoutMilliseconds);
		request_.on('error', () => finish(new ClalCollectionError(signal?.aborted ? 'TIMEOUT' : 'OTP_REQUIRED')));
		request_.on('response', response => {
			const chunks: Uint8Array[] = [];
			let bytes = 0;
			response.on('data', (chunk: Uint8Array) => {
				bytes += chunk.length;
				if (bytes > maximumBodyBytes) {
					finish(new ClalCollectionError('INVALID_RESPONSE'));
					response.destroy();
					return;
				}

				chunks.push(chunk);
			});
			response.on('aborted', () => finish(new ClalCollectionError('OTP_REQUIRED')));
			response.on('error', () => finish(new ClalCollectionError('OTP_REQUIRED')));
			response.on('end', () => finish(undefined, {
				status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'),
				contentType: response.headers['content-type'] ?? '',
			}));
		});
		request_.end(method === 'POST' ? '{}' : undefined);
	});
}

const receiverStates = ['ready', 'connecting', 'disconnected', 'inactive', 'phone_unavailable', 'phone_syncing', 'reauth_required'] as const;
export type GoogleMessagesHealth = {ready: boolean; reason: typeof receiverStates[number] | 'unavailable'};
export type GoogleMessagesProvider = 'clal' | 'best-invest';

/** Reads configured provider readiness. Never arms a lease, lists messages, or requests an SMS. */
export async function readGoogleMessagesHealth(socketPath: string, provider: GoogleMessagesProvider): Promise<GoogleMessagesHealth> {
	try {
		if (!path.isAbsolute(socketPath) || socketPath.includes('\0')) {
			return {ready: false, reason: 'unavailable'};
		}

		const value = objectResponse(await receiverRequest(socketPath, 'GET', `/v1/${provider}/healthz`, 3000), 200, ['online', 'state']);
		const reason = receiverStates.find(state => state === value.state) ?? 'unavailable';
		const ready = value.online === true && reason === 'ready';
		return {ready, reason: !ready && reason === 'ready' ? 'unavailable' : reason};
	} catch {
		return {ready: false, reason: 'unavailable'};
	}
}

function objectResponse(response: ReceiverResponse, expectedStatus: number, keys: string[]): Record<string, unknown> {
	if (response.status !== expectedStatus) {
		throw new ClalCollectionError([404, 409, 410, 503].includes(response.status) ? 'OTP_REQUIRED' : 'INVALID_RESPONSE');
	}

	if (!/^application\/json(?:\s*;|$)/i.test(response.contentType)) {
		throw new ClalCollectionError('INVALID_RESPONSE');
	}

	try {
		const value: unknown = JSON.parse(response.body);
		if (!value || typeof value !== 'object' || Array.isArray(value)
			|| Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
			throw new ClalCollectionError('INVALID_RESPONSE');
		}

		return value as Record<string, unknown>;
	} catch {
		throw new ClalCollectionError('INVALID_RESPONSE');
	}
}

function timestamp(value: unknown): number {
	if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)) {
		throw new ClalCollectionError('INVALID_RESPONSE');
	}

	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 19) !== value.slice(0, 19)) {
		throw new ClalCollectionError('INVALID_RESPONSE');
	}

	return parsed;
}

/** Google Messages stays in a separate receiver; this client cannot list an inbox or send SMS. */
export function createGoogleMessagesOtpSource(socketPath: string, provider: GoogleMessagesProvider = 'clal'): ClalOtpSource {
	if (!path.isAbsolute(socketPath) || socketPath.includes('\0')) {
		throw new ClalCollectionError('INVALID_RESPONSE');
	}

	return {
		async prepare(signal) {
			const startedAt = Date.now();
			const response = objectResponse(await receiverRequest(socketPath, 'POST', `/v1/${provider}/arm`, 10_000, signal), 201, ['requestId', 'armedAt', 'expiresAt']);
			const {requestId} = response;
			if (typeof requestId !== 'string' || !/^[\w-]{20,128}$/.test(requestId)) {
				throw new ClalCollectionError('INVALID_RESPONSE');
			}

			const route = `/v1/${provider}/${requestId}`;
			const requestController = new AbortController();
			let canceled = false;
			let reading = false;
			const cancel = async (): Promise<void> => {
				if (canceled) {
					return;
				}

				canceled = true;
				requestController.abort();
				try {
					await receiverRequest(socketPath, 'DELETE', route, 3000);
				} catch {
					// The server's bounded lease still expires if cancellation cannot be delivered.
				}
			};

			let expiresAt: number;
			try {
				const armedAt = timestamp(response.armedAt);
				expiresAt = timestamp(response.expiresAt);
				if (armedAt < startedAt - 1000 || armedAt > Date.now() + 1000
					|| expiresAt <= Date.now() || expiresAt <= armedAt || expiresAt - armedAt > maximumLeaseMilliseconds) {
					throw new ClalCollectionError('INVALID_RESPONSE');
				}

				if (signal.aborted) {
					throw new ClalCollectionError('TIMEOUT');
				}
			} catch (error) {
				await cancel();
				throw error;
			}

			return {
				cancel,
				async read(readSignal) {
					if (reading || canceled) {
						throw new ClalCollectionError('OTP_REQUIRED');
					}

					reading = true;
					const combinedSignal = AbortSignal.any([readSignal, requestController.signal]);
					for (;;) {
						if (combinedSignal.aborted || Date.now() >= expiresAt) {
							throw new ClalCollectionError('TIMEOUT');
						}

						// eslint-disable-next-line no-await-in-loop -- Consume one armed request sequentially; concurrent polls could race delivery.
						const result = await receiverRequest(socketPath, 'POST', `${route}/wait`, Math.min(25_000, expiresAt - Date.now()), combinedSignal);
						if (combinedSignal.aborted || Date.now() >= expiresAt) {
							throw new ClalCollectionError('TIMEOUT');
						}

						if (result.status === 202) {
							try {
								// eslint-disable-next-line no-await-in-loop -- Pending responses need bounded spacing before the next poll.
								await delay(Math.min(1000, expiresAt - Date.now()), undefined, {signal: combinedSignal});
							} catch {
								throw new ClalCollectionError('TIMEOUT');
							}

							continue;
						}

						const value = objectResponse(result, 200, ['requestId', 'code', 'expiresAt']);
						if (value.requestId !== requestId || timestamp(value.expiresAt) !== expiresAt
							|| typeof value.code !== 'string' || !/^\d{6}$/.test(value.code)) {
							throw new ClalCollectionError('INVALID_RESPONSE');
						}

						return value.code;
					}
				},
			};
		},
	};
}
