import {z} from 'zod';

const id = z.string().trim().min(1).max(255);
const date = z.iso.date();
const timestamp = z.iso.datetime();
const currency = z.string().regex(/^[A-Z]{3}$/);

/** Exact money on the wire and in SQLite: never parse through a float. */
export const investmentMoneySchema = z.string().regex(/^-?(?:0|[1-9]\d*)\.\d{2}$/).refine(value => value !== '-0.00');
const nonnegativeMoney = investmentMoneySchema.refine(value => !value.startsWith('-'));
const coverage = z.enum(['complete', 'partial', 'unavailable']);

export const investmentReportSummarySchema = z.strictObject({
	id,
	title: z.string().trim().min(1).max(255),
	fromDate: date.nullable(),
	toDate: date.nullable(),
	lines: z.array(z.strictObject({label: z.string().trim().min(1).max(500), amount: investmentMoneySchema})),
}).refine(report => !report.fromDate || !report.toDate || report.fromDate <= report.toDate, {
	message: 'Report period must not end before it begins',
});

export const investmentProductSchema = z.strictObject({
	id,
	provider: z.literal('clal'),
	/** Actual provider account/policy identity, independent of its display name or classification. */
	providerProductId: id,
	kind: z.enum(['pension', 'keren_hishtalmut', 'provident_fund', 'investment']),
	name: z.string().trim().min(1).max(255),
	currency,
	/** Explicit authoritative current value; history collection alone never changes this pointer. */
	currentValuationId: id.nullable(),
	liquidity: z.strictObject({
		status: z.enum(['restricted', 'available', 'partially_available', 'unknown']),
		availableFrom: date.nullable(),
		availableAmount: nonnegativeMoney.nullable(),
	}),
	coverage: z.strictObject({valuations: coverage, activities: coverage, tracks: coverage}),
	forecast: z.strictObject({monthlyPension: nonnegativeMoney, currency, asOf: date.nullable()}).nullable(),
	/** Provider period figures only: never generate activities or add them to valuations. */
	reportSummaries: z.array(investmentReportSummarySchema)
		.refine(reports => new Set(reports.map(report => report.id)).size === reports.length, {message: 'Duplicate report identity'})
		.optional(),
});

export const investmentValuationSchema = z.strictObject({
	id,
	productId: id,
	/** Null means the provider did not supply a valuation date. Never substitute the observation date. */
	asOf: date.nullable(),
	observedAt: timestamp,
	amount: nonnegativeMoney,
	currency,
});

export const investmentActivitySchema = z.strictObject({
	id,
	productId: id,
	/** Stable provider row identity; text/amount/date similarity alone is insufficient for deduplication. */
	sourceId: id,
	date: z.string(),
	dateKind: z.enum(['effective', 'booking', 'contribution_month']),
	kind: z.enum([
		'employee_contribution',
		'employer_contribution',
		'severance_contribution',
		'withdrawal',
		'transfer_in',
		'transfer_out',
		'management_fee',
		'insurance_cost',
		'investment_return',
		'actuarial_adjustment',
		'other',
	]),
	/** Signed effect on the product's value. Positive fee reversals are valid. */
	amount: investmentMoneySchema,
	currency,
	description: z.string().trim().min(1).max(1000),
	observedAt: timestamp,
}).superRefine((activity, context) => {
	const valid = activity.dateKind === 'contribution_month'
		? /^\d{4}-(?:0[1-9]|1[0-2])$/.test(activity.date)
		: date.safeParse(activity.date).success;
	if (!valid) {
		context.addIssue({code: 'custom', path: ['date'], message: 'Date must retain the precision specified by dateKind'});
	}
});

export const investmentTrackSchema = z.strictObject({
	id,
	productId: id,
	name: z.string().trim().min(1).max(255),
	allocationPercent: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/)
		.refine(value => Number(value) <= 100).nullable(),
	amount: nonnegativeMoney.nullable(),
	currency,
	asOf: date.nullable(),
	observedAt: timestamp,
});

export const investmentErrorCodeSchema = z.enum([
	'OTP_REQUIRED',
	'INVALID_CREDENTIALS',
	'ACCOUNT_BLOCKED',
	'TIMEOUT',
	'CREDENTIAL_RESOLUTION_FAILED',
	'INCOMPLETE_RESPONSE',
	'INVALID_RESPONSE',
	'COLLECTION_FAILED',
]);

export const investmentSourceStateSchema = z.strictObject({
	provider: z.literal('clal'),
	status: z.enum(['ok', 'partial', 'auth_required', 'error', 'never_synced']),
	lastAttemptAt: timestamp.nullable(),
	lastSuccessAt: timestamp.nullable(),
	staleAfterHours: z.number().int().positive(),
	errorCode: investmentErrorCodeSchema.nullable(),
	inventoryComplete: z.boolean(),
});

const dataShape = {
	products: z.array(investmentProductSchema),
	valuations: z.array(investmentValuationSchema),
	activities: z.array(investmentActivitySchema),
	tracks: z.array(investmentTrackSchema),
};

export const investmentFeedSchema = z.strictObject({
	schemaVersion: z.literal(1),
	generatedAt: timestamp,
	source: investmentSourceStateSchema,
	...dataShape,
});

/** Collector result. complete=false never replaces previously verified records. */
export const investmentSnapshotSchema = z.strictObject({
	observedAt: timestamp,
	complete: z.boolean(),
	inventoryComplete: z.boolean(),
	...dataShape,
});
