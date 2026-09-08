import type {InvestmentValuation} from './types.js';

function part(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) {
		throw new Error('Investment identifiers must not be empty');
	}

	return encodeURIComponent(trimmed);
}

function checked(value: string): string {
	if (value.length > 255) {
		throw new Error('Investment identifiers must not exceed 255 characters');
	}

	return value;
}

/** Provider identity only: product renames and kind corrections do not change identity. */
export function investmentProductId(providerProductId: string): string {
	return checked(`clal:${part(providerProductId)}`);
}

/** Corrections retain their identity; the store retains earlier revisions separately. */
export function investmentValuationId(productId: string, asOf: InvestmentValuation['asOf']): string {
	return checked(`${productId}:valuation:${asOf ?? 'undated'}`);
}

export function investmentActivityId(productId: string, sourceId: string): string {
	return checked(`${productId}:activity:${part(sourceId)}`);
}

export function investmentTrackId(productId: string, sourceTrackId: string): string {
	return checked(`${productId}:track:${part(sourceTrackId)}`);
}
