/* eslint-disable @typescript-eslint/no-restricted-types -- Control state uses explicit null for absent observations. */
import {ClalCollectionError} from './browser.js';
import type {ClalOtpSource} from './otp.js';

export type ManualRecoveryState = 'starting' | 'awaiting_code' | 'verifying' | 'complete' | 'failed' | 'canceled' | 'expired';
export type ManualRecoveryErrorCode = 'OTP_REQUIRED' | 'COLLECTION_FAILED' | 'RECOVERY_CANCELED' | 'OTP_EXPIRED' | 'RECOVERY_INTERRUPTED';
export type ManualRecoveryStatus = {
	challengeId: string;
	state: ManualRecoveryState;
	expiresAt: string | null;
	errorCode: ManualRecoveryErrorCode | null;
};
export type ManualRecoveryError = 'recovery_in_progress' | 'recovery_not_found' | 'recovery_not_waiting' | 'recovery_expired';
export type ManualRecoveryResult = {recovery: ManualRecoveryStatus} | {error: ManualRecoveryError};
const terminalStates = new Set<ManualRecoveryState>(['complete', 'failed', 'canceled', 'expired']);
const providerLeases = new Set<string>();
const challengeLifetimeMilliseconds = 180_000;

export function hasManualRecoveryLease(provider: string): boolean {
	return providerLeases.has(provider);
}

/** Only the sanitized status may be persisted. Codes travel directly to one waiting login. */
export function createManualRecovery(options: {
	provider: string;
	requestId: string;
	now(): Date;
	abort(): void;
	persist(status: ManualRecoveryStatus): void;
}): {status(): ManualRecoveryStatus; source: ClalOtpSource; submit(code: string): ManualRecoveryResult; cancel(): ManualRecoveryResult; finish(success: boolean, errorCode?: ManualRecoveryErrorCode): void} | undefined {
	if (providerLeases.has(options.provider)) {
		return undefined;
	}

	providerLeases.add(options.provider);
	let current: ManualRecoveryStatus = {
		challengeId: options.requestId, state: 'starting',
		expiresAt: new Date(options.now().getTime() + challengeLifetimeMilliseconds).toISOString(), errorCode: null,
	};
	let prepared = false;
	let pending: {resolve(code: string): void; reject(error: Error): void} | undefined;
	let removeAbortListener: (() => void) | undefined;
	const status = (): ManualRecoveryStatus => ({...current});
	const terminal = (): boolean => terminalStates.has(current.state);
	const release = (): void => {
		clearTimeout(timer);
		removeAbortListener?.();
		removeAbortListener = undefined;
		pending?.reject(new ClalCollectionError('OTP_REQUIRED'));
		pending = undefined;
		providerLeases.delete(options.provider);
	};

	const end = (state: ManualRecoveryState, errorCode: ManualRecoveryErrorCode | null): void => {
		if (terminal()) {
			return;
		}

		current = {...current, state, expiresAt: null, errorCode};
		release();
		options.persist(status());
	};

	const timer = setTimeout(() => {
		end('expired', 'OTP_EXPIRED');
		options.abort();
	}, challengeLifetimeMilliseconds);
	timer.unref();
	return {
		status,
		source: {
			async prepare(signal) {
				if (prepared || terminal() || signal.aborted) {
					throw new ClalCollectionError('OTP_REQUIRED');
				}

				prepared = true;
				return {
					async read(readSignal) {
						if (current.state !== 'starting' || readSignal.aborted || signal.aborted) {
							throw new ClalCollectionError('OTP_REQUIRED');
						}

						current = {...current, state: 'awaiting_code'};
						return new Promise<string>((resolve, reject) => {
							pending = {resolve, reject};
							const abort = (): void => {
								end('canceled', 'RECOVERY_CANCELED');
							};

							signal.addEventListener('abort', abort, {once: true});
							readSignal.addEventListener('abort', abort, {once: true});
							removeAbortListener = () => {
								signal.removeEventListener('abort', abort);
								readSignal.removeEventListener('abort', abort);
							};
						});
					},
					async cancel() {
						// Login cleanup after consumption must not cancel the following collection.
						if (current.state === 'starting' || current.state === 'awaiting_code') {
							end('failed', 'OTP_REQUIRED');
						}
					},
				};
			},
		},
		submit(code) {
			if (current.expiresAt && options.now().getTime() >= Date.parse(current.expiresAt)) {
				end('expired', 'OTP_EXPIRED');
				options.abort();
			}

			if (current.state === 'expired') {
				return {error: 'recovery_expired'};
			}

			if (current.state !== 'awaiting_code' || !pending || !/^\d{6}$/.test(code)) {
				return {error: 'recovery_not_waiting'};
			}

			const {resolve} = pending;
			pending = undefined;
			clearTimeout(timer);
			removeAbortListener?.();
			removeAbortListener = undefined;
			current = {...current, state: 'verifying', expiresAt: null};
			resolve(code);
			return {recovery: status()};
		},
		cancel() {
			if (current.state === 'expired') {
				return {error: 'recovery_expired'};
			}

			if (terminal() && current.state !== 'canceled') {
				return {error: 'recovery_not_waiting'};
			}

			end('canceled', 'RECOVERY_CANCELED');
			options.abort();
			return {recovery: status()};
		},
		finish(success, errorCode = 'COLLECTION_FAILED') {
			end(success ? 'complete' : 'failed', success ? null : errorCode);
		},
	};
}
