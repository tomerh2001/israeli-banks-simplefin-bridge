# Hachshara Best Invest

Best Invest is a separate read-only investment source. It uses its own database,
browser profile, bearer token, schedule, and OTP request allowance. Clal keeps its
existing configuration and `/investments/v1` endpoint.

## Configure

Add a `bestInvest` section to the bridge configuration:

```json
{
  "bestInvest": {
    "enabled": true,
    "readToken": "op://Home Server/Best Invest/read_token",
    "credentials": {
      "id": "op://Home Server/Best Invest/id_number",
      "phone": "op://Home Server/Best Invest/phone",
      "email": "op://Home Server/Best Invest/email"
    },
    "schedule": "30 3 * * *",
    "staleHours": 72
  }
}
```

The read token must contain at least 32 non-whitespace characters. Generate a
separate random token for each source. Secret references use the existing
1Password resolver. The customer portal uses a one-time code, not a permanent
investment account password. Existing portal registration must be completed
by the account owner before using the collector.

```sh
bridge best-invest-login --email
bridge best-invest-sync
bridge best-invest-status
```

Email login sends a code to `credentials.email` and accepts six digits through
hidden terminal input. `best-invest-login --manual-otp` selects SMS instead.
Never pass a code as an argument. Container entrypoints supply a virtual display
for login, sync, and scheduled collection.

The collector reuses a saved session until the provider expires it. A failed
login leaves previously verified balances available with `auth_required` status.
It never registers the user, updates communication preferences, deposits,
withdraws, or changes investment allocations.

## Securo connection

Configure Securo's backend **and worker** with:

```text
INVESTMENT_FEED_ENABLED=true
BEST_INVEST_FEED_URL=http://israeli-banks-bridge:8080/investments/best-invest/v1
```

Connect through Securo's investment provider using `best-invest.<readToken>`.
Securo removes the prefix and sends the actual token only to the administrator's
Best Invest URL. Keep the unprefixed Clal token and `INVESTMENT_FEED_URL` for Clal.
The bridge endpoint itself expects `Authorization: Bearer <readToken>`.

## Imported data

- Current policy value in ILS and the provider's actual valuation date.
- Investment track balances with stable source track identities and reconciled totals.
- Current-year deposit totals as provider reports.

Deposit rows do not expose verified stable transaction identities, so they are
not imported into the activity ledger. Repeated rows still contribute to the
reported total. Historical coverage remains partial. Contribution allocation
percentages and projected annual costs are not treated as cash balances or paid
fees. Missing policy data or failed reconciliation cannot replace saved values.

## Authentication and operations

The existing Google Messages receiver has isolated `/v1/best-invest` routes.
A controlled login verified the Hebrew one-time-password message and its
`@customers.hcsra.co.il` WebOTP footer. Both six-digit codes must agree, and the
actual sender must match the separate private Best Invest sender allowlist.

To enable automatic SMS, add `--best-invest-senders-file` with that private JSON
array to the existing receiver command, and set
`bestInvest.googleMessagesOtpSocket` to its private Unix socket. Use the mobile
number registered with Hachshara in `credentials.phone`. A missing sender file
keeps the Best Invest route unavailable even when Clal is connected.
`GET /v1/best-invest/healthz` verifies provider configuration and receiver
liveness without requesting an SMS or reserving the shared lease. Source control
status uses this provider health result and the independent Best Invest request
allowance to report automatic OTP readiness.

Email onboarding uses an operator-provided code; it does not grant the deployed
collector access to a Gmail connector running in another application.

Native headed Chromium controlled through CDP was needed for the authorization
server. The collector reuses the bridge's pinned Puppeteer runtime, avoiding a
second Python browser runtime. CDP listens only on a random loopback port.

The provider token lives in browser `sessionStorage`, so a Chrome profile alone
does not preserve it between processes. Only the portal's session is saved in
the dedicated `chrome/best-invest` profile and restored to the exact portal
origin. Keep that directory private. On NFSv4 datasets, explicitly apply file
permissions after creation because inherited ACLs may override creation modes.

If an interrupted process leaves `best-invest.collector-lock`, first confirm no
collector or browser still owns that profile, then remove only that stale lock.
Never share this profile with Clal or run a second Google Messages receiver on
the same pairing. The receiver keeps one global OTP lease and each collector
has its own persistent limit of two automatic requests per rolling day.
