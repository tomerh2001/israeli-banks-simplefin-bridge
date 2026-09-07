/**
 * Securo-import-compatible CSV export.
 *
 * Columns: date,description,amount,type,currency,external_id,payee,notes.
 * Securo's CSV importer auto-detects date/description/amount/type/currency/payee/notes
 * by header name; `external_id` has to be mapped explicitly in the import dialog
 * (import_service.py: "External ID must be mapped explicitly"). `amount` is absolute
 * and `type` is `debit` (money out) or `credit` (money in). RFC 4180 quoting, CRLF.
 */

import type {CompanyConfig, CompanyId, Config, IsoDate, Ledger, LedgerTransaction} from '../types.js';
import {formatAmount} from '../simplefin/payload.js';

export const CSV_HEADER = ['date', 'description', 'amount', 'type', 'currency', 'external_id', 'payee', 'notes'] as const;

export type CsvExportOptions = {
	accountIds?: string[];
	/** Inclusive lower bound on bookedDate. */
	from?: IsoDate;
	/** Exclusive upper bound on bookedDate. */
	to?: IsoDate;
};

/** Quote a field per RFC 4180 when it contains a comma, quote, CR or LF. */
export function csvField(value: string): string {
	return /[\n\r",]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function csvRow(row: LedgerTransaction): string {
	const description = row.description.trim();
	return [
		row.bookedDate,
		description,
		formatAmount(Math.abs(row.amount)),
		row.amount < 0 ? 'debit' : 'credit',
		row.currency,
		row.id,
		description,
		row.memo?.trim() ?? '',
	].map(field => csvField(field)).join(',');
}

function companyFor(config: Config, company: CompanyId): CompanyConfig | undefined {
	return config.companies[company];
}

/**
 * Export ledger transactions as CSV text. Only accounts of enabled companies are
 * exported; pending rows are included only for companies with `includePending`.
 */
export function exportCsv(ledger: Ledger, config: Config, options: CsvExportOptions = {}): string {
	const rows = ledger
		.listTransactions({accountIds: options.accountIds, from: options.from, to: options.to, includePending: true, includeSynthetic: true})
		.filter(row => {
			const companyConfig = companyFor(config, row.company);
			return companyConfig?.enabled && (row.status !== 'pending' || companyConfig.includePending);
		});
	const lines = [CSV_HEADER.join(','), ...rows.map(row => csvRow(row))];
	return `${lines.join('\r\n')}\r\n`;
}
