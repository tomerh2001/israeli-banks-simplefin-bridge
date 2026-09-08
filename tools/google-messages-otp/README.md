# Google Messages receiver for investment OTPs

This separate Go executable uses the Google Messages protocol library
[`libgm` v0.2608.0](https://github.com/mautrix/gmessages/tree/v0.2608.0/pkg/libgm)
by Tulir Asokan and contributors. It creates no Matrix mirror and performs no
message backfill, contact enumeration, outgoing SMS, read receipts or deletion.
Google Messages still delivers its event stream to the paired device; unrelated
events are discarded in memory. Library logging is disabled because upstream
diagnostic paths can contain decrypted messages or authentication responses.

The executable and its source directory are licensed under AGPL-3.0-only; see
[LICENSE](LICENSE). The surrounding TypeScript application retains its own
license. The receiver imports the standalone protocol package, not the Matrix
connector. Build with Go 1.26.6:

```sh
go test -race ./...
go vet ./...
go build -o google-messages-otp .
```

## Pairing

Use a dedicated directory owned by the service user, mode 0700. Credential files
must be regular files with mode 0600. Do not save them in this repository.

```sh
google-messages-otp pair \
  --cookies-file /state/cookies.json \
  --session-file /state/session.json \
  --expected-account user@example.com
```

`cookies.json` is a Google authentication cookie name/value object. Required
names are `SID`, `HSID`, `SSID`, `OSID`, `APISID` and `SAPISID`; upstream also
documents `__Secure-1PSIDTS` for some accounts. The helper verifies the account
email returned by Google's configuration endpoint before starting pairing.
The only pairing output is an emoji and state. Tap that emoji on the phone.
The phone must have Google Messages account pairing enabled and remain online.
QR pairing is discontinued upstream.

Successful pairing atomically writes the complete `libgm.AuthData` session.
The command refuses to replace an existing session. The receiver saves refreshed
authentication state and checkpoints on orderly shutdown. A per-session OS
file lock prevents concurrent pairing/receiving processes from using the keys.
Google may require fresh Google authentication later; the helper reports an
unavailable state and never attempts Google login itself.

## Receiver

`clal-senders.json` is a private JSON array of exact actual SMS sender addresses,
verified using a controlled Clal login. Display names/contact names are not
sender identities. There is no permissive default or automatic enrollment.

```sh
google-messages-otp serve \
  --session-file /state/session.json \
  --socket /state/receiver.sock \
  --senders-file /state/clal-senders.json
google-messages-otp health --socket /state/receiver.sock
```

Only the mode 0600 Unix socket exposes the API. There is no TCP listener, shared
bearer credential or public route. The health command returns success only when
the receiver is ready.

| Request | Result |
| --- | --- |
| `POST /v1/clal/arm` with `{}` | 201: `requestId`, `armedAt`, `expiresAt` |
| `POST /v1/clal/{requestId}/wait` with `{}` | Up to 20 seconds: 200 with `requestId`, `code`, `expiresAt`, or 202 pending |
| `DELETE /v1/clal/{requestId}` | 204, idempotent cancellation |
| `GET /healthz` | `online` and sanitized `state` |

The caller arms immediately before its single Clal SMS request. The receiver
owns the 180-second lifetime and permits one lease at a time. A delivered lease
remains reserved until cancellation/deadline; the code cannot be fetched twice.
410 means expired/consumed/cancelled, 409 means an active lease or ambiguous
messages, and 503 means unavailable. Caller-supplied dates, senders, providers,
query parameters and additional JSON fields are rejected.

Only incoming SMS events qualify. The source timestamp must be present, no
earlier than arming and at most one second ahead of the receiver clock. Old
replayed events are rejected. The actual sender must match the configured
allowlist. Both the Hebrew OTP sentence and exact final
`@www.clalbit.co.il #NNNNNN` line must contain the same six ASCII digits.
Where the event omits the sender, the helper requests only that candidate's
conversation metadata and resolves its participant identity. It fetches no
message history or media. Multiple matching message identities make the lease
ambiguous; the receiver does not choose the latest code.

OTPs and SMS bodies remain in memory. A bounded seven-day list of consumed
message-ID hashes is atomically persisted before a code is delivered. Leases
are never persisted, and disconnects invalidate them. No SMS mechanism can
cryptographically distinguish this login's code from a simultaneous external
Clal login, so the bridge must also hold its Clal profile lock throughout login.


## Additional investment providers

Best Invest has separate routes:
`POST /v1/best-invest/arm`,
`POST /v1/best-invest/{requestId}/wait`, and
`DELETE /v1/best-invest/{requestId}`.
Their response formats match the Clal routes.

An optional `--best-invest-senders-file /state/best-invest-senders.json` supplies
a private JSON array of exact sender addresses verified through a controlled
Best Invest login. It is separate from the required Clal sender file. Missing,
invalid or unverified sender configuration cannot fall back to Clal matching.

Provider availability additionally requires a verified exact SMS template.
Until a controlled Best Invest SMS supplies that evidence, the Best Invest
matcher remains disabled in source and its routes return 503, even when the
sender file is supplied. Synthetic test templates are never installed in the
running receiver.

There is one global lease across providers. A Best Invest lease prevents a
simultaneous Clal arm and vice versa. The active lease selects the only template
and exact sender set eligible for matching or conversation lookup. Waiting on
another provider's lease returns 410; cancellation through another provider's
route has no effect. The global consumed-message hashes also prevent a source
message from being delivered again through another provider.

Clal's existing flags, routes, template and pairing process remain unchanged.
The health endpoint describes the shared connection; callers must successfully
arm their own provider before requesting an SMS.

## Verified upstream entry points

- [`pair_google.go`](https://github.com/mautrix/gmessages/blob/v0.2608.0/pkg/libgm/pair_google.go): `StartGaiaPairing`, `FinishGaiaPairing`.
- [`client.go`](https://github.com/mautrix/gmessages/blob/v0.2608.0/pkg/libgm/client.go): `AuthData`, `NewClient`, `Connect`, cookie refresh.
- [`event_handler.go`](https://github.com/mautrix/gmessages/blob/v0.2608.0/pkg/libgm/event_handler.go): `WrappedMessage` and old-event flag.
- [`conversations.proto`](https://github.com/mautrix/gmessages/blob/v0.2608.0/pkg/libgm/gmproto/conversations.proto): incoming status, sender identity and message contents.
- [`handlegmessages.go`](https://github.com/mautrix/gmessages/blob/v0.2608.0/pkg/connector/handlegmessages.go): timestamp conversion uses `time.UnixMicro`.

The upstream `gmtest` example handles bare `gmproto.Message` and `ClientReady`,
but current normal delivery uses `libgm.WrappedMessage` and a live
`UserAlertEvent` with `BROWSER_ACTIVE`. Do not copy those outdated example
branches into this receiver.
