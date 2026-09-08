// eslint-disable-next-line import-x/no-extraneous-dependencies, n/no-extraneous-import
import type {Page} from 'puppeteer';
import {CLAL_PORTFOLIO_URL, ClalCollectionError, isClalLogin, withClalBrowser} from './browser.js';
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
				await page.goto(CLAL_PORTFOLIO_URL, {waitUntil: 'networkidle2'});
				if (await isClalLogin(page)) {
					throw new ClalCollectionError('OTP_REQUIRED');
				}

				return readSnapshot(page, attemptedAt, signal);
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

			const errorCode = error instanceof ClalCollectionError ? error.code : 'INVALID_RESPONSE';
			const status = errorCode === 'OTP_REQUIRED' ? 'auth_required' : 'error';
			context.store.recordFailure({status, attemptedAt, errorCode});
			context.logger.warn('Clal collection needs attention', {status, errorCode});
			return status;
		}
	};
}
