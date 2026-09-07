/**
 * Official web sites of every institution israeli-bank-scrapers supports.
 * Used for SimpleFIN `connections[].org_url` / `accounts[].org` so consumers
 * (Securo derives an institution favicon from it) show the right bank.
 *
 * The `Record<CompanyId, ...>` type makes the compiler refuse a missing company.
 */

import type {CompanyId} from '../types.js';

export type OrgInfo = {
	/** Institution display name (English). */
	name: string;
	/** Public web site, https, no trailing slash. */
	url: string;
};

export const ORGS: Record<CompanyId, OrgInfo> = {
	hapoalim: {name: 'Bank Hapoalim', url: 'https://www.bankhapoalim.co.il'},
	beinleumi: {name: 'First International Bank (Beinleumi)', url: 'https://www.fibi.co.il'},
	union: {name: 'Union Bank', url: 'https://www.unionbank.co.il'},
	amex: {name: 'American Express Israel', url: 'https://www.americanexpress.co.il'},
	isracard: {name: 'Isracard', url: 'https://www.isracard.co.il'},
	visaCal: {name: 'Visa Cal', url: 'https://www.cal-online.co.il'},
	max: {name: 'Max', url: 'https://www.max.co.il'},
	otsarHahayal: {name: 'Bank Otsar Hahayal', url: 'https://www.bankotsar.co.il'},
	discount: {name: 'Discount Bank', url: 'https://www.discountbank.co.il'},
	mercantile: {name: 'Mercantile Bank', url: 'https://www.mercantile.co.il'},
	mizrahi: {name: 'Mizrahi-Tefahot Bank', url: 'https://www.mizrahi-tefahot.co.il'},
	leumi: {name: 'Bank Leumi', url: 'https://www.leumi.co.il'},
	massad: {name: 'Bank Massad', url: 'https://www.bankmassad.co.il'},
	yahav: {name: 'Bank Yahav', url: 'https://www.bank-yahav.co.il'},
	behatsdaa: {name: 'Behatsdaa', url: 'https://www.behatsdaa.org.il'},
	beyahadBishvilha: {name: 'Beyahad Bishvilha', url: 'https://www.hist.org.il'},
	oneZero: {name: 'One Zero Digital Bank', url: 'https://www.onezerobank.com'},
	pagi: {name: 'Bank Pagi', url: 'https://www.pagi.co.il'},
};

/** Org info for a company; unknown ids (ledger rows from a newer scraper version) get a generic entry. */
export function orgFor(company: string): OrgInfo {
	return (ORGS as Record<string, OrgInfo | undefined>)[company] ?? {name: company, url: 'https://github.com/eshaham/israeli-bank-scrapers'};
}

/** Host name of an org URL, for the v1 `org.domain` field. */
export function orgDomain(org: OrgInfo): string {
	try {
		return new URL(org.url).hostname;
	} catch {
		return org.url;
	}
}
