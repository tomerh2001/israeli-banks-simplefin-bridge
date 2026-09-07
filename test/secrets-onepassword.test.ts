import {chmodSync, writeFileSync} from 'node:fs';
import {createServer, type Server} from 'node:http';
import path from 'node:path';
import type {AddressInfo} from 'node:net';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {scrub} from '../src/log.js';
import {createSecretsResolver, credentialFingerprint, parseOpReference, selectField} from '../src/secrets/onepassword.js';
import type {RuntimeEnv} from '../src/types.js';
import {createCapturingLogger, createTemporaryEnv} from './mocks/fixtures.js';

const VAULT_ID = 'abcdefghijklmnopqrstuvwxyz';
const ITEM_ID = 'itemitemitemitemitemitem01';
const CARD_ITEM_ID = 'carditemcarditemcarditem02';
const TOKEN = 'connect-token-0123456789';
const PASSWORD_VALUE = 'hunter2-super-secret';

type Request = {method: string; url: string; authorization: string | undefined};

type StubItem = {id: string; title: string; fields: unknown[]};

const hapoalimItem: StubItem = {
	id: ITEM_ID,
	title: 'Bank Hapoalim',
	fields: [
		{id: 'username', label: 'user code', purpose: 'USERNAME', value: 'user-42'},
		{id: 'password', label: 'password', purpose: 'PASSWORD', value: PASSWORD_VALUE},
		{id: 'f1', label: 'Branch', value: '627'},
		{id: 'empty', label: 'Empty', value: ''},
	],
};

const calItem: StubItem = {
	id: CARD_ITEM_ID,
	title: 'Visa Cal',
	fields: [
		{id: 'un', label: 'ID number', purpose: 'USERNAME', value: '012345678'},
		{id: 'pw', label: 'Password', purpose: 'PASSWORD', value: 'cal-pass-secret'},
		{id: 'card6', label: 'card6Digits', value: '123456'},
	],
};

const items = new Map<string, StubItem>([[ITEM_ID, hapoalimItem], [CARD_ITEM_ID, calItem]]);

function createConnectStub(): {server: Server; requests: Request[]; failWith?: number} {
	const state = {requests: [] as Request[], failWith: undefined as number | undefined, server: undefined as unknown as Server};
	state.server = createServer((request, response) => {
		state.requests.push({method: request.method ?? '', url: request.url ?? '', authorization: request.headers.authorization});
		const send = (status: number, body: unknown) => {
			response.writeHead(status, {'content-type': 'application/json'});
			response.end(JSON.stringify(body));
		};

		if (state.failWith) {
			send(state.failWith, {status: state.failWith, message: 'nope'});
			return;
		}

		if (request.headers.authorization !== `Bearer ${TOKEN}`) {
			send(401, {status: 401, message: 'unauthorized'});
			return;
		}

		const url = new URL(request.url ?? '/', 'http://stub');
		if (url.pathname === '/v1/vaults') {
			send(200, [{id: 'otherotherotherotherothe00', name: 'Personal'}, {id: VAULT_ID, name: 'Home Server'}]);
			return;
		}

		if (url.pathname === `/v1/vaults/${VAULT_ID}/items`) {
			const title = /^title eq "(?<title>.*)"$/.exec(url.searchParams.get('filter') ?? '')?.groups?.title;
			const found = [...items.values()].filter(item => item.title === title).map(item => ({id: item.id, title}));
			send(200, found);
			return;
		}

		const itemId = new RegExp(`^/v1/vaults/${VAULT_ID}/items/(?<id>[0-9a-z]+)$`).exec(url.pathname)?.groups?.id;
		const item = itemId ? items.get(itemId) : undefined;
		if (item) {
			send(200, item);
			return;
		}

		send(404, {status: 404, message: 'not found'});
	});
	return state;
}

describe('createSecretsResolver', () => {
	const stub = createConnectStub();
	let env: RuntimeEnv;
	let tokenFile: string;

	beforeAll(async () => {
		await new Promise<void>(resolve => {
			stub.server.listen(0, '127.0.0.1', resolve);
		});
	});

	afterAll(async () => {
		await new Promise<void>(resolve => {
			stub.server.close(() => resolve());
		});
	});

	beforeEach(() => {
		stub.requests.length = 0;
		stub.failWith = undefined;
		env = createTemporaryEnv({opDisabled: false});
		tokenFile = path.join(env.dataDir, 'op-token');
		writeFileSync(tokenFile, `${TOKEN}\n`, {mode: 0o600});
		env.opConnectTokenFile = tokenFile;
		env.opConnectHost = `http://127.0.0.1:${(stub.server.address() as AddressInfo).port}`;
	});

	it('passes literal values through without touching Connect', async () => {
		const resolver = createSecretsResolver({...env, opConnectHost: undefined, opConnectTokenFile: undefined}, createCapturingLogger());
		expect(await resolver.resolve('plain-value')).toBe('plain-value');
		expect(await resolver.resolveAll({a: 'x', b: 'y'})).toEqual({a: 'x', b: 'y'});
		expect(stub.requests).toHaveLength(0);
	});

	it('resolves vault by title, item by title and fields by label, id and purpose', async () => {
		const logger = createCapturingLogger();
		const resolver = createSecretsResolver(env, logger);

		const resolved = await resolver.resolveAll({
			userCode: 'op://Home Server/Bank Hapoalim/username',
			password: 'op://Home Server/Bank Hapoalim/PASSWORD',
			branch: 'op://Home Server/Bank Hapoalim/f1',
			literal: 'kept-as-is',
		});

		expect(resolved).toEqual({userCode: 'user-42', password: PASSWORD_VALUE, branch: '627', literal: 'kept-as-is'});
		const urls = stub.requests.map(request => request.url);
		expect(urls).toEqual([
			'/v1/vaults',
			`/v1/vaults/${VAULT_ID}/items?filter=${encodeURIComponent('title eq "Bank Hapoalim"')}`,
			`/v1/vaults/${VAULT_ID}/items/${ITEM_ID}`,
		]);
		expect(stub.requests.every(request => request.authorization === `Bearer ${TOKEN}`)).toBe(true);
		expect(logger.lines.some(line => line.level === 'warn')).toBe(false);

		// Resolved values and the token are redacted from log lines.
		expect(scrub(`token ${TOKEN} password ${PASSWORD_VALUE} user user-42`)).toBe('token [redacted] password [redacted] user [redacted]');
	});

	it('accepts vault and item ids and caches the lookups per instance', async () => {
		const resolver = createSecretsResolver(env, createCapturingLogger());
		expect(await resolver.resolve(`op://${VAULT_ID}/Visa Cal/card6Digits`)).toBe('123456');
		expect(await resolver.resolve(`op://Home Server/${CARD_ITEM_ID}/username`)).toBe('012345678');
		expect(await resolver.resolve('op://Home Server/Visa Cal/password')).toBe('cal-pass-secret');

		const urls = stub.requests.map(request => request.url);
		expect(urls.filter(url => url === '/v1/vaults')).toHaveLength(1);
		expect(urls.filter(url => url.includes('?filter='))).toHaveLength(2); // Once by title, once falling through to the id.
		expect(urls.filter(url => url.endsWith(`/items/${CARD_ITEM_ID}`))).toHaveLength(3); // Item contents are re-read per resolve call.

		stub.requests.length = 0;
		await resolver.resolveAll({a: 'op://Home Server/Visa Cal/username', b: 'op://Home Server/Visa Cal/password'});
		expect(stub.requests.map(request => request.url)).toEqual([`/v1/vaults/${VAULT_ID}/items/${CARD_ITEM_ID}`]);
	});

	it('fails descriptively without leaking secret values', async () => {
		const resolver = createSecretsResolver(env, createCapturingLogger());
		await expect(resolver.resolve('op://Nope/Bank Hapoalim/password')).rejects.toThrow('1Password vault "Nope" not found');
		await expect(resolver.resolve('op://Home Server/Missing Item/password')).rejects.toThrow('1Password item "Missing Item" not found');
		await expect(resolver.resolve('op://Home Server/Bank Hapoalim/nope')).rejects.toThrow('has no usable field "nope"');
		await expect(resolver.resolve('op://Home Server/Bank Hapoalim/Empty')).rejects.toThrow('has no usable field "Empty"');
		await expect(resolver.resolve('op://broken')).rejects.toThrow('Malformed 1Password reference');

		stub.failWith = 500;
		const fresh = createSecretsResolver(env, createCapturingLogger());
		const error = await fresh.resolve('op://Home Server/Bank Hapoalim/password').then(() => undefined, (error_: unknown) => error_ as Error);
		expect(error).toBeInstanceOf(Error);
		expect(error?.message).toBe('1Password Connect GET /v1/vaults returned HTTP 500');
		expect(error?.message).not.toContain(TOKEN);
		expect(error?.message).not.toContain(PASSWORD_VALUE);
	});

	it('retries a lookup that failed instead of caching the failure', async () => {
		const resolver = createSecretsResolver(env, createCapturingLogger());
		stub.failWith = 503;
		await expect(resolver.resolve('op://Home Server/Bank Hapoalim/password')).rejects.toThrow('HTTP 503');
		stub.failWith = undefined;
		expect(await resolver.resolve('op://Home Server/Bank Hapoalim/password')).toBe(PASSWORD_VALUE);
	});

	it('rejects op:// references when OP_DISABLED is set, and unconfigured hosts', async () => {
		const disabled = createSecretsResolver({...env, opDisabled: true}, createCapturingLogger());
		await expect(disabled.resolve('op://Home Server/Bank Hapoalim/password')).rejects.toThrow('OP_DISABLED');
		expect(await disabled.resolve('literal')).toBe('literal');

		const unconfigured = createSecretsResolver({...env, opConnectHost: undefined}, createCapturingLogger());
		await expect(unconfigured.resolve('op://Home Server/Bank Hapoalim/password')).rejects.toThrow('not configured');
		expect(stub.requests).toHaveLength(0);
	});

	it('warns when the token file is group/other readable and rejects an empty one', async () => {
		chmodSync(tokenFile, 0o644);
		const logger = createCapturingLogger();
		const resolver = createSecretsResolver(env, logger);
		expect(await resolver.resolve('op://Home Server/Bank Hapoalim/username')).toBe('user-42');
		expect(logger.lines.some(line => line.level === 'warn' && line.message.includes('readable by group/other'))).toBe(true);

		writeFileSync(tokenFile, '  \n', {mode: 0o600});
		const empty = createSecretsResolver(env, createCapturingLogger());
		await expect(empty.resolve('op://Home Server/Bank Hapoalim/username')).rejects.toThrow('is empty');
	});
});

describe('helpers', () => {
	it('parses references', () => {
		expect(parseOpReference('op://Home Server/Bank Hapoalim/password')).toEqual({vault: 'Home Server', item: 'Bank Hapoalim', field: 'password'});
		expect(parseOpReference('op://a/b')).toBeUndefined();
		expect(parseOpReference('op://a//c')).toBeUndefined();
		expect(parseOpReference('literal')).toBeUndefined();
	});

	it('selects fields by label, id, then purpose', () => {
		const fields = [
			{id: 'x1', label: 'Login', purpose: 'USERNAME', value: 'u'},
			{id: 'password', label: 'Passcode', purpose: 'PASSWORD', value: 'p'},
		];
		expect(selectField(fields, 'LOGIN')?.value).toBe('u');
		expect(selectField(fields, 'username')?.value).toBe('u');
		expect(selectField(fields, 'password')?.value).toBe('p');
		expect(selectField(fields, 'x1')?.value).toBe('u');
		expect(selectField(fields, 'nothing')).toBeUndefined();
	});

	it('fingerprints credential tuples independent of key order', () => {
		const a = credentialFingerprint({userCode: 'u', password: 'p'});
		const b = credentialFingerprint({password: 'p', userCode: 'u'});
		expect(a).toBe(b);
		expect(a).toMatch(/^[0-9a-f]{64}$/);
		expect(credentialFingerprint({userCode: 'u', password: 'q'})).not.toBe(a);
	});
});
