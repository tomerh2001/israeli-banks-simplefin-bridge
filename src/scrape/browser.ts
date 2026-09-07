/**
 * Chrome binary discovery and launch arguments shared by the headless runner
 * and the assisted (visible) login.
 */

import {existsSync, readdirSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {RuntimeEnv} from '../types.js';

/**
 * Explicit `PUPPETEER_EXECUTABLE_PATH`, else the first Chrome that puppeteer's
 * `browsers install` put under `~/.cache/puppeteer/chrome/<build>/chrome-linux64/chrome`,
 * else undefined so the library's own puppeteer default applies.
 */
export function resolveExecutablePath(env: RuntimeEnv): string | undefined {
	if (env.puppeteerExecutablePath) {
		return env.puppeteerExecutablePath;
	}

	const chromeRoot = path.join(process.env.PUPPETEER_CACHE_DIR ?? path.join(os.homedir(), '.cache', 'puppeteer'), 'chrome');
	let builds: string[];
	try {
		builds = readdirSync(chromeRoot).sort();
	} catch {
		return undefined;
	}

	for (const build of builds) {
		const candidate = path.join(chromeRoot, build, 'chrome-linux64', 'chrome');
		if (existsSync(candidate)) {
			return candidate;
		}
	}

	return undefined;
}

/**
 * Launch flags: a dedicated profile directory plus container-friendly switches.
 * Sandbox switches are added only when `CHROME_NO_SANDBOX=1` (rootless containers
 * without user namespaces); prefer running as a non-root user instead.
 */
export function buildLaunchArgs(profileDir: string): string[] {
	const args = [
		`--user-data-dir=${profileDir}`,
		'--disable-dev-shm-usage',
		'--disable-gpu',
		'--no-first-run',
		'--no-default-browser-check',
		'--password-store=basic',
	];
	if (process.env.CHROME_NO_SANDBOX === '1') {
		args.push('--no-sandbox', '--disable-setuid-sandbox');
	}

	return args;
}
