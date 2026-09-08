import type {z} from 'zod';
import type {
	investmentActivitySchema,
	investmentErrorCodeSchema,
	investmentFeedSchema,
	investmentProductSchema,
	investmentReportSummarySchema,
	investmentSnapshotSchema,
	investmentSourceStateSchema,
	investmentTrackSchema,
	investmentValuationSchema,
} from './schema.js';

export type InvestmentProduct = z.infer<typeof investmentProductSchema>;
export type InvestmentReportSummary = z.infer<typeof investmentReportSummarySchema>;
export type InvestmentValuation = z.infer<typeof investmentValuationSchema>;
export type InvestmentActivity = z.infer<typeof investmentActivitySchema>;
export type InvestmentTrack = z.infer<typeof investmentTrackSchema>;
export type InvestmentFeed = z.infer<typeof investmentFeedSchema>;
export type InvestmentSnapshot = z.infer<typeof investmentSnapshotSchema>;
export type InvestmentSourceState = z.infer<typeof investmentSourceStateSchema>;
export type InvestmentErrorCode = z.infer<typeof investmentErrorCodeSchema>;

export type InvestmentFailure = {
	status: 'partial' | 'auth_required' | 'error';
	attemptedAt: string;
	errorCode: InvestmentErrorCode;
};

export type InvestmentImportSummary = {
	applied: boolean;
	inserted: number;
	updated: number;
	unchanged: number;
};

export type InvestmentStore = {
	/** Atomic; incomplete results preserve every previously verified row. Absence never deletes a product. */
	applySnapshot(snapshot: InvestmentSnapshot): InvestmentImportSummary;
	recordFailure(failure: InvestmentFailure): void;
	getFeed(now: Date, staleAfterHours: number): InvestmentFeed;
	close(): void;
};
