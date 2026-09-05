/**
 * Minimal logger with secret redaction.
 *
 * Rules:
 * - Any value registered with `redact()` is replaced by `[redacted]` in every line.
 * - Info-level lines must never contain account numbers, descriptions or amounts of
 *   individual transactions; log counts. Row-level detail only via `debug`, which is
 *   printed only when VERBOSE is on.
 */

const secrets = new Set<string>();
let verbose = false;

export function setVerbose(value: boolean): void {
	verbose = value;
}

export function isVerbose(): boolean {
	return verbose;
}

/** Register a secret value so it never appears in logs. Short values (< 4 chars) are ignored. */
export function redact(value: string | undefined): void {
	if (value && value.length >= 4) {
		secrets.add(value);
	}
}

export function scrub(text: string): string {
	let out = text;
	for (const secret of secrets) {
		out = out.split(secret).join('[redacted]');
	}

	return out;
}

function format(level: string, scope: string, message: string, extra?: Record<string, unknown>): string {
	const suffix = extra && Object.keys(extra).length > 0 ? ` ${JSON.stringify(extra)}` : '';
	return scrub(`${new Date().toISOString()} ${level.padEnd(5)} [${scope}] ${message}${suffix}`);
}

export type Logger = {
	info(message: string, extra?: Record<string, unknown>): void;
	warn(message: string, extra?: Record<string, unknown>): void;
	error(message: string, extra?: Record<string, unknown>): void;
	debug(message: string, extra?: Record<string, unknown>): void;
	child(scope: string): Logger;
};

export function createLogger(scope: string): Logger {
	return {
		info: (message, extra) => console.log(format('info', scope, message, extra)),
		warn: (message, extra) => console.warn(format('warn', scope, message, extra)),
		error: (message, extra) => console.error(format('error', scope, message, extra)),
		debug(message, extra) {
			if (verbose) {
				console.log(format('debug', scope, message, extra));
			}
		},
		child: child => createLogger(`${scope}:${child}`),
	};
}
