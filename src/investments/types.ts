import type {z} from 'zod';
import type {
	clalSessionStateSchema,
	investmentActivitySchema,
	investmentErrorCodeSchema,
	investmentExecutionSchema,
	investmentFeedSchema,
	investmentProductSchema,
	investmentProviderSchema,
	investmentReportSummarySchema,
	investmentSnapshotSchema,
	investmentSourceStateSchema,
	investmentTrackSchema,
	investmentValuationSchema,
} from './schema.js';

export type InvestmentProduct = z.infer<typeof investmentProductSchema>;
export type InvestmentProvider = z.infer<typeof investmentProviderSchema>;
export type InvestmentReportSummary = z.infer<typeof investmentReportSummarySchema>;
export type InvestmentValuation = z.infer<typeof investmentValuationSchema>;
export type InvestmentActivity = z.infer<typeof investmentActivitySchema>;
export type InvestmentTrack = z.infer<typeof investmentTrackSchema>;
export type InvestmentExecution = z.infer<typeof investmentExecutionSchema>;
export type InvestmentFeed = z.infer<typeof investmentFeedSchema>;
export type InvestmentSnapshot = z.infer<typeof investmentSnapshotSchema>;
export type InvestmentSourceState = z.infer<typeof investmentSourceStateSchema>;
export type InvestmentErrorCode = z.infer<typeof investmentErrorCodeSchema>;
export type ClalSessionState = z.infer<typeof clalSessionStateSchema>;

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
	/** Append reviewed offline valuations only; preserves source freshness and every existing record. */
	seedArchive(snapshot: InvestmentSnapshot, evidence: {sourceSha256: string; manifest: unknown}): InvestmentImportSummary;
	/** Native consistent backup, written by the same service user as the database. */
	backup(destination: string): Promise<void>;
	recordFailure(failure: InvestmentFailure): void;
	getSessionState(): ClalSessionState;
	/** Does not change financial records or source freshness. */
	setSessionState(state: ClalSessionState): void;
	/** Atomically reserve one of two automatic SMS attempts in a rolling 24-hour window. Never refunded after an uncertain send. */
	consumeAutomaticSmsAttempt(attemptedAt: string): boolean;
	/** A read never reserves an SMS or changes its persistent allowance. */
	getAutomaticSmsNextAllowedAt(at: string): InvestmentSourceState['lastAttemptAt'];
	/** Two explicit refresh starts per rolling minute, shared across process restarts. */
	consumeControlRefreshAttempt(at: string): {allowed: boolean; retryAfterSeconds: number};
	getFeed(now: Date, staleAfterHours: number): InvestmentFeed;
	close(): void;
};
