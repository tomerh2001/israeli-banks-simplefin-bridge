/**
 * Smoke tests for the process entry and the `bridge` CLI: the CLI is run through
 * tsx as a child process (help, health, mint-token, status, export, usage errors)
 * against an empty temporary ledger; `serve()` is exercised in-process on a free port.
 */

import {Buffer} from 'node:buffer';
import {execFile} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';
import {parseCommandLine, table} from '../src/cli/args.js';
import {serve} from '../src/serve.js';
import type {HealthReport} from '../src/types.js';
import {createInvestmentStore} from '../src/investments/store.js';
import {silentLogger} from './helpers/seed.js';

const repoRoot = path.resolve(import.meta.dirname, '..');
const tsx = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const cliSource = path.join(repoRoot, 'src', 'cli.ts');
const COMMANDS = ['scrape', 'status', 'mint-token', 'revoke', 'login', 'unpark', 'reset-profile', 'audit', 'export', 'health', 'serve', 'clal-login', 'clal-sync', 'clal-status'];

type CliResult = {code: number; stdout: string; stderr: string};

let dataDir: string;
let configPath: string;

function writeConfig(target: string, overrides: Record<string, unknown> = {}): void {
	writeFileSync(target, JSON.stringify({
		timezone: 'Asia/Jerusalem',
		companies: {
			hapoalim: {label: 'Bank Hapoalim', kind: 'checking', credentials: {userCode: 'user-1', password: 'pass-1234'}},
		},
		// eslint-disable-next-line unicorn/prefer-https
		server: {publicUrl: 'http://bridge.test:8080'},
		...overrides,
	}));
}

async function runCli(args: string[]): Promise<CliResult> {
	const env = {...process.env, CONFIG_PATH: configPath, DATA_DIR: dataDir, OP_DISABLED: '1'};
	return new Promise(resolve => {
		execFile(process.execPath, [tsx, cliSource, ...args], {cwd: repoRoot, env, timeout: 25_000}, (error, stdout, stderr) => {
			const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
			resolve({code, stdout, stderr});
		});
	});
}

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.once('error', reject);
		probe.listen(0, '127.0.0.1', () => {
			const {port} = probe.address() as {port: number};
			probe.close(() => {
				resolve(port);
			});
		});
	});
}

/** The setup token is printed on its own line right after the "Setup token:" heading. */
function extractSetupToken(stdout: string): string {
	const afterHeading = stdout.split('Setup token:\n', 2)[1] ?? '';
	return afterHeading.split('\n', 1)[0] ?? '';
}

beforeAll(() => {
	dataDir = mkdtempSync(path.join(os.tmpdir(), 'ibs-bridge-cli-'));
	configPath = path.join(dataDir, 'config.json');
	writeConfig(configPath);
});

afterAll(() => {
	rmSync(dataDir, {recursive: true, force: true});
});

describe('argument parsing', () => {
	it('recognises every documented command and its options', () => {
		expect(parseCommandLine(['scrape', 'hapoalim', '--from', '2026-01-01', '--force'])).toMatchObject({command: 'scrape', company: 'hapoalim', values: {from: '2026-01-01', force: true}});
		expect(parseCommandLine(['mint-token', '--label', 'securo', '--rotate'])).toMatchObject({command: 'mint-token', values: {label: 'securo', rotate: true}});
		expect(parseCommandLine(['export', '--account', 'a', '--account', 'b', '--to', '2026-02-01'])).toMatchObject({command: 'export', values: {account: ['a', 'b'], to: '2026-02-01'}});
		expect(parseCommandLine(['--help'])).toEqual({help: true});
		for (const command of COMMANDS) {
			expect(parseCommandLine([command])).toMatchObject({command});
		}
	});

	it('rejects unknown commands, foreign options and stray positionals', () => {
		expect(() => parseCommandLine([])).toThrow(/Missing command/);
		expect(() => parseCommandLine(['frobnicate'])).toThrow(/Unknown command/);
		expect(() => parseCommandLine(['status', '--force'])).toThrow(/not valid for "status"/);
		expect(() => parseCommandLine(['status', 'extra'])).toThrow(/Unexpected argument/);
		expect(() => parseCommandLine(['health', '--bogus'])).toThrow(/bogus/);
		expect(() => parseCommandLine(['clal-login', '123456'])).toThrow(/Unexpected argument/);
		expect(() => parseCommandLine(['clal-login', '--otp', '123456'])).toThrow(/otp/);
		expect(() => parseCommandLine(['clal-sync', '--force'])).toThrow(/not valid/);
	});

	it('renders aligned tables', () => {
		const rendered = table(['A', 'Bee'], [['1', 'x'], ['22', 'yy']]);
		expect(rendered.split('\n')).toEqual(['A   Bee', '--  ---', '1   x', '22  yy']);
	});
});

describe('bridge CLI (child process)', () => {
	it('--help exits 0 and lists every command', async () => {
		const result = await runCli(['--help']);
		expect(result.code).toBe(0);
		for (const command of COMMANDS) {
			expect(result.stdout).toContain(`  ${command}`);
		}
	});

	it('usage errors exit 2 with the usage text', async () => {
		const result = await runCli(['nope']);
		expect(result.code).toBe(2);
		expect(result.stderr).toContain('Unknown command "nope"');
		expect(result.stderr).toContain('Usage: bridge');
	});

	it('health prints a JSON report and exits 1 on an empty ledger', async () => {
		const result = await runCli(['health']);
		expect(result.code).toBe(1);
		const report = JSON.parse(result.stdout) as HealthReport;
		expect(report.ok).toBe(false);
		expect(report.idSchemeVersion).toBe(1);
		expect(report.companies).toEqual([expect.objectContaining({company: 'hapoalim', enabled: true, healthy: false, parked: false, accounts: 0})]);
		expect(report.consumers).toEqual([]);
		expect(result.stderr).not.toContain('ExperimentalWarning');
	});

	it('mint-token prints a setup token that decodes to the claim URL, then status lists the consumer', async () => {
		const minted = await runCli(['mint-token', '--label', 'Test Consumer']);
		expect(minted.code).toBe(0);
		const token = extractSetupToken(minted.stdout);
		expect(token).toMatch(/^[\d+/=a-z]+$/i);
		const claimUrl = Buffer.from(token, 'base64').toString('utf8');
		expect(claimUrl).toMatch(/^http:\/\/bridge\.test:8080\/simplefin\/claim\/[\w-]{24}$/);
		expect(minted.stdout).toContain(`Claim URL:   ${claimUrl}`);

		const again = await runCli(['mint-token', '--label', 'Test Consumer']);
		expect(again.code).toBe(1);
		expect(again.stderr).toContain('already exists');

		const status = await runCli(['status']);
		expect(status.code).toBe(0);
		expect(status.stdout).toContain('Test Consumer');
		expect(status.stdout).toContain('test-consumer-');
		expect(status.stdout).toContain('hapoalim');
		expect(status.stdout).toContain('Duplicate groups: 0');
	});

	it('export prints the CSV header for an empty ledger and rejects a bad date', async () => {
		const ok = await runCli(['export']);
		expect(ok.code).toBe(0);
		expect(ok.stdout.startsWith('date,description,amount,type,currency,external_id,payee,notes')).toBe(true);
		const bad = await runCli(['export', '--from', 'yesterday']);
		expect(bad.code).toBe(2);
		expect(bad.stderr).toContain('--from must be YYYY-MM-DD');
	});

	it('scrape refuses an unconfigured company with a usage error', async () => {
		const result = await runCli(['scrape', 'leumi']);
		expect(result.code).toBe(2);
		expect(result.stderr).toContain('not in the config');
	});

	it('Clal status reports missing configuration without exposing bank records', async () => {
		const result = await runCli(['clal-status']);
		expect(result.code).toBe(1);
		expect(JSON.parse(result.stdout)).toEqual({configured: false, enabled: false});
		expect(result.stdout).not.toContain('hapoalim');
	});

	it.each(['clal-login', 'clal-sync'])('%s refuses missing investment configuration before any provider action', async command => {
		const result = await runCli([command]);
		expect(result.code).toBe(2);
		expect(result.stderr).toContain('Clal investments are not configured');
	});

	it('Clal status prints counts and health but no stored balances, product identity, or credentials', async () => {
		const target = path.join(dataDir, 'clal-config.json');
		writeConfig(target, {investments: {
			enabled: false, readToken: 'private-cli-fixture-token', credentials: {id: 'private-fixture-id', phone: 'private-fixture-phone'},
		}});
		const store = createInvestmentStore(path.join(dataDir, 'investments.sqlite'));
		store.applySnapshot({
			observedAt: '2026-09-08T06:00:00.000Z', complete: true, inventoryComplete: true,
			products: [{
				id: 'clal:CLI-FIXTURE', provider: 'clal', providerProductId: 'CLI-FIXTURE', kind: 'pension', name: 'Private fixture pension', currency: 'ILS',
				currentValuationId: 'clal:CLI-FIXTURE:valuation:undated',
				liquidity: {status: 'restricted', availableFrom: null, availableAmount: null},
				coverage: {valuations: 'partial', activities: 'unavailable', tracks: 'unavailable'}, forecast: null,
			}],
			valuations: [{id: 'clal:CLI-FIXTURE:valuation:undated', productId: 'clal:CLI-FIXTURE', asOf: null, observedAt: '2026-09-08T06:00:00.000Z', amount: '654321.09', currency: 'ILS'}],
			activities: [], tracks: [],
		});
		store.close();
		const result = await runCli(['--config', target, 'clal-status']);
		expect(result.code).toBe(1);
		expect(JSON.parse(result.stdout)).toMatchObject({configured: true, enabled: false, counts: {products: 1, valuations: 1, activities: 0, tracks: 0}});
		for (const privateValue of ['654321.09', 'CLI-FIXTURE', 'Private fixture pension', 'private-cli-fixture-token', 'private-fixture-id', 'private-fixture-phone']) {
			expect(result.stdout + result.stderr).not.toContain(privateValue);
		}

		const disabled = await runCli(['--config', target, 'clal-sync']);
		expect(disabled.code).toBe(2);
		expect(disabled.stderr).toContain('Clal investments are disabled');
	});
});

describe('serve()', () => {
	it('starts the server without a schedule, answers /healthz and shuts down', async () => {
		const port = await freePort();
		const serveDir = mkdtempSync(path.join(os.tmpdir(), 'ibs-bridge-serve-'));
		const serveConfig = path.join(serveDir, 'config.json');
		const base = `http://127.0.0.1:${port}`;
		writeConfig(serveConfig, {server: {publicUrl: base, host: '127.0.0.1', port}});
		vi.stubEnv('CONFIG_PATH', serveConfig);
		vi.stubEnv('DATA_DIR', serveDir);
		vi.stubEnv('OP_DISABLED', '1');
		vi.stubEnv('SCHEDULE', '');
		const lines: string[] = [];

		const running = await serve({logger: silentLogger(lines)});
		try {
			expect(running.port).toBe(port);
			const response = await fetch(`${base}/healthz`);
			expect(response.status).toBe(503);
			const report = await response.json() as HealthReport;
			expect(report.ok).toBe(false);
			expect(lines.some(line => line.includes('bridge started'))).toBe(true);
			expect(running.scheduler.isRunning()).toBe(false);
		} finally {
			await running.shutdown();
			await running.shutdown();
			vi.unstubAllEnvs();
			rmSync(serveDir, {recursive: true, force: true});
		}

		await expect(fetch(`${base}/healthz`)).rejects.toThrow();
	});
});
