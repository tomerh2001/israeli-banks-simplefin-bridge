import {PassThrough, Writable} from 'node:stream';
import {describe, expect, it, vi} from 'vitest';
import {readOneTimeCode, type OtpInput} from './otp.js';

function streams(tty = false, raw = false) {
	const input: OtpInput = new PassThrough();
	input.isTTY = tty;
	input.isRaw = raw;
	input.setRawMode = vi.fn((enabled: boolean) => {
		input.isRaw = enabled;
		return input;
	});
	const printed: string[] = [];
	const output = new Writable({
		write(chunk: Uint8Array, _encoding, done) {
			printed.push(new TextDecoder().decode(chunk));
			done();
		},
	});
	return {input: input as OtpInput & PassThrough, output, printed};
}

describe('private OTP input', () => {
	it('reads a piped six-digit line without printing it', async () => {
		const {input, output, printed} = streams();
		const pending = readOneTimeCode(new AbortController().signal, input, output);
		input.end('246810\n');
		expect(await pending).toBe('246810');
		expect(printed.join('')).not.toContain('246810');
		expect(input.setRawMode).not.toHaveBeenCalled();
		expect(input.listenerCount('data')).toBe(0);
	});

	it('accepts an exact piped code at EOF without requiring a newline', async () => {
		const {input, output} = streams();
		const pending = readOneTimeCode(new AbortController().signal, input, output);
		input.end('135790');
		expect(await pending).toBe('135790');
	});

	it('uses hidden raw terminal input and restores the previous mode after editing', async () => {
		const {input, output, printed} = streams(true);
		const pending = readOneTimeCode(new AbortController().signal, input, output);
		expect(input.isRaw).toBe(true);
		input.write('246819');
		input.write('\u{7F}0\r');
		expect(await pending).toBe('246810');
		expect(input.isRaw).toBe(false);
		expect(input.setRawMode).toHaveBeenNthCalledWith(1, true);
		expect(input.setRawMode).toHaveBeenNthCalledWith(2, false);
		expect(printed.join('')).not.toMatch(/24681/);
	});

	it('preserves an already-raw terminal mode', async () => {
		const {input, output} = streams(true, true);
		const pending = readOneTimeCode(new AbortController().signal, input, output);
		input.write('246810\n');
		expect(await pending).toBe('246810');
		expect(input.isRaw).toBe(true);
	});

	it('restores raw mode, pause state, and listeners when collection aborts', async () => {
		const {input, output, printed} = streams(true);
		input.pause();
		const controller = new AbortController();
		const pending = readOneTimeCode(controller.signal, input, output);
		input.write('246');
		controller.abort();
		await expect(pending).rejects.toThrow('OTP entry canceled');
		expect(input.isRaw).toBe(false);
		expect(input.isPaused()).toBe(true);
		expect(input.listenerCount('data')).toBe(0);
		expect(input.listenerCount('end')).toBe(0);
		expect(input.listenerCount('error')).toBe(0);
		expect(printed.join('')).not.toContain('246');
	});

	it('handles terminal Ctrl-C without echoing or leaving raw mode enabled', async () => {
		const {input, output} = streams(true);
		const pending = readOneTimeCode(new AbortController().signal, input, output);
		input.write('\u{3}');
		await expect(pending).rejects.toThrow('OTP entry canceled');
		expect(input.isRaw).toBe(false);
	});

	it.each(['24681\n', '2468109\n', 'secret-input\n'])('rejects invalid input without including its value in output or errors', async value => {
		const {input, output, printed} = streams(true);
		const pending = readOneTimeCode(new AbortController().signal, input, output);
		input.write(value);
		await expect(pending).rejects.toThrow('Enter exactly six digits');
		expect(input.isRaw).toBe(false);
		expect(printed.join('')).not.toContain(value.trim());
	});

	it('restores terminal input after a stream error without exposing error details', async () => {
		const {input, output} = streams(true);
		const pending = readOneTimeCode(new AbortController().signal, input, output);
		input.emit('error', new Error('private provider input'));
		await expect(pending).rejects.toThrow('Could not read OTP input');
		expect(input.isRaw).toBe(false);
	});

	it('does not change terminal mode for an already-aborted operation', async () => {
		const {input, output, printed} = streams(true);
		const controller = new AbortController();
		controller.abort();
		await expect(readOneTimeCode(controller.signal, input, output)).rejects.toThrow('OTP entry canceled');
		expect(input.setRawMode).not.toHaveBeenCalled();
		expect(printed).toEqual([]);
	});
});
