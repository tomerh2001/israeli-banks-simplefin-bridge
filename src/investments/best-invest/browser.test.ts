import {spawn, type ChildProcess} from 'node:child_process';
import {EventEmitter, once} from 'node:events';
import {existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {readRuntimeEnv} from '../../config.js';
import {acquireClalProfile} from '../browser.js';
import {acquireBestInvestProfile, BestInvestProfileBusyError, saveBestInvestSession, stopBestInvestProcess, validBestInvestSession, withBestInvestBrowser} from './browser.js';

const directories: string[] = [];
const children: ChildProcess[] = [];
function environment() {
	const chromeDir = mkdtempSync(path.join(os.tmpdir(), 'best-invest-profile-test-'));
	directories.push(chromeDir);
	return {...readRuntimeEnv(), chromeDir};
}

afterEach(async () => {
	vi.restoreAllMocks();
	for (const child of children) {
		if (child.exitCode !== null || child.signalCode !== null) {
			continue;
		}

		const exited = once(child, 'exit');
		child.kill('SIGKILL');
		// eslint-disable-next-line no-await-in-loop -- Reap every synthetic child before releasing its test directory.
		await exited;
	}

	children.length = 0;
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

async function syntheticChild(ignoreTerm = false): Promise<ChildProcess> {
	const child = spawn(process.execPath, ['-e', `
		${ignoreTerm ? 'process.on(\'SIGTERM\', () => {});' : ''}
		process.on('message', message => {
			if (message === 'close') setTimeout(() => process.exit(0), 50);
		});
		process.send('ready');
	`], {stdio: ['ignore', 'ignore', 'ignore', 'ipc']});
	children.push(child);
	await once(child, 'message');
	return child;
}

describe('Best Invest native browser shutdown', () => {
	it('allows asynchronous native cleanup after a close request without sending SIGTERM', async () => {
		const child = await syntheticChild();
		const kill = vi.spyOn(child, 'kill');
		// CDP acknowledgement can return while the native process is still cleaning up.
		child.send('close');
		expect(child.exitCode).toBeNull();
		await stopBestInvestProcess(child, 1000, 1000);
		expect(child.exitCode).toBe(0);
		expect(kill).not.toHaveBeenCalled();
		expect(child.listenerCount('exit')).toBe(0);
	});

	it('sends SIGTERM only after the natural-exit grace expires', async () => {
		const child = await syntheticChild();
		const kill = vi.spyOn(child, 'kill');
		await stopBestInvestProcess(child, 20, 1000);
		expect(kill.mock.calls).toEqual([['SIGTERM']]);
		expect(child.signalCode).toBe('SIGTERM');
		expect(child.listenerCount('exit')).toBe(0);
	});

	it('escalates to SIGKILL when an unresponsive native process ignores SIGTERM', async () => {
		const child = await syntheticChild(true);
		const kill = vi.spyOn(child, 'kill');
		await stopBestInvestProcess(child, 20, 50);
		expect(kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
		expect(child.signalCode).toBe('SIGKILL');
		expect(child.listenerCount('exit')).toBe(0);
	});

	it('finishes cleanup even when the collection abort signal is already set', async () => {
		const controller = new AbortController();
		const child = await syntheticChild();
		const kill = vi.spyOn(child, 'kill');
		let closing: Promise<void> | undefined;
		controller.signal.addEventListener('abort', () => {
			child.send('close');
			closing = stopBestInvestProcess(child, 1000, 1000);
		}, {once: true});
		controller.abort();
		await closing;
		expect(controller.signal.aborted).toBe(true);
		expect(child.exitCode).toBe(0);
		expect(kill).not.toHaveBeenCalled();
	});

	it('rejects an already-aborted collection before browser launch and releases its own lease', async () => {
		const env = environment();
		const controller = new AbortController();
		controller.abort();
		const work = vi.fn();
		await expect(withBestInvestBrowser({env, signal: controller.signal, timeoutMinutes: 1}, work)).rejects.toThrow('TIMEOUT');
		expect(work).not.toHaveBeenCalled();
		expect(existsSync(path.join(env.chromeDir, 'best-invest.collector-lock'))).toBe(false);
	});

	it('fails within bounded waits and preserves profile ownership if process exit cannot be confirmed', async () => {
		const lease = acquireBestInvestProfile(environment());
		const owner = path.join(`${lease.profileDir}.collector-lock`, 'owner.json');
		const before = readFileSync(owner, 'utf8');
		// eslint-disable-next-line unicorn/prefer-event-target -- ChildProcess uses Node's EventEmitter exit protocol.
		const child = Object.assign(new EventEmitter(), {pid: 1, exitCode: null, signalCode: null, kill: vi.fn(() => false)}) as unknown as ChildProcess;
		await expect(stopBestInvestProcess(child, 5, 5)).rejects.toThrow('COLLECTION_FAILED');
		expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
		expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
		expect(child.listenerCount('exit')).toBe(0);
		expect(readFileSync(owner, 'utf8')).toBe(before);
		lease.release();
	});

	it('does not signal a native process that has already exited or was never launched', async () => {
		const child = await syntheticChild();
		const exited = once(child, 'exit');
		child.send('close');
		await exited;
		const kill = vi.spyOn(child, 'kill');
		await stopBestInvestProcess(child, 20, 20);
		await stopBestInvestProcess(undefined, 20, 20);
		expect(kill).not.toHaveBeenCalled();
	});
});
