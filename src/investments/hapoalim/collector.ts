import {randomUUID} from 'node:crypto';
import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
// eslint-disable-next-line import-x/no-extraneous-dependencies, n/no-extraneous-import
import type {Browser} from 'puppeteer';
import type {Logger} from '../../log.js';
import type {SourceRunContext} from '../../types.js';
import {calendarDate} from '../../scrape/dates.js';
import {HapoalimInvestmentError, readHapoalimSecurities} from './browser.js';
import {buildHapoalimSnapshot} from './parser.js';

export const HAPOALIM_INVESTMENT_TIMEOUT_MS = 180_000;

/** This function receives an existing authenticated browser; it cannot log in or reserve another attempt. */
export async function collectHapoalimInvestments(input: {
	context: SourceRunContext;
	browser: Browser;
	apiBase: string;
	logger: Logger;
	/** Offline test seam only; production always uses the bounded native read path. */
	read?: typeof readHapoalimSecurities;
}): Promise<void> {
	const {context, browser, apiBase, logger} = input;
	const integration = context.hapoalimInvestments;
	if (!integration?.config.enabled || context.company !== 'hapoalim') {
		return;
	}

	const {config, store} = integration;
	const attemptedAt = new Date().toISOString();
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		if (!Array.isArray(context.config.accounts) || context.config.accounts.length !== 1) {
			throw new HapoalimInvestmentError('INVALID_RESPONSE');
		}

		const accountSelector = context.config.accounts[0]!;
		const captureDir = path.join(context.env.dataDir, 'hapoalim-investments', 'captures', randomUUID());
		mkdirSync(path.dirname(path.dirname(captureDir)), {recursive: true, mode: 0o700});
		mkdirSync(path.dirname(captureDir), {recursive: true, mode: 0o700});
		mkdirSync(captureDir, {mode: 0o700});
		const timeout = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => {
				const error = new HapoalimInvestmentError('TIMEOUT');
				controller.abort(error);
				reject(error);
			}, HAPOALIM_INVESTMENT_TIMEOUT_MS);
		});
		const to = calendarDate(new Date(attemptedAt), context.timezone);
		const read = await Promise.race([
			(input.read ?? readHapoalimSecurities)({
				browser, apiBase, accountSelector, from: config.historyStartDate, to, signal: controller.signal,
				capture(name, value) {
					controller.signal.throwIfAborted();
					if (!/^(?:portfolio|history-\d{3})$/.test(name)) {
						throw new HapoalimInvestmentError('INVALID_RESPONSE');
					}

					writeFileSync(path.join(captureDir, `${name}.json`), `${JSON.stringify(value)}\n`, {mode: 0o600, flag: 'wx'});
				},
			}), timeout,
		]);
		controller.signal.throwIfAborted();
		const snapshot = buildHapoalimSnapshot({read, accountSelector, from: config.historyStartDate, to, observedAt: attemptedAt});
		store.applySnapshot(snapshot);
		writeFileSync(path.join(captureDir, 'summary.json'), `${JSON.stringify({
			observedAt: attemptedAt, paginationComplete: read.paginationComplete, historyPages: read.historyPages,
			executions: read.executions.length, requestedFrom: config.historyStartDate, requestedTo: to,
			lifetimeHistoryCompleteness: 'unverified', currentValuationVerified: false,
		})}\n`, {mode: 0o600, flag: 'wx'});
		logger.info('Hapoalim investment history collected; current portfolio remains unverified', {
			executions: read.executions.length, pages: read.historyPages, status: 'partial',
		});
	} catch (error) {
		const errorCode = error instanceof HapoalimInvestmentError ? error.code : 'INVALID_RESPONSE';
		try {
			store.recordFailure({status: errorCode === 'OTP_REQUIRED' ? 'auth_required' : 'partial', attemptedAt, errorCode});
		} catch {
			logger.error('Hapoalim investment status unavailable; checking result retained');
		}

		logger.warn('Hapoalim investment collection needs attention; checking result retained', {errorCode});
	} finally {
		clearTimeout(timer);
		controller.abort();
	}
}
