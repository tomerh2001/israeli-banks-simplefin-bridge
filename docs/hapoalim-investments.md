# Hapoalim investment account onboarding

## Verified starting point before deployment — September 10, 2026

The deployed Securo application has one SimpleFIN connection and two investment
collector connections. Its four investment products belong to Clal and Hachshara
Best Invest. No Hapoalim investment product or share trade has been imported.

The existing SimpleFIN consumer can read current holdings when a bridge supplies
them. It does not import investment activity or source-dated valuation history.
Its generic holdings path dates new snapshots on the consumer's current day,
archives holdings absent from a response, and does not create an account for an
empty holdings list. It therefore cannot faithfully restore a historical bank
investment account on its own.

The investment feed is the appropriate existing account representation: one
valued product represents the account, while its activities and component
holdings must not add the same value to net worth again. A verified zero balance
and an unavailable balance are distinct states. An account with history remains
visible even when there are no current securities.

## Offline history evidence

Private preparation lives under
`/mnt/Pool/Services/Data/israeli-banks-bridge/investment-onboarding`. The user authorized importing appropriate surviving history. Source files,
identifiers, descriptions, amounts and raw rows must remain inside that restricted directory. Aggregate
findings alone belong in this document.

The April 3 Sure gzip backup contains one active account explicitly named as a
Hapoalim investment account. It has 52 transaction entries dated December 12,
2023 through March 24, 2026 and two reconciliation valuation entries dated April
2–3, 2026. All entries use ILS. There are no share trades or security holdings.
All 52 transactions have the generic `funds_movement` kind, without provider
identifiers, specific investment activity labels, or security quantities.
These records establish archived activity, not a verified current portfolio.

The newer independent Sure archive contains 16 investment valuation entries
dated April 2–27 and no investment transactions, trades or holdings. Its account
and accountable identities match April exactly. Both original valuation entries
survive unchanged and 14 valuations are new. All 52 April transaction entries
and their transaction objects are absent from the entire newer database; none
moved to another account. Their later deletion may have been intentional. Keep
those 52 records as private review evidence and do not resurrect them by merging
the archives. The surviving 16 dated reconciliations are the archival baseline
for the historical import. The earlier bank/card-only June targeted export does not
include this investment account and cannot answer that question.

`prepare_sure_investment_archive.py` prepares private review manifests without
opening any live database or contacting a provider. The April review preserves
all 54 original entry identities and complete private provenance, sets no
current valuation, and leaves provider attempt/success timestamps unset. Its
review purpose explicitly marks those records as April evidence only. The June
review preserves the 16 surviving valuations and no activities. Exact amount,
identity and date checks pass against the source rows. Archive capture and later
archive-read timestamps are distinct observations; neither is a bank collection.
Sure's timezone-less Rails update fields remain verbatim in private provenance.

All 16 June reconciliation amounts retain four decimal places, with 12 containing
nonzero precision beyond cents. The valuation contract now accepts two through six decimal places; cash
activities remain cent-only. Securo's `AssetValue.amount` column already supports six.
The native archive seed preserves these amounts exactly, including source
provenance; no financial amount migration or rounding is needed.

Sure's `Entry#classification` defines a negative amount as income and a positive
amount as expense. An investment activity view using positive inflows negates
that amount and retains its original value in provenance. Generic funds movement
must not become an invented buy, sell, dividend, fee, transfer counterparty or
security quantity. Reconciliation valuations remain explicitly dated archive
records; they do not prove a current zero balance or a successful bank collection.

## Integration boundaries

The Hapoalim integration has a distinct provider identity, scoped cached endpoint
and read token selection. Its reserved control capability does not enable a
separate bank refresh. Securo supports this provider in its feed schema, routing,
configuration and token connection flow. Preserve the existing Clal and Best
Invest endpoint identity guards. Backend and worker configuration must agree.
A separate connection adopts the same verified Hapoalim product identity on
future syncs rather than minting a duplicate account.

The current feed can represent one investment product with historical valuations
and unclassified cash activity, with `currentValuationId=null` until a current
source value is verified. Securo's existing source-valued account path then
returns an unavailable current balance while retaining historical values. A
later live zero must be an explicit source valuation, not inferred from empty
or incomplete collection results. Never promote an archived valuation into the
current slot to make onboarding appear complete.

The typed `executions` extension carries security identifiers, quantities,
prices, trade and settlement dates, source activity labels and original cash
currencies separately from the pension activity ledger. It does not infer
positions, taxes, cash signs or current account value. The bank's `View.Account`
current portfolio shape remains unverified. Activity and track currencies still
match their product; execution trade and settlement currencies remain independent.
Do not reduce mixed-currency trades to guessed ILS values or use account cash
movements to manufacture orders.

Securo's separate `AssetTransaction` ledger accepts only buys and sells and
derives positions, average cost and realized gain from them. It is unsuitable for
the verified Sure funds-movement archive, which has no quantities or prices.
Manual Asset creation is also insufficient: adding an old AssetValue makes it
the apparent current value, manual assets are not investment account rows, and
the native manual APIs do not write source activity.

New bank collection must use the existing Hapoalim headed browser/session and
guarded bank runtime, including the two-attempt local-day cap. Prefer collecting
investment data within the same authorized bank login; do not create an
independent unguarded login path. Cached Securo imports never initiate collection.
Deploy application changes through reviewed source PRs, deployment-branch merge,
passing CI/published `latest` images, and normal pull/restart verification.

## Verified upstream collection reference

The installed normal Hapoalim scraper in `israeli-bank-scrapers` 6.11 does not
provide holdings. An independent public implementation exists in
[`Urigo/accounter-fullstack` at commit `88568d9`](https://github.com/Urigo/accounter-fullstack/tree/88568d9b9be1cf17a44ac070ef330de1dd3dda21/packages/modern-poalim-scraper/src).
Its `scrapers/hapoalim.ts` implements `getSecuritiesInfo` and
`getSecuritiesTransactions`; `utils/fetch.ts` contains
`captureMytradeSession` and `fetchPoalimMytradeWithinPage`.

The source boots the authenticated same-origin `/mytrade/app` application and
captures the actual `session`/`csession` headers and XSRF capability from its
requests. It reads securities with the bodyless POST
`/mytrade/api/v2/json2/account/view` and execution history with GET
`/mytrade/api/v2/json2/order/executions/history`. The latter takes the selected
account, `fromDate`/`toDate` in `ddMMyyyy` form, and an optional opaque `pageState`.
`scrapers/hapoalim-securities-paging.ts` consumes `Account.PageState` with a
100-round cap. Do not replace its cursor with guessed page numbers.

This is a source reference, not proof that this user's securities account is
currently reachable or empty. The public securities-info schema models metadata
but leaves the actual `View.Account` value shape unmodeled. Verify the live
response shape before implementing current values; empty metadata does not prove
zero holdings. Query execution history independently of whether current holdings
are present. Any bounded diagnostic must preserve the existing headed profile,
configured service UID/GID and bank attempt accounting, stop on manual OTP, and
avoid order-placement or other financial endpoints.

## Native Hapoalim feed and archival seed

The `hapoalimInvestments` root config has `enabled` (default false), independent
`readToken`, optional reserved `controlToken`, `staleHours` (30), and
`historyStartDate` (`2023-01-01`). It has no separate login credentials or cron.
When enabled, the existing Hapoalim bank collection receives its own investment
store and reads the securities account within the same guarded headed login.
The dedicated database is `DATA_DIR/hapoalim-investments.sqlite`; it is never
shared with Clal, Best Invest or the checking ledger.

`GET /investments/hapoalim/v1` requires the Hapoalim bearer read capability and
serves cached records only. Clal session/control endpoints are not mounted under
this provider. The reserved control token must differ from the resolved read
token; configuring it does not enable a refresh endpoint.

The securities product identity is the full configured bank account selector
plus `:securities`, encoded with the provider prefix by `investmentProductId`.
It remains independent of the account display name and future bank deposit
products. Securities executions have their own ledger and stable
`natural-key-v1:<sha256>` source identities. Execution identifiers encode that
component as `productId:execution:natural-key-v1%3A<sha256>`. Raw source trade,
transaction and payment labels remain available when normalized kind is `other`.
Executions never become ordinary cash income or spending, and foreign trade and
settlement currencies remain separate. Duplicate natural identities or truncated
history refuse the snapshot rather than silently dropping possible fills.

Private portfolio and history captures store a `{rawBody: string}` envelope with
the exact original response text before decoding. The JSON decoder preserves the
original numeric tokens for `NV`, `TradePrice`, `NetValueTradeCurrency` and
`NetValueSettlementCurrency` through the reviver's `context.source`. This avoids
binary floating-point rounding before decimal validation. Other fields retain
their JSON types, including numeric error codes. A runtime without source-token
support refuses those financial values rather than rounding them.

A verified history response may be applied with incomplete portfolio inventory.
That advances only `lastAttemptAt`, marks the source `partial`, and retains its
previous `lastSuccessAt`. A current portfolio value remains unavailable until
verified. Archive ingestion changes neither source timestamp nor source status.

The native offline archival command is:

```sh
bridge hapoalim-investments-seed \
  --archive /private/surviving-review.json \
  --source /private/targeted-source.json \
  --provider-product-id '00-000-000001:securities' \
  --backup-dir /private/hapoalim-backups
```

Use the actual configured account selector and run as the service UID/GID. The
command verifies the reviewed source SHA-256, every original valuation identity,
date, exact amount and currency against the targeted export, and requires that
export to contain only the surviving investment valuations. The older April
activity review is rejected. The command opens no bank ledger, resolves no
provider credentials, and performs no provider requests. Before insertion it
creates a consistent private SQLite backup, then atomically appends missing
historical rows. Existing products, current value pointers and source status are
preserved; conflicting valuations or evidence roll back all writes. Repeating
the same seed is idempotent.

Feed valuation IDs retain `sure:entry:<original UUID>` and safe typed archival
provenance. The full private review manifest is retained in the investment
store's archival evidence table; raw account details never appear in the feed.
The source stays `never_synced` when only archive data exists, and each initial
product has `currentValuationId: null`. Use
`bridge hapoalim-investments-status` to inspect aggregate cached status without
triggering collection. The command prints valid structured status and exits 1
when the source is not `ok`, including the expected archive-only `never_synced`
state. Read that JSON before treating a nonzero exit as a command failure; it
does not authorize a bank retry. Verify SQLite/WAL/SHM ownership and an actual
application read after deployment or maintenance.

### Verified onboarding — September 10, 2026

The native seed successfully stored the 16 surviving valuations dated April
2–27, 2026 with their original identities, financial amounts and dates. Current
value remains unknown, and provider attempt/success timestamps remain unset.
The older 52 transaction records were not imported. Securo's native onboarding
created one investment asset and group, imported the same 16 exact historical
values, and created no activities or executions. Current balance and source
attempt/success timestamps remain unset. Repeating the cached sync was
idempotent, and preexisting financial records and policy settings were unchanged.
The worker and scheduler were restored on the published Securo image, and the
worker answered its health check.

Archive observation timestamps crossing Python and JavaScript need identical
precision. The native JavaScript seed canonicalizes them with
`Date.toISOString()`. Private verification must normalize its expected
observation timestamp to that same UTC representation, truncating to
milliseconds. Keep the original manifest and its full observation precision
unchanged; no transport copy is required. This comparison normalization applies
only to observation timestamps. Financial values and valuation dates are
unchanged, and archive observation never establishes bank freshness.

The native seeder requires private directories. On this TrueNAS host,
mode 0700 alone did not remove inherited named ACL access. Follow the
[NFSv4 storage checks](operations.md#private-storage-on-truenas-nfsv4-datasets)
before preparing evidence, backups or the investment database.

## September 10 diagnostic boundary

The isolated headed diagnostic reserved the second native Hapoalim attempt of
the Jerusalem day at 09:31 UTC. The bank redirected to its modern authentication
page, but the expected login inputs did not become usable within the bounded
wait. No credentials were submitted, no securities reads occurred, and no
financial records changed. This is not evidence of an invalid password or a
manual OTP requirement. The attempt remains counted: do not refund it, force a
retry, or unpark the source. The ordinary checking success remains September 10
at 03:00 UTC (06:00 Jerusalem). That day's 18:00 collection must respect the
exhausted allowance; the next ordinary opportunity is September 11 at 06:00.

The isolated browser wrapper required `tini -g -- xvfb-run ...`; using Xvfb as
the container entrypoint stalled before Node started. The failed startup did
not reserve an attempt. The corrected wrapper and a prior offline browser check
used the configured service UID/GID. The normal bridge was restored and an
application read confirmed SQLite/WAL/SHM ownership after the diagnostic.

On this host, direct package-bin execution can report permission denied even
when executable mode bits are present. Equivalent local validation uses
`node node_modules/xo/dist/cli.js .`,
`node node_modules/typescript/bin/tsc --noEmit`, and
`node node_modules/vitest/vitest.mjs run`. Generate the configuration schema with
`node node_modules/tsx/dist/cli.mjs scripts/generate-schema.ts`. Keep Git commands
under the repository owner's UID; root-owned object fanout or worktree metadata
can otherwise prevent subsequent fetches and isolated worktree creation.

## Collection limits during onboarding

The September 10 diagnostic did not establish a current portfolio value or
successful securities-history collection. Its login reservation counts toward
the same two-attempt Hapoalim Jerusalem-day cap as scheduled bank collection.
Deploying the integration does not reset that allowance or authorize another
same-day login after it is exhausted. The next eligible normal bank collection
can attempt the securities reads in its existing session.

The implemented parser deliberately leaves current value unavailable: the
upstream reference does not establish the bank's `View.Account` current-value
shape. Historical executions can be collected independently, with partial
coverage, but unknown positions or empty security metadata cannot imply a zero
balance. Extending current holdings/value support requires verified source
fields and the same source-to-PR-to-published-image deployment workflow.

## Deployment order

Deploy the updated Securo backend, worker and scheduler with its execution and
provenance migration before deploying the bridge. The new bridge includes the
optional execution collection on all investment feeds, while the older Securo
strict schema rejects that field. The updated consumer accepts older feeds with
an empty execution default, allowing this ordered rollout without a service-code
hot patch. Pull only the reviewed, merged and CI-published moving images.
The Google Messages receiver is unchanged by this rollout. Hapoalim collection
continues to share its normal bank session and requires no new OTP receiver.
