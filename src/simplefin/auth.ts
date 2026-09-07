/**
 * HTTP Basic auth parsing and consumer-secret hashing.
 *
 * Secrets are stored as `scrypt$<saltB64>$<hashB64>` (N=16384, r=8, p=1, 32-byte key)
 * and compared with a timing-safe comparison of the derived keys.
 */

import {Buffer} from 'node:buffer';
import {randomBytes, scryptSync, timingSafeEqual} from 'node:crypto';

const scryptOptions = {N: 16_384, r: 8, p: 1};
const keyLength = 32;
const saltLength = 16;

export type BasicCredentials = {
	user: string;
	secret: string;
};

/**
 * Parse an `Authorization: Basic <base64(user:secret)>` header.
 * Returns undefined for a missing/malformed header; the secret may contain ':'.
 */
export function parseBasicAuth(header: string | undefined): BasicCredentials | undefined {
	if (!header) {
		return undefined;
	}

	const [scheme, token, ...rest] = header.trim().split(/\s+/);
	if (scheme?.toLowerCase() !== 'basic' || !token || rest.length > 0) {
		return undefined;
	}

	const decoded = Buffer.from(token, 'base64').toString('utf8');

	const separator = decoded.indexOf(':');
	if (separator <= 0) {
		return undefined;
	}

	return {user: decoded.slice(0, separator), secret: decoded.slice(separator + 1)};
}

/** Derive `scrypt$<saltB64>$<hashB64>` for a fresh random salt. */
export function hashSecret(secret: string): string {
	const salt = randomBytes(saltLength);
	const hash = scryptSync(secret, salt, keyLength, scryptOptions);
	return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/** Hash verified in place of a missing one so unknown and known users cost the same time. */
export const DUMMY_SECRET_HASH = hashSecret('dummy-secret-for-constant-time-auth');

/** Timing-safe check of `secret` against a stored `scrypt$...` hash. Malformed hashes never verify. */
export function verifySecret(storedHash: string | undefined, secret: string): boolean {
	if (!storedHash) {
		return false;
	}

	const [scheme, saltB64, hashB64] = storedHash.split('$');
	if (scheme !== 'scrypt' || !saltB64 || !hashB64) {
		return false;
	}

	const expected = Buffer.from(hashB64, 'base64');
	if (expected.length !== keyLength) {
		return false;
	}

	const actual = scryptSync(secret, Buffer.from(saltB64, 'base64'), keyLength, scryptOptions);
	return timingSafeEqual(actual, expected);
}
