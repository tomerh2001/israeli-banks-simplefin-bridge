/**
 * Scraper error mapping. Messages are FIXED per error type: bank page text
 * (which can contain names, balances or session ids) is never forwarded to
 * the ledger, the logs at info level or SimpleFIN consumers.
 */

import type {ScrapeErrorType} from '../types.js';

export type MappedScrapeError = {
	errorType: ScrapeErrorType;
	message: string;
};

export const SCRAPE_ERROR_MESSAGES: Record<ScrapeErrorType, string> = {
	INVALID_PASSWORD: 'Bank rejected the credentials',
	CHANGE_PASSWORD: 'Bank requires a password change',
	ACCOUNT_BLOCKED: 'Bank reports the account as blocked',
	TIMEOUT: 'Scrape exceeded its time limit',
	GENERIC: 'Scraper failed with a generic error',
	GENERAL_ERROR: 'Scraper failed with a general error',
	TWO_FACTOR_RETRIEVER_MISSING: 'Scraper needs a two-factor code retriever that is not configured',
	OTP_REQUIRED: 'Bank asked for a one-time code; run "bridge login" for this company',
	BRIDGE_ERROR: 'Bridge internal error',
};

const KNOWN_TYPES = new Set<string>(Object.keys(SCRAPE_ERROR_MESSAGES));

/** Require an explicit code-challenge marker; Hapoalim's /ng-portals/auth is also its normal login page. */
const OTP_PATTERN = /\botp\b|\bsms\b/i;

/** True when the (message + URL) text looks like a one-time-code challenge. */
export function looksLikeOtpChallenge(text: string | undefined): boolean {
	return text !== undefined && OTP_PATTERN.test(text);
}

/**
 * Map a library `errorType`/`errorMessage` (plus, optionally, the last page URL
 * appended to the message by the runner) to the bridge's fixed error vocabulary.
 * Never returns the raw message.
 */
export function mapScraperError(errorType?: string, errorMessage?: string): MappedScrapeError {
	if (looksLikeOtpChallenge(errorMessage)) {
		return {errorType: 'OTP_REQUIRED', message: SCRAPE_ERROR_MESSAGES.OTP_REQUIRED};
	}

	const type: ScrapeErrorType = errorType && KNOWN_TYPES.has(errorType) ? errorType as ScrapeErrorType : 'GENERIC';
	return {errorType: type, message: SCRAPE_ERROR_MESSAGES[type]};
}
