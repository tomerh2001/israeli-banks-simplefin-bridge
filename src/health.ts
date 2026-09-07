/**
 * `/healthz` report. A company is healthy iff it is enabled, not parked and has a
 * successful scrape within `staleHours`; the bridge is ok iff every enabled company
 * is healthy and at least one company is enabled.
 */

import {
	ID_SCHEME_VERSION,
	type CompanyConfig,
	type CompanyHealth,
	type CompanyId,
	type Config,
	type HealthReport,
	type Ledger,
	type SourceState,
} from './types.js';

function withinHours(timestamp: string | undefined, hours: number, now: Date): boolean {
	return timestamp !== undefined && now.getTime() - Date.parse(timestamp) <= hours * 3_600_000;
}

function companyHealth(company: CompanyId, companyConfig: CompanyConfig, state: SourceState | undefined, ledger: Ledger, config: Config, now: Date): CompanyHealth {
	const parked = state?.parked ?? false;
	return {
		company,
		enabled: companyConfig.enabled,
		healthy: companyConfig.enabled && !parked && withinHours(state?.lastSuccessAt, config.staleHours, now),
		parked,
		lastSuccessAt: state?.lastSuccessAt,
		lastErrorType: state?.lastErrorType,
		staleHours: config.staleHours,
		accounts: ledger.listAccounts({company}).length,
	};
}

/** Build the health report for `GET /healthz` and `bridge health`. */
export function buildHealthReport(ledger: Ledger, config: Config, now: Date = new Date()): HealthReport {
	const companies = (Object.entries(config.companies) as Array<[CompanyId, CompanyConfig | undefined]>)
		.filter((entry): entry is [CompanyId, CompanyConfig] => entry[1] !== undefined)
		.map(([company, companyConfig]) => companyHealth(company, companyConfig, ledger.getSourceState(company), ledger, config, now));
	const enabled = companies.filter(company => company.enabled);
	const consumers = ledger
		.listConsumers()
		.filter(consumer => !consumer.revokedAt)
		.map(consumer => ({label: consumer.label, lastSeenAt: consumer.lastSeenAt, claimed: consumer.claimCount > 0}));
	const storedVersion = Number(ledger.getMeta('id_scheme_version'));

	return {
		ok: enabled.length > 0 && enabled.every(company => company.healthy),
		checkedAt: now.toISOString(),
		companies,
		consumers,
		idSchemeVersion: Number.isSafeInteger(storedVersion) ? storedVersion : ID_SCHEME_VERSION,
	};
}
