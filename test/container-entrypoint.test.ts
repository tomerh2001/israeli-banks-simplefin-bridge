import {execFileSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {parseCommandLine} from '../src/cli/args.js';

describe('container entrypoint dispatch', () => {
	let stubDir: string;

	beforeAll(() => {
		// /tmp may be mounted noexec on the service host; keep executable stubs in the cache.
		const cache = path.join(os.homedir(), '.cache');
		mkdirSync(cache, {recursive: true});
		stubDir = mkdtempSync(path.join(cache, 'bridge-entrypoint-test-'));
		for (const command of ['xvfb-run', 'bridge', 'stub-command']) {
			writeFileSync(path.join(stubDir, command), `#!/usr/bin/env node\nconsole.log(JSON.stringify({command: ${JSON.stringify(command)}, args: process.argv.slice(2)}));\n`, {mode: 0o700});
		}
	});

	afterAll(() => {
		rmSync(stubDir, {recursive: true, force: true});
	});

	function dispatch(args: string[]): {command: string; args: string[]} {
		const output = execFileSync('/bin/sh', ['scripts/container-entrypoint.sh', ...args], {
			cwd: process.cwd(),
			env: {...process.env, PATH: `${stubDir}${path.delimiter}${process.env.PATH ?? ''}`},
			encoding: 'utf8',
		});
		return JSON.parse(output) as {command: string; args: string[]};
	}

	it.each([
		['serve'],
		['scrape', 'hapoalim', '--config', '/config with spaces.json'],
		['--config', '/config with spaces.json', '--verbose', 'scrape', 'hapoalim'],
		['--data-dir', '/data with spaces', '--config=/config.json', 'serve'],
		['--data-dir=/data with spaces', '--verbose', 'serve'],
		['--force', '--from', '2026-09-01', 'scrape', 'hapoalim'],
		['--', 'scrape', 'hapoalim'],
	])('supplies a display without changing supported CLI arguments: %j', (...args) => {
		expect(parseCommandLine(args)).toHaveProperty('command');
		expect(dispatch(['bridge', ...args])).toEqual({
			command: 'xvfb-run',
			args: ['--auto-servernum', '--server-num=98', '--server-args=-screen 0 1280x900x24 -nolisten tcp', 'bridge', ...args],
		});
	});

	it.each([
		['login', 'hapoalim'],
		['--config', '/config with spaces.json', '--verbose', 'login', 'hapoalim'],
		['status'],
		['--help'],
	])('runs assisted login and metadata commands without a display wrapper: %j', (...args) => {
		expect(parseCommandLine(args)).toBeDefined();
		expect(dispatch(['bridge', ...args])).toEqual({command: 'bridge', args});
	});

	it('preserves an arbitrary command and its argument boundaries', () => {
		const args = ['serve', 'space in one argument', '$(literal)', '--config=file'];
		expect(dispatch(['stub-command', ...args])).toEqual({command: 'stub-command', args});
	});
});
