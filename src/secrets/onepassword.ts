/**
 * `op://<vault>/<item>/<field>` resolution through the 1Password Connect REST API.
 *
 * - Literal values (anything not starting with `op://`) pass through unchanged.
 * - Vault and item are matched by id or exact title; the field by label
 *   (case-insensitive), then field id, then purpose (`USERNAME`/`PASSWORD`) for
 *   references named `username`/`password`.
 * - Vault ids and item ids are cached per resolver instance; item *contents* are
 *   re-fetched on every `resolveAll` so credential changes in 1Password are seen.
 * - Every resolved value is registered with the logger's redaction list.
 * - Error messages describe the reference, never the secret.
 */

import {createHash} from 'node:crypto';
import {readFileSync, statSync} from 'node:fs';
import {redact, type Logger} from '../log.js';
import type {RuntimeEnv, SecretsResolver} from '../types.js';

const OP_PREFIX = 'op://';

export type OpReference = {
	vault: string;
	item: string;
	field: string;
};

type ConnectVault = {id: string; name: string};
type ConnectItemSummary = {id: string; title: string};
type ConnectField = {id?: string; label?: string; purpose?: string; value?: string};
type ConnectItem = {id: string; title: string; fields?: ConnectField[]};

/** True when the value is an `op://` reference rather than a literal. */
export function isOpReference(value: string): boolean {
	return value.startsWith(OP_PREFIX);
}

/** Split `op://<vault>/<item>/<field>` into its parts; undefined when malformed. */
export function parseOpReference(reference: string): OpReference | undefined {
	if (!isOpReference(reference)) {
		return undefined;
	}

	const parts = reference.slice(OP_PREFIX.length).split('/');
	if (parts.length !== 3 || parts.some(part => part.trim() === '')) {
		return undefined;
	}

	const [vault, item, field] = parts as [string, string, string];
	return {vault: vault.trim(), item: item.trim(), field: field.trim()};
}

/** sha256 (hex) of the JSON of the sorted `[key, value]` entries. */
export function credentialFingerprint(values: Record<string, string>): string {
	const entries = Object.entries(values).sort(([a], [b]) => a.localeCompare(b));
	return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

/** Read and trim the Connect token; warn when the file is readable by group/other. */
function readToken(tokenFile: string, logger: Logger): string {
	// eslint-disable-next-line no-bitwise
	const mode = statSync(tokenFile).mode & 0o777;
	// eslint-disable-next-line no-bitwise
	if ((mode & 0o077) !== 0) {
		logger.warn('1Password Connect token file is readable by group/other; chmod 0600 it', {file: tokenFile, mode: mode.toString(8)});
	}

	const token = readFileSync(tokenFile, 'utf8').trim();
	if (token === '') {
		throw new Error(`1Password Connect token file ${tokenFile} is empty`);
	}

	redact(token);
	return token;
}

/** Pick the field a reference names: label, then id, then purpose for username/password. */
export function selectField(fields: ConnectField[], fieldReference: string): ConnectField | undefined {
	const wanted = fieldReference.toLowerCase();
	const byLabel = fields.find(field => field.label?.toLowerCase() === wanted);
	if (byLabel) {
		return byLabel;
	}

	const byId = fields.find(field => field.id === fieldReference);
	if (byId) {
		return byId;
	}

	const purpose = wanted === 'username' ? 'USERNAME' : (wanted === 'password' ? 'PASSWORD' : undefined);
	return purpose ? fields.find(field => field.purpose === purpose) : undefined;
}

type ConnectClient = {
	get<T>(pathname: string): Promise<T>;
};

function createConnectClient(host: string, token: string): ConnectClient {
	return {
		async get<T>(pathname: string): Promise<T> {
			let response: Response;
			try {
				response = await fetch(`${host}${pathname}`, {headers: {authorization: `Bearer ${token}`, accept: 'application/json'}});
			} catch (error) {
				throw new Error(`1Password Connect request GET ${pathname} failed: ${(error as Error).message}`);
			}

			if (!response.ok) {
				throw new Error(`1Password Connect GET ${pathname} returned HTTP ${response.status}`);
			}

			return response.json() as Promise<T>;
		},
	};
}

/**
 * Build the resolver. The Connect client is created lazily on the first `op://`
 * reference so literal-only configurations never touch the token file.
 */
export function createSecretsResolver(env: RuntimeEnv, logger: Logger): SecretsResolver {
	let client: ConnectClient | undefined;
	let vaultsPromise: Promise<ConnectVault[]> | undefined;
	const itemIds = new Map<string, Promise<string>>();

	const getClient = (): ConnectClient => {
		if (client) {
			return client;
		}

		if (!env.opConnectHost || !env.opConnectTokenFile) {
			throw new Error('1Password Connect is not configured: set OP_CONNECT_HOST and OP_CONNECT_TOKEN_FILE (or OP_DISABLED=1 with literal values)');
		}

		client = createConnectClient(env.opConnectHost, readToken(env.opConnectTokenFile, logger));
		return client;
	};

	const resolveVaultId = async (vaultReference: string): Promise<string> => {
		vaultsPromise ??= getClient().get<ConnectVault[]>('/v1/vaults');
		let vaults: ConnectVault[];
		try {
			vaults = await vaultsPromise;
		} catch (error) {
			vaultsPromise = undefined;
			throw error;
		}

		const vault = vaults.find(candidate => candidate.id === vaultReference) ?? vaults.find(candidate => candidate.name === vaultReference);
		if (!vault) {
			throw new Error(`1Password vault "${vaultReference}" not found (by id or exact title)`);
		}

		return vault.id;
	};

	const lookupItemId = async (vaultId: string, itemReference: string): Promise<string> => {
		const filter = encodeURIComponent(`title eq "${itemReference}"`);
		const matches = await getClient().get<ConnectItemSummary[]>(`/v1/vaults/${vaultId}/items?filter=${filter}`);
		const exact = matches.filter(item => item.title === itemReference);
		if (exact.length === 1) {
			return exact[0]!.id;
		}

		if (exact.length > 1) {
			throw new Error(`1Password item "${itemReference}" is ambiguous: ${exact.length} items share that title`);
		}

		if (/^[\da-z]{26}$/.test(itemReference)) {
			return itemReference;
		}

		throw new Error(`1Password item "${itemReference}" not found in vault ${vaultId} (by exact title or id)`);
	};

	const resolveItemId = async (vaultId: string, itemReference: string): Promise<string> => {
		const key = `${vaultId}/${itemReference}`;
		let promise = itemIds.get(key);
		if (!promise) {
			promise = lookupItemId(vaultId, itemReference);
			itemIds.set(key, promise);
		}

		try {
			return await promise;
		} catch (error) {
			itemIds.delete(key);
			throw error;
		}
	};

	const fetchItem = async (vaultId: string, itemId: string): Promise<ConnectItem> =>
		getClient().get<ConnectItem>(`/v1/vaults/${vaultId}/items/${itemId}`);

	const resolveReference = async (reference: string, itemCache: Map<string, Promise<ConnectItem>>): Promise<string> => {
		if (!isOpReference(reference)) {
			return reference;
		}

		if (env.opDisabled) {
			throw new Error(`OP_DISABLED is set but a 1Password reference was found: ${reference}`);
		}

		const parsed = parseOpReference(reference);
		if (!parsed) {
			throw new Error(`Malformed 1Password reference "${reference}"; expected op://<vault>/<item>/<field>`);
		}

		const vaultId = await resolveVaultId(parsed.vault);
		const itemId = await resolveItemId(vaultId, parsed.item);
		const cacheKey = `${vaultId}/${itemId}`;
		let itemPromise = itemCache.get(cacheKey);
		if (!itemPromise) {
			itemPromise = fetchItem(vaultId, itemId);
			itemCache.set(cacheKey, itemPromise);
		}

		const item = await itemPromise;
		const field = selectField(item.fields ?? [], parsed.field);
		if (!field || typeof field.value !== 'string' || field.value === '') {
			throw new Error(`1Password item "${parsed.item}" has no usable field "${parsed.field}" (looked up label, id, purpose)`);
		}

		redact(field.value);
		logger.debug('resolved 1Password reference', {reference});
		return field.value;
	};

	return {
		resolve: async reference => resolveReference(reference, new Map()),
		async resolveAll(values) {
			const itemCache = new Map<string, Promise<ConnectItem>>();
			const resolved: Record<string, string> = {};
			for (const [key, value] of Object.entries(values)) {
				// Sequential so the per-call item cache is reused and Connect is not hammered.
				// eslint-disable-next-line no-await-in-loop
				resolved[key] = await resolveReference(value, itemCache);
			}

			return resolved;
		},
	};
}
