import {ClalCollectionError, ClalProfileBusyError} from './browser.js';
import {assistedClalLogin} from './login.js';
import {createGoogleMessagesOtpSource, type ClalOtpSource} from './otp.js';
import type {InvestmentCollectionContext, InvestmentCollector} from './runtime.js';
import type {InvestmentStore} from './types.js';

export type ClalRecoveryDependencies = {
	login?: typeof assistedClalLogin;
	otpSource?: (socketPath: string) => ClalOtpSource;
	now?: () => Date;
};

/** Called by the login while it still owns the profile. Never changes financial freshness. */
export function clalSessionVerifiedCallback(store: InvestmentStore, signal: AbortSignal, now: () => Date = () => new Date()): (remainingSeconds: number) => void {
	return remainingSeconds => {
		if (signal.aborted) {
			return;
		}

		const checkedAt = now();
		store.setSessionState({
			status: 'active', lastCheckedAt: checkedAt.toISOString(),
			lastRenewedAt: store.getSessionState().lastRenewedAt,
			expiresAt: new Date(checkedAt.getTime() + (remainingSeconds * 1000)).toISOString(), errorCode: null,
		});
	};
}

/** One automatic login only. The receiver must be ready before reserving and requesting its SMS. */
export async function automaticClalLogin(context: InvestmentCollectionContext, dependencies: ClalRecoveryDependencies = {}, onSmsAttemptReserved: () => void = () => undefined): Promise<void> {
	const socketPath = context.config.googleMessagesOtpSocket;
	if (!socketPath) {
		throw new ClalCollectionError('OTP_REQUIRED');
	}

	context.signal.throwIfAborted();
	const now = dependencies.now ?? (() => new Date());
	await (dependencies.login ?? assistedClalLogin)({
		env: {...context.env, showBrowser: true}, config: context.config, secrets: context.secrets,
		timeoutMinutes: context.config.timeoutMinutes, signal: context.signal,
		otpSource: (dependencies.otpSource ?? createGoogleMessagesOtpSource)(socketPath),
		async beforeSmsRequest(signal) {
			signal.throwIfAborted();
			if (!context.store.consumeAutomaticSmsAttempt(now().toISOString())) {
				context.logger.warn('Clal automatic SMS allowance exhausted', {errorCode: 'OTP_REQUIRED'});
				throw new ClalCollectionError('OTP_REQUIRED');
			}

			onSmsAttemptReserved();
		},
		onSessionVerified: clalSessionVerifiedCallback(context.store, context.signal, now),
	});
}

/** Only a real collection authentication failure may trigger one login and one retry. */
export function createClalRecoveryCollector(collect: InvestmentCollector, dependencies: ClalRecoveryDependencies = {}): InvestmentCollector {
	return async context => {
		const status = await collect(context);
		if (status !== 'auth_required' || !context.config.googleMessagesOtpSocket) {
			return status;
		}

		if (context.signal.aborted) {
			return 'error';
		}

		let smsReserved = false;
		try {
			await automaticClalLogin(context, dependencies, () => {
				smsReserved = true;
			});
			if (context.signal.aborted) {
				return 'error';
			}

			const retryStatus = await collect(context);
			// End this scheduled occurrence even when another process takes the profile
			// after login. A 30-second busy retry must not trigger another SMS sequence.
			return retryStatus === 'skipped' ? 'error' : retryStatus;
		} catch (error) {
			if (context.signal.aborted) {
				return 'error';
			}

			if (error instanceof ClalProfileBusyError && !smsReserved) {
				return 'skipped';
			}

			const errorCode = error instanceof ClalCollectionError ? error.code : 'COLLECTION_FAILED';
			context.logger.warn('Clal automatic authentication did not complete', {errorCode});
			return 'auth_required';
		}
	};
}
