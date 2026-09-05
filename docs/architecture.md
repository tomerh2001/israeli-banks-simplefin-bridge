# Architecture

`israeli-banks-simplefin-bridge` is one Node/TypeScript process that:

1. **Scrapes** the operator's Israeli banks and credit cards on a cron schedule with
   [`israeli-bank-scrapers`](https://github.com/eshaham/israeli-bank-scrapers) (puppeteer, one Chrome profile per company).
2. **Keeps a ledger** of every account, transaction and holding it has ever seen in SQLite (`node:sqlite`).
   Rows are frozen at first sight so consumer-side dedup stays stable.
3. **Serves the ledger over the SimpleFIN protocol** (claim + `/accounts`) on the internal Docker network, so
   consumers with native SimpleFIN support, such as [Securo](https://usesecuro.com) and Actual Budget,
   do account creation, scheduled sync, dedup, balance reconciliation and holdings themselves.
   No consumer API token, no consumer-side code, no reverse-proxy route.

```
[Bank sites] <-- Chrome/puppeteer -- [scrape runner] --upsert--> [SQLite ledger] <--read-- [SimpleFIN server :8080]
[1Password Connect] <-- op:// resolver (read-only token) -- [scrape runner]           ^
[Securo backend/worker] -- POST claim, GET /simplefin/accounts (Basic) ---------------+
[Gatus] -- GET /healthz --------------------------------------------------------------+
```

## Module ownership

| Directory / file            | Responsibility                                                                                     |
|-----------------------------|----------------------------------------------------------------------------------------------------|
| `src/types.ts`              | Shared contracts. Change with care; everything codes against it.                                   |
| `src/config.ts`             | Config schema (zod), env overrides, runtime env.                                                   |
| `src/log.ts`                | Logger with secret redaction.                                                                      |
| `src/ids.ts`                | Id scheme (see below). Pure.                                                                       |
| `src/normalize.ts`          | israeli-bank-scrapers result -> ledger rows. Pure.                                                 |
| `src/ledger/sqlite.ts`      | `Ledger` implementation on `node:sqlite`, migrations, freeze semantics.                            |
| `src/ledger/memory.ts`      | Test fake implementing `Ledger`.                                                                   |
| `src/simplefin/`            | Hono app: claim, Basic auth, `/accounts` payload builder, `/info`, `/healthz`, CSV export.         |
| `src/scrape/`               | Scheduler, per-company runner (browser launch, timeouts, profiles, backoff/parking), assisted login, synthetic card payments. |
| `src/secrets/onepassword.ts`| `op://` resolution through the 1Password Connect REST API, credential fingerprints.                |
| `src/export/csv.ts`         | Securo-import-compatible CSV export.                                                               |
| `src/cli.ts`                | `bridge` command line.                                                                             |
| `src/index.ts`              | Process entry: load config, open ledger, start server + scheduler.                                 |

## Id scheme (`ID_SCHEME_VERSION = 1`)

Consumers dedup on `(account, transaction id)` only, so ids must be **unique per row** and **stable across runs**.
Scraper identifiers alone are neither: Hapoalim reuses institution codes across rows, Visa Cal pending rows have
none, Max emits the literal string `undefined`, Isracard/Amex may repeat voucher numbers across installment months.

- Account id: `<companyId>:<accountNumber>` (e.g. `hapoalim:12-627-187430`, `visaCal:1234`).
- Transaction id: `<companyId>:<accountNumber>:<identifier|->:<fp>` where
  - `identifier` is the scraper identifier when usable. Unusable = `undefined`, `null`, empty, numeric `0`,
    or any string starting with `undefined`.
  - `fp` = first 16 hex chars of `sha256(bookedDate|amount.toFixed(2)|description|memo|installmentNumber/installmentTotal)`.
  - When several rows in one scrape share the same id, the 2nd, 3rd... get a stable ordinal suffix `#2`, `#3`
    (ordered by the scraper's own order after a stable sort on `chargeDate`, `identifier`).
- Synthetic card payment id: `<companyId>:<accountNumber>:payment:<chargeDate>`.
- Holding id: `<accountId>:<symbol or slug(description)>`.
- All ids are ASCII, at most 255 characters.

The scheme version is stored in the ledger (`meta.id_scheme_version`); the process refuses to serve a ledger
written with a different version.

## Dates, amounts, currency

- `bookedDate` = calendar date in the bridge timezone (default `Asia/Jerusalem`) of the scraper `date`
  (purchase/event date) or, with `dateMode: "charge"`, of `processedDate`.
- `chargeDate` = calendar date of `processedDate` (bank charge/billing date) when present.
- SimpleFIN `posted` = `Date.UTC(y, m, d, 12)` of `bookedDate` so a consumer converting to a UTC date never
  shifts the day. `transacted_at` = same for the purchase date.
- `amount` = scraper `chargedAmount` (signed; negative = money out, already in the account currency). Fallback
  to `originalAmount` only when `chargedAmount` is missing and the currencies match.
- Currency symbols/strings from scrapers are normalised to ISO-4217 (`₪`, `ש"ח`, `NIS`, `ILS(₪)` -> `ILS`;
  `$`, `USD($)` -> `USD`; numeric `376/840/978` -> `ILS/USD/EUR`). Unknown -> account currency.
- Card balances are emitted as **negative** numbers (debt), per SimpleFIN convention. Checking = real balance.

## Freeze semantics and anomalies

A transaction's `id`, `amount`, `bookedDate` and `description` never change after first insert. Later scrapes
only refresh `lastSeen`, `status` (pending -> posted), `chargeDate`, `category`, `memo`, `raw`. If a frozen field
comes back different, an **anomaly** is recorded (and surfaced by `bridge status`/`bridge audit`) instead of being
applied, because consumers never update amounts either.

Pending rows are stored but **not served** unless `includePending` is on for the company.

## SimpleFIN server

See [`docs/securo-simplefin-contract.md`](./securo-simplefin-contract.md) for the exact request/response contract
Securo exercises. Summary:

- `POST /simplefin/claim/<claimId>` -> `200 text/plain` Access URL `http://<user>:<secret>@<host>/simplefin`.
  A claim id is valid `server.claimTtlMinutes` and may be claimed up to `server.maxClaims` times, but never after
  the first successful authenticated GET. Afterwards `403`.
- `GET /simplefin/accounts` (Basic) with `version`, `pending`, `account`, `start-date`, `end-date`,
  `balances-only` -> union of v1 and v2 shapes.
- `GET /simplefin/info` -> `{"versions":["1","2"]}`.
- `GET /healthz` (no auth) -> `200` or `503` with a `HealthReport`.
- `GET /export/transactions.csv` (Basic) -> Securo CSV import columns.
- Never redirects. Never forwards bank page text in error messages.

## Scraping

- Sequential per company; an in-process guard prevents overlapping runs.
- Scrape window start = `max(config.startDate, lastSuccessAt - overlapDays)`; the scraper clamps further.
- Per-company wall-clock limit (`timeoutMinutes`), then the browser is killed and the run is marked `timeout`.
- Backoff after `TIMEOUT`/`GENERIC`: 1h, then 3h, then the next scheduled slot.
- `INVALID_PASSWORD`, `CHANGE_PASSWORD`, `ACCOUNT_BLOCKED` **park** the company: no retries until the resolved
  credential fingerprint changes in 1Password or `bridge unpark <company>`.
- At most `maxLoginAttemptsPerDay` login attempts per company per calendar day.
- One Chrome profile per company under `DATA_DIR/chrome/<companyId>`; stale `Singleton*` lock files are removed
  before launch.
- The scraper library is driven with an explicit `executablePath` (the Chrome bundled in the image) so the
  library's own puppeteer version never needs to download a second browser.

### Assisted login (`bridge login <company>`)

Some banks (Hapoalim) demand an SMS one-time code on an untrusted device. `bridge login` launches the same Chrome
profile **visibly** under Xvfb, exposes it through noVNC on port 6080 (password from `NOVNC_PASSWORD`, otherwise
random and printed), runs the library login, and keeps the browser open when the library gives up so the operator
can finish the OTP by hand. When the post-login page is detected (or the operator presses Enter), Chrome is closed
gracefully so the device-trust cookies persist in the profile. It is meant to run via a separate compose service on
an isolated network with the port published on `127.0.0.1` only.

## Secrets

- Bank credentials live in 1Password; `config.json` holds `op://<vault>/<item>/<field>` references.
- The bridge resolves them in-process through the 1Password Connect REST API using a **read-only** Connect token
  mounted from `OP_CONNECT_TOKEN_FILE`. Resolved values live in memory for one run and are registered with the
  logger's redaction list.
- `sha256` of the resolved credential tuple is stored per company; a change auto-unparks the company.
- `OP_DISABLED=1` allows literal values in `config.json` for smoke tests only.

## CLI (`bridge`)

| Command | Purpose |
|---|---|
| `bridge scrape [company] [--from YYYY-MM-DD] [--force]` | Run a scrape now (all enabled companies or one). `--force` ignores parking/backoff. |
| `bridge status` | Per-company state, accounts, row counts, consumers, anomalies. |
| `bridge mint-token --label <name> [--rotate]` | Create (or rotate) a consumer and print its base64 SimpleFIN setup token. |
| `bridge revoke --label <name>` | Revoke a consumer. |
| `bridge login <company>` | Assisted (visible) login, see above. |
| `bridge unpark <company>` | Clear parking/backoff. |
| `bridge reset-profile <company>` | Delete the company's Chrome profile. |
| `bridge audit` | List duplicate-looking rows and recent anomalies. |
| `bridge export [--account id] [--from] [--to]` | CSV to stdout. |
| `bridge health` | Exit 0/1 for the Docker HEALTHCHECK. |
| `bridge serve` | Start the server + scheduler (same as `node dist/index.js`). |

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `CONFIG_PATH` | `./config.json` | Config file. |
| `DATA_DIR` | `./data` | Ledger, Chrome profiles, screenshots. |
| `LEDGER_PATH` | `$DATA_DIR/ledger.sqlite` | |
| `SCHEDULE` | from config | Cron override. |
| `OP_CONNECT_HOST` | | e.g. `http://172.16.1.1:8088`. |
| `OP_CONNECT_TOKEN_FILE` | | Read-only Connect token file. |
| `OP_DISABLED` | `0` | Treat config values as literals. |
| `PUPPETEER_EXECUTABLE_PATH` | auto-detected | Chrome binary. |
| `SHOW_BROWSER` | `0` | Headed Chrome (needs a display). |
| `NOVNC_PASSWORD` | random | Assisted-login VNC password. |
| `VERBOSE` | `0` | Row-level debug logging. |
| `TZ` | `Asia/Jerusalem` | |
