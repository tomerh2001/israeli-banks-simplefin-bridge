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
until assisted login completes. With Google Messages explicitly configured, a
collection may make one automatic login attempt and then collect once more.
Automatic SMS requests have a separate persisted allowance of two per rolling
24 hours. They do not reduce the bank sources' attempt budgets. The feed serves
cached data only.

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
  the configured 1Password references. A configured Google Messages receiver
  supplies the code automatically. With `--manual-otp`, or when no receiver is
  configured, the command reads a six-digit code from standard input only after
  Clal displays its SMS-code form. Terminal entry is
  hidden, and the original terminal mode is restored on completion, cancellation,
  input errors, and timeout. Piped input is supported; keep the supplying process
  private. Codes are never accepted as command arguments or stored.
- `bridge clal-sync` collects investments using the saved Clal session. It never
  requests an SMS code unless Google Messages recovery is explicitly configured.
  Otherwise, if authentication expired, run `clal-login`, followed by `clal-sync`.
- `bridge clal-renew` explicitly checks protected account access and renews an
  existing Clal session. It never logs in, requests SMS, or applies financial
  snapshots. A busy profile is skipped; an unavailable/expired session exits one.
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

Clal uses visually hidden Material radio and checkbox inputs. Assisted login
selects the radio labelled `סמס` and verifies the single consent checkbox without
toggling controls that are already checked. Delivery is selected before entering
credentials because switching delivery recreates Clal's phone field empty.
The offline browser regression test uses synthetic HTML and never contacts Clal;
run it with `CLAL_BROWSER_TEST=1` and `PUPPETEER_EXECUTABLE_PATH` pointing to the
pinned container browser.

## Optional session renewal

Set `investments.sessionKeepAliveMinutes` to a value from 1 to 10 to check and
renew the saved session on startup and at that interval. The default is 0
(disabled). Five minutes leaves time to recover from a temporary failed request
within the observed twenty-minute idle lifetime. This is best-effort renewal;
provider revocation, absolute expiry and long service outages can still require
assisted SMS login.

The session maintainer uses Clal's own `KeepSessionAlive` request and verifies
protected portfolio access before and after renewal. The expiration timer alone
is not authentication evidence: a fresh unauthenticated browser can receive a
positive timer after `KeepSessionAlive`. A failed protected account check must
never be reported as an active login.

Maintenance shares the collector's execution gate and cross-process profile lock.
It skips a busy profile without changing health, and a collection due during
maintenance waits for that short operation to finish. A scheduled collection
blocked by another profile owner or an overlapping collection retries every
thirty seconds for up to ten minutes. Duplicate schedule callbacks share that
retry; shutdown cancels it. Provider errors and OTP requirements end the attempt
without this busy retry. Confirmed expired
authentication pauses scheduled browser attempts until successful assisted login
or collection updates the separate session record. No automatic SMS is sent.

Session state is stored separately in `investment_meta`, with check/renewal times,
estimated expiry and a sanitized error code. `clal-status` and authenticated
`GET /investments/v1/session-status` expose it, including expired/overdue flags.
Maintenance never changes valuation dates, source collection timestamps,
inventory completeness or financial records. Reading status never triggers a
renewal. Shutdown aborts maintenance and closes its browser before releasing
the profile or database.

## Google Messages login recovery

`investments.googleMessagesOtpSocket` optionally selects a local Google Messages
receiver. Omit it to leave automatic SMS login disabled. The standalone receiver
is included as `google-messages-otp`; pairing, sender configuration and its Unix
socket contract are documented in `tools/google-messages-otp/README.md`.

Run the receiver in a companion container with only its private state directory
mounted. Both processes need access to its mode0600 Unix socket. Initial Google
sign-in and phone emoji confirmation are required. The Google account must match
the account selected in Google Messages on the phone. Pairing can later expire;
a receiver requiring Google authentication stays unavailable until repaired.

An automatic login first verifies receiver readiness and reserves a single code
request, then atomically spends its SMS allowance immediately before clicking
Clal's Send button. Even an uncertain click counts. The receiver accepts only a
new incoming Clal SMS from configured sender addresses, with matching six-digit
codes in the Hebrew message and exact Clal website footer. It rejects old,
ambiguous and already consumed messages. Codes stay in memory and never enter
logs or persistent storage. Pairing credentials and hashes of consumed message
IDs remain in the private receiver directory.

A collection may recover once from confirmed expired authentication. Failed
pairing, an offline phone, an unavailable receiver, an exhausted allowance or an
unsuccessful OTP ends that recovery without a resend. Automatic recovery never
runs from the session-maintenance timer or a feed/status read. The importer
verifies protected Clal account access before accepting the login and refreshing
financial data. `clal-login --manual-otp` remains available for explicit recovery.

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

## Collector control API

The financial read token remains read-only. Optional `investments.controlToken`
accepts a separate 1Password reference, for example
`op://Home Server/Investment Collector/controlToken`. Generate a new random
secret of at least 32 characters; reusing the financial read secret disables
control access. A missing or unresolved control token leaves financial and bank
feeds available. Keep the control token in the consuming application's backend;
never embed it in browser requests or an access URL.

Both control operations require `Authorization: Bearer <control token>` and
return `Cache-Control: no-store`. Browser-origin requests and query parameters
are rejected. SimpleFIN credentials and the investment read token cannot use
these routes, and the control token cannot read the financial feed.

- `GET /investments/v1/control/status` returns schema version 1, observation time,
  the stored source health/freshness summary, current collection state and its
  last result/times, actual schedule state/expression/description/timezone/next
  run, automatic OTP readiness/reason/next allowance time, and the separate
  verified session observation. It never collects, arms an OTP lease, requests
  SMS, consumes allowance, or changes financial freshness. Receiver health uses
  only its bounded local `GET /healthz`, with an allowlist of safe states. No
  phone number, credentials, account values, message text or OTP is returned.
- `POST /investments/v1/control/refresh` accepts an empty body or `{}` and requires
  `X-Investment-Provider` to match the stored source provider. A consuming backend
  must first compare that provider with the connected financial feed and its
  own saved provider identity. The bridge repeats the identity check immediately
  before reserving collection. It returns HTTP202 with
  `{ "result": "started", "retryAfterSeconds": 0 }`, or `already_running` when
  sharing existing work. This starts the same collector and automatic recovery
  policy as cron. Poll status until `collection.running` is false, inspect
  `lastResult` and source freshness, then import the cached feed into the app.
  An accepted request is not proof that collection or authentication succeeded.

Explicit refresh starts have a persistent limit of two per rolling minute.
Overlapping requests share existing work and consume no extra allowance. HTTP429
returns `refresh_rate_limited`, `retryAfterSeconds` and `Retry-After`. The
independent persistent maximum of two automatic SMS requests per rolling
24 hours still applies, across scheduled, manual and control-triggered recovery.
A provider identity mismatch returns HTTP409 `source_identity_mismatch`; missing
control configuration or runtime availability returns HTTP503
`investment_control_unavailable`. A disabled/invalid schedule reports no next
run, rather than an estimated date.

The receiver being ready confirms current receiver health, not future delivery
or a completed unattended collection. An offline phone, expired pairing,
provider authentication challenge or source error can still stop a run. Report
those conditions with the last successful financial collection time; do not
claim that successful cached feed imports prove scheduled provider collection.
