/**
 * Calendar-date <-> epoch helpers for the SimpleFIN payload.
 *
 * `posted` is always 12:00 UTC of the booked calendar date, so a consumer that
 * converts it to a UTC date can never shift the day. Windows (`start-date`,
 * `end-date`) are mapped back onto calendar dates with the same convention:
 * a row is in the window iff startEpoch <= posted(bookedDate) < endEpoch.
 */

import type {IsoDate} from '../types.js';

const secondsPerDay = 86_400;
const noonOffset = secondsPerDay / 2;

/** Epoch seconds of 12:00 UTC on a `YYYY-MM-DD` calendar date. */
export function calendarDateToPostedEpoch(date: IsoDate): number {
	const [y, m, d] = date.split('-').map(Number);
	return Math.floor(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12) / 1000);
}

/** `YYYY-MM-DD` for a day index (days since 1970-01-01 UTC). */
function dayIndexToDate(dayIndex: number): IsoDate {
	return new Date(dayIndex * secondsPerDay * 1000).toISOString().slice(0, 10);
}

/**
 * Earliest calendar date whose posted epoch (12:00Z) is >= `epochSeconds`.
 * Used for the inclusive lower bound of a window.
 */
export function windowStartDate(epochSeconds: number): IsoDate {
	return dayIndexToDate(Math.ceil((epochSeconds - noonOffset) / secondsPerDay));
}

/**
 * Earliest calendar date whose posted epoch (12:00Z) is >= `epochSeconds`;
 * as an exclusive upper bound it excludes exactly the dates with posted >= end.
 */
export function windowEndDate(epochSeconds: number): IsoDate {
	return windowStartDate(epochSeconds);
}

/** Epoch seconds (integer) of an ISO timestamp or Date. */
export function toEpochSeconds(value: string | Date): number {
	const ms = value instanceof Date ? value.getTime() : Date.parse(value);
	return Math.floor(ms / 1000);
}
