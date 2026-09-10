import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import {bestInvestConfigSchema, hapoalimInvestmentsConfigSchema, investmentConfigSchema} from './investments/config.js';
import type {Config, RuntimeEnv} from './types.js';

const accountKind = z.enum(['checking', 'credit_card', 'savings', 'investment']);

const companySchema = z.object({
	enabled: z.boolean().default(true),
	label: z.string().min(1),
	kind: accountKind,
	credentials: z.record(z.string(), z.string().min(1)),
	accounts: z.union([z.literal('all'), z.array(z.string().min(1))]).default('all'),
	startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
	additionalTransactionInformation: z.boolean().default(false),
	includePending: z.boolean().default(false),
	futureMonthsToScrape: z.number().int().min(0).max(12).optional(),
	dateMode: z.enum(['purchase', 'charge']).default('purchase'),
	chargeDay: z.number().int().min(1).max(31).optional(),
	synthesizePayments: z.boolean().default(false),
	timeoutMinutes: z.number().int().min(1).max(120).default(20),
	scraperOptions: z.record(z.string(), z.unknown()).optional(),
});

const serverSchema = z.object({
	publicUrl: z.url().default('http://israeli-banks-bridge:8080').transform(url => url.replace(/\/+$/, '')),
	port: z.number().int().min(1).max(65_535).default(8080),
	host: z.string().default('0.0.0.0'),
	claimTtlMinutes: z.number().int().min(1).max(1440).default(15),
	maxClaims: z.number().int().min(1).max(10).default(3),
});

export const configSchema = z.object({
	schedule: z.string().min(1).optional(),
	timezone: z.string().default('Asia/Jerusalem'),
	currency: z.string().regex(/^[A-Z]{3}$/).default('ILS'),
	staleHours: z.number().int().min(1).default(30),
	overlapDays: z.number().int().min(1).max(365).default(30),
	maxLoginAttemptsPerDay: z.number().int().min(1).max(20).default(2),
	companies: z.record(z.string(), companySchema),
	investments: investmentConfigSchema.optional(),
	bestInvest: bestInvestConfigSchema.optional(),
	hapoalimInvestments: hapoalimInvestmentsConfigSchema.optional(),
	// `prefault` feeds the empty object through the schema so every nested default applies.
	server: serverSchema.prefault({}),
});

export type ParsedConfig = z.infer<typeof configSchema>;

export function parseConfig(raw: unknown): Config {
	return configSchema.parse(raw);
}

export async function loadConfig(configPath: string): Promise<Config> {
	const text = await readFile(configPath, 'utf8');
	let raw: unknown;
	try {
		raw = JSON.parse(text) as unknown;
	} catch (error) {
		throw new Error(`Config ${configPath} is not valid JSON: ${(error as Error).message}`);
	}

	const config = parseConfig(raw);
	if (process.env.SCHEDULE) {
		config.schedule = process.env.SCHEDULE;
	}

	return config;
}

function flag(name: string): boolean {
	const value = process.env[name];
	return value !== undefined && ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

export function readRuntimeEnv(): RuntimeEnv {
	const dataDir = path.resolve(process.env.DATA_DIR ?? './data');
	return {
		configPath: path.resolve(process.env.CONFIG_PATH ?? './config.json'),
		dataDir,
		ledgerPath: path.resolve(process.env.LEDGER_PATH ?? path.join(dataDir, 'ledger.sqlite')),
		chromeDir: path.resolve(process.env.CHROME_DIR ?? path.join(dataDir, 'chrome')),
		screenshotsDir: path.resolve(process.env.SCREENSHOTS_DIR ?? path.join(dataDir, 'screenshots')),
		opConnectHost: process.env.OP_CONNECT_HOST?.replace(/\/+$/, ''),
		opConnectTokenFile: process.env.OP_CONNECT_TOKEN_FILE,
		opDisabled: flag('OP_DISABLED'),
		verbose: flag('VERBOSE'),
		showBrowser: flag('SHOW_BROWSER'),
		puppeteerExecutablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
	};
}
