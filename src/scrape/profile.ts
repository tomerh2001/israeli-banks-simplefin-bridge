/**
 * One Chrome profile per company under `DATA_DIR/chrome/<companyId>`.
 * Profiles carry the bank's device-trust cookies, so they are precious;
 * only `resetProfile` (CLI `bridge reset-profile`) deletes one.
 */

import {mkdirSync, rmSync} from 'node:fs';
import path from 'node:path';
import type {CompanyId, RuntimeEnv} from '../types.js';

/** Chrome leaves these behind when it is killed; a new launch refuses to start while they exist. */
const SINGLETON_FILES = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];

/** Absolute profile directory for the company, created with mode 0700. */
export function ensureProfileDir(env: RuntimeEnv, company: CompanyId): string {
	const profileDir = path.resolve(env.chromeDir, company);
	mkdirSync(profileDir, {recursive: true, mode: 0o700});
	return profileDir;
}

/** Remove stale `Singleton*` lock files (symlinks) left by a killed Chrome. */
export function clearStaleLocks(profileDir: string): void {
	for (const name of SINGLETON_FILES) {
		rmSync(path.join(profileDir, name), {force: true});
	}
}

/** Delete the company's profile directory entirely. Returns the path that was removed. */
export function resetProfile(env: RuntimeEnv, company: CompanyId): string {
	const profileDir = path.resolve(env.chromeDir, company);
	rmSync(profileDir, {recursive: true, force: true});
	return profileDir;
}
