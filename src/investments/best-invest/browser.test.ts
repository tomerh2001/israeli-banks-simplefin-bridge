import {existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {readRuntimeEnv} from '../../config.js';
import {acquireClalProfile} from '../browser.js';
import {acquireBestInvestProfile, BestInvestProfileBusyError, saveBestInvestSession, validBestInvestSession} from './browser.js';

const directories: string[] = [];
function environment() {
	const chromeDir = mkdtempSync(path.join(os.tmpdir(), 'best-invest-profile-test-'));
	directories.push(chromeDir);
	return {...readRuntimeEnv(), chromeDir};
}

afterEach(() => {
	for (const directory of directories) {
		rmSync(directory, {recursive: true, force: true});
	}

	directories.length = 0;
});

describe('Best Invest browser ownership', () => {
	it('isolates the profile and private ownership file from Clal', () => {
		const env = environment();
		const clal = acquireClalProfile(env);
		const best = acquireBestInvestProfile(env);
		expect(best.profileDir).not.toBe(clal.profileDir);
		const owner = path.join(`${best.profileDir}.collector-lock`, 'owner.json');
		expect(statSync(best.profileDir).mode % 0o1000).toBe(0o700);
		expect(statSync(owner).mode % 0o1000).toBe(0o600);
		expect(JSON.parse(readFileSync(owner, 'utf8'))).toMatchObject({version: 1, processId: process.pid});
		best.release();
		expect(existsSync(`${clal.profileDir}.collector-lock`)).toBe(true);
		clal.release();
	});

	it('does not steal an existing profile lock or replace its metadata', () => {
		const env = environment();
		const lease = acquireBestInvestProfile(env);
		const ownerFile = path.join(`${lease.profileDir}.collector-lock`, 'owner.json');
		const owner = readFileSync(ownerFile, 'utf8');
		expect(() => acquireBestInvestProfile(env)).toThrow(BestInvestProfileBusyError);
		expect(readFileSync(ownerFile, 'utf8')).toBe(owner);
		lease.release();
		lease.release();
	});

	it('never removes a replacement owner when releasing its own lease', () => {
		const lease = acquireBestInvestProfile(environment());
		const ownerFile = path.join(`${lease.profileDir}.collector-lock`, 'owner.json');
		writeFileSync(ownerFile, JSON.stringify({ownershipToken: 'another-owner'}));
		expect(() => lease.release()).toThrow('COLLECTION_FAILED');
		expect(existsSync(ownerFile)).toBe(true);
	});
});

describe('Best Invest stored session validation', () => {
	const now = Date.parse('2026-09-08T06:00:00Z');
	const session = {username: '123456782', token: 'synthetic-session-token-only', expireAt: '2026-09-08T06:05:00Z'};
	it('accepts a bounded valid user session and rejects expiry or malformed tokens', () => {
		expect(validBestInvestSession(JSON.stringify(session), now)).toBe(true);
		expect(validBestInvestSession(JSON.stringify({...session, expireAt: '2026-09-08T06:00:20Z'}), now)).toBe(false);
		expect(validBestInvestSession(JSON.stringify({...session, username: 'wrong'}), now)).toBe(false);
		expect(validBestInvestSession(JSON.stringify({...session, token: null}), now)).toBe(false);
		expect(validBestInvestSession('not-json', now)).toBe(false);
		expect(validBestInvestSession('x'.repeat(65_537), now)).toBe(false);
	});

	it('writes a private saved session and preserves it when a later capture is invalid', () => {
		const lease = acquireBestInvestProfile(environment());
		const valid = JSON.stringify({...session, expireAt: new Date(Date.now() + 300_000).toISOString()});
		expect(saveBestInvestSession(lease.profileDir, valid)).toBe(true);
		const sessionFile = path.join(lease.profileDir, 'portal-session.json');
		expect(statSync(sessionFile).mode % 0o1000).toBe(0o600);
		expect(readFileSync(sessionFile, 'utf8')).toBe(valid);
		expect(saveBestInvestSession(lease.profileDir, null)).toBe(false);
		expect(readFileSync(sessionFile, 'utf8')).toBe(valid);
		lease.release();
	});
});
