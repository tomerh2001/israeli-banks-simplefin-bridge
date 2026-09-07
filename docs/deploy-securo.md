# Connecting Securo

Step-by-step instructions for pointing a self-hosted [Securo](https://usesecuro.com) (verified on 0.15.1) at this bridge.
The wire contract behind every step is in [securo-simplefin-contract.md](./securo-simplefin-contract.md); line
references below are to the Securo backend source at that version.

## Host audit: 2026-09-07

Read-only inspection found Securo 0.15.1, image revision
`6c8c6d2f8dd9f5aa498a6eab74b39077fb089d80`. Both backend and worker already have
`SIMPLEFIN_ENABLED=true`, `SIMPLEFIN_API_URL=http://israeli-banks-bridge:8080`, and ILS in
`SUPPORTED_CURRENCIES`. User display currency and workspace default currency are ILS.
Native OIDC remains enabled with local authentication disabled; this integration needs no auth-route exception.

There were no bridge containers, bank connections, or imported transactions at audit time. One existing manual
USD checking account was present. Preserve it: SimpleFIN creates separate connected accounts and does not offer a
link-to-existing-account step. Deployment, current bank/card credentials, successful initial scrapes, and the first
Securo connection remain necessary before automatic importing can be verified. The audit made no bank login or
sync calls; do not treat saved credentials as tested.

Staged configuration on the same date uses Bank Hapoalim and CAL (`hapoalim`, `visaCal`), both explicitly
`enabled: false` pending current credentials. The available 1Password Connect token exposes the Home Server
vault, which had no usable bank login entries; the config's bank item references are placeholders to fill before
enabling a company. The planned schedule is 06:00 and 18:00 Asia/Jerusalem, with at most two login attempts per
company per day. Hapoalim is restricted to the legacy checking-account selector, excluding its investment
account for this first phase. CAL uses charge dates; pending transactions and synthetic payments are disabled.

The staged Compose mounts configuration at `/app/config.json`, persistent data at `/app/data`, and the Connect
token read-only. It uses `traefik_proxy` with `traefik.enable=false`. The Connect API is reachable from this
network at its existing host-gateway binding, `http://172.16.1.1:8088`; the LAN address has no listener on that
port. No extra network or public route was added.

### Deployment verification, 2026-09-07

[Release v1.0.0](https://github.com/tomerh2001/israeli-banks-simplefin-bridge/releases/tag/v1.0.0) was built by
[CI](https://github.com/tomerh2001/israeli-banks-simplefin-bridge/actions/runs/34156997467) from merged source
`be0c0827def2eed3360586b2fdfcd01c8e8dc46c` and deployed using the moving `latest` tag. Resolved image digest:
`sha256:c7e910eb34d5b31304d1419e0f2791764afc0bda725338cb6ac8d99d02ddb9c8`.

- All 190 offline tests, lint, typecheck, schema consistency and production build passed.
- Both `securo-backend` and `securo-worker` read `/simplefin/info` successfully (HTTP 200).
- Unauthenticated `/simplefin/accounts` returned 403; `/healthz` returned 503 with both companies disabled.
- The bridge resolved its read-only, mode-0600 Connect token and received HTTP 200 from `/v1/vaults`.
- The ledger contained zero runs, source states, accounts, transactions and consumers. No bank login or import ran.
- The container had no published ports or public router. Key compiled modules matched the locally verified build.

The container remains **paused pending current credentials**, and Securo has no bridge connection yet. Its
freshness healthcheck intentionally remains unsuccessful in this state. Before activation, resolve the actual
1Password item references, stop the serving container while performing a manual initial scrape, and enable one
provider at a time. Do not claim successful bank synchronization until real results have been checked and the
Securo connection has been created.

The image currently inherits Puppeteer OCI labels; those labels identify its base, not the bridge revision.
Use the release/run, resolved digest and compiled-source comparison for this deployment's provenance. Outline
was excluded from service startup and unavailable during this run, so these project notes are the durable record.

## 1. Network: put the bridge where Securo can see it

Securo's backend (claim + manual sync) **and** its worker (scheduled sync) both call the bridge over plain HTTP by
container name. The bridge publishes no ports; attach it to the network the Securo containers use instead.

```yaml
# compose.yml of the bridge stack
services:
  israeli-banks-bridge:
    # No published ports or Traefik router. Uses the one shared external network.
    networks: [default]
networks:
  default:
    name: traefik_proxy
    external: true
```

Check from the Securo side before going further:

```sh
docker exec securo-backend python -c 'import urllib.request; print(urllib.request.urlopen("http://israeli-banks-bridge:8080/simplefin/info", timeout=5).read().decode())'
docker exec securo-worker python -c 'import urllib.request; print(urllib.request.urlopen("http://israeli-banks-bridge:8080/simplefin/info", timeout=5).read().decode())'
```

These metadata requests read only the bridge and never trigger a bank scrape. They should return
`{"versions":["1","2"]}`. Check `/healthz` separately for data freshness; it returns 503 until every enabled
company has a recent successful scrape, so an unseeded bridge can be reachable while its health check fails.

The hostname must match `server.publicUrl` in the bridge `config.json` (default `http://israeli-banks-bridge:8080`),
because that is the host embedded in setup tokens and Access URLs. Nothing may sit in between that redirects:
Securo never follows 3xx.

## 2. Securo environment

Set these on **both** `securo-backend` and `securo-worker` (beat only schedules, it makes no HTTP calls):

| Variable | Value | Why |
|---|---|---|
| `SIMPLEFIN_ENABLED` | `true` | The only switch that registers the provider (`core/config.py:47`, `providers/__init__.py`). If only the backend has it, connecting works but every scheduled sync logs `ProviderNotConfiguredError` and is skipped. |
| `SUPPORTED_CURRENCIES` | default list **plus `ILS`** | Comma-separated; the default (`core/config.py:69`) is `USD,EUR,GBP,BRL,CAD,AUD,CHF,ARS,JPY,MXN,INR,SEK,DKK,NOK,PLN,CZK,HUF,RON,CRC,IDR,COP,CLP,DOP,RUB,GTQ,PHP,UAH,NZD,VND,SGD,AZN,TRY` and does not contain ILS. FX rates are only stored for listed currencies and the currency picker only offers listed ones, so append `,ILS`. |
| `SIMPLEFIN_API_URL` | `http://israeli-banks-bridge:8080` (optional) | Defined but not used by the provider in 0.15.1; the bridge host comes from the pasted token. |

Restart backend and worker after changing them. The audited host already has these values; no restart is needed
merely to recheck them.

## 3. Currency settings, before connecting

Every synced transaction is stamped with an amount in the **user's primary currency** at connect time
(`connection_service.py` reads `user.primary_currency`, which is the `currency_display` preference, falling back to
`DEFAULT_CURRENCY=USD`). Do this first, or every ILS row gets FX-converted into USD:

1. Profile / preferences: set **currency display** to `ILS`.
2. Workspace settings: set the workspace **default currency** to `ILS`.

The bridge itself always emits `currency: "ILS"` (or the account's real currency) on accounts and transactions.

## 4. Mint a setup token and connect

On the bridge host:

```sh
docker compose exec israeli-banks-bridge bridge mint-token --label securo
```

It prints a base64 setup token. Treat it as a credential and keep it out of shared logs and committed files.
The token is valid for `server.claimTtlMinutes` (default 15) and can be claimed at most `server.maxClaims` times
(default 3). It remains retryable within both limits even after an authenticated `/accounts` GET, because Securo
can still roll back its connect request during the subsequent backfill. A closed claim cannot be reused; the
already-claimed Access URL remains valid until its consumer is rotated or revoked.
The temporary plaintext setup secret is wiped on the last allowed claim; a startup and 60-second sweep removes
expired claim secrets even when the token is never used.

In Securo: **Accounts -> Connect bank -> SimpleFIN**, paste the token, confirm. Ignore the dialog's
"Generate token at SimpleFIN Bridge" link; it points at bridge.simplefin.org.

The initial connect request runs synchronously: claim, account list, a 365-day backfill of every account in five
chunks, and holdings when enabled. A nominal 90-day chunk uses an inclusive end, represented as an exclusive
bound one day later, so each full request spans 91 days. The bridge serves its local ledger, but end-to-end connect
duration remains unverified until the first real import. If it fails, fix the cause and retry within the token's
remaining claim/TTL limits, or mint a fresh token.

One token spans every enabled company (`connections[]` carries one entry per company). Securo uses the first
company for the connection identity/name and attaches institution metadata to each account. Keep company order
stable when reconnecting. Mint one token per consumer, not per bank; separate tokens do not filter companies.

The API used by the dialog is authenticated `POST /api/connections/oauth/callback` with
`{"provider":"simplefin","code":"<setup token>","sync_assets":false}`. Keep `sync_assets` off while this deployment
only covers bank and card accounts. The route requires the signed-in user's writable workspace context.

## 5. Retype credit cards

Securo types every SimpleFIN account `checking` and stores the balance raw. The bridge emits card balances as
**negative** numbers (debt) per the SimpleFIN convention, so a card first shows up as an overdrawn checking
account. For each card account, edit it in Securo:

| Field | Value | Why |
|---|---|---|
| Type | `credit_card` | From then on Securo negates the incoming SimpleFIN balance (`account_service._simplefin_to_internal_balance`) so debt is positive, the way its other providers report it, and the opening-balance reconciliation re-targets the new sign. |
| Statement close day | unset until verified | Use the actual card cycle only if it maps correctly to Securo's cycle calculation. |
| Payment due day | unset until verified | Do not infer it from a generic Israeli billing convention. |

If the scraper does not report a balance, the feed contains `0.00` and an `act.balance_unavailable` warning.
That value is a placeholder. Do not treat it as a verified zero balance when checking account reconciliation.

### Preserve actual card dates

Securo's cash-flow date for a card purchase is `credit_card_service.compute_effective_date(tx_date, close_day, due_day)`:

1. find the first close day **strictly after** `tx_date` (a purchase on the close day itself belongs to the next cycle);
2. return the first `payment_due_day` strictly after that close.

That model is not proof of an Israeli issuer's billing cycle. Statement boundaries, installment charge dates,
weekends, and issuer processing can differ. Never enter an invented close/due day to force a preferred result.

For cash-flow reporting, select the company's `dateMode: "charge"` **before the first import**, validate that the
scraper's `processedDate` is the actual charge date, and leave both Securo cycle fields unset. The bridge falls
back to the purchase date when `processedDate` is absent. For purchase-date reporting, use `dateMode: "purchase"`;
only fill Securo's cycle fields after comparing its computed dates with an actual statement.

The SimpleFIN feed uses the chosen booking date for both `posted` and `transacted_at`, with `extra.charge_date`
when available. It does not currently expose a separate purchase-date field in charge mode. Changing `dateMode`
later does not rewrite frozen ledger rows or transactions Securo has already imported.

## 6. What sync looks like

- Celery beat runs the SimpleFIN sync task every hour; it only touches connections with status `active` or
  `error` whose `last_sync_at` is older than 4 hours (or null). Effective cadence: every 4-5 h, plus manual syncs
  from the connection page (`POST /api/connections/{id}/sync`).
- Each sync: 1 GET for the account list, 1 GET per account for the last 14 days (`last_sync_at - 14d .. today`),
  1 GET for holdings while `sync_assets` is on (default), and 1 GET for the logo until the institution has one.
- Initial connect pulls 365 days per account. Reconnect saves refreshed credentials; the next sync performs
  the full backfill.
- Bridge scrapes are independent (default `0 6,18 * * *`); Securo picks up whatever the ledger holds. New rows
  therefore normally appear in Securo within the next 4-5 h after the bridge scraped them. A manual Securo sync
  reads the current ledger; SimpleFIN does not trigger a fresh bank scrape.
- A row first discovered or first observed changing from pending to posted inside the requested time window is
  served even if its booking date is older than the lower bound. This catches late postings beyond Securo's
  14-day rewind, including a hold that posts weeks after it was first seen. The exclusive upper booking-date bound
  still applies, so future-dated installments are withheld until due. Stable IDs allow repeated delivery.
- Securo does not overwrite amount, date, or description when importing an already-known ID, and disappearing
  upstream rows are not automatically deleted. The bridge freezes those fields per ID; a conflicting same-ID
  update records an anomaly (`bridge audit`). Its IDs also hash transaction fields, so an upstream correction or
  a later `dateMode` change can instead create a new ID and a duplicate requiring review. This is not a general
  upstream correction/reversal reconciliation mechanism.
- Pending rows are not served unless `includePending` is on for the company (their ids are unstable for several
  issuers, which would create duplicates in Securo). When enabled, a pending row is served only while the latest
  account scrape still reports it. Removing it from the feed cannot remove a pending row already imported into
  Securo, so posted-only remains the default.
- Bank credential/MFA failures park the affected company and surface `con.failed`, not a SimpleFIN auth error.
  Securo can keep reading cached accounts from the other companies. Check `bridge status` and `/healthz`: a
  successful Securo sync does not prove the underlying bank data is fresh. Fixing bank credentials does not
  require rotating the Securo consumer token.

## 7. Reconnect, expiry, `SECRET_KEY` rotation

Securo stores the Access URL encrypted with its `SECRET_KEY`. Rotating `SECRET_KEY` makes every SimpleFIN
connection undecryptable: the next sync raises `SessionExpiredError`, the connection flips to status `expired`,
and it drops out of scheduled sync (only `active`/`error` are picked up) until a user reconnects it.

To reconnect: mint a fresh token for the same consumer (`bridge mint-token --label securo --rotate`, which also
rotates the consumer's secret) and paste it into the **existing connection's** reconnect banner. Its request
includes `reconnect_connection_id`; using the new-connection dialog again creates a second account tree.
Reconnecting resets `last_sync_at`; the next manual or scheduled sync re-pulls 365 days. Stable IDs deduplicate
unchanged transactions within that existing link.

The same banner appears when the bridge answers `401`/`403` (consumer revoked with `bridge revoke`, or rotated
secret) or returns an `errlist` entry with code `con.auth`/`gen.auth`.

Keep the Securo `SECRET_KEY` stable; treat a rotation as a planned reconnect of every SimpleFIN link.

## 8. Modelling card payments

The bank account records card repayments (e.g. `ויזה כאל`), while the card account holds the individual purchases.
Counting both as expenses double-counts spending. Two ways to handle it:

**Default: mark the bank-side debit as a transfer.** Securo's built-in `Transfers` category has
`treat_as_transfer = true`, which removes its rows from spending reports and the dashboard. Create a rule
(Settings -> Rules) matching the bank debit's description or payee and assigning it to `Transfers`. This is enough
when the card side is what you budget against, and it needs nothing from the bridge.

**Opt-in: synthetic payments.** Set `synthesizePayments: true` and `chargeDay` on the card company in the bridge
config. The bridge then emits one positive row per charge date on the card account
(`<company>:<account>:payment:<chargeDate>`, offsetting the purchases charged on that date) so Securo's transfer detection
can pair it with the bank debit: it pairs an unpaired debit and credit in different accounts with the same absolute
amount within +-2 days and links them, at which point neither counts as spend or income. Enable this only after the
ledger has been reconciled to at least one **full** billing statement. The earliest-row guard can reject an
obviously partial first cycle, but it cannot prove complete statement coverage or exclude fees/refunds handled
elsewhere. An incomplete synthetic credit may not match the real bank debit. Its amount freezes when inserted in
the bridge ledger, before it is served. Keep this option disabled for the initial deployment.

Do not do both: a bank debit categorised as a transfer *and* paired is harmless, but a synthetic credit with no
pair shows up as card income.

## 9. Checklist

- [ ] bridge and Securo containers share a network; metadata reads from backend and worker work
- [ ] `SIMPLEFIN_ENABLED=true` and `SUPPORTED_CURRENCIES=...,ILS` on backend and worker
- [ ] current bank/card credentials resolved; company deliberately enabled after configuration review
- [ ] user currency display = ILS, workspace default currency = ILS
- [ ] `bridge status` shows a successful scrape for every enabled company
- [ ] token minted, connection created, accounts visible
- [ ] existing manual accounts preserved; incoming accounts and currencies checked
- [ ] cards retyped to `credit_card`; date mode and any cycle fields validated against actual statements
- [ ] rule sending the bank-side card debit to `Transfers`
- [ ] Gatus (or similar) polling `http://israeli-banks-bridge:8080/healthz`
