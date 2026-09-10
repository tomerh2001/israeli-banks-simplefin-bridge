import {z} from 'zod';

export const investmentConfigSchema = z.strictObject({
	enabled: z.boolean().default(false),
	/** Kept empty on omission so an unconfigured investment feed cannot stop the bank server. */
	readToken: z.string().default(''),
	/** Independent capability for status and explicit collection; never reuse the read token. */
	controlToken: z.string().default(''),
	credentials: z.strictObject({id: z.string().default(''), phone: z.string().default('')}).prefault({}),
	schedule: z.string().default('0 7 * * 1'),
	staleHours: z.number().int().min(1).default(192),
	timeoutMinutes: z.number().int().min(1).max(30).default(10),
	/** Opt in to session-only renewal; disabled by default and never requests an SMS. */
	sessionKeepAliveMinutes: z.number().int().min(0).max(10).default(0),
	/** A dedicated local OTP receiver; omission keeps every SMS request operator initiated. */
	googleMessagesOtpSocket: z.string().regex(/^\/[^\0]+$/).max(107).optional(),
});

export type InvestmentConfig = z.infer<typeof investmentConfigSchema>;

export const bestInvestConfigSchema = investmentConfigSchema.extend({
	credentials: z.strictObject({
		id: z.string().default(''), phone: z.string().default(''), email: z.string().optional(),
	}).prefault({}),
	schedule: z.string().default('30 3 * * *'),
	staleHours: z.number().int().min(1).default(72),
	// Best Invest does not expose a verified session renewal contract.
	sessionKeepAliveMinutes: z.literal(0).default(0),
});

export type BestInvestConfig = z.infer<typeof bestInvestConfigSchema>;

/** Collected during the existing Hapoalim login; never has a separate schedule or credentials. */
export const hapoalimInvestmentsConfigSchema = z.strictObject({
	enabled: z.boolean().default(false),
	readToken: z.string().default(''),
	controlToken: z.string().default(''),
	staleHours: z.number().int().min(1).default(30),
	historyStartDate: z.iso.date().default('2023-01-01'),
});

export type HapoalimInvestmentsConfig = z.infer<typeof hapoalimInvestmentsConfigSchema>;
