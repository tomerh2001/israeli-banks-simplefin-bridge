/**
 * Generate config.schema.json from the zod config schema.
 *
 * Usage: yarn schema   (tsx scripts/generate-schema.ts)
 *
 * The JSON Schema describes the *input* shape of config.json (defaults make
 * fields optional, `op://` references are plain strings). The `companies`
 * keys are restricted to israeli-bank-scrapers' CompanyTypes so editors flag
 * typos such as "hapoalim " or "visacal" immediately.
 */

import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {CompanyTypes} from 'israeli-bank-scrapers/lib/definitions.js';
import {z} from 'zod';
import {configSchema} from '../src/config.js';

type JsonObject = Record<string, unknown>;

const outputPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'config.schema.json');

/** Restrict `companies` keys to the scraper library's company ids. */
function restrictCompanyKeys(schema: JsonObject): void {
	const properties = schema.properties as JsonObject | undefined;
	const companies = properties?.companies as JsonObject | undefined;
	if (!companies) {
		throw new Error('generated schema has no "companies" property');
	}

	companies.propertyNames = {enum: Object.values(CompanyTypes).sort()};
}

/** Hover documentation for editors; mirrors the JSDoc in src/types.ts. */
const descriptions: Record<string, string> = {
	schedule: 'Cron expression for scheduled scrapes (5 fields, evaluated in `timezone`). Omit for one-shot mode via the CLI. The SCHEDULE env var overrides it.',
	timezone: 'IANA timezone used for calendar dates. Default Asia/Jerusalem.',
	currency: 'Default account currency (ISO-4217) when a scraper does not say. Default ILS.',
	staleHours: '/healthz returns 503 when an enabled company has no successful scrape within this many hours. Default 30.',
	overlapDays: 'Days re-scraped on every run to catch late postings (window starts at lastSuccess - overlapDays). Default 30.',
	maxLoginAttemptsPerDay: 'Max login attempts per company per calendar day (bank lockout guard). Default 2.',
	companies: 'One entry per bank/card company, keyed by the israeli-bank-scrapers company id.',
	investments: 'Optional dedicated Clal investment collection and feed, separate from SimpleFIN bank accounts.',
	'investments.enabled': 'Enable the investment feed and independent collector. Default false.',
	'investments.readToken': 'Dedicated investment read bearer token or op:// reference. Missing or unavailable token disables only the investment feed.',
	'investments.credentials': 'Clal Israeli ID and phone, preferably op:// references resolved by 1Password Connect.',
	'investments.schedule': 'Independent collection cron in the bridge timezone. Default 0 7 * * 1 (weekly Monday at 07:00).',
	'investments.staleHours': 'Age after which investment data is stale. Default 192 hours.',
	'investments.timeoutMinutes': 'Maximum time allowed for one collection. Default 10 minutes.',
	'companies.enabled': 'Disabled companies are never scraped and never served. Default true.',
	'companies.label': 'Human label used for SimpleFIN connection/account names and logs.',
	'companies.kind': 'Default kind for every account of this company (checking, credit_card, savings, investment).',
	'companies.credentials': 'Credential fields exactly as israeli-bank-scrapers expects them (userCode/password, username/password, id/card6Digits/password, ...). Values may be literal strings or op://<vault>/<item>/<field> references.',
	'companies.accounts': 'Scraper accountNumber filter: "all" or a list of account numbers. Default "all".',
	'companies.startDate': 'Lower bound for scraping, YYYY-MM-DD. Each scraper clamps to its own max lookback.',
	'companies.additionalTransactionInformation': 'israeli-bank-scrapers option; slower, more bot-detection exposure, may change identifiers for some banks. Default false.',
	'companies.includePending': 'Serve pending rows to consumers. Default false (pending ids are unstable for several companies).',
	'companies.futureMonthsToScrape': 'israeli-bank-scrapers option (credit cards): how many future billing months to scrape.',
	'companies.dateMode': 'Which date becomes the row date: purchase/event date ("purchase") or bank charge/billing date ("charge"). Default purchase.',
	'companies.chargeDay': 'Credit cards only: day of month the bank account is debited for the bill. Used for documentation and synthetic payments.',
	'companies.synthesizePayments': 'Credit cards only, opt-in: emit one synthetic positive "card payment" row per charge date. Default false.',
	'companies.timeoutMinutes': 'Wall-clock limit for one scrape of this company, in minutes. Default 20.',
	'companies.scraperOptions': 'Extra israeli-bank-scrapers options passed through verbatim (e.g. optInFeatures, viewportSize).',
	server: 'SimpleFIN server settings.',
	'server.publicUrl': 'Base URL consumers use to reach this bridge, no trailing slash. Default http://israeli-banks-bridge:8080.',
	'server.port': 'Listen port. Default 8080.',
	'server.host': 'Listen host. Default 0.0.0.0.',
	'server.claimTtlMinutes': 'Setup tokens expire this many minutes after minting. Default 15.',
	'server.maxClaims': 'A setup token may be claimed at most this many times (until the first successful authenticated GET). Default 3.',
};

/** Attach `description` to every documented property. */
function describe(schema: JsonObject): void {
	const properties = schema.properties as JsonObject;
	const companies = (properties.companies as JsonObject).additionalProperties as JsonObject;
	const server = properties.server as JsonObject;
	const investments = properties.investments as JsonObject;
	const targets: Record<string, JsonObject> = {
		'': properties,
		'companies.': companies.properties as JsonObject,
		'server.': server.properties as JsonObject,
		'investments.': investments.properties as JsonObject,
	};
	for (const [key, description] of Object.entries(descriptions)) {
		const dot = key.lastIndexOf('.');
		const container = targets[dot === -1 ? '' : key.slice(0, dot + 1)];
		const property = container?.[dot === -1 ? key : key.slice(dot + 1)] as JsonObject | undefined;
		if (!property) {
			throw new Error(`description for unknown property ${key}`);
		}

		property.description = description;
	}
}

/** zod emits Number.MAX_SAFE_INTEGER bounds for unbounded ints; they only add noise. */
function stripSafeIntegerBounds(value: unknown): void {
	if (Array.isArray(value)) {
		for (const item of value) {
			stripSafeIntegerBounds(item);
		}

		return;
	}

	if (!value || typeof value !== 'object') {
		return;
	}

	const object = value as JsonObject;
	if (object.maximum === Number.MAX_SAFE_INTEGER) {
		delete object.maximum;
	}

	if (object.minimum === Number.MIN_SAFE_INTEGER) {
		delete object.minimum;
	}

	for (const child of Object.values(object)) {
		stripSafeIntegerBounds(child);
	}
}

/** Allow the `$schema` key that editors add for validation. */
function allowSchemaKey(schema: JsonObject): void {
	const properties = schema.properties as JsonObject;
	properties.$schema = {type: 'string', description: 'JSON Schema reference for editor support.'};
}

function buildJsonSchema(): JsonObject {
	const schema = z.toJSONSchema(configSchema, {target: 'draft-7', io: 'input'}) as JsonObject;
	const {$schema: draft, ...rest} = schema;
	const output: JsonObject = {
		$schema: draft,
		$id: 'https://github.com/tomerh2001/israeli-banks-simplefin-bridge/blob/main/config.schema.json',
		title: 'israeli-banks-simplefin-bridge configuration',
		description: 'config.json for israeli-banks-simplefin-bridge. Credential values may be literal strings or op://<vault>/<item>/<field> references resolved through 1Password Connect.',
		...rest,
	};
	stripSafeIntegerBounds(output);
	restrictCompanyKeys(output);
	describe(output);
	allowSchemaKey(output);
	return output;
}

async function main(): Promise<void> {
	const schema = buildJsonSchema();
	await writeFile(outputPath, `${JSON.stringify(schema, null, 2)}\n`);
	console.log(`wrote ${outputPath}`);
}

await main();
