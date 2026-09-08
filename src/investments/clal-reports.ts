import {ClalCollectionError} from './browser.js';
import {clalArray, clalProductIdentity, clalRecord, parseClalDate, parseClalMoney, requireClalSuccess, type ClalPortfolioInput} from './clal-portfolio.js';
import {investmentSnapshotSchema} from './schema.js';
import type {InvestmentProduct, InvestmentSnapshot} from './types.js';

type Report = NonNullable<InvestmentProduct['reportSummaries']>[number];

function label(value: unknown): string {
	if (typeof value !== 'string' || !value.trim()) {
		throw new ClalCollectionError('INVALID_RESPONSE');
	}

	return value.trim();
}

function lines(value: unknown): Report['lines'] {
	return clalArray(value).map(raw => clalRecord(raw)).filter(row =>
		row.Total !== null && row.Total !== undefined && (typeof row.Total !== 'string' || !['', '-', '—'].includes(row.Total.trim()))).map(row => ({label: label(row.Title), amount: parseClalMoney(row.Total)}));
}

function openingDate(rows: Report['lines']): Report['fromDate'] {
	const opening = rows.find(row => row.label.includes('(פתיחה)'));
	const date = opening?.label.match(/\b\d{2}\/\d{2}\/\d{4}\b/)?.[0];
	return parseClalDate(date);
}

/** Provider reports are informational aggregates. Never manufacture dated fees or add them to wealth. */
export function enrichClalReports(snapshot: InvestmentSnapshot, input: Pick<ClalPortfolioInput, 'pensionDetails' | 'gemelDetails'>): InvestmentSnapshot {
	const products = snapshot.products.map(product => ({...product}));
	for (const [family, responses] of [
		['pension', input.pensionDetails ?? []], ['hishtalmut', input.gemelDetails ?? []],
	] as const) {
		for (const response of responses) {
			if (response.status !== 200) {
				throw new ClalCollectionError('INVALID_RESPONSE');
			}

			const data = requireClalSuccess(response.data);
			const details = clalRecord(family === 'pension' ? data.PolicyDetails : data.FundDetails);
			const {id} = clalProductIdentity(family, family === 'pension' ? details.PolicyId : details.FundNumber);
			const product = products.find(item => item.id === id);
			if (!product) {
				throw new ClalCollectionError('INVALID_RESPONSE');
			}

			const reports: Report[] = [];
			const keys = family === 'pension' ? ['PeriodBalance', 'PeriodBalanceLastYear'] : ['DeposMonthlyBalance'];
			const availableKeys = keys.filter(key => data[key] !== null && data[key] !== undefined);
			for (const key of availableKeys) {
				const block = clalRecord(data[key]);
				const reportLines = lines(family === 'pension' ? block.PeriodBalanceRows : block.DeposMonthlyList);
				const fromDate = family === 'pension' ? openingDate(reportLines) : parseClalDate(block.StartYear);
				const toDate = parseClalDate(family === 'pension' ? block.Date : block.EndYear);
				reports.push({id: `${key}:${fromDate ?? 'unknown'}:${toDate ?? 'unknown'}`, title: 'תנועות ויתרות', fromDate, toDate, lines: reportLines});
			}

			product.reportSummaries = reports;
		}
	}

	return investmentSnapshotSchema.parse({...snapshot, products});
}
