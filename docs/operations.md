# Operations runbooks

All commands assume the generic [`compose.yml`](../compose.yml) and are run from the stack directory.
`bridge` inside the container is a wrapper for `node /app/dist/cli.js`; the command table is in
[architecture.md](./architecture.md#cli-bridge).

```sh
alias bridge='docker compose exec israeli-banks-bridge bridge'
```

## First run

1. `cp config.example.json config.json` and edit: one entry per company with `op://` references, `kind`, and for
   cards `chargeDay`. Validate against `config.schema.json` (most editors do it from the `$schema` key).
2. Create a read-only 1Password Connect token with access to the vault holding the bank items and save it to
   `secrets/op-connect-token` (mode 0600). Set `OP_CONNECT_HOST` in `compose.yml`.
3. `mkdir -p data && chown 10042:999 data` (uid/gid of `pptruser` in the image). The ledger and Chrome profiles
   live here.
4. Attach the consumer's network in `compose.yml` (see [deploy-securo.md](./deploy-securo.md)).
5. `docker compose up -d`, then `docker compose logs -f israeli-banks-bridge`. The server starts immediately;
   the first scrape runs at the next cron slot. Run one now: `bridge scrape`.
6. For companies that ask for an SMS code on a new device (Hapoalim), the first scrape fails with
   `OTP_REQUIRED`/`TWO_FACTOR_RETRIEVER_MISSING`. Do the [OTP enrolment](#otp-enrolment-and-re-enrolment) once,
   then `bridge scrape <company>`.
7. `bridge status` should show every enabled company with a recent `lastSuccessAt`, and `curl
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
3. To resume immediately: `bridge scrape <company>`. If you changed nothing in 1Password (false alarm), use
   `bridge unpark <company>` first, or `bridge scrape <company> --force`.

`INVALID_PASSWORD` and `ACCOUNT_BLOCKED` park the same way. `ACCOUNT_BLOCKED` means the bank locked the login; unlock
it with the bank first, then unpark.

## OTP enrolment and re-enrolment

Device trust lives in the company's Chrome profile (`data/chrome/<company>`). Re-enrol when the bank asks for a code
again (profile deleted, cookies expired, bank policy change), which surfaces as `OTP_REQUIRED`.

```sh
docker compose stop israeli-banks-bridge                  # never run two Chromes on one profile
COMPANY=hapoalim docker compose --profile bootstrap run --rm israeli-banks-bridge-login
```

The helper prints the noVNC URL (`http://127.0.0.1:6080/vnc.html`) and password (`NOVNC_PASSWORD` or a random one).
Open it from the host (SSH port-forward `-L 6080:127.0.0.1:6080` from elsewhere), watch the automated login, type
the SMS code when the bank asks, and wait until the post-login page shows up; the helper detects it and closes Chrome
gracefully so the trust cookie is persisted. Press Enter in the terminal to close it by hand if detection does not
trigger. Then:

```sh
docker compose up -d israeli-banks-bridge
bridge scrape hapoalim
```

The helper runs on its own network with the port bound to loopback only; it never shares a network with the
consumers and is not reachable from the LAN.

## Rotating a consumer token

Consumers keep the Access URL; the setup token is single-use. To rotate the secret a consumer authenticates with:

```sh
bridge mint-token --label securo --rotate     # new secret + new claim id; old secret stops working immediately
```

Paste the new token into the consumer (Securo: connection page -> reconnect; Actual: reset SimpleFIN credentials,
then link again). To cut a consumer off for good: `bridge revoke --label <name>`; it gets `401` from then on.

Un-claimed tokens expire after `server.claimTtlMinutes`; nothing to clean up.

## Backups

State is entirely under `data/`:

| Path | Contents | Backup |
|---|---|---|
| `data/ledger.sqlite` (+ `-wal`/`-shm`) | accounts, transactions, holdings, consumers (hashed access secrets and temporary setup secrets), scrape state, anomalies | yes; this is what keeps consumer ids stable. Copy while the container is stopped, or use `sqlite3 data/ledger.sqlite ".backup /path/ledger.bak"` for a hot copy. |
| `data/chrome/<company>/` | Chrome profile with device-trust cookies | yes, unless you are happy to re-enrol OTP after a restore. Stop the container first; a profile copied mid-run is corrupt. |
| `data/screenshots/` | failure screenshots | no |
| `config.json`, `secrets/` | config and Connect token | keep with the stack, outside the image |

Restoring: stop, replace `data/`, fix ownership (`chown -R 10042:999 data`), start. A restored ledger with an older
`meta.id_scheme_version` than the running image is refused at startup; that is deliberate, see
[architecture.md](./architecture.md#id-scheme-id_scheme_version--1).

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
| `/healthz` is **503**, company **stale** | `lastErrorType`, `docker compose logs` | `TIMEOUT`/`GENERIC` back off 1 h, then 3 h, then the next slot. Run `bridge scrape <company>` to retry now; check `data/screenshots/` for what the page looked like. Raise `timeoutMinutes` for slow sites. |
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
