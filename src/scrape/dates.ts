/**
 * Calendar-date helpers for the scheduler and synthetic payments. Pure.
 * (src/normalize.ts owns the scraper-facing date conversions; these are the
 * few the scrape side needs on its own.)
 */

import type {IsoDate} from '../types.js';

const formatters = new Map<string, Intl.DateTimeFormat>();

/** `YYYY-MM-DD` of an instant in the given IANA timezone. */
export function calendarDate(instant: Date, timezone: string): IsoDate {
	let formatter = formatters.get(timezone);
	if (!formatter) {
		formatter = new Intl.DateTimeFormat('en-CA', {timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'});
		formatters.set(timezone, formatter);
	}

	return formatter.format(instant);
}

/** Add (or subtract) whole days to a `YYYY-MM-DD` date, UTC arithmetic so DST never bites. */
export function addDays(date: IsoDate, days: number): IsoDate {
	const [year, month, day] = date.split('-').map(Number) as [number, number, number];
	const shifted = new Date(Date.UTC(year, month - 1, day + days));
	return shifted.toISOString().slice(0, 10);
}

/** Largest of the given dates (undefined entries ignored); undefined when none. */
export function maxDate(...dates: Array<Date | undefined>): Date | undefined {
	let max: Date | undefined;
	for (const date of dates) {
		if (date && (!max || date.getTime() > max.getTime())) {
			max = date;
		}
	}

	return max;
}
