/**
 * POST /simplefin/claim/:claimId — exchange a one-time claim id for an Access URL.
 *
 * Rules: the consumer must exist and not be revoked, the claim must not be expired
 * and `claimCount < maxClaims`. Every successful claim increments `claimCount` and
 * returns the SAME Access URL, also after the first authenticated GET: Securo's
 * connect performs claim + account list + a 365-day backfill in one request and
 * rolls everything back on a mid-way failure, so the operator must be able to
 * re-paste the same token until the TTL or maxClaims closes the claim. Once the
 * claim is closed the plain secret is wiped and the claim answers 403 forever.
 */

import {createLogger, type Logger} from '../log.js';
import type {Config, Consumer, Ledger} from '../types.js';

export type ClaimResult =
	| {status: 200; body: string}
	| {status: 403 | 404};

const defaultLogger = createLogger('simplefin:claim');

/** `scheme://<basicUser>:<secret>@<host[:port]>/simplefin` derived from the public URL. */
export function buildAccessUrl(publicUrl: string, basicUser: string, secret: string): string {
	const url = new URL(publicUrl);
	const basePath = url.pathname.replace(/\/+$/, '');
	return `${url.protocol}//${encodeURIComponent(basicUser)}:${encodeURIComponent(secret)}@${url.host}${basePath}/simplefin`;
}

/** True while the claim can still be exchanged: plain secret present, TTL not passed, claims left. */
export function isClaimOpen(consumer: Consumer, now: Date): boolean {
	return rejectionReason(consumer, now) === undefined;
}

function rejectionReason(consumer: Consumer | undefined, now: Date): string | undefined {
	if (!consumer) {
		return 'unknown';
	}

	if (consumer.revokedAt) {
		return 'revoked';
	}

	if (!consumer.claimExpiresAt || Date.parse(consumer.claimExpiresAt) <= now.getTime()) {
		return 'expired';
	}

	if (consumer.claimCount >= consumer.maxClaims) {
		return 'max_claims';
	}

	if (!consumer.secretPlain) {
		return 'closed';
	}

	return undefined;
}

/** Drop the plain secret of a consumer whose claim is over; the hash keeps authenticating it. */
function wipePlainSecret(ledger: Ledger, consumer: Consumer): void {
	if (consumer.secretPlain !== undefined) {
		ledger.updateConsumer({...consumer, secretPlain: undefined});
	}
}

/** Handle a claim; logs the outcome with the remote ip (never the secret or the URL). */
export function handleClaim(ledger: Ledger, config: Config, claimId: string, now: Date, remoteIp: string, logger: Logger = defaultLogger): ClaimResult {
	const consumer = claimId ? ledger.getConsumerByClaimId(claimId) : undefined;
	const reason = rejectionReason(consumer, now);
	if (reason) {
		if (consumer && reason !== 'closed') {
			wipePlainSecret(ledger, consumer);
		}

		logger.info('claim refused', {consumer: consumer?.id, reason, remoteIp});
		return {status: reason === 'unknown' ? 404 : 403};
	}

	const claimed: Consumer = {...consumer!, claimCount: consumer!.claimCount + 1, claimedAt: now.toISOString()};
	const accessUrl = buildAccessUrl(config.server.publicUrl, claimed.basicUser, claimed.secretPlain!);
	if (claimed.claimCount >= claimed.maxClaims) {
		claimed.secretPlain = undefined;
	}

	ledger.updateConsumer(claimed);
	logger.info('claim accepted', {consumer: claimed.id, claimCount: claimed.claimCount, maxClaims: claimed.maxClaims, remoteIp});
	return {status: 200, body: accessUrl};
}
