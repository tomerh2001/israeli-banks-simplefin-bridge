/**
 * Hide the one ExperimentalWarning `node:sqlite` prints on Node 22 so CLI output
 * and container logs stay clean; every other warning still prints. Node emits the
 * warning while the builtin is instantiated (ESM link time, before any user module
 * evaluates), so the filter must be installed before the ledger module is loaded:
 * `openContext()` imports it dynamically after calling this.
 */

import process from 'node:process';

let installed = false;

/** Install the filter once; safe to call repeatedly. */
export function suppressSqliteWarning(): void {
	if (installed) {
		return;
	}

	installed = true;
	const listeners = process.listeners('warning');
	process.removeAllListeners('warning');
	process.on('warning', warning => {
		if (warning.name === 'ExperimentalWarning' && warning.message.includes('SQLite')) {
			return;
		}

		for (const listener of listeners) {
			listener(warning);
		}
	});
}
