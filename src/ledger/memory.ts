/**
 * In-memory Ledger used by unit tests of modules that must not depend on SQLite.
 * Behaviour mirrors src/ledger/sqlite.ts (freeze semantics, anomaly reporting).
 */

import type {
	Anomaly,
	CompanyId,
	Consumer,
	DuplicateGroup,
	IsoDate,
	Ledger,
	LedgerAccount,
	LedgerHolding,
	LedgerTransaction,
	RunRecord,
	SourceState,
	SyntheticPayment,
	TransactionQuery,
	UpsertSummary,
} from '../types.js';
import {resolveArchiveInstallments, preserveArchiveRaw, validateArchiveInstallmentPairs} from './archive-installments.js';

export function createMemoryLedger(): Ledger {
	const sourceStates = new Map<CompanyId, SourceState>();
	const runs: RunRecord[] = [];
	const accounts = new Map<string, LedgerAccount>();
	const transactions = new Map<string, LedgerTransaction>();
	const holdings = new Map<string, LedgerHolding>();
	const syntheticPayments: SyntheticPayment[] = [];
	const consumers = new Map<string, Consumer>();
	const anomalies: Anomaly[] = [];
	const meta = new Map<string, string>();

	const clone = <T>(value: T): T => structuredClone(value);

	return {
		getSourceState: company => clone(sourceStates.get(company)),
		upsertSourceState(state) {
			sourceStates.set(state.company, clone(state));
		},
		listSourceStates: () => [...sourceStates.values()].map(state => clone(state)),
		recordRun(run) {
			runs.push(clone(run));
		},
		listRuns(options) {
			const filtered = runs.filter(run => !options?.company || run.company === options.company);
			const sorted = [...filtered].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
			return sorted.slice(0, options?.limit ?? 100).map(run => clone(run));
		},

		upsertAccount(account) {
			const existing = accounts.get(account.id);
			accounts.set(account.id, clone({...account, firstSeen: existing?.firstSeen ?? account.firstSeen}));
		},
		getAccount: id => clone(accounts.get(id)),
		listAccounts(options) {
			return [...accounts.values()]
				.filter(account => !options?.company || account.company === options.company)
				.sort((a, b) => a.id.localeCompare(b.id))
				.map(account => clone(account));
		},

		upsertTransactions(rows, options) {
			const aliases = options ? resolveArchiveInstallments(rows, [...transactions.values()], options.timezone) : new Map<string, LedgerTransaction>();
			const summary: UpsertSummary = {inserted: 0, updated: 0, unchanged: 0, anomalies: []};
			for (const row of rows) {
				const existing = transactions.get(row.id) ?? aliases.get(row.id);
				if (!existing) {
					transactions.set(row.id, clone(row));
					summary.inserted++;
					continue;
				}

				const frozen: Array<[Anomaly['field'], string, string]> = [
					['amount', existing.amount.toFixed(2), row.amount.toFixed(2)],
					['bookedDate', existing.bookedDate, (existing.id === row.id ? row : existing).bookedDate],
					['description', existing.description, row.description],
				];
				for (const [field, previous, incoming] of frozen) {
					if (previous !== incoming) {
						summary.anomalies.push({transactionId: row.id, field, previous, incoming, seenAt: row.lastSeen});
					}
				}

				const status = existing.status === 'pending' && row.status === 'posted' ? 'posted' : existing.status;
				const changed = status !== existing.status
					|| existing.chargeDate !== row.chargeDate
					|| existing.category !== row.category
					|| existing.memo !== row.memo;
				transactions.set(existing.id, clone({
					...existing,
					status,
					postedSeenAt: existing.postedSeenAt ?? (status === existing.status ? undefined : row.lastSeen),
					chargeDate: row.chargeDate ?? existing.chargeDate,
					category: row.category ?? existing.category,
					memo: row.memo ?? existing.memo,
					raw: preserveArchiveRaw(existing, row),
					lastSeen: row.lastSeen,
				}));
				if (changed) {
					summary.updated++;
				} else {
					summary.unchanged++;
				}
			}

			anomalies.push(...summary.anomalies.map(anomaly => clone(anomaly)));
			return summary;
		},
		coalesceArchiveInstallments(pairs, options) {
			const validated = validateArchiveInstallmentPairs(pairs, [...transactions.values()], options.timezone);
			for (const {duplicate} of validated) {
				if (syntheticPayments.some(payment => payment.transactionId === duplicate.id)
					|| anomalies.some(anomaly => anomaly.transactionId === duplicate.id)) {
					throw new Error('Installment duplicate has dependent ledger records; no repair applied');
				}
			}

			if (!options.dryRun) {
				for (const {canonical, duplicate} of validated) {
					transactions.set(canonical.id, clone({...canonical,
						chargeDate: duplicate.chargeDate ?? canonical.chargeDate,
						category: duplicate.category ?? canonical.category,
						memo: duplicate.memo ?? canonical.memo,
						raw: preserveArchiveRaw(canonical, duplicate), lastSeen: duplicate.lastSeen,
					}));
					transactions.delete(duplicate.id);
				}
			}

			return {matched: validated.length, coalesced: options.dryRun ? 0 : validated.length};
		},
		getTransaction: id => clone(transactions.get(id)),
		listTransactions(query: TransactionQuery) {
			return [...transactions.values()]
				.filter(row => !query.accountIds || query.accountIds.includes(row.accountId))
				.filter(row => !query.from || row.bookedDate >= query.from)
				.filter(row => !query.to || row.bookedDate < query.to)
				.filter(row => query.includePending || row.status !== 'pending')
				.filter(row => query.includeSynthetic || !row.synthetic)
				.sort((a, b) => a.bookedDate.localeCompare(b.bookedDate) || a.id.localeCompare(b.id))
				.map(row => clone(row));
		},
		findDuplicates() {
			const groups = new Map<string, DuplicateGroup>();
			for (const row of transactions.values()) {
				const key = [row.accountId, row.bookedDate, row.amount.toFixed(2), row.description].join('\u{0}');
				const group = groups.get(key) ?? {
					accountId: row.accountId,
					bookedDate: row.bookedDate,
					amount: row.amount,
					description: row.description,
					transactionIds: [],
				};
				group.transactionIds.push(row.id);
				groups.set(key, group);
			}

			return [...groups.values()].filter(group => group.transactionIds.length > 1);
		},
		earliestBookedDate(accountId): IsoDate | undefined {
			let earliest: IsoDate | undefined;
			for (const row of transactions.values()) {
				if (row.accountId === accountId && !row.synthetic && (!earliest || row.bookedDate < earliest)) {
					earliest = row.bookedDate;
				}
			}

			return earliest;
		},

		upsertHoldings(rows) {
			for (const row of rows) {
				const existing = holdings.get(row.id);
				holdings.set(row.id, clone({...row, firstSeen: existing?.firstSeen ?? row.firstSeen}));
			}
		},
		listHoldings(accountId) {
			return [...holdings.values()].filter(row => !accountId || row.accountId === accountId).map(row => clone(row));
		},

		listSyntheticPayments: accountId => syntheticPayments.filter(payment => payment.accountId === accountId).map(payment => clone(payment)),
		insertSyntheticPayment(payment) {
			syntheticPayments.push(clone(payment));
		},

		createConsumer(consumer) {
			if (consumers.has(consumer.id)) {
				throw new Error(`Consumer ${consumer.id} already exists`);
			}

			consumers.set(consumer.id, clone(consumer));
		},
		updateConsumer(consumer) {
			consumers.set(consumer.id, clone(consumer));
		},
		getConsumer: id => clone(consumers.get(id)),
		getConsumerByClaimId: claimId => clone([...consumers.values()].find(consumer => consumer.claimId === claimId)),
		getConsumerByBasicUser: basicUser => clone([...consumers.values()].find(consumer => consumer.basicUser === basicUser)),
		listConsumers: () => [...consumers.values()].map(consumer => clone(consumer)),

		recordAnomalies(items) {
			anomalies.push(...items.map(item => clone(item)));
		},
		listAnomalies: options => anomalies.slice(-(options?.limit ?? 100)).map(item => clone(item)),

		getMeta: key => meta.get(key),
		setMeta(key, value) {
			meta.set(key, value);
		},
		close() {
			// Nothing to release.
		},
	};
}
