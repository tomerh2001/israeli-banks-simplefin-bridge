# Investment feed version 1

Clal pensions and savings use a dedicated investment feed and database. They never
become SimpleFIN bank accounts. A consumer must count each product once; tracks
are descriptive allocations within a product, not extra assets to add to its value.

The contract is defined by `src/investments/schema.ts`. The HTTP integration serves
`GET /investments/v1` with a dedicated read bearer token; the SimpleFIN consumer
credentials do not grant access to this endpoint. Credentials, browser state,
raw provider responses and revision history are not part of the feed.

## Identity and financial values

- Product IDs contain the actual provider account or policy identifier, percent
  encoded after `clal:`. Neither display names nor inferred product kinds enter
  the identity. If Clal namespaces policy numbers, the adapter must use the actual
  provider namespace and policy composite consistently.
- Monetary amounts are exact strings with two decimal places. Missing amounts
  must not become zero. Activity amounts are signed effects on the product value;
  a reversed charge can therefore have a positive amount.
- Valuation IDs are stable for each product and provider valuation date. A
  corrected value replaces that record, and the store retains the old revision.
- `product.currentValuationId` explicitly identifies its authoritative current
  value. A newly retrieved historical valuation never implicitly replaces the
  current balance. Null means the provider supplied no verified current value.
- `asOf` is the provider valuation date. `observedAt` is when the collector observed
  the value. If the provider supplies no date, `asOf` is explicitly null and the
  value has one stable `:valuation:undated` identity across observations. Consumers
  must mark the date as unverified and must not present the observation date as a
  provider valuation date.
- Activities require a stable source row identifier. Matching only date, text and
  amount is insufficient: two equal contributions can be separate real entries.
  Month-only contributions use `dateKind=contribution_month` and `YYYY-MM`; they do
  not acquire an invented day of the month.
- Balance changes do not generate activities. Investment return and actuarial
  adjustments are exposed only when supplied by the provider. Forecast monthly
  pension is separate metadata and never current wealth.
- Optional `product.reportSummaries` contains the provider's period reports:
  identity, title, actual nullable period bounds, and labelled signed money
  strings in the product currency. Use stable IDs that distinguish the report
  family and reporting period. Reports are retained by ID, with corrections
  replacing the same report; omission never erases a previously collected report.
  Overlapping reports stay separate. Their fees, insurance, returns and other
  figures never become synthetic activities, cash transactions, or extra wealth.

## Persistence and completeness

`createInvestmentStore` opens a dedicated SQLite database. The collector supplies
an `InvestmentSnapshot`; all its records and source-success state commit together.
Invalid identities, duplicate IDs, currency mismatches and orphan records reject
the snapshot before any financial data is written. An observation older than the
last successful collection cannot replace it.

The collector sets `complete=false` for a failed or truncated required response.
`inventoryComplete=false` means the product listing was incomplete. Either flag
preserves all previously verified data and records a partial source status. An
authentication or collection failure also preserves previous records and their
last-success timestamp. A missing product never implicitly deletes or closes it.

Per-product coverage describes how much history the provider makes available;
`partial` history can be a valid complete collection. It is distinct from an
incomplete network response. Empty activity arrays do not prove there was no
activity, and unavailable coverage remains explicit.

The feed carries the last attempt, last success, a fixed sanitized error code, and
a stale threshold. Consumers should retain values while showing old data or an
authentication requirement. A successful HTTP fetch of cached data is not a new
provider collection and must not refresh the provider's success timestamp.

## Collection integration

The runtime should resolve Clal ID and phone references with the existing
1Password Connect resolver. Use an isolated Clal browser profile, a separate weekly
schedule, and its own login-attempt guard. An OTP requirement parks collection
until assisted login completes; scheduled collection must not repeatedly send SMS
or reduce the bank sources' attempt budgets. The feed serves cached data only.

`config.investments` is optional and disabled by default. Its independent schedule
defaults to Monday at 07:00 in the bridge timezone; the stale threshold is 192
hours. `readToken` is a dedicated token or 1Password reference with at least 32
characters. A missing token or unavailable investment database returns a sanitized
503 from the investment endpoint while bank routes remain available. Read-token
resolution occurs at startup. Collection does not run at startup or on feed reads.

`createInvestmentRuntime` accepts an injected collector. The collector applies
verified snapshots or records sanitized source failures itself. It must use the
context's abort signal to close its browser during shutdown and enforce the
configured collection timeout. Unexpected collector exceptions become a fixed
`COLLECTION_FAILED` status without logging exception text or provider responses.
An orderly shutdown cancels collection without replacing the last source-health
status or applying an unfinished snapshot.

## Operator commands

- `bridge clal-login` performs an explicit assisted login. Credentials come from
  the configured 1Password references. Only after Clal displays its SMS-code form
  does the command read a six-digit code from standard input. Terminal entry is
  hidden, and the original terminal mode is restored on completion, cancellation,
  input errors, and timeout. Piped input is supported; keep the supplying process
  private. Codes are never accepted as command arguments or stored.
- `bridge clal-sync` collects investments using the saved Clal session. It never
  requests an SMS code. If authentication expired, run `clal-login`, followed by
  `clal-sync`.
- `bridge clal-status` prints configured/enabled flags, sanitized source health,
  staleness and record counts. It never prints product identifiers, amounts,
  descriptions, credentials or the read token. Exit zero means an enabled,
  healthy, fresh source; otherwise it exits one.

Login and sync reject missing or disabled investment configuration before
contacting Clal. Both honor the global `--config` and `--data-dir` options. The
container entrypoint supplies their virtual display, and process interrupt or
termination signals cancel collection before releasing the browser profile.
`serve` uses the Clal collector on its independent weekly schedule without
performing an initial scrape.

## Profile lock recovery

The Clal profile has an adjacent `clal.collector-lock` directory containing a
private `owner.json`: container/host name, process ID, acquisition time, and a
random ownership marker. The normal owner removes this lock only after its
browser closes. A forced termination can leave the lock behind.

Never clear a lock because its process ID is absent in the current container.
Different containers have different PID namespaces, and a PID can be reused.
To recover manually:

1. Stop the bridge and every assisted-login or maintenance container mounting
   this Clal profile. Disable automatic restarts while investigating.
2. Compare `owner.json` with the stopped container's identity. Verify through
   the host's container/process inventory that no running collector or Chromium
   process can still be using this profile. If ownership remains uncertain,
   leave the lock in place.
3. Once exclusive access is proven, move the stale lock directory into the
   private data area's recovery archive. Keep its metadata for diagnosis.
4. Restart the bridge, then perform one collection. Do not delete profile data
   or Chrome singleton files as a shortcut for establishing ownership.
