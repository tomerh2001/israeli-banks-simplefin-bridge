import {z} from 'zod';

export const investmentConfigSchema = z.strictObject({
	enabled: z.boolean().default(false),
	/** Kept empty on omission so an unconfigured investment feed cannot stop the bank server. */
	readToken: z.string().default(''),
	credentials: z.strictObject({id: z.string().default(''), phone: z.string().default('')}).prefault({}),
	schedule: z.string().default('0 7 * * 1'),
	staleHours: z.number().int().min(1).default(192),
	timeoutMinutes: z.number().int().min(1).max(30).default(10),
});

export type InvestmentConfig = z.infer<typeof investmentConfigSchema>;
