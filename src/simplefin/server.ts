/**
 * Bind the Hono app on config.server.host/port with the hono node-server adapter.
 */

import type {AddressInfo} from 'node:net';
import type {Hono} from 'hono';
import {serve} from '@hono/node-server';
import type {Logger} from '../log.js';
import type {Config, Ledger} from '../types.js';
import {createApp} from './app.js';
import {sweepClosedClaims} from './consumers.js';

export type ServerOptions = {
	config: Config;
	ledger: Ledger;
	logger: Logger;
	investmentRouter?: Hono;
};

export type RunningServer = {
	/** Stop accepting connections and wait for the listener to close. */
	close(): Promise<void>;
	/** Actual bound port (useful when config.server.port is 0 in tests). */
	port: number;
};

/** Start listening; resolves once the socket is bound. */
export async function startServer(options: ServerOptions): Promise<RunningServer> {
	const app = createApp(options);
	const {host, port} = options.config.server;
	sweepClosedClaims(options.ledger);

	return new Promise((resolve, reject) => {
		const server = serve({fetch: app.fetch, hostname: host, port}, (info: AddressInfo) => {
			const claimCleanup = setInterval(() => {
				try {
					sweepClosedClaims(options.ledger);
				} catch (error) {
					options.logger.error('claim cleanup failed', {message: (error as Error).message});
				}
			}, 60_000);
			claimCleanup.unref();
			server.once('close', () => clearInterval(claimCleanup));
			options.logger.info('listening', {host: info.address, port: info.port});
			resolve({
				port: info.port,
				async close() {
					clearInterval(claimCleanup);
					await new Promise<void>((done, fail) => {
						server.close(error => {
							if (error) {
								fail(error);
							} else {
								done();
							}
						});
					});
				},
			});
		});
		server.once('error', reject);
	});
}
