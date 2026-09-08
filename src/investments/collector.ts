// eslint-disable-next-line import-x/no-extraneous-dependencies, n/no-extraneous-import
import type {Page} from 'puppeteer';
import {CLAL_PORTFOLIO_URL, ClalCollectionError, ClalProfileBusyError, isClalLogin, withClalBrowser} from './browser.js';
import {readClalSessionRemaining} from './session.js';
import type {InvestmentCollector} from './runtime.js';
import type {InvestmentSnapshot} from './types.js';

export type ClalSnapshotReader = (page: Page, observedAt: string, signal: AbortSignal) => Promise<InvestmentSnapshot>;

/** Collection only reuses the saved session; assisted login is a separate operator action. */
export function createClalCollector(readSnapshot: ClalSnapshotReader): InvestmentCollector {
	return async context => {
		if (context.signal.aborted) {
			return 'error';
		}

		const attemptedAt = new Date().toISOString();
		try {
			const snapshot = await withClalBrowser({...context, timeoutMinutes: context.config.timeoutMinutes}, async (page, signal) => {
				await page.goto(CLAL_PORTFOLIO_URL, {waitUntil: 'domcontentloaded'});
				if (await isClalLogin(page)) {
					throw new ClalCollectionError('OTP_REQUIRED');
				}

				const snapshot = await readSnapshot(page, attemptedAt, signal);
				try {
					// A verified protected snapshot proves access. This ancillary timer read
					// must not discard financial data if its separate endpoint is unavailable.
					const remainingSeconds = await readClalSessionRemaining(page);
					if (!signal.aborted) {
						const checkedAt = new Date();
						context.store.setSessionState({
							...context.store.getSessionState(), status: 'active',
							lastCheckedAt: checkedAt.toISOString(),
							expiresAt: new Date(checkedAt.getTime() + (remainingSeconds * 1000)).toISOString(), errorCode: null,
						});
					}
				} catch (error) {
					if (!signal.aborted) {
						const errorCode = error instanceof ClalCollectionError ? error.code : 'INVALID_RESPONSE';
						context.store.setSessionState({
							...context.store.getSessionState(), status: errorCode === 'OTP_REQUIRED' ? 'auth_required' : 'error',
							lastCheckedAt: new Date().toISOString(), expiresAt: null, errorCode,
						});
					}
				}

				return snapshot;
			});
			if (context.signal.aborted) {
				return 'error';
			}

			const result = context.store.applySnapshot(snapshot);
			context.logger.info('Clal collection completed', {status: result.applied ? 'ok' : 'partial', products: snapshot.products.length});
			return result.applied ? 'ok' : 'partial';
		} catch (error) {
			if (context.signal.aborted) {
				return 'error';
			}

			if (error instanceof ClalProfileBusyError) {
				context.logger.info('Clal collection skipped; profile is in use');
				return 'skipped';
			}

			const errorCode = error instanceof ClalCollectionError ? error.code : 'INVALID_RESPONSE';
			const status = errorCode === 'OTP_REQUIRED' ? 'auth_required' : 'error';
			if (status === 'auth_required') {
				context.store.setSessionState({
					...context.store.getSessionState(), status: 'auth_required',
					// Browser ownership has already been released. A newer assisted login
					// must take precedence over this older attempt's authentication failure.
					lastCheckedAt: attemptedAt, expiresAt: null, errorCode,
				});
			}

			context.store.recordFailure({status, attemptedAt, errorCode});
			context.logger.warn('Clal collection needs attention', {status, errorCode});
			return status;
		}
	};
}
