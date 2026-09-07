import {afterEach, describe, expect, it, vi} from 'vitest';
import {createMemoryLedger} from '../src/ledger/memory.js';
import {mintConsumerToken} from '../src/simplefin/consumers.js';
import {startServer} from '../src/simplefin/server.js';
import {makeConfig, NOW, silentLogger} from './helpers/seed.js';

afterEach(() => vi.useRealTimers());

describe('server claim cleanup', () => {
	it('removes expired setup credentials without consumer requests and releases its timer on shutdown', async () => {
		vi.useFakeTimers({toFake: ['Date', 'setInterval', 'clearInterval']});
		vi.setSystemTime(NOW);
		const ledger = createMemoryLedger();
		const config = makeConfig();
		config.server.host = '127.0.0.1';
		config.server.port = 0;
		const expired = mintConsumerToken(ledger, config, {label: 'expired', now: new Date(NOW.getTime() - (16 * 60_000))});
		const fresh = mintConsumerToken(ledger, config, {label: 'fresh', now: NOW});
		const server = await startServer({config, ledger, logger: silentLogger()});
		try {
			expect(ledger.getConsumer('expired')?.secretPlain).toBeUndefined();
			expect(ledger.getConsumer('expired')?.secretHash).toBe(expired.consumer.secretHash);
			expect(ledger.getConsumer('fresh')?.secretPlain).toBe(fresh.consumer.secretPlain);
			await vi.advanceTimersByTimeAsync(15 * 60_000);
			expect(ledger.getConsumer('fresh')?.secretPlain).toBeUndefined();
			expect(ledger.getConsumer('fresh')?.secretHash).toBe(fresh.consumer.secretHash);
		} finally {
			await server.close();
		}

		expect(vi.getTimerCount()).toBe(0);
	});
});
