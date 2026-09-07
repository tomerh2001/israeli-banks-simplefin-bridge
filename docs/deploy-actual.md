# Connecting Actual Budget

Actual's sync-server has a built-in SimpleFIN client. It consumes the same bridge as Securo, but it reads the
**protocol v1** shapes and is stricter about a few fields. The bridge always emits the union of v1 and v2, so no
configuration is needed on the bridge side. Details are in
[securo-simplefin-contract.md](./securo-simplefin-contract.md); the short version:

| Actual expects | Bridge behaviour |
|---|---|
| no `version` query param; reads `accounts[].org.name` and the v1 `errors` array | both are emitted alongside the v2 `connections[]`/`errlist` |
| userinfo (`user:secret@`) in the Access URL | always present |
| `balance-date` on every account | always present |
| `balance` with exactly two decimals (Actual strips the `.` to get cents) | always two decimals |
| pending rows dated by `transacted_at`, booked = `!pending && posted != 0` | `posted` is 0 while pending, `transacted_at` is always set; pending rows are only served when `includePending` is on |
| `pending=1` or `balances-only=1`, repeated `account=` params | all honoured |

## Network

The sync-server container must resolve the hostname in `server.publicUrl` (default `israeli-banks-bridge`), so put
it on the bridge's Docker network the same way as Securo (see [deploy-securo.md](./deploy-securo.md), step 1).

Actual validates outbound URLs with `assertUrlAllowed`, but for SimpleFIN it calls it with
`allowPrivateNetwork: true`, so an internal hostname or RFC-1918 address is accepted. Plain `http://` is fine.
Nothing may redirect in between.

## Setup token

```sh
docker compose exec israeli-banks-bridge bridge mint-token --label actual
```

Mint a separate consumer per Actual instance rather than reusing Securo's: consumers are independent (own secret,
own revocation, own `lastSeenAt` in `bridge status`).

In Actual: **Account -> Link account -> SimpleFIN**, paste the setup token. Actual claims it once and stores the
resulting Access URL in the sync-server's secrets; you only paste a token again after resetting the SimpleFIN
credentials in Actual or revoking/rotating the consumer on the bridge (`bridge revoke --label actual`, then mint a
new one).

Actual then lists the bridge accounts; link each one to a budget account. Card accounts arrive with a negative
balance (debt); use Actual's credit-card account type.

## Sync

Actual pulls on demand (bank sync button or on open). The bridge answers from its ledger, so what Actual sees is
whatever the last scheduled scrape stored. Ids are stable, so re-syncing never duplicates rows, and Actual's own
importer dedups on `(account, id)` as well.
