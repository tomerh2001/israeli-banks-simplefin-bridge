#!/usr/bin/env node
/**
 * Process entry (`node dist/index.js`, `yarn dev`): same as `bridge serve`.
 * Loads config, opens the ledger, starts the SimpleFIN server and the scheduler.
 */

import process from 'node:process';
import {createLogger} from './log.js';
import {serve} from './serve.js';

const logger = createLogger('bridge');

try {
	await serve({logger, exit: code => process.exit(code)});
} catch (error) {
	logger.error('startup failed', {error: (error as Error).message});
	process.exit(1);
}
