import {existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {readRuntimeEnv} from '../config.js';
import {acquireClalProfile, ClalProfileBusyError} from './browser.js';

const directories: string[] = [];
function environment() {
	const chromeDir = mkdtempSync(path.join(os.tmpdir(), 'clal-profile-test-'));
	directories.push(chromeDir);
	return {...readRuntimeEnv(), chromeDir};
}

afterEach(() => {
	for (const directory of directories) {
		rmSync(directory, {recursive: true, force: true});
	}

	directories.length = 0;
});

describe('Clal profile ownership', () => {
	it('records a private diagnostic owner and releases only its own lock', () => {
		const env = environment();
		const lease = acquireClalProfile(env);
		const lock = `${lease.profileDir}.collector-lock`;
		const ownerFile = path.join(lock, 'owner.json');
		const owner = JSON.parse(readFileSync(ownerFile, 'utf8')) as Record<string, unknown>;
		expect(owner).toMatchObject({version: 1, hostname: os.hostname(), processId: process.pid});
		expect(owner.ownershipToken).toEqual(expect.any(String));
		expect(statSync(lock).mode % 0o1000).toBe(0o700);
		expect(statSync(ownerFile).mode % 0o1000).toBe(0o600);
		lease.release();
		lease.release();
		expect(existsSync(lock)).toBe(false);
	});

	it('refuses concurrent access without removing the active owner metadata', () => {
		const env = environment();
		const lease = acquireClalProfile(env);
		const ownerFile = path.join(`${lease.profileDir}.collector-lock`, 'owner.json');
		const owner = readFileSync(ownerFile, 'utf8');
		expect(() => acquireClalProfile(env)).toThrow(ClalProfileBusyError);
		expect(readFileSync(ownerFile, 'utf8')).toBe(owner);
		lease.release();
	});

	it('never steals a lock because its recorded PID appears dead in this namespace', () => {
		const env = environment();
		const lease = acquireClalProfile(env);
		const ownerFile = path.join(`${lease.profileDir}.collector-lock`, 'owner.json');
		const owner = JSON.parse(readFileSync(ownerFile, 'utf8')) as Record<string, unknown>;
		writeFileSync(ownerFile, JSON.stringify({...owner, processId: 999_999_999, hostname: 'another-container'}));
		expect(() => acquireClalProfile(env)).toThrow(ClalProfileBusyError);
		expect(existsSync(ownerFile)).toBe(true);
		lease.release();
	});

	it('does not classify a broken profile path as contention', () => {
		const env = environment();
		writeFileSync(path.join(env.chromeDir, 'clal'), 'not a directory');
		expect(() => acquireClalProfile(env)).not.toThrow(ClalProfileBusyError);
		expect(() => acquireClalProfile(env)).toThrow();
	});

	it('does not remove a replacement lock belonging to another owner', () => {
		const env = environment();
		const lease = acquireClalProfile(env);
		const ownerFile = path.join(`${lease.profileDir}.collector-lock`, 'owner.json');
		writeFileSync(ownerFile, JSON.stringify({ownershipToken: 'another-owner'}));
		expect(() => lease.release()).toThrow('COLLECTION_FAILED');
		expect(existsSync(ownerFile)).toBe(true);
	});
});
