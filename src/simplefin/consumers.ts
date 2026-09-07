/**
 * Consumer (SimpleFIN client) management: mint setup tokens, rotate, revoke, list.
 *
 * A consumer is identified by `slug(label)`. Minting creates the Basic-auth user,
 * a random secret (stored hashed; the plain value is kept only while the claim is
 * open, i.e. until `claimTtlMinutes`/`maxClaims`, so re-claims return the same
 * Access URL) and a one-time claim id that is embedded in the base64 setup token.
 */

import {Buffer} from 'node:buffer';
import {randomBytes} from 'node:crypto';
import type {Config, Consumer, Ledger} from '../types.js';
import {hashSecret} from './auth.js';
import {isClaimOpen} from './claim.js';

export type MintOptions = {
	label: string;
	/** Replace the secret and claim of an existing consumer (also un-revokes it). */
	rotate?: boolean;
	now?: Date;
};

export type MintResult = {
	/** base64(publicUrl + '/simplefin/claim/' + claimId), what the operator pastes into Securo. */
	setupToken: string;
	claimUrl: string;
	consumer: Consumer;
};

const basicUserSuffixLength = 6;
const secretBytes = 32;
const claimIdBytes = 18; // 24 base64url characters

/** Lower-case `[a-z0-9-]` slug of a label; throws when nothing usable remains. */
export function slug(label: string): string {
	const value = label
		.toLowerCase()
		.normalize('NFKD')
		.replaceAll(/[^0-9a-z]+/g, '-')
		.replaceAll(/^-+|-+$/g, '');
	if (!value) {
		throw new Error('Consumer label must contain at least one letter or digit');
	}

	return value;
}

function randomLowerAlnum(length: number): string {
	const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
	const bytes = randomBytes(length);
	let out = '';
	for (const byte of bytes) {
		out += alphabet[byte % alphabet.length];
	}

	return out;
}

/** Path of the claim endpoint for a claim id (relative to the public URL). */
export function claimPath(claimId: string): string {
	return `/simplefin/claim/${claimId}`;
}

/** Build the base64 setup token for a claim URL. */
export function encodeSetupToken(claimUrl: string): string {
	return Buffer.from(claimUrl, 'utf8').toString('base64');
}

function freshClaim(config: Config, now: Date): Pick<Consumer, 'claimId' | 'claimExpiresAt' | 'claimCount' | 'maxClaims' | 'claimedAt'> {
	return {
		claimId: randomBytes(claimIdBytes).toString('base64url'),
		claimExpiresAt: new Date(now.getTime() + (config.server.claimTtlMinutes * 60_000)).toISOString(),
		claimCount: 0,
		maxClaims: config.server.maxClaims,
		claimedAt: undefined,
	};
}

/**
 * Create a consumer (or, with `rotate`, replace the secret and claim of an existing one)
 * and return its setup token. Throws when the consumer exists and `rotate` is not set.
 */
export function mintConsumerToken(ledger: Ledger, config: Config, options: MintOptions): MintResult {
	const now = options.now ?? new Date();
	const id = slug(options.label);
	const existing = ledger.getConsumer(id);
	if (existing && !options.rotate) {
		throw new Error(`Consumer "${id}" already exists; use rotate to re-issue its token`);
	}

	const secretPlain = randomBytes(secretBytes).toString('base64url');
	const consumer: Consumer = {
		id,
		label: options.label,
		basicUser: existing?.basicUser ?? `${id}-${randomLowerAlnum(basicUserSuffixLength)}`,
		secretHash: hashSecret(secretPlain),
		secretPlain,
		...freshClaim(config, now),
		firstAuthenticatedAt: undefined,
		lastSeenAt: existing?.lastSeenAt,
		createdAt: existing?.createdAt ?? now.toISOString(),
		revokedAt: undefined,
	};

	if (existing) {
		ledger.updateConsumer(consumer);
	} else {
		ledger.createConsumer(consumer);
	}

	const claimUrl = `${config.server.publicUrl}${claimPath(consumer.claimId!)}`;
	return {setupToken: encodeSetupToken(claimUrl), claimUrl, consumer};
}

/** Revoke a consumer: its Basic credentials stop working and its claim answers 403. Returns false when unknown. */
export function revokeConsumer(ledger: Ledger, label: string, now = new Date()): boolean {
	const consumer = ledger.getConsumer(slug(label));
	if (!consumer) {
		return false;
	}

	ledger.updateConsumer({...consumer, revokedAt: consumer.revokedAt ?? now.toISOString(), secretPlain: undefined});
	return true;
}

/**
 * Wipe the plain secret of every consumer whose claim is no longer open (expired
 * or exhausted without ever being touched again). Returns how many were wiped.
 */
export function sweepClosedClaims(ledger: Ledger, now = new Date()): number {
	let wiped = 0;
	for (const consumer of ledger.listConsumers()) {
		if (consumer.secretPlain === undefined || isClaimOpen(consumer, now)) {
			continue;
		}

		ledger.updateConsumer({...consumer, secretPlain: undefined});
		wiped++;
	}

	return wiped;
}

/** All consumers, including revoked ones, sorted by id. Secrets are never included. */
export function listConsumers(ledger: Ledger): Array<Omit<Consumer, 'secretHash' | 'secretPlain'>> {
	return ledger
		.listConsumers()
		.sort((a, b) => a.id.localeCompare(b.id))
		.map(({secretHash, secretPlain, ...rest}) => rest);
}
