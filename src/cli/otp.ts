import {Buffer} from 'node:buffer';
import process from 'node:process';
import type {Readable, Writable} from 'node:stream';

export class OtpInputError extends Error {}

export type OtpInput = Readable & {
	isTTY?: boolean;
	isRaw?: boolean;
	setRawMode?(enabled: boolean): unknown;
};

/** Read one six-digit code without echo, logging, argv, or persistent storage. */
export async function readOneTimeCode(
	signal: AbortSignal,
	input: OtpInput = process.stdin,
	output: Pick<Writable, 'write'> = process.stderr,
): Promise<string> {
	if (signal.aborted) {
		throw new OtpInputError('OTP entry canceled');
	}

	return new Promise<string>((resolve, reject) => {
		let code = '';
		let finished = false;
		let changedRawMode = false;
		const previousRawMode = input.isRaw ?? false;
		const restorePaused = input.readableFlowing !== true;
		const finish = (error?: OtpInputError): void => {
			if (finished) {
				return;
			}

			finished = true;
			input.off('data', onData);
			input.off('end', onEnd);
			input.off('close', onEnd);
			input.off('error', onError);
			signal.removeEventListener('abort', onAbort);
			try {
				if (changedRawMode) {
					input.setRawMode?.(previousRawMode);
				}

				if (restorePaused) {
					input.pause();
				}

				if (input.isTTY) {
					output.write('\n');
				}
			} catch {
				error ??= new OtpInputError('Could not restore terminal input');
			}

			const result = code;
			code = '';
			if (error) {
				reject(error);
			} else {
				resolve(result);
			}
		};

		const onAbort = (): void => finish(new OtpInputError('OTP entry canceled'));
		const onError = (): void => finish(new OtpInputError('Could not read OTP input'));
		const onEnd = (): void => finish(code.length === 6 ? undefined : new OtpInputError('Enter exactly six digits'));
		const onData = (chunk: string | Uint8Array): void => {
			const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
			for (const character of text) {
				if (character === '\r' || character === '\n') {
					onEnd();
					return;
				}

				if (character === '\u{3}' || character === '\u{4}') {
					onAbort();
					return;
				}

				if (input.isTTY && (character === '\b' || character === '\u{7F}')) {
					code = code.slice(0, -1);
					continue;
				}

				if (!/^\d$/.test(character) || code.length >= 6) {
					finish(new OtpInputError('Enter exactly six digits'));
					return;
				}

				code += character;
			}
		};

		input.on('data', onData);
		input.once('end', onEnd);
		input.once('close', onEnd);
		input.once('error', onError);
		signal.addEventListener('abort', onAbort, {once: true});
		try {
			if (signal.aborted) {
				onAbort();
				return;
			}

			if (input.isTTY) {
				if (!input.setRawMode) {
					finish(new OtpInputError('Terminal does not support hidden OTP entry'));
					return;
				}

				input.setRawMode(true);
				changedRawMode = true;
			}

			output.write('Clal sent an SMS code. Enter the 6-digit code (hidden): ');
			input.resume();
			if (input.readableEnded || input.destroyed) {
				onEnd();
			}
		} catch {
			finish(new OtpInputError('Could not initialize hidden OTP input'));
		}
	});
}
