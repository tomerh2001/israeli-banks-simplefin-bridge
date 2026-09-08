# israeli-banks-simplefin-bridge

Self-hosted [SimpleFIN](https://www.simplefin.org/protocol.html) bridge for Israeli banks and credit cards.
It scrapes your accounts with [israeli-bank-scrapers](https://github.com/eshaham/israeli-bank-scrapers),
keeps a local ledger, and serves it to any SimpleFIN-capable money manager, such as
[Securo](https://usesecuro.com) or Actual Budget, on your own network. Your consumer app thinks it is talking to
the SimpleFIN Bridge; no app-side code or API tokens are needed.

Successor of [israeli-banks-sure-importer](https://github.com/tomerh2001/israeli-banks-sure-importer) and
[israeli-banks-actual-budget-importer](https://github.com/tomerh2001/israeli-banks-actual-budget-importer).

See [docs/architecture.md](docs/architecture.md) and [docs/securo-simplefin-contract.md](docs/securo-simplefin-contract.md).

[Hachshara Best Invest](docs/best-invest.md) and Clal investments use independent
read-only feeds for Securo, separate from the bank transaction ledger.

## Features

- **One process, three jobs**: cron-scheduled scraping (puppeteer, one Chrome profile per company), a SQLite
  ledger (`node:sqlite`, no native addons), and a SimpleFIN server (claim + `/accounts`) on the internal Docker
  network.
- **18 companies** supported through israeli-bank-scrapers 6.9: Hapoalim, Leumi, Discount, Mizrahi, Mercantile,
  Otsar Hahayal, Beinleumi, Massad, Yahav, Union, One Zero, Pagi, Behatsdaa, Beyahad Bishvilha, Visa Cal, Max,
  Isracard, Amex.
- **Repeatable imports**: unchanged source rows keep the same ids across runs. Stored amounts, dates and
  descriptions are frozen; changes received under the same id become anomalies. Source corrections that change
  the id fingerprint can create new rows and need review (see [identity limits](docs/architecture.md#freeze-semantics-and-anomalies)).
- **Serves Securo and Actual from one payload**: the union of SimpleFIN v1 and v2 shapes, two-decimal balances,
  midday-UTC `posted` timestamps so dates never shift, negative card balances per convention.
- **Secrets stay in 1Password**: `config.json` holds `op://` references resolved at run time through a read-only
  1Password Connect token; resolved values are redacted from logs.
- **Safe scraping**: per-company wall-clock timeouts, backoff, a daily login-attempt cap, and *parking* on
  `INVALID_PASSWORD` / `CHANGE_PASSWORD` / `ACCOUNT_BLOCKED` to avoid repeated attempts with stale credentials.
- **Assisted login** for banks that require an SMS code on a new device: a visible Chrome behind noVNC, bound to
  localhost, on an isolated network.
- **Operability**: `/healthz`, Docker `HEALTHCHECK`, a `bridge` CLI (status, audit, export, token management),
  CSV export in Securo's import format.

## Quick start (Docker)

Requirements: Docker with Compose v2, a 1Password Connect server reachable from the container (or `OP_DISABLED=1`
for a smoke test with literal credentials), and a consumer (Securo or Actual) on a Docker network you can attach to.

```sh
mkdir israeli-banks-bridge && cd israeli-banks-bridge
curl -fsSLO https://raw.githubusercontent.com/tomerh2001/israeli-banks-simplefin-bridge/main/compose.yml
curl -fsSLO https://raw.githubusercontent.com/tomerh2001/israeli-banks-simplefin-bridge/main/config.example.json
curl -fsSLO https://raw.githubusercontent.com/tomerh2001/israeli-banks-simplefin-bridge/main/config.schema.json
cp config.example.json config.json            # edit: companies, op:// references, chargeDay for cards
mkdir -p data secrets && chown 10042:999 data  # pptruser in the image
printf '%s' 'your-read-only-connect-token' > secrets/op-connect-token && chmod 600 secrets/op-connect-token
# in compose.yml: set OP_CONNECT_HOST and attach the network your consumer uses
docker compose up -d
docker compose exec israeli-banks-bridge bridge scrape          # first scrape now instead of the next cron slot
docker compose exec israeli-banks-bridge bridge status
docker compose exec israeli-banks-bridge bridge mint-token --label securo
```

Paste the printed setup token into your consumer (see [Connecting Securo](#connecting-securo)). If a company ends
in `OTP_REQUIRED`, do the [assisted login](#assisted-login-otp) once.

The [`compose.yml`](compose.yml) in this repo is the reference deployment: no published ports, `cap_add: SYS_ADMIN`
and `shm_size: 1g` for Chrome, `no-new-privileges`, the config mounted read-only, and the Connect token mounted as
a file. Image: `ghcr.io/tomerh2001/israeli-banks-simplefin-bridge` (`latest`, `<version>`, `<major>-latest`),
about 2.45 GB because it carries Chrome plus the Xvfb/noVNC tooling for assisted login; see the header of the
[`Dockerfile`](Dockerfile) for the breakdown.

## Configuration

`config.json` is validated at startup against the schema in [`src/config.ts`](src/config.ts);
[`config.schema.json`](config.schema.json) is generated from it (`yarn schema`) for editor completion, and
[`config.example.json`](config.example.json) is a working starting point.

### Top level

| Field | Default | Meaning |
|---|---|---|
| `schedule` | none | Cron expression (5 fields, in `timezone`) for scheduled scrapes. Without it the process only serves and you scrape via the CLI. `SCHEDULE` env overrides it. |
| `timezone` | `Asia/Jerusalem` | IANA timezone used to turn scraper timestamps into calendar dates. |
| `currency` | `ILS` | Account currency when the scraper does not provide one. ISO-4217, upper case. |
| `staleHours` | `30` | `/healthz` returns 503 when an enabled company has no successful scrape within this many hours. |
| `overlapDays` | `30` | Each run re-scrapes from `lastSuccess - overlapDays` to catch late postings (1-365). |
| `maxLoginAttemptsPerDay` | `2` | Login attempts per company per calendar day; the bank-lockout guard (1-20). |
| `companies` | required | Map of company id -> [company config](#per-company). Keys are israeli-bank-scrapers ids (table below). |
| `server.publicUrl` | `http://israeli-banks-bridge:8080` | Base URL consumers use to reach the bridge; embedded in setup tokens and Access URLs. No trailing slash. |
| `server.port` | `8080` | Listen port. |
| `server.host` | `0.0.0.0` | Listen address. |
| `server.claimTtlMinutes` | `15` | A setup token expires this long after minting (1-1440). |
| `server.maxClaims` | `3` | Maximum setup-token claims (1-10), including retries after a partially failed consumer connection. The TTL also applies. |

### Per company

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Disabled companies are neither scraped nor served. |
| `label` | required | Display name: SimpleFIN `connections[].name`, account names, logs. |
| `kind` | required | `checking`, `credit_card`, `savings` or `investment`. Carried to consumers as a hint (`extra.kind`); cards get negative (debt) balances. |
| `credentials` | required | The login fields israeli-bank-scrapers expects for this company (table below). Values are literals or `op://<vault>/<item>/<field>`. |
| `accounts` | `"all"` | `"all"` or a list of scraper `accountNumber` values to keep. |
| `startDate` | none | Lower bound `YYYY-MM-DD` for scraping; each scraper clamps to its own maximum lookback. |
| `additionalTransactionInformation` | `false` | israeli-bank-scrapers option: fetch extra detail per row. Slower, more bot-detection exposure, may change identifiers for some banks. |
| `includePending` | `false` | Serve pending rows. Off by default because pending ids are unstable for several companies. Pending rows are stored either way. |
| `futureMonthsToScrape` | none | israeli-bank-scrapers option for credit cards: future billing months to include (0-12). |
| `dateMode` | `"purchase"` | Which date becomes the row date: purchase/event date, or `"charge"` for the bank charge/billing date. |
| `chargeDay` | none | Cards: day of month the bank account is debited for the bill (1-31). Used in docs and by synthetic payments. |
| `synthesizePayments` | `false` | Cards, opt-in: emit one positive synthetic "card payment" row per charge date so consumers can pair it with the bank-side debit. Only meaningful after one full billing cycle is in the ledger. |
| `timeoutMinutes` | `20` | Wall-clock limit for one scrape of the company (1-120); the browser is killed afterwards. |
| `scraperOptions` | none | Extra israeli-bank-scrapers options passed through verbatim (e.g. `optInFeatures`, `viewportSize`). |

### Companies and credential fields

Company ids and login fields as defined by israeli-bank-scrapers 6.9.0 (`lib/definitions.js`). Use the id as the
key under `companies` and the field names as keys under `credentials`.

| Id | Name | Credential fields | Kind |
|---|---|---|---|
| `hapoalim` | Bank Hapoalim | `userCode`, `password` | checking |
| `leumi` | Bank Leumi | `username`, `password` | checking |
| `discount` | Discount Bank | `id`, `password`, `num` | checking |
| `mercantile` | Mercantile Bank | `id`, `password`, `num` | checking |
| `mizrahi` | Mizrahi Bank | `username`, `password` | checking |
| `otsarHahayal` | Bank Otsar Hahayal | `username`, `password` | checking |
| `beinleumi` | Beinleumi | `username`, `password` | checking |
| `massad` | Massad | `username`, `password` | checking |
| `yahav` | Bank Yahav | `username`, `nationalID`, `password` | checking |
| `union` | Union | `username`, `password` | checking |
| `oneZero` | One Zero | `email`, `password`, `otpCodeRetriever`, `phoneNumber`, `otpLongTermToken` | checking |
| `pagi` | Pagi | `username`, `password` | checking |
| `behatsdaa` | Behatsdaa | `id`, `password` | checking |
| `beyahadBishvilha` | Beyahad Bishvilha | `id`, `password` | checking |
| `visaCal` | Visa Cal | `username`, `password` | credit_card |
| `max` | Max | `username`, `password` | credit_card |
| `isracard` | Isracard | `id`, `card6Digits`, `password` | credit_card |
| `amex` | Amex | `id`, `card6Digits`, `password` | credit_card |

`otpCodeRetriever` (One Zero) is a callback in the library's API and cannot be expressed in a JSON config; One Zero
therefore needs `otpLongTermToken` obtained once outside the bridge.

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `CONFIG_PATH` | `./config.json` (`/app/config.json` in the image) | Config file. |
| `DATA_DIR` | `./data` (`/app/data` in the image) | Ledger, Chrome profiles, screenshots. |
| `LEDGER_PATH` | `$DATA_DIR/ledger.sqlite` | SQLite file. |
| `SCHEDULE` | from config | Cron override. |
| `OP_CONNECT_HOST` | | 1Password Connect base URL, e.g. `http://op-connect:8080`. |
| `OP_CONNECT_TOKEN_FILE` | | File containing the read-only Connect token. |
| `OP_DISABLED` | `0` | Treat config credential values as literals (smoke tests only). |
| `PUPPETEER_EXECUTABLE_PATH` | auto (image: bundled Chrome) | Chrome binary. |
| `SHOW_BROWSER` | `0` | Headed Chrome (needs a display). |
| `NOVNC_PASSWORD` | random | Assisted-login VNC password. |
| `VERBOSE` | `0` | Row-level debug logging. |
| `TZ` | `Asia/Jerusalem` | Process timezone. |

## Connecting Securo

Full walk-through with the reasoning behind each step: [docs/deploy-securo.md](docs/deploy-securo.md). In short:

1. Attach the bridge container to the network `securo-backend` and `securo-worker` are on; the bridge publishes no
   ports and Securo reaches it as `http://israeli-banks-bridge:8080`. Nothing may redirect in between.
2. On **both** backend and worker set `SIMPLEFIN_ENABLED=true` and `SUPPORTED_CURRENCIES=<default list>,ILS`
   (the default list has no ILS). `SIMPLEFIN_API_URL` is unused in 0.15 but harmless to set.
3. Before connecting, set your currency display **and** the workspace default currency to ILS; otherwise every row
   is FX-stamped in USD.
4. `bridge mint-token --label securo`, then Securo: **Accounts -> Connect bank -> SimpleFIN**, paste the token.
5. Securo creates every account as `checking`. Edit each card: type `credit_card`, statement close day `1`,
   payment due day = the company's `chargeDay`. Securo then flips the negative debt balance and buckets each
   month's purchases onto the following month's charge date.
6. Sync runs hourly via beat but only for connections older than 4 h; incremental pulls rewind 14 days, the first
   pull covers 365 days in 90-day chunks. Rotating Securo's `SECRET_KEY` expires the connection; reconnect with a
   new token.
7. Card payments: send the bank-side debit to Securo's `Transfers` category with a rule (default), or opt in to
   `synthesizePayments` after one full billing cycle so Securo pairs both sides.

Transactions discovered late, including old pending rows that become posted, are included in the next
matching sync window using their discovery timestamps. Their purchase dates and ids stay unchanged, and
consumer deduplication handles copies returned in both a historical and a recent window. Pending rows that
disappear from the latest successful scrape are no longer served.

Investment, pension and provident-fund collection is not implemented yet. The ledger and SimpleFIN payload
have holdings support for future sources; `israeli-bank-scrapers` currently supplies bank/card transactions.

## Connecting Actual Budget

[docs/deploy-actual.md](docs/deploy-actual.md). Actual's sync-server reads the SimpleFIN v1 shapes, which the
bridge emits alongside v2. Put the sync-server on the bridge's network (Actual allows private-network SimpleFIN
hosts), mint a dedicated consumer (`bridge mint-token --label actual`), and paste the token under
**Account -> Link account -> SimpleFIN**.

## Credentials and 1Password

- Bank credentials never live in `config.json`; put `op://<vault>/<item>/<field>` references there and store the
  values in 1Password. Field names inside the item are yours to choose; the reference decides.
- The bridge resolves references in-process through the [1Password Connect](https://developer.1password.com/docs/connect/)
  REST API, using the token in `OP_CONNECT_TOKEN_FILE`. Create that token with **read-only** access to just the vault
  holding the bank items. Resolved values live in memory for one run and are registered with the logger's
  redaction list.
- A `sha256` fingerprint of each company's resolved credentials is stored in the ledger. Changing the password in
  1Password changes the fingerprint, which automatically un-parks a company that was parked for
  `INVALID_PASSWORD`/`CHANGE_PASSWORD`.
- `OP_DISABLED=1` makes the bridge treat config values as literals. Use it for smoke tests only and never commit
  such a config; `config.json` and `secrets/` are git-ignored.

## Assisted login (OTP)

Some banks (Hapoalim in particular) require an SMS one-time code when a new device logs in. Headless scraping
cannot answer it, so the bridge ships `bridge login <company>`: it launches the company's Chrome profile
**visibly** under Xvfb, exposes it through noVNC on port 6080, runs the library login, and keeps the browser open
when the library gives up so you can finish the OTP by hand. When the post-login page is detected (or you press
Enter) Chrome is closed gracefully so the device-trust cookies persist in the profile.

The reference `compose.yml` runs it as a second service behind the `bootstrap` profile, on its own network, with
the port published on `127.0.0.1` only:

```sh
docker compose stop israeli-banks-bridge          # one Chrome per profile at a time
COMPANY=hapoalim docker compose --profile bootstrap run --rm israeli-banks-bridge-login
# open http://127.0.0.1:6080/vnc.html (password printed, or NOVNC_PASSWORD), type the SMS code, wait for the home page
docker compose up -d israeli-banks-bridge
docker compose exec israeli-banks-bridge bridge scrape hapoalim
```

From another machine, tunnel first: `ssh -L 6080:127.0.0.1:6080 <host>`. Repeat whenever a scrape ends in
`OTP_REQUIRED` (the bank forgot the device, or the profile was reset). Runbook:
[docs/operations.md](docs/operations.md#otp-enrolment-and-re-enrolment).

## CLI

Inside the container `bridge` wraps `node /app/dist/cli.js`; locally use `yarn cli <command>`.

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
| `bridge export [--account id] [--from] [--to]` | CSV to stdout (Securo import columns). |
| `bridge health` | Exit 0/1 for the Docker HEALTHCHECK. |
| `bridge serve` | Start the server + scheduler (same as `node dist/index.js`). |

## Health and monitoring

- `GET /healthz` (no auth) returns `200` with a JSON `HealthReport` when every enabled company is not parked and
  has a successful scrape within `staleHours`, else `503` with the same body (per-company `healthy`, `parked`,
  `lastSuccessAt`, `lastErrorType`; per-consumer `lastSeenAt` and `claimed`). A parked company therefore flips
  health immediately, not only once it goes stale.
- The image declares `HEALTHCHECK --interval=5m --timeout=20s --start-period=60s CMD bridge health`, so
  `docker ps` shows `(unhealthy)` on the same condition.
- Gatus example (Gatus must be on the same Docker network):

  ```yaml
  endpoints:
    - name: israeli-banks-bridge
      group: finance
      url: http://israeli-banks-bridge:8080/healthz
      interval: 10m
      conditions:
        - "[STATUS] == 200"
        - "[BODY].ok == true"
  ```

- `bridge status` and `bridge audit` are the manual views; `docker compose logs` has one info line per run with
  counts only.

## Development

```sh
corepack enable            # yarn 4.12 via packageManager
yarn install --immutable
yarn dev                   # tsx src/index.ts, serve + scheduler from ./config.json and ./data
yarn cli status            # any bridge command
yarn test                  # lint (xo) + typecheck (tsc) + unit tests (vitest)
yarn test:unit             # vitest only
yarn schema                # regenerate config.schema.json from src/config.ts
yarn build                 # tsc -> dist/
yarn docker:build          # local image israeli-banks-simplefin-bridge:dev
```

Node 22.22+ (`node:sqlite`), TypeScript 6, ESM with NodeNext resolution, tabs and single quotes enforced by
[xo](https://github.com/xojs/xo). Unit tests live next to their sources as `*.test.ts` or under `test/`; the
contract test in `test/` mirrors [docs/securo-simplefin-contract.md](docs/securo-simplefin-contract.md). Set
`PUPPETEER_SKIP_DOWNLOAD=1` before installing if you do not want puppeteer to fetch a Chrome for local scraping.
Releases are cut by semantic-release from conventional commits on `main`; CI builds and pushes the image to GHCR.

## Security notes

- **No published ports.** The bridge speaks plain HTTP and relies on the Docker network for isolation. Attach it
  only to the network your consumer uses; never put it behind the public reverse proxy. The assisted-login helper
  binds noVNC to `127.0.0.1` on an isolated network.
- **Consumer secrets** are generated by the bridge (URL-safe characters), stored as scrypt hashes, and returned
  in clear only in the Access URL the consumer receives at claim time. The plain secret is retained during the
  setup-token TTL so a failed connection can retry after an authenticated GET. It is erased immediately when
  the claim count is exhausted, or on startup and within one minute after expiry while serving. Revoke with
  `bridge revoke`.
- **Bank credentials** are read from 1Password Connect with a read-only token on every run and never written to
  disk by the bridge. Chrome profiles under `data/chrome/` do contain session cookies: treat `data/` as sensitive.
- **Logging**: info level carries counts and error classes only; account numbers, descriptions, amounts and
  credentials never appear at that level, resolved secrets are redacted everywhere, and bank page text is never
  forwarded in error responses. `VERBOSE=1` logs row-level detail; use it deliberately.
- **Chrome** runs as the unprivileged `pptruser` (uid 10042). `cap_add: SYS_ADMIN` is what its sandbox needs; keep
  `no-new-privileges` and do not add `--no-sandbox`.

## License

MIT, Tomer Horowitz.
