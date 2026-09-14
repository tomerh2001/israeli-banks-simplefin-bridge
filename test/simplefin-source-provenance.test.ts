import {describe, expect, it} from 'vitest';
import {createMemoryLedger} from '../src/ledger/memory.js';
import {toSimpleFinTransaction} from '../src/simplefin/payload.js';
import {seedAccount, seedTransaction} from './helpers/seed.js';

const recordId = 'f551360d-1caf-4c81-82c2-2b3ff8fe8f54';

function transaction(raw: unknown, synthetic = false) {
	const ledger = createMemoryLedger();
	seedAccount(ledger);
	const row = seedTransaction(ledger, {raw, synthetic});
	return {row, wire: toSimpleFinTransaction(row, 'ILS')};
}

describe('minimal archive provenance', () => {
	it.each(['actual', 'sure'] as const)('retains %s identity without disclosing archived source records or altering money', origin => {
		const {row, wire} = transaction({archiveMigration: {
			origin, originRowId: recordId, sourceIdentifier: 'private-reference', sourceRecord: {privateValue: 'not-for-feed'},
		}});
		expect(wire.extra?.source_provenance).toEqual({origin: `${origin}_archive`, source_record_id: recordId});
		expect(wire.id).toBe(row.id);
		expect(wire.amount).toBe(row.amount.toFixed(2));
		expect(JSON.stringify(wire)).not.toMatch(/private-reference|not-for-feed|sourceIdentifier|sourceRecord/);
	});

	it.each([
		undefined,
		{},
		{archiveMigration: {origin: 'guessed', originRowId: recordId}},
		{archiveMigration: {origin: 'actual', originRowId: 'not-a-uuid'}},
		{source_provenance: {origin: 'actual_archive', source_record_id: recordId}},
	])('does not manufacture archive provenance from unknown or malformed evidence', raw => {
		expect(transaction(raw).wire.extra).not.toHaveProperty('source_provenance');
	});

	it('does not attribute a synthetic payment to an archive', () => {
		expect(transaction({archiveMigration: {origin: 'actual', originRowId: recordId}}, true).wire.extra).not.toHaveProperty('source_provenance');
	});
});
