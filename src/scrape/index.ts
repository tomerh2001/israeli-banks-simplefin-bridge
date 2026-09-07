/** Scraping side: browser launch, profiles, runner, scheduler, assisted login, synthetic payments. */

export {buildLaunchArgs, resolveExecutablePath} from './browser.js';
export {addDays, calendarDate, maxDate} from './dates.js';
export {looksLikeOtpChallenge, mapScraperError, SCRAPE_ERROR_MESSAGES, type MappedScrapeError} from './errors.js';
export {assistedLogin, createPostLoginDetector, type AssistedLoginOptions} from './login.js';
export {clearStaleLocks, ensureProfileDir, resetProfile} from './profile.js';
export {
	buildScraperOptions,
	createScraperSource,
	pruneScreenshots,
	runCompany,
	SCREENSHOT_RETENTION_DAYS,
	screenshotPath,
} from './runner.js';
export {
	computeWindowStart,
	createScheduler,
	defaultSourceState,
	unparkCompany,
	type RunNowOptions,
	type Scheduler,
	type SchedulerOptions,
} from './scheduler.js';
export {computeSyntheticPayments} from './synthetic.js';
