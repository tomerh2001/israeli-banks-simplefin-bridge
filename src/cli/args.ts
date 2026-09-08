/**
 * `bridge` argument parsing and text-table rendering (node:util parseArgs, no deps).
 * Kept apart from src/cli.ts so tests can import it without running the CLI.
 */

import {parseArgs, type ParseArgsConfig} from 'node:util';

export type Command =
	| 'scrape'
	| 'status'
	| 'mint-token'
	| 'revoke'
	| 'login'
	| 'unpark'
	| 'reset-profile'
	| 'audit'
	| 'export'
	| 'health'
	| 'clal-login'
	| 'clal-sync'
	| 'clal-renew'
	| 'clal-status'
	| 'serve';

export type OptionName = 'config' | 'data-dir' | 'verbose' | 'help' | 'from' | 'to' | 'force' | 'label' | 'rotate' | 'account';

export type ParsedArgs = {
	command: Command;
	/** First positional after the command (`<company>` for the commands that take one). */
	company?: string;
	values: Partial<Record<OptionName, string | boolean | string[]>>;
};

/** Thrown for bad invocations; reported with the usage hint and exit code 2. */
export class UsageError extends Error {}

const OPTIONS = {
	config: {type: 'string'},
	'data-dir': {type: 'string'},
	verbose: {type: 'boolean'},
	help: {type: 'boolean', short: 'h'},
	from: {type: 'string'},
	to: {type: 'string'},
	force: {type: 'boolean'},
	label: {type: 'string'},
	rotate: {type: 'boolean'},
	account: {type: 'string', multiple: true},
} satisfies ParseArgsConfig['options'];

const GLOBAL_OPTIONS: OptionName[] = ['config', 'data-dir', 'verbose', 'help'];

/** Per-command option whitelist (on top of the globals) and whether a `<company>` positional is accepted. */
const COMMANDS: Record<Command, {options: OptionName[]; positional?: 'company'}> = {
	scrape: {options: ['from', 'force'], positional: 'company'},
	status: {options: []},
	'mint-token': {options: ['label', 'rotate']},
	revoke: {options: ['label']},
	login: {options: [], positional: 'company'},
	unpark: {options: [], positional: 'company'},
	'reset-profile': {options: [], positional: 'company'},
	audit: {options: []},
	export: {options: ['account', 'from', 'to']},
	health: {options: []},
	'clal-login': {options: []},
	'clal-sync': {options: []},
	'clal-renew': {options: []},
	'clal-status': {options: []},
	serve: {options: []},
};

export const USAGE = `Usage: bridge <command> [options]

Commands:
  scrape [company] [--from YYYY-MM-DD] [--force]
                          Scrape now (all enabled companies or one). --force ignores
                          parking and backoff; the per-day login cap still applies.
  status                  Per-company state, accounts and row counts, consumers,
                          the last 20 anomalies and the duplicate-group count.
  mint-token --label <name> [--rotate]
                          Create (or rotate) a consumer and print its SimpleFIN setup token.
  revoke --label <name>   Revoke a consumer (its Basic credentials stop working).
  login <company>         Assisted (visible) login through noVNC, for SMS one-time codes.
  unpark <company>        Clear parking, backoff and today's login-attempt counter.
  reset-profile <company> Delete the company's Chrome profile (re-enrol OTP afterwards).
  audit                   Duplicate-looking rows and recent anomalies.
  export [--account <id>]... [--from YYYY-MM-DD] [--to YYYY-MM-DD]
                          Securo-import CSV to stdout (from inclusive, to exclusive).
  health                  Print the health report as JSON; exit 0 when ok, else 1.
  clal-login              Request Clal SMS authentication; enter the code privately on stdin.
  clal-sync               Collect Clal investments using the saved session; never request SMS.
  clal-renew              Renew an authenticated Clal session; never request SMS or collect data.
  clal-status             Print Clal source/session health and record counts as JSON.
  serve                   Start the SimpleFIN server and the scheduler (same as node dist/index.js).

Global options:
  --config <path>         Config file (CONFIG_PATH, default ./config.json).
  --data-dir <path>       Ledger, Chrome profiles and screenshots (DATA_DIR, default ./data).
  --verbose               Row-level debug logging (VERBOSE=1).
  -h, --help              Show this help.

Environment: OP_CONNECT_HOST, OP_CONNECT_TOKEN_FILE, OP_DISABLED, SCHEDULE, ONE_SHOT,
PUPPETEER_EXECUTABLE_PATH, SHOW_BROWSER, NOVNC_PASSWORD, TZ (see docs/architecture.md).
`;

function isCommand(value: string): value is Command {
	return Object.hasOwn(COMMANDS, value);
}

/** Parse argv; rejects unknown commands, options foreign to the command and stray positionals. */
export function parseCommandLine(args: string[]): ParsedArgs | {help: true} {
	let values: ParsedArgs['values'];
	let positionals: string[];
	try {
		({values, positionals} = parseArgs({args, options: OPTIONS, allowPositionals: true, strict: true}));
	} catch (error) {
		throw new UsageError((error as Error).message);
	}

	if (values.help) {
		return {help: true};
	}

	const [name, ...rest] = positionals;
	if (name === undefined) {
		throw new UsageError('Missing command');
	}

	if (!isCommand(name)) {
		throw new UsageError(`Unknown command "${name}"`);
	}

	const spec = COMMANDS[name];
	const allowed = new Set<string>([...GLOBAL_OPTIONS, ...spec.options]);
	for (const given of Object.keys(values)) {
		if (!allowed.has(given)) {
			throw new UsageError(`Option --${given} is not valid for "${name}"`);
		}
	}

	if (rest.length > (spec.positional ? 1 : 0)) {
		if (name.startsWith('clal-')) {
			throw new UsageError(`Unexpected argument for "${name}"; OTP codes are accepted only on stdin`);
		}

		throw new UsageError(`Unexpected argument "${rest.at(-1)}" for "${name}"`);
	}

	return {command: name, company: rest[0], values};
}

/** Render rows as a padded text table with a dashed rule under the header. */
export function table(headers: string[], rows: string[][]): string {
	const widths = headers.map((header, column) => Math.max(header.length, ...rows.map(row => (row[column] ?? '').length)));
	const line = (cells: string[]): string => cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join('  ').trimEnd();
	return [line(headers), line(widths.map(width => '-'.repeat(width))), ...rows.map(row => line(row))].join('\n');
}
