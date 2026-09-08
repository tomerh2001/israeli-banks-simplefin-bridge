import {mkdtempSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {investmentActivityId, investmentProductId, investmentValuationId} from './ids.js';
import {investmentActivitySchema, investmentMoneySchema, investmentSnapshotSchema} from './schema.js';
import {createInvestmentStore} from './store.js';
import type {InvestmentSnapshot, InvestmentStore} from './types.js';

const productId = investmentProductId('POLICY-EXAMPLE');
const observedAt = '2026-09-08T06:00:00.000Z';

function fixture(): InvestmentSnapshot {
	return {
		observedAt, complete: true, inventoryComplete: true,
		products: [{
			id: productId, provider: 'clal', providerProductId: 'POLICY-EXAMPLE', kind: 'pension',
			name: 'Example Pension', currency: 'ILS',
			currentValuationId: investmentValuationId(productId, '2026-08-31'),
			liquidity: {status: 'restricted', availableFrom: null, availableAmount: null},
			coverage: {valuations: 'partial', activities: 'partial', tracks: 'unavailable'}, forecast: null,
		}],
		valuations: [{id: investmentValuationId(productId, '2026-08-31'), productId, asOf: '2026-08-31', observedAt, amount: '12345.67', currency: 'ILS'}],
		activities: [{
			id: investmentActivityId(productId, 'CONTRIBUTION-EXAMPLE'), productId,
			sourceId: 'CONTRIBUTION-EXAMPLE', date: '2026-08', dateKind: 'contribution_month',
			kind: 'employee_contribution', amount: '200.00', currency: 'ILS', description: 'Example contribution', observedAt,
		}],
		tracks: [],
	};
}

const opened: InvestmentStore[] = [];
function open(): InvestmentStore {
	const store = createInvestmentStore(':memory:');
	opened.push(store);
	return store;
}

afterEach(() => {
	for (const store of opened) {
		store.close();
	}

	opened.length = 0;
});

describe('investment contracts', () => {
	it('preserves decimal precision without accepting floats or silently rounding', () => {
		expect(investmentMoneySchema.parse('12345678901234567890.01')).toBe('12345678901234567890.01');
		for (const value of [1.25, '1.234', 'NaN', 'Infinity', '1e3', '-0.00']) {
			expect(investmentMoneySchema.safeParse(value).success).toBe(false);
		}
	});

	it('retains month-only contribution dates and rejects fabricated precision', () => {
		const activity = fixture().activities[0]!;
		expect(investmentActivitySchema.parse(activity).date).toBe('2026-08');
		expect(investmentActivitySchema.safeParse({...activity, date: '2026-08-01'}).success).toBe(false);
		expect(investmentActivitySchema.safeParse({...activity, dateKind: 'booking'}).success).toBe(false);
		expect(investmentActivitySchema.safeParse({...activity, dateKind: 'booking', date: '2026-02-30'}).success).toBe(false);
	});

	it('does not substitute observation dates for missing valuation dates', () => {
		const snapshot = fixture();
		snapshot.valuations[0]!.asOf = null;
		snapshot.valuations[0]!.id = investmentValuationId(productId, null);
		snapshot.products[0]!.currentValuationId = snapshot.valuations[0]!.id;
		const parsed = investmentSnapshotSchema.parse(snapshot);
		expect(parsed.valuations[0]!.asOf).toBeNull();
		expect(parsed.valuations[0]!.observedAt).toBe(observedAt);
	});

	it('rejects raw or secret fields instead of accidentally serving them', () => {
		expect(investmentSnapshotSchema.safeParse({...fixture(), credentials: {password: 'example'}}).success).toBe(false);
		const snapshot = fixture();
		expect(investmentSnapshotSchema.safeParse({...snapshot, products: [{...snapshot.products[0], raw: {example: true}}]}).success).toBe(false);
	});

	it('keeps identity independent of classification, display names, and delimiter collisions', () => {
		expect(investmentProductId('  POLICY-EXAMPLE  ')).toBe(productId);
		expect(investmentProductId('group:policy/1')).toBe('clal:group%3Apolicy%2F1');
		expect(investmentProductId('group:policy/1')).not.toBe(investmentProductId('group%3Apolicy%2F1'));
		expect(() => investmentProductId(' ')).toThrow();
	});
});

describe('investment store', () => {
	it('persists session health separately without changing financial data or source freshness', () => {
		const directory = mkdtempSync(path.join(os.tmpdir(), 'clal-session-store-test-'));
		const filename = path.join(directory, 'investments.sqlite');
		const store = createInvestmentStore(filename);
		store.applySnapshot(fixture());
		const before = store.getFeed(new Date(observedAt), 192);
		expect(store.getSessionState()).toEqual({
			status: 'unknown', lastCheckedAt: null, lastRenewedAt: null, expiresAt: null, errorCode: null,
		});
		const state = {
			status: 'active' as const, lastCheckedAt: observedAt, lastRenewedAt: observedAt,
			expiresAt: '2026-09-08T06:20:00.000Z', errorCode: null,
		};
		store.setSessionState(state);
		expect(store.getFeed(new Date(observedAt), 192)).toEqual(before);
		store.close();
		const reopened = createInvestmentStore(filename);
		try {
			expect(reopened.getSessionState()).toEqual(state);
			expect(reopened.getFeed(new Date(observedAt), 192)).toEqual(before);
		} finally {
			reopened.close();
			rmSync(directory, {recursive: true, force: true});
		}
	});

	it('ignores older session writes and rejects unknown fields without erasing current health', () => {
		const store = open();
		const state = {
			status: 'active' as const, lastCheckedAt: observedAt, lastRenewedAt: observedAt,
			expiresAt: '2026-09-08T06:20:00.000Z', errorCode: null,
		};
		store.setSessionState(state);
		store.setSessionState({...state, status: 'auth_required', lastCheckedAt: '2026-09-08T05:59:00.000Z', errorCode: 'OTP_REQUIRED'});
		store.setSessionState({...state, status: 'unknown', lastCheckedAt: null});
		expect(store.getSessionState()).toEqual(state);
		const invalid = {...state, raw: 'must never be stored'};
		expect(() => store.setSessionState(invalid)).toThrow();
		expect(store.getSessionState()).toEqual(state);
	});

	it('reports an uninitialized source without fabricating balances', () => {
		const feed = open().getFeed(new Date(observedAt), 192);
		expect(feed.source).toMatchObject({status: 'never_synced', lastSuccessAt: null, staleAfterHours: 192});
		expect(feed.products).toEqual([]);
		expect(feed.valuations).toEqual([]);
	});

	it('imports exact values and is idempotent', () => {
		const store = open();
		expect(store.applySnapshot(fixture())).toEqual({applied: true, inserted: 3, updated: 0, unchanged: 0});
		expect(store.applySnapshot(fixture())).toEqual({applied: true, inserted: 0, updated: 0, unchanged: 3});
		const feed = store.getFeed(new Date(observedAt), 192);
		expect(feed.valuations[0]!.amount).toBe('12345.67');
		expect(feed.activities[0]!.date).toBe('2026-08');
		expect(feed.source.status).toBe('ok');
	});

	it.each(['complete', 'inventoryComplete'] as const)('retains all verified records when %s is false', field => {
		const store = open();
		store.applySnapshot(fixture());
		const partial = fixture();
		partial[field] = false;
		partial.observedAt = '2026-09-15T06:00:00.000Z';
		partial.valuations[0]!.amount = '0.00';
		partial.activities = [];
		expect(store.applySnapshot(partial).applied).toBe(false);
		const feed = store.getFeed(new Date(partial.observedAt), 192);
		expect(feed.valuations[0]!.amount).toBe('12345.67');
		expect(feed.activities).toHaveLength(1);
		expect(feed.source).toMatchObject({status: 'partial', lastSuccessAt: observedAt, lastAttemptAt: partial.observedAt, errorCode: 'INCOMPLETE_RESPONSE'});
	});

	it('preserves values and successful freshness when authentication expires', () => {
		const store = open();
		store.applySnapshot(fixture());
		store.recordFailure({status: 'auth_required', attemptedAt: '2026-09-15T06:00:00.000Z', errorCode: 'OTP_REQUIRED'});
		const feed = store.getFeed(new Date(observedAt), 192);
		expect(feed.valuations).toEqual(fixture().valuations);
		expect(feed.source).toMatchObject({status: 'auth_required', errorCode: 'OTP_REQUIRED', lastSuccessAt: observedAt});
	});

	it('updates a corrected dated valuation and renamed product without creating another asset', () => {
		const store = open();
		store.applySnapshot(fixture());
		const correction = fixture();
		correction.products[0]!.name = 'Renamed Example Pension';
		correction.valuations[0]!.amount = '12346.67';
		expect(store.applySnapshot(correction)).toMatchObject({inserted: 0, updated: 2});
		const feed = store.getFeed(new Date(observedAt), 192);
		expect(feed.products).toHaveLength(1);
		expect(feed.valuations).toHaveLength(1);
		expect(feed.valuations[0]!.amount).toBe('12346.67');
	});

	it('keeps one current undated value across observations', () => {
		const store = open();
		const snapshot = fixture();
		snapshot.valuations[0]!.asOf = null;
		snapshot.valuations[0]!.id = investmentValuationId(productId, null);
		snapshot.products[0]!.currentValuationId = snapshot.valuations[0]!.id;
		store.applySnapshot(snapshot);
		snapshot.observedAt = '2026-09-15T06:00:00.000Z';
		snapshot.valuations[0]!.observedAt = snapshot.observedAt;
		snapshot.valuations[0]!.amount = '13000.00';
		store.applySnapshot(snapshot);
		const feed = store.getFeed(new Date(snapshot.observedAt), 192);
		expect(feed.valuations).toHaveLength(1);
		expect(feed.valuations[0]).toMatchObject({asOf: null, observedAt: snapshot.observedAt, amount: '13000.00'});
	});

	it('prevents an older observation or delayed failure from replacing newer state', () => {
		const store = open();
		store.applySnapshot(fixture());
		const old = fixture();
		old.observedAt = '2026-09-01T06:00:00.000Z';
		old.valuations[0]!.amount = '1.00';
		expect(() => store.applySnapshot(old)).toThrow(/predates/);
		store.recordFailure({status: 'error', attemptedAt: old.observedAt, errorCode: 'COLLECTION_FAILED'});
		const feed = store.getFeed(new Date(observedAt), 192);
		expect(feed.source.status).toBe('ok');
		expect(feed.valuations[0]!.amount).toBe('12345.67');
	});

	it('retains the explicit current pointer when newly collected history has a known date', () => {
		const store = open();
		const snapshot = fixture();
		snapshot.valuations[0]!.asOf = null;
		snapshot.valuations[0]!.id = investmentValuationId(productId, null);
		snapshot.products[0]!.currentValuationId = snapshot.valuations[0]!.id;
		store.applySnapshot(snapshot);
		snapshot.observedAt = '2026-09-15T06:00:00.000Z';
		snapshot.valuations.push({
			id: investmentValuationId(productId, '2026-07-31'), productId, asOf: '2026-07-31',
			observedAt: snapshot.observedAt, amount: '11000.00', currency: 'ILS',
		});
		store.applySnapshot(snapshot);
		const feed = store.getFeed(new Date(snapshot.observedAt), 192);
		expect(feed.valuations).toHaveLength(2);
		expect(feed.products[0]!.currentValuationId).toBe(investmentValuationId(productId, null));
	});

	it('rejects a current pointer that does not identify the product valuation', () => {
		const store = open();
		const snapshot = fixture();
		snapshot.products[0]!.currentValuationId = investmentValuationId('clal:another-product', '2026-08-31');
		expect(() => store.applySnapshot(snapshot)).toThrow(/current value/);
		expect(store.getFeed(new Date(observedAt), 192).products).toEqual([]);
	});

	it('never deletes products absent from a later inventory', () => {
		const store = open();
		store.applySnapshot(fixture());
		store.applySnapshot({...fixture(), products: [], valuations: [], activities: []});
		const feed = store.getFeed(new Date(observedAt), 192);
		expect(feed.products).toHaveLength(1);
		expect(feed.valuations).toHaveLength(1);
	});

	it('rejects duplicate provider identities without partially writing the snapshot', () => {
		const store = open();
		const snapshot = fixture();
		snapshot.products.push({...snapshot.products[0]!, name: 'Duplicate'});
		expect(() => store.applySnapshot(snapshot)).toThrow(/Duplicate/);
		expect(store.getFeed(new Date(observedAt), 192).products).toEqual([]);
	});

	it('rejects orphan, currency-mismatched, and incorrectly identified records atomically', () => {
		const store = open();
		for (const change of [
			(snapshot: InvestmentSnapshot) => {
				snapshot.valuations[0]!.productId = 'clal:unknown';
			},
			(snapshot: InvestmentSnapshot) => {
				snapshot.valuations[0]!.currency = 'USD';
			},
			(snapshot: InvestmentSnapshot) => {
				snapshot.activities[0]!.sourceId = 'changed';
			},
		]) {
			const snapshot = fixture();
			change(snapshot);
			expect(() => store.applySnapshot(snapshot)).toThrow();
			expect(store.getFeed(new Date(observedAt), 192).products).toEqual([]);
		}
	});
});
