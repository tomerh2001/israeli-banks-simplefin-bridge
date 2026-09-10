/* eslint-disable @typescript-eslint/no-restricted-types -- Explicit null preserves unavailable provider fields in the investment feed. */
import {createHash} from 'node:crypto';
import {investmentExecutionId, investmentProductId} from '../ids.js';
import {investmentExecutionSchema, investmentSnapshotSchema} from '../schema.js';
import type {InvestmentExecution, InvestmentSnapshot} from '../types.js';
import {HapoalimInvestmentError, type HapoalimSecuritiesRead} from './browser.js';

function invalid(): never {
	throw new HapoalimInvestmentError('INVALID_RESPONSE');
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : invalid();
}

function text(value: unknown, nullable = false): string | null {
	if (value === null && nullable) {
		return null;
	}

	return typeof value === 'string' && value.trim() ? value.trim() : invalid();
}

/** Preserve source decimal digits, including scientific JSON numbers, without rounding positions. */
export function sourceDecimal(value: unknown, nullable = false): string | null {
	if (value === null && nullable) {
		return null;
	}

	if ((typeof value !== 'string' && typeof value !== 'number') || (typeof value === 'number' && !Number.isFinite(value))) {
		return invalid();
	}

	const raw = String(value);
	const parts = /^(?<sign>-?)(?<integer>0|[1-9]\d*)(?:\.(?<fraction>\d+))?(?:e(?<exponent>[+-]?\d+))?$/i.exec(raw);
	if (!parts) {
		return invalid();
	}

	const exponent = Number(parts.groups!.exponent ?? 0);
	if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 30) {
		return invalid();
	}

	const integer = parts.groups!.integer!;
	const digits = integer + (parts.groups!.fraction ?? '');
	const point = integer.length + exponent;
	const expanded = point <= 0
		? `0.${'0'.repeat(-point)}${digits}`
		: (point >= digits.length ? digits.padEnd(point, '0') : `${digits.slice(0, point)}.${digits.slice(point)}`);
	const [whole, fraction = ''] = expanded.split('.');
	const canonicalWhole = whole!.replace(/^0+(?=\d)/, '');
	const canonicalFraction = fraction.replace(/0+$/, '');
	if (canonicalFraction.length > 12 || canonicalWhole.length > 30) {
		return invalid();
	}

	const canonical = canonicalWhole + (canonicalFraction ? `.${canonicalFraction}` : '');
	return parts.groups!.sign && canonical !== '0' ? `-${canonical}` : canonical;
}

function money(value: unknown): string | null {
	const decimal = sourceDecimal(value, true);
	if (decimal === null) {
		return null;
	}

	const [whole, fraction = ''] = decimal.split('.');
	if (fraction.length > 2) {
		return invalid();
	}

	return `${whole}.${fraction.padEnd(2, '0')}`;
}

function calendarDate(value: unknown, nullable = false): string | null {
	if (value === null && nullable) {
		return null;
	}

	if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}(?:[+-]\d{2}:\d{2})?$/.test(value)) {
		return invalid();
	}

	const date = value.slice(0, 10);
	if (nullable && date === '0001-01-01') {
		return null;
	}

	if (date < '1900-01-01' || new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) !== date) {
		return invalid();
	}

	return date;
}

const currencies: Record<string, string> = {
	'שקל חדש': 'ILS', 'דולר ארה"ב': 'USD', אירו: 'EUR', 'לירה שטרלינג': 'GBP', 'ין יפני': 'JPY',
	ILS: 'ILS', USD: 'USD', EUR: 'EUR', GBP: 'GBP', JPY: 'JPY',
};
const kinds: Record<string, InvestmentExecution['kind']> = {
	קניה: 'buy', מכירה: 'sell', 'דבידנד תשלום': 'dividend', 'ריבית תשלום': 'interest', פדיון: 'redemption',
	'הטבה חלוקת מניות': 'stock_bonus', 'העברה לזכות הפקדון': 'transfer_in', 'העברה לחובת הפקדון': 'transfer_out',
	'העברה לזכות הפקדון (דו צדדית)': 'transfer_in', 'העברה לחובת הפקדון (דו צדדית)': 'transfer_out',
};

function currency(value: unknown): string {
	return typeof value === 'string' && Object.hasOwn(currencies, value) ? currencies[value]! : invalid();
}

export function parseHapoalimExecution(value: unknown, input: {accountSelector: string; from: string; to: string; observedAt: string}): InvestmentExecution {
	const row = record(value);
	const [, expectedBranch, expectedAccount] = input.accountSelector.split('-');
	if (!/^\d+-\d+-\d+$/.test(input.accountSelector) || String(row.Branch) !== String(Number(expectedBranch))
		|| String(row.Account) !== String(Number(expectedAccount))) {
		return invalid();
	}

	const productId = investmentProductId(`${input.accountSelector}:securities`, 'hapoalim');
	const tradeDate = calendarDate(row.TradeDate)!;
	if (tradeDate < input.from || tradeDate > input.to || !['כן', 'לא'].includes(row.IsCancelTransaction as string)) {
		return invalid();
	}

	const valueDate = calendarDate(row.ValueDate, true);
	const settlementDate = calendarDate(row.SettlementDate, true);
	const cancelDate = calendarDate(row.CancelDate, true);
	const cancelled = row.IsCancelTransaction === 'כן';
	if (cancelled && cancelDate === null) {
		return invalid();
	}

	const securityId = text(row.Security)!;
	const sourceTradeType = text(row.TradeType)!;
	const sourceTransactionType = text(row.TransactionType)!;
	const sourcePaymentType = text(row.PaymentType, true);
	const quantity = sourceDecimal(row.NV, true);
	const unitPrice = sourceDecimal(row.TradePrice, true);
	const netCashAmount = money(row.NetValueTradeCurrency);
	const identity = [
		input.accountSelector,
		securityId,
		tradeDate,
		valueDate,
		settlementDate,
		sourceTradeType,
		sourceTransactionType,
		quantity,
		unitPrice,
		netCashAmount,
		sourcePaymentType,
		calendarDate(row.PaymentDate, true),
		calendarDate(row.ExDate, true),
		cancelDate,
	];
	const sourceId = `natural-key-v1:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;
	return investmentExecutionSchema.parse({
		id: investmentExecutionId(productId, sourceId), productId, sourceId, sourceIdKind: 'natural_key',
		kind: Object.hasOwn(kinds, sourceTradeType) ? kinds[sourceTradeType] : 'other',
		securityId, isin: text(row.ISIN, true), symbol: text(row.Symbol, true), name: text(row.EngName ?? row.HebName),
		tradeDate, valueDate, settlementDate, cancelDate, cancelled, quantity, unitPrice, netCashAmount,
		currency: currency(row.TradeCurrency), settlementNetCashAmount: money(row.NetValueSettlementCurrency),
		settlementCurrency: currency(row.SettlementCurrency), sourceTradeType, sourceTransactionType,
		sourcePaymentType, observedAt: input.observedAt,
	});
}

/** Position metadata alone proves neither current value nor an empty portfolio. */
export function buildHapoalimSnapshot(input: {
	read: HapoalimSecuritiesRead; accountSelector: string; from: string; to: string; observedAt: string;
}): InvestmentSnapshot {
	const view = record(record(input.read.portfolio).View);
	const meta = record(view.Meta);
	if (meta.Security !== undefined && !Array.isArray(meta.Security)) {
		return invalid();
	}

	const productId = investmentProductId(`${input.accountSelector}:securities`, 'hapoalim');
	const executions = input.read.executions.map(row => parseHapoalimExecution(row, input));
	const identities = new Set(executions.map(row => row.id));
	if (identities.size !== executions.length || !input.read.paginationComplete) {
		throw new HapoalimInvestmentError('INCOMPLETE_RESPONSE');
	}

	return investmentSnapshotSchema.parse({
		observedAt: input.observedAt, complete: true, inventoryComplete: false,
		products: [{
			id: productId, provider: 'hapoalim', providerProductId: `${input.accountSelector}:securities`,
			kind: 'investment', name: 'Hapoalim Investments', currency: 'ILS', currentValuationId: null,
			liquidity: {status: 'unknown', availableFrom: null, availableAmount: null},
			coverage: {valuations: 'unavailable', activities: 'unavailable', tracks: 'unavailable', executions: 'partial'}, forecast: null,
		}],
		valuations: [], activities: [], tracks: [], executions,
	});
}
