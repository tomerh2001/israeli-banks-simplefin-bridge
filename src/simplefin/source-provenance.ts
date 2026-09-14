import {z} from 'zod';
import type {LedgerTransaction} from '../types.js';

const archiveSchema = z.object({origin: z.enum(['actual', 'sure']), originRowId: z.uuid()});

/** Expose only the archive's identity; retained source records stay inside the ledger. */
export function sourceProvenance(row: LedgerTransaction): {origin: 'actual_archive' | 'sure_archive'; source_record_id: string} | undefined {
	if (row.synthetic || !row.raw || typeof row.raw !== 'object') {
		return undefined;
	}

	const parsed = archiveSchema.safeParse((row.raw as Record<string, unknown>).archiveMigration);
	return parsed.success
		? {origin: parsed.data.origin === 'actual' ? 'actual_archive' : 'sure_archive', source_record_id: parsed.data.originRowId.toLowerCase()}
		: undefined;
}
