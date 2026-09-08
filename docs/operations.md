# Operations runbooks

All commands assume the generic [`compose.yml`](../compose.yml) and are run from the stack directory.
`bridge` inside the container is a wrapper for `node /app/dist/cli.js`; the command table is in
[architecture.md](./architecture.md#cli-bridge). The alias below is for status/token commands on a running server.
For manual scraping, assisted login or profile changes, stop the serving container and use a one-off container
with the same data mounts. The scheduler's overlap guard only covers its own process.

```sh
alias bridge='docker compose exec israeli-banks-bridge bridge'
```

## First run

1. `cp config.example.json config.json` and edit: one entry per company with `op://` references, `kind`, and for
   cards the intended date mode (do not guess `chargeDay`). Validate against `config.schema.json` (most editors do it from the `$schema` key).
2. Create a read-only 1Password Connect token with access to the vault holding the bank items and save it to
   `secrets/op-connect-token` (mode 0600). Set `OP_CONNECT_HOST` in `compose.yml`.
3. Create `data/` with ownership matching the configured runtime uid/gid. The audited TrueNAS stack uses
   `10042:3027`; use its filesystem ACL API for dataset ownership, not a copied generic `chown` command.
   The ledger and Chrome profiles live here.
4. Attach the consumer's network in `compose.yml` (see [deploy-securo.md](./deploy-securo.md)).
5. After current credentials are resolved and a company is enabled, keep the serving container stopped and run
   `docker compose run --rm --no-deps israeli-banks-bridge bridge scrape <company>`. Start with one company.
6. If a company asks for an SMS code, follow [OTP enrolment](#otp-enrolment-and-re-enrolment). Successful
   assistance performs its confirmation scrape while the serving container remains stopped. Do not retry an
   abandoned or failed login automatically.
7. After initial results are verified, run `docker compose up -d israeli-banks-bridge`. `bridge status` should
   show every enabled company with a recent `lastSuccessAt`, and `curl
   http://israeli-banks-bridge:8080/healthz` (from any container on the network) should return 200.
8. Mint a token per consumer and connect them.

## Rotating a bank password

Hapoalim (and some others) expire passwords periodically. The library reports this as `CHANGE_PASSWORD`, which
**parks** the company: `bridge status` shows `parked` with reason `CHANGE_PASSWORD`, `/healthz` turns 503 immediately (parked
companies are unhealthy regardless of `staleHours`), and no further login attempts are made (each attempt would burn one of the
`maxLoginAttemptsPerDay` and risk a lockout).

1. Change the password on the bank's site.
2. Update the field in 1Password. Nothing else: the bridge fingerprints the resolved credential tuple, and a changed
   fingerprint auto-unparks the company on the next scheduled run.
3. To resume immediately, stop the serving container, run
   `docker compose run --rm --no-deps israeli-banks-bridge bridge scrape <company>`, then restart the server.
   If credentials did not change, establish that the reported problem is resolved before deliberately unparking
   or forcing a login. A force option still respects the daily attempt cap.

`INVALID_PASSWORD` and `ACCOUNT_BLOCKED` park the same way. `ACCOUNT_BLOCKED` means the bank locked the login; unlock
it with the bank first, then unpark.

## OTP enrolment and re-enrolment

Hapoalim's `/ng-portals/auth/he/` is its ordinary login page, so a timeout on that URL alone does not prove
that an SMS code is required. A blank failure screenshot and no `LOGGING_IN` progress event indicate a failure
before the scraper clicked Submit. Inspect page loading before starting OTP enrolment. On this host, an earlier
importer recovered from fresh-profile redirect timeouts after receiving a copy of a previously working Chrome
profile. If reusing that approach, stop all profile writers, archive the destination profile, and copy the old
profile into the company's dedicated directory with the correct service ownership; never share a live profile
between importers. Existing device trust may have expired, so verify the result within the daily attempt cap.

Device trust lives in the company's Chrome profile (`data/chrome/<company>`). Re-enrol when the bank asks for a code
again (profile deleted, cookies expired, bank policy change), which surfaces as `OTP_REQUIRED`.

Hapoalim can display its SMS form on the same ordinary login URL. The runner watches for the visible
`form.auth-otp-login` before the scraper closes Chrome and retains only that boolean observation. If the run
then ends with a generic error or timeout, it reports `OTP_REQUIRED` and parks the company for assisted login.
A hidden form or ordinary login URL does not establish an OTP challenge; explicit credential errors and
successful results retain their original meaning.

```sh
docker compose stop israeli-banks-bridge                  # never run two Chromes on one profile
COMPANY=hapoalim docker compose --profile bootstrap run --rm israeli-banks-bridge-login
```

The helper prints the noVNC URL (`http://127.0.0.1:6080/vnc.html`) and password (`NOVNC_PASSWORD` or a random one).
Open it from the host (SSH port-forward `-L 6080:127.0.0.1:6080` from elsewhere), watch the automated login, type
the SMS code when the bank asks, and wait until the post-login page shows up; the helper detects it and closes Chrome
gracefully so the trust cookie is persisted. Press Enter only after verifying the login completed if detection
fails. The helper then performs its confirmation scrape. A timeout or closed browser does not unpark or retry.
Once confirmation succeeds, restart the serving container:

```sh
docker compose up -d israeli-banks-bridge
```

The helper runs on its own network with the port bound to loopback only; it never shares a network with the
consumers and is not reachable from the LAN.

On this host, Hapoalim still required `scraperOptions.showBrowser: true` after SMS enrolment: a headed scrape
succeeded while a headless run stalled before login. The container entrypoint supplies an Xvfb display for
`bridge serve` and `bridge scrape`, so that setting also works during scheduled collection. CAL can remain
headless. Assisted login starts its own display and noVNC stack; the scheduled display exposes no remote UI.

## Chrome and Puppeteer versions

The Docker base is pinned to Puppeteer `24.43.1`, matching the driver resolved in `yarn.lock` and its supported
Chrome `148.0.7778.97`. Update the base and dependency lock together. The image build checks the actual Chrome
binary against the installed driver's `PUPPETEER_REVISIONS.chrome` and fails if they differ; the bridge's
published deployment image still uses its moving `latest` tag.

On 2026-09-07, the former `puppeteer:latest` base supplied Chrome `152.0.7977.75` while the application still
loaded Puppeteer `24.43.1`. That mismatch was found during CAL page-closure and Hapoalim login investigations.
After deployment with the matching pair, local page rendering passed and CAL's assisted login reached
`LOGIN_SUCCESS`; the former Chrome 152 run had lost its page before login. A successful assisted login verifies
authentication only: check the normal scrape and destination sync separately before enabling unattended import.
[Puppeteer's supported-browser list](https://pptr.dev/supported-browsers) maps the tested browser pairs.

Upgrading only `israeli-bank-scrapers` from `6.9.0` to `6.11.0` does not change its Hapoalim, CAL, or browser-base
implementation, and both releases depend on Puppeteer 24. Puppeteer 25 requires separate compatibility checks:
its [major release](https://github.com/puppeteer/puppeteer/releases/tag/puppeteer-v25.0.0) changes the package to
ESM and makes `executablePath()` and `defaultArgs()` asynchronous.

## Rotating a consumer token

Consumers keep the Access URL; the setup token has a limited claim count and TTL. To rotate the secret a consumer authenticates with:

```sh
bridge mint-token --label securo --rotate     # new secret + new claim id; old secret stops working immediately
```

Paste the new token into the consumer (Securo: connection page -> reconnect; Actual: reset SimpleFIN credentials,
then link again). To cut a consumer off for good: `bridge revoke --label <name>`; it gets `403` from then on.

Un-claimed tokens expire after `server.claimTtlMinutes`; nothing to clean up.

## Accounts without a reported balance

When a source returns no balance, the account name includes `(balance unavailable)` and the SimpleFIN response
contains `act.balance_unavailable`. Securo still stores the required numeric `0.00` placeholder and reconciles
the opening balance to zero; do not treat that placeholder as the source's reported balance. The name warning
reflects the latest scrape and clears on the next sync when a balance is reported, including a real zero.
An account with no balance can still have valid transaction history; missing balance alone establishes neither
that the card is closed nor that it is inactive. A user-defined display name in Securo can hide the name warning.

## Backups

State is entirely under `data/`:

| Path | Contents | Backup |
|---|---|---|
| `data/ledger.sqlite` (+ `-wal`/`-shm`) | accounts, transactions, holdings, consumers (hashed access secrets and temporary setup secrets), scrape state, anomalies | yes; this is what keeps consumer ids stable. Copy while the container is stopped, or use `sqlite3 data/ledger.sqlite ".backup /path/ledger.bak"` for a hot copy. |
| `data/chrome/<company>/` | Chrome profile with device-trust cookies | yes, unless you are happy to re-enrol OTP after a restore. Stop the container first; a profile copied mid-run is corrupt. |
| `data/screenshots/` | failure screenshots | no |
| `config.json`, `secrets/` | config and Connect token | keep with the stack, outside the image |

Restoring: stop, replace `data/`, restore the configured runtime ownership/ACLs, then start. A restored ledger with an older
`meta.id_scheme_version` than the running image is refused at startup; that is deliberate, see
[architecture.md](./architecture.md#id-scheme-id_scheme_version--1).

## Recovering history from retired importers

A successful scrape establishes what the source returned, not complete account history. A requested start date
can be clamped by the bank, and CAL can filter by purchase date while the bridge books transactions on charge
date. Check both dates when comparing archive coverage with a fresh scrape. A database's last checkpoint also
does not establish the last successful bank refresh or prove that a gap contains no activity.

Keep extracts, comparison scripts, raw records, checksums and the review manifest outside the repository. On
this host, use `/mnt/Pool/Services/Data/israeli-banks-bridge/migration/` with mode 0700 and files mode 0600.
Share aggregate counts and date ranges in operational documentation; keep account identifiers, descriptions,
amounts and credentials in the private artifacts.

1. **Inventory before recovery.** Compare retired Actual SQLite caches, Sure SQL backups and PostgreSQL data
   directories by size, timestamp and database version. Read SQLite with `mode=ro`, `PRAGMA query_only=ON` and
   a read transaction. A targeted Sure SQL export needs accounts, entries and their transaction records; select
   the intended bank/card accounts, transaction entries and non-excluded rows. Leave valuations and investment
   accounts outside a bank/card recovery.
2. **Recover PostgreSQL on a copy.** Check shutdown state and major version, then copy the retired data into
   the private migration directory. Start that copy with the matching PostgreSQL major version, `--network none`
   and read-only SQL transactions. Startup may write to the copy; the original stays untouched. Export only the
   selected accounts and joined entries/transactions, record checksums and provenance, then stop and remove the
   temporary container. Compare older and newer exports before assuming the newer one is a superset.
3. **Normalize with source evidence.** Sure expense amounts are positive; negate the signed entry amount for
   the bridge. Actual amounts are signed integer cents. Preserve CAL's `Processed date` from Sure notes as the
   charge date and keep the purchase date separately. Old Actual imports may retain only the purchase or
   installment date: preserve that known date, leave `chargeDate` absent, and record this limitation in raw
   provenance. Do not infer a billing day. Verify currency from the archive's account/source context.
4. **Compare identities and multiplicity.** Match the company and original account/card first. Use the source
   identifier together with dates, signed amount, original description, memo and installment fields. Bank
   references can repeat across unrelated transactions, and CAL installments can reuse an identifier in
   different months. Identical merchant, date and amount do not prove a duplicate when source identifiers or
   purchase dates differ. Conversely, repeated archive rows with identical fields and one reused reference
   need evidence of distinct transactions; assigning ordinal IDs does not supply that evidence. Different native
   IDs also do not prove distinct transactions when an archive uses purchase dates and the current feed uses
   charge dates: compare the original purchase date and source identity before retaining both. Preserve
   unresolved groups in a separate review file.
5. **Prepare a reviewable transaction manifest.** Prefer a verified newer archive while retaining older records
   it lacks. Exclude rows already represented in the current ledger, synthetic reconciliations, opening/closing
   valuations, and aggregate card-payment legs that lack an original card mapping. Treat old no-ID card rows
   that resemble a later settlement as unresolved until their posting can be established. Record every include,
   exclusion and unresolved match with its source provenance. Preserve the real scraper identifier or CSV source
   reference; use a deterministic archive identifier only when the original identifier is unavailable. Keep the
   original memo separate from Sure's appended importer metadata, which belongs in `raw`. Use the bridge's
   `assignTransactionIds` with the reconstructed fields and check for collisions with existing IDs before import.
6. **Back up and insert through the native ledger.** Take consistent bridge and destination backups and record
   the existing accounts, balances, source states, runs and transactions. Serialize the operation with scraping
   and destination sync. Insert only reviewed historical transactions through `ledger.upsertTransactions`;
   do not replace the ledger or call account/source/run update methods. Give newly inserted rows the actual
   import time in `firstSeen` and `lastSeen`, so the next incremental SimpleFIN fetch can discover old dates.
   Inspect the upsert summary and anomalies, and confirm all protected state remains unchanged.
7. **Sync the existing Securo connection and verify twice.** Use Securo's native cached connection sync; it reads
   the bridge ledger and does not log into the banks. Reuse the existing connection and linked accounts. Compare
   the imported external IDs, account mapping, dates, signed amounts, currencies and descriptions with the
   manifest. Verify historical and current rows, current balances and the preserved manual accounts separately.
   A second cached sync should add no transactions or duplicate external IDs. Securo's sync return count can
   describe merged manual transactions, so verify stored transaction counts rather than treating that return
   value as the import total.

### Review Securo transfer matches after backfill

Securo can infer transfer pairs from opposite amounts on different accounts with nearby dates. During this
recovery it paired two ordinary card purchase debits with bank credits without supporting transfer evidence.
Source identity and amount
verification alone will not catch that reporting change: inspect newly assigned `transfer_pair_id` values and
verify the source descriptions and direction of both legs. Clear unsupported pairs through the native
`transfer_detection_service.unlink_transfer_pair` operation, preserving the financial records and categories.

The current model has no permanent “never pair these transactions” flag. An unchanged cached sync only
considers newly imported rows and does not recreate an old-to-old pair, but a global manual transfer-detection
run or another nearby historical import can reconsider it. Keep the private pair review so the decision is
reproducible. Pairing a bank credit with a card purchase is not established merely because their amounts match.

### Hapoalim history can stop at 150 rows

On 2026-09-08, Hapoalim returned `numItemsPerPage: 150` even though the request specified `1000`. The normal
year-range scrape had returned 150 rows starting on May 5. A single request to the same authenticated
`/current-account/transactions` endpoint with `retrievalStartDate=20260427` and `retrievalEndDate=20260504`
returned nine posted transactions inside that range, with `eventCounter: 9`. The response's `retrievalMinDate`
was `20240908`, so May 5 was not the oldest accessible date in that session. This observation establishes the
returned page size and successful gap recovery; it does not establish that every historical interval is complete.

The installed scraper makes one transaction request per account and discards response metadata. It has no
pagination or date-window subdivision. [Upstream PR #738](https://github.com/eshaham/israeli-bank-scrapers/pull/738)
previously raised the requested row limit from 150 to 1,000, but that change alone did not prevent the observed
150-row response. The scraper also fixes the upper date bound to today and clamps the lower bound to about one
year ago, so changing `startDate` alone cannot request an isolated older interval. Another implementation uses
[date-window subdivision](https://github.com/zenmoney/ZenPlugins/blob/c7af1ee865ae40482694f572e8205babcb8aaf15/src/plugins/hapoalim/api.js#L1508)
when a response reaches its assumed limit; the bridge does not yet implement this.

For a known gap, preserve the response's `numItemsPerPage`, `retrievalTransactionData` date bounds and
`eventCounter` before conversion. These fields are described in the
[Hapoalim response schema](https://github.com/Urigo/accounter-fullstack/blob/c7932d82771f47f94a854a45ee2c7901babf839b/packages/modern-poalim-scraper/src/zod-schemas/hapoalim-ils-checking-transactions-schema.ts).
Use an explicitly bounded date range and the configured account selector, with no concurrent browser profile
writer. Reserve the diagnostic login in the normal daily attempt counter before login; preserve every other
source-state field. Save the response privately and normalize only its transactions for duplicate review before
insertion. Keep current account balances, freshness and run history unchanged. Do not invent page-number
parameters or claim complete backfill from a successful, potentially capped response.

## Upgrading

```sh
docker compose pull && docker compose up -d
```

- Ledger migrations run at startup. Take a backup of `data/ledger.sqlite` first.
- Read the release notes for a `BREAKING` entry mentioning `ID_SCHEME_VERSION`. A scheme change means every
  consumer would see every transaction again under new ids; such a release documents the migration path.
- `israeli-bank-scrapers` upgrades can change scraped identifiers or fingerprint fields for some banks. Existing
  ledger rows stay unchanged, but revised ids can create duplicates. Only changes under the same id become
  anomalies. Compare affected statements after an upgrade; `bridge audit` cannot identify every correction.
- The Chrome version comes from the puppeteer base image and moves with it. Profiles survive Chrome upgrades.

## Troubleshooting

| Symptom | Where to look | Fix |
|---|---|---|
| `bridge status` shows **parked** | `parkedReason` | See [rotating a bank password](#rotating-a-bank-password). `bridge unpark <company>` after fixing the cause. |
| `/healthz` is **503**, company **stale** | `lastErrorType`, `docker compose logs` | `TIMEOUT`/`GENERIC` back off 1 h, then 3 h, then the next slot. If a retry is appropriate, stop the server and run a one-off scrape before restarting; check `data/screenshots/` for what the page looked like. Raise `timeoutMinutes` for slow sites. |
| Consumer shows **401/403** / reconnect banner | `bridge status` consumers section | The consumer was revoked or rotated, or the Securo `SECRET_KEY` changed. Mint a new token and reconnect. `403` on the claim itself means the token was already used up (`maxClaims`) or expired: mint a new one. |
| Scrape fails immediately with a Chrome launch error | logs mention `SingletonLock` / `profile in use` | Another Chrome holds the profile (login helper still running, or a previous run was killed). Stop it; the bridge removes stale `Singleton*` files before launch, but not while a live process owns them. Last resort: `bridge reset-profile <company>` (re-enrol OTP afterwards). |
| Chrome crashes / `Target closed` mid-scrape | container logs | `shm_size` too small (keep 1g) or missing `SYS_ADMIN`. |
| Login page loops, captcha, `GENERIC` right after login | screenshots | Bot detection. Reduce frequency (two runs a day is plenty), turn off `additionalTransactionInformation`, do not run several companies of the same group concurrently (the bridge is sequential already), and do an assisted login so the session looks like a trusted device. |
| `TWO_FACTOR_RETRIEVER_MISSING` / `OTP_REQUIRED` | | [OTP enrolment](#otp-enrolment-and-re-enrolment). |
| `bridge audit` lists duplicates | | Rows with identical date/amount/description under different ids. Usually real (installments, repeated purchases); check the `identifier` column. Nothing is deleted automatically. |
| Anomalies reported | `bridge audit` | The bank changed a frozen field after first sight. The stored value is kept, matching what consumers already imported. Correct by hand in the consumer if needed. |
| `1Password`: `op://` resolution fails | logs `secrets` scope | Connect host unreachable, token expired, or the token's vault access is missing. Test with `curl -H "Authorization: Bearer $(cat secrets/op-connect-token)" $OP_CONNECT_HOST/v1/vaults`. |
| Ledger refused: id scheme mismatch | startup log | Wrong image version for this `data/`; see [upgrading](#upgrading). |

Logs never contain credentials, account numbers, descriptions or amounts at info level; set `VERBOSE=1` for
row-level debug output when reproducing a problem, and unset it afterwards.


## Dependency audit, 2026-09-07

A production-only Yarn audit reports `extract-zip@2.0.1` through `@puppeteer/browsers@2.13.2`:
[GHSA-jmr9-qjv8-65gv](https://github.com/advisories/GHSA-jmr9-qjv8-65gv). The advisory lists no patched version.
It concerns extracting malicious ZIP archives. In the inspected dependency, the caller is the browser-install
path (`@puppeteer/browsers/lib/cjs/install.js` -> `fileUtil.js`). This deployment sets
`PUPPETEER_SKIP_DOWNLOAD=1` and launches the Chrome already bundled in the image through an explicit executable
path. Routine bridge scraping does not invoke that archive installer. This limits exposure for the deployed
path; it does not remove the vulnerable dependency. Recheck the advisory when updating the scraper/browser
packages or changing browser installation behavior.
