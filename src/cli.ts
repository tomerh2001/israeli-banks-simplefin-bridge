#!/usr/bin/env node
/**
 * `bridge` command line. Commands are listed in docs/architecture.md ("CLI").
 *
 * Exit codes: 0 ok, 1 the command failed (or a scrape run failed), 2 usage error.
 * Global `--config` / `--data-dir` map onto CONFIG_PATH / DATA_DIR before the
 * runtime env is read, so every command sees the same overrides.
 */

import process from 'node:process';
import path from 'node:path';
import {parseCommandLine, table, USAGE, UsageError, type ParsedArgs} from './cli/args.js';
import {readOneTimeCode} from './cli/otp.js';
import {exportCsv} from './export/csv.js';
import {buildHealthReport} from './health.js';
import {createLogger, type Logger} from './log.js';
import {assistedLogin, createScheduler, resetProfile, unparkCompany} from './scrape/index.js';
import {listConsumers, mintConsumerToken, revokeConsumer} from './simplefin/consumers.js';
import {ORGS} from './simplefin/orgs.js';
import {
	describeSchedule,
	openContext,
	runFailed,
	serve,
	type BridgeContext,
} from './serve.js';
import type {CompanyId, Config, IsoDate, RunRecord} from './types.js';
import type {InvestmentConfig} from './investments/config.js';
import {assistedClalLogin} from './investments/login.js';
import {collectClal} from './investments/reader.js';
import {createInvestmentRuntime} from './investments/runtime.js';
import {createInvestmentStore} from './investments/store.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ANOMALY_LIMIT = 20;
const AUDIT_ANOMALY_LIMIT = 50;

/** Apply --config / --data-dir / --verbose as environment overrides before the env is read. */
function applyGlobalOptions(values: ParsedArgs['values']): void {
	if (typeof values.config === 'string') {
		process.env.CONFIG_PATH = values.config;
	}

	if (typeof values['data-dir'] === 'string') {
		process.env.DATA_DIR = values['data-dir'];
	}

	if (values.verbose === true) {
		process.env.VERBOSE = '1';
	}
}

function optionalDate(value: unknown, name: string): IsoDate | undefined {
	if (value === undefined) {
		return undefined;
	}

	if (typeof value !== 'string' || !ISO_DATE.test(value)) {
		throw new UsageError(`--${name} must be YYYY-MM-DD`);
	}

	return value;
}

function requireLabel(values: ParsedArgs['values']): string {
	if (typeof values.label !== 'string' || values.label.trim() === '') {
		throw new UsageError('--label <name> is required');
	}

	return values.label.trim();
}

/** A company id known to the scraper library (not necessarily configured). */
function requireKnownCompany(value: string | undefined): CompanyId {
	if (value === undefined) {
		throw new UsageError(`Missing <company>; one of ${Object.keys(ORGS).join(', ')}`);
	}

	if (!Object.hasOwn(ORGS, value)) {
		throw new UsageError(`Unknown company "${value}"; one of ${Object.keys(ORGS).join(', ')}`);
	}

	return value as CompanyId;
}

/** A company present in config.json. */
function requireConfiguredCompany(config: Config, value: string | undefined): CompanyId {
	const company = requireKnownCompany(value);
	if (!Object.hasOwn(config.companies, company)) {
		throw new UsageError(`Company "${company}" is not in the config; configured: ${Object.keys(config.companies).join(', ') || 'none'}`);
	}

	return company;
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

const show = (value: string | number | boolean | undefined): string => (value === undefined ? '-' : String(value));

function print(text: string): void {
	process.stdout.write(`${text}\n`);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function commandScrape(context: BridgeContext, args: ParsedArgs): Promise<number> {
	const {config, env, ledger, secrets, logger} = context;
	const company = args.company === undefined ? undefined : requireConfiguredCompany(config, args.company);
	if (company && !config.companies[company]?.enabled) {
		throw new UsageError(`Company "${company}" is disabled in the config`);
	}

	const scheduler = createScheduler({config, env, ledger, secrets, logger: logger.child('scrape')});
	const runs = await scheduler.runNow({company, from: optionalDate(args.values.from, 'from'), force: args.values.force === true});
	if (runs.length === 0) {
		print('No enabled companies to scrape.');
		return 0;
	}

	print(table(
		['Company', 'Status', 'Accounts', 'Txns', 'New', 'Anomalies', 'Message'],
		runs.map((run: RunRecord) => [run.company, run.status, show(run.accountsSeen), show(run.transactionsSeen), show(run.transactionsNew), show(run.anomalies), run.message ?? '']),
	));
	return runs.some(run => runFailed(run)) ? 1 : 0;
}

function rowCount(context: BridgeContext, accountId: string): number {
	return context.ledger.listTransactions({accountIds: [accountId], includePending: true, includeSynthetic: true}).length;
}

function printCompanies(context: BridgeContext): void {
	const {config, ledger} = context;
	const rows: string[][] = [];
	for (const company of Object.keys(config.companies) as CompanyId[]) {
		const state = ledger.getSourceState(company);
		const accounts = ledger.listAccounts({company});
		const total = accounts.reduce((sum, account) => sum + rowCount(context, account.id), 0);
		rows.push([
			company,
			show(config.companies[company]?.enabled),
			state?.parked ? `yes (${state.parkedReason ?? ''})` : 'no',
			show(state?.lastRunAt),
			show(state?.lastSuccessAt),
			state?.lastErrorType ? `${state.lastErrorType}${state.nextAllowedAt ? ` (until ${state.nextAllowedAt})` : ''}` : '-',
			show(accounts.length),
			show(total),
		]);
	}

	print('Companies');
	print(table(['Company', 'Enabled', 'Parked', 'Last run', 'Last success', 'Last error', 'Accounts', 'Rows'], rows));
}

function printAccounts(context: BridgeContext): void {
	const accounts = context.ledger.listAccounts();
	if (accounts.length === 0) {
		print('\nAccounts: none yet');
		return;
	}

	print('\nAccounts');
	print(table(
		['Id', 'Name', 'Kind', 'Balance', 'Balance at', 'Rows', 'Last seen'],
		accounts.map(account => [
			account.id,
			account.name,
			account.kind,
			account.balance === undefined ? '-' : `${account.balance.toFixed(2)} ${account.currency}`,
			show(account.balanceAt),
			show(rowCount(context, account.id)),
			account.lastSeen,
		]),
	));
}

function printConsumers(context: BridgeContext): void {
	const consumers = listConsumers(context.ledger);
	if (consumers.length === 0) {
		print('\nConsumers: none (run "bridge mint-token --label <name>")');
		return;
	}

	print('\nConsumers');
	print(table(
		['Label', 'Basic user', 'Claims', 'Authenticated', 'Last seen', 'Revoked'],
		consumers.map(consumer => [
			consumer.label,
			consumer.basicUser,
			`${consumer.claimCount}/${consumer.maxClaims}`,
			show(consumer.firstAuthenticatedAt),
			show(consumer.lastSeenAt),
			show(consumer.revokedAt),
		]),
	));
}

function printAnomalies(context: BridgeContext, limit: number): void {
	const anomalies = context.ledger.listAnomalies({limit});
	if (anomalies.length === 0) {
		print(`\nAnomalies (last ${limit}): none`);
		return;
	}

	print(`\nAnomalies (last ${limit})`);
	print(table(['Transaction', 'Field', 'Previous', 'Incoming', 'Seen at'], anomalies.map(anomaly => [anomaly.transactionId, anomaly.field, anomaly.previous, anomaly.incoming, anomaly.seenAt])));
}

function commandStatus(context: BridgeContext): number {
	print(`Schedule: ${describeSchedule(context.config.schedule)}   Timezone: ${context.config.timezone}   Ledger: ${context.env.ledgerPath}`);
	printCompanies(context);
	printAccounts(context);
	printConsumers(context);
	printAnomalies(context, ANOMALY_LIMIT);
	print(`\nDuplicate groups: ${context.ledger.findDuplicates().length} (see "bridge audit")`);
	return 0;
}

function commandMintToken(context: BridgeContext, args: ParsedArgs): number {
	const {config, ledger} = context;
	const rotate = args.values.rotate === true;
	const result = mintConsumerToken(ledger, config, {label: requireLabel(args.values), rotate});
	const {consumer} = result;
	print(`Consumer:    ${consumer.id} (Basic user ${consumer.basicUser})${rotate ? ' [rotated: the previous secret stops working now]' : ''}`);
	print(`Claim URL:   ${result.claimUrl}`);
	print(`Expires:     ${show(consumer.claimExpiresAt)} (at most ${consumer.maxClaims} claims, none after the first authenticated sync)`);
	print('\nSetup token:');
	print(result.setupToken);
	print('\nPaste the setup token into Securo (Accounts -> Connect bank -> SimpleFIN; ignore its "Generate token" link)');
	print('or Actual Budget (Account -> Link account -> SimpleFIN). Consumers must reach');
	print(`${config.server.publicUrl} on the Docker network; rotate with "bridge mint-token --label ${consumer.label} --rotate".`);
	return 0;
}

function commandRevoke(context: BridgeContext, args: ParsedArgs): number {
	const label = requireLabel(args.values);
	if (!revokeConsumer(context.ledger, label)) {
		print(`No consumer with label "${label}".`);
		return 1;
	}

	print(`Consumer "${label}" revoked; its Basic credentials now answer 401 and its claim URL 403.`);
	return 0;
}

async function commandLogin(context: BridgeContext, args: ParsedArgs): Promise<number> {
	const {config, env, ledger, secrets, logger} = context;
	const company = requireConfiguredCompany(config, args.company);
	await assistedLogin({company, config, env, ledger, secrets, logger: logger.child('login')});
	return 0;
}

function commandUnpark(context: BridgeContext, args: ParsedArgs): number {
	const company = requireKnownCompany(args.company);
	if (!unparkCompany(context.ledger, company)) {
		print(`Company "${company}" has no scrape state yet; nothing to clear.`);
		return 1;
	}

	print(`Company "${company}" unparked: parking, backoff and today's login attempts cleared.`);
	return 0;
}

function commandResetProfile(context: BridgeContext, args: ParsedArgs): number {
	const company = requireKnownCompany(args.company);
	const removed = resetProfile(context.env, company);
	print(`Removed Chrome profile ${removed}. Re-enrol device trust with "bridge login ${company}" if the bank needs it.`);
	return 0;
}

function commandAudit(context: BridgeContext): number {
	const groups = context.ledger.findDuplicates();
	if (groups.length === 0) {
		print('Duplicate groups: none');
	} else {
		print(`Duplicate groups: ${groups.length} (same account, date, amount and description under different ids)`);
		print(table(
			['Account', 'Date', 'Amount', 'Description', 'Transaction ids'],
			groups.map(group => [group.accountId, group.bookedDate, group.amount.toFixed(2), group.description, group.transactionIds.join(' ')]),
		));
	}

	printAnomalies(context, AUDIT_ANOMALY_LIMIT);
	return 0;
}

function commandExport(context: BridgeContext, args: ParsedArgs): number {
	const accountIds = Array.isArray(args.values.account) ? args.values.account : undefined;
	const csv = exportCsv(context.ledger, context.config, {
		accountIds,
		from: optionalDate(args.values.from, 'from'),
		to: optionalDate(args.values.to, 'to'),
	});
	process.stdout.write(csv);
	return 0;
}

function commandHealth(context: BridgeContext): number {
	const report = buildHealthReport(context.ledger, context.config);
	print(JSON.stringify(report, null, 2));
	return report.ok ? 0 : 1;
}

function requireClalConfig(context: BridgeContext): InvestmentConfig {
	const config = context.config.investments;
	if (!config) {
		throw new UsageError('Clal investments are not configured; add config.investments first');
	}

	if (!config.enabled) {
		throw new UsageError('Clal investments are disabled; set config.investments.enabled to true');
	}

	return config;
}

/** Let collectors release the profile and restore terminal input before exiting. */
async function withCommandSignal(work: (signal: AbortSignal) => Promise<number>): Promise<number> {
	const controller = new AbortController();
	let signalExit: number | undefined;
	const interrupt = (): void => {
		signalExit = 130;
		controller.abort();
	};

	const terminate = (): void => {
		signalExit = 143;
		controller.abort();
	};

	process.on('SIGINT', interrupt);
	process.on('SIGTERM', terminate);
	try {
		const result = await work(controller.signal);
		return signalExit ?? result;
	} catch (error) {
		if (signalExit !== undefined) {
			return signalExit;
		}

		throw error;
	} finally {
		process.off('SIGINT', interrupt);
		process.off('SIGTERM', terminate);
	}
}

async function commandClalLogin(context: BridgeContext): Promise<number> {
	const config = requireClalConfig(context);
	return withCommandSignal(async signal => {
		await assistedClalLogin({
			config, env: {...context.env, showBrowser: true}, secrets: context.secrets,
			timeoutMinutes: config.timeoutMinutes, signal, readOtp: readOneTimeCode,
		});
		print('Clal login completed. Run "bridge clal-sync" to refresh investments.');
		return 0;
	});
}

async function commandClalSync(context: BridgeContext): Promise<number> {
	const config = requireClalConfig(context);
	return withCommandSignal(async signal => {
		const runtime = await createInvestmentRuntime({
			config, env: context.env, secrets: context.secrets, logger: context.logger.child('investments'),
			timezone: context.config.timezone,
			collect: async input => collectClal({...input, signal: AbortSignal.any([input.signal, signal])}),
		});
		try {
			const status = await runtime.runNow();
			if (status === 'auth_required') {
				print('Clal needs SMS approval. Run "bridge clal-login", then "bridge clal-sync".');
			} else {
				print(`Clal collection: ${status ?? 'unavailable'}`);
			}

			return status === 'ok' ? 0 : 1;
		} finally {
			await runtime.close();
		}
	});
}

function commandClalStatus(context: BridgeContext): number {
	const config = context.config.investments;
	if (!config) {
		print(JSON.stringify({configured: false, enabled: false}));
		return 1;
	}

	const store = createInvestmentStore(path.join(context.env.dataDir, 'investments.sqlite'));
	try {
		const now = new Date();
		const feed = store.getFeed(now, config.staleHours);
		const lastSuccess = feed.source.lastSuccessAt ? Date.parse(feed.source.lastSuccessAt) : undefined;
		const stale = lastSuccess === undefined || now.getTime() - lastSuccess > config.staleHours * 3_600_000;
		print(JSON.stringify({
			configured: true, enabled: config.enabled, source: feed.source, stale,
			counts: {products: feed.products.length, valuations: feed.valuations.length, activities: feed.activities.length, tracks: feed.tracks.length},
		}, null, 2));
		return config.enabled && feed.source.status === 'ok' && !stale ? 0 : 1;
	} finally {
		store.close();
	}
}

async function dispatch(context: BridgeContext, args: ParsedArgs): Promise<number> {
	switch (args.command) {
		case 'scrape': {
			return commandScrape(context, args);
		}

		case 'status': {
			return commandStatus(context);
		}

		case 'mint-token': {
			return commandMintToken(context, args);
		}

		case 'revoke': {
			return commandRevoke(context, args);
		}

		case 'login': {
			return commandLogin(context, args);
		}

		case 'unpark': {
			return commandUnpark(context, args);
		}

		case 'reset-profile': {
			return commandResetProfile(context, args);
		}

		case 'audit': {
			return commandAudit(context);
		}

		case 'export': {
			return commandExport(context, args);
		}

		case 'health': {
			return commandHealth(context);
		}

		case 'clal-login': {
			return commandClalLogin(context);
		}

		case 'clal-sync': {
			return commandClalSync(context);
		}

		case 'clal-status': {
			return commandClalStatus(context);
		}

		case 'serve': {
			throw new Error('serve is handled before the ledger is opened');
		}
	}
}

/** Commands that open the ledger themselves (everything except `serve`). */
async function runWithContext(args: ParsedArgs, logger: Logger): Promise<number> {
	const context = await openContext(logger);
	try {
		return await dispatch(context, args);
	} finally {
		context.close();
	}
}

/** Returns the exit code, or undefined when the process must keep running (`serve`). */
async function main(args: string[]): Promise<number | undefined> {
	const parsed = parseCommandLine(args);
	if ('help' in parsed) {
		print(USAGE.trimEnd());
		return 0;
	}

	applyGlobalOptions(parsed.values);
	const logger = createLogger('bridge');
	if (parsed.command === 'serve') {
		await serve({logger, exit: code => process.exit(code)});
		return undefined;
	}

	return runWithContext(parsed, logger);
}

try {
	const code = await main(process.argv.slice(2));
	if (code !== undefined) {
		process.exitCode = code;
	}
} catch (error) {
	if (error instanceof UsageError) {
		process.stderr.write(`bridge: ${error.message}\n\n${USAGE}`);
		process.exitCode = 2;
	} else {
		process.stderr.write(`bridge: ${(error as Error).message}\n`);
		process.exitCode = 1;
	}
}
