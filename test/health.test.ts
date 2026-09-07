import {describe, expect, it} from 'vitest';
import {buildHealthReport} from '../src/health.js';
import {createMemoryLedger} from '../src/ledger/memory.js';
import {mintConsumerToken, revokeConsumer} from '../src/simplefin/consumers.js';
import {companyConfig, makeConfig, NOW, seedAccount, seedSourceState} from './helpers/seed.js';

const hoursAgo = (hours: number) => new Date(NOW.getTime() - (hours * 3_600_000)).toISOString();

describe('buildHealthReport', () => {
	it('is ok when every enabled company has a fresh success', () => {
		const ledger = createMemoryLedger();
		seedSourceState(ledger, 'hapoalim', {lastSuccessAt: hoursAgo(29)});
		seedSourceState(ledger, 'visaCal', {lastSuccessAt: hoursAgo(1)});
		seedAccount(ledger);
		const report = buildHealthReport(ledger, makeConfig(), NOW);
		expect(report.ok).toBe(true);
		expect(report.checkedAt).toBe(NOW.toISOString());
		expect(report.idSchemeVersion).toBe(1);
		expect(report.companies.map(company => [company.company, company.healthy, company.accounts])).toEqual([
			['hapoalim', true, 1],
			['visaCal', true, 0],
		]);
		expect(report.companies[0]).toMatchObject({enabled: true, parked: false, staleHours: 30, lastSuccessAt: hoursAgo(29)});
	});

	it('is not ok when a company is stale, never succeeded or parked', () => {
		const ledger = createMemoryLedger();
		seedSourceState(ledger, 'hapoalim', {lastSuccessAt: hoursAgo(31)});
		expect(buildHealthReport(ledger, makeConfig(), NOW).ok).toBe(false);

		seedSourceState(ledger, 'hapoalim', {lastSuccessAt: hoursAgo(1)});
		expect(buildHealthReport(ledger, makeConfig(), NOW).companies.find(company => company.company === 'visaCal')?.healthy).toBe(false);

		seedSourceState(ledger, 'visaCal', {lastSuccessAt: hoursAgo(1), parked: true, lastErrorType: 'INVALID_PASSWORD'});
		const report = buildHealthReport(ledger, makeConfig(), NOW);
		expect(report.ok).toBe(false);
		expect(report.companies[1]).toMatchObject({parked: true, healthy: false, lastErrorType: 'INVALID_PASSWORD'});
	});

	it('ignores disabled companies for ok but lists them, and fails with no enabled company', () => {
		const ledger = createMemoryLedger();
		seedSourceState(ledger, 'hapoalim', {lastSuccessAt: hoursAgo(1)});
		const config = makeConfig();
		config.companies.visaCal = companyConfig({label: 'Visa Cal', enabled: false});
		const report = buildHealthReport(ledger, config, NOW);
		expect(report.ok).toBe(true);
		expect(report.companies[1]).toMatchObject({company: 'visaCal', enabled: false, healthy: false});

		expect(buildHealthReport(ledger, makeConfig({companies: {}}), NOW).ok).toBe(false);
	});

	it('summarises non-revoked consumers', () => {
		const ledger = createMemoryLedger();
		const config = makeConfig();
		mintConsumerToken(ledger, config, {label: 'Securo', now: NOW});
		const actual = mintConsumerToken(ledger, config, {label: 'Actual', now: NOW});
		ledger.updateConsumer({...actual.consumer, claimCount: 1, lastSeenAt: NOW.toISOString()});
		mintConsumerToken(ledger, config, {label: 'Old', now: NOW});
		revokeConsumer(ledger, 'Old');
		expect(buildHealthReport(ledger, config, NOW).consumers).toEqual([
			{label: 'Securo', lastSeenAt: undefined, claimed: false},
			{label: 'Actual', lastSeenAt: NOW.toISOString(), claimed: true},
		]);
	});

	it('reports the ledger id scheme version when stored', () => {
		const ledger = createMemoryLedger();
		ledger.setMeta('id_scheme_version', '7');
		expect(buildHealthReport(ledger, makeConfig(), NOW).idSchemeVersion).toBe(7);
	});
});
