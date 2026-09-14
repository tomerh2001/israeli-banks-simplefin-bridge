# Manual SMS recovery and account history

Clal and Hachshara Best Invest can recover a portal session through a code entered in the consuming application's account page. This is useful when the automatic Google Messages receiver needs reauthentication. Scheduled collections continue to use their configured receiver; a manual source overrides only the explicitly requested collection.

## Control API

Use the independent investment control bearer token, never the financial-read token. All writes require the exact `X-Investment-Provider` header (`clal` or `hachshara_best_invest`). Browser-origin requests and query parameters are rejected. Securo calls these endpoints through its authenticated backend.

The base is `/investments/v1/control` for Clal and `/investments/best-invest/v1/control` for Best Invest.

| Request | Body | Success |
| --- | --- | --- |
| `GET /status` | None | Existing status plus `manualVerificationAvailable` and `recovery` |
| `POST /recovery` | `{"requestId":"<UUID>"}` | 202, `{"recovery": ...}` |
| `POST /recovery/<UUID>/code` | Exactly `{"code":"123456"}` | 202, `{"recovery": ...}` |
| `DELETE /recovery/<UUID>` | Empty or `{}` | 200, `{"recovery": ...}` |

The request ID is the challenge ID. The consumer should persist its operation ID before starting recovery and reuse that UUID for retries. Repeating it returns the previous state without starting another collection or sending another SMS. A different request cannot overlap the active collection or another in-process recovery for the same provider.

`recovery` is `null` before the first request, otherwise:

```json
{
  "challengeId": "<UUID>",
  "state": "awaiting_code",
  "expiresAt": "2026-09-15T09:03:00.000Z",
  "errorCode": null
}
```

States are `starting`, `awaiting_code`, `verifying`, `complete`, `failed`, `canceled`, and `expired`. `awaiting_code` appears only after the portal confirms its code-entry step. The challenge expires 180 seconds after starting unless a code has already been accepted. Verification and collection then retain their existing browser timeout. `complete` means recovery and a successful or partial collection completed; consult source freshness and collection status for financial completeness.

Error codes are `OTP_REQUIRED`, `COLLECTION_FAILED`, `RECOVERY_CANCELED`, `OTP_EXPIRED`, and `RECOVERY_INTERRUPTED`. No portal response, phone number, or SMS code is returned as an error. HTTP failures use `invalid_request` (400), `source_identity_mismatch`, `recovery_in_progress`, or `recovery_not_waiting` (409), `recovery_not_found` (404), `recovery_expired` (410), and `investment_control_unavailable` (503). Refresh throttling remains `refresh_rate_limited` (429 with `Retry-After`).

Codes are delivered once directly to a waiting login and are never saved, logged, or returned by status. Only request-ID tombstones and terminal sanitized status are persisted. Starting a request first saves an interrupted-outcome tombstone, so restarting the collector cannot repeat an uncertain SMS. Old tombstones are pruned after 24 hours when a new request starts. Recovery shares the existing two SMS attempts per rolling 24 hours and two control starts per rolling minute; it never resets those budgets. Polling, repeated starts, navigation, and code submission never request another SMS.

## Historical dates in the feed

For credit-card transactions, the feed recovers a date from retained scraper or archive evidence. `posted` and `transacted_at` use noon UTC on that date; `posted` remains zero for pending entries. The wire extensions are:

- `extra.transaction_date`: evidenced purchase or installment occurrence date.
- `extra.transaction_date_kind`: `purchase`, `installment_occurrence`, or `archive_purchase_or_occurrence`.
- `extra.charge_date`: the bill date, retained separately.
- `extra.source_provenance`: recognized archive origin (`actual_archive` or `sure_archive`) and its immutable `source_record_id` UUID, on both bank and card entries. Synthetic entries omit provenance. Full archived records, account references, and import decisions remain private to the ledger.

Later CAL installments are explicitly labeled occurrences because the scraper shifts their date by the installment number. Missing or malformed evidence falls back to the frozen ledger date without claiming purchase-date evidence. Ledger IDs and stored booked dates never change. Date-window filtering uses the recovered date too, so an already-posted September purchase billed in October can be imported in September. Existing late-arrival detection remains in place.

Archive billing dates require `archiveMigration.dateBasis=source_processed_date` and a valid source record date. Actual rows marked `archived_purchase_or_installment_date_charge_date_unavailable` omit `charge_date`, even when their frozen ledger date was copied from the purchase date.

Account `extra.balance_semantics` is `next_statement_debit` for CAL cards and `balance` for Hapoalim checking accounts. This prevents consumers from interpreting the next card bill as a complete card running balance.

Clal history also includes explicit dated opening and closing balances retained in annual report summaries. Report balances extend history only when the product already has an authoritative current valuation. Direct portfolio observations take precedence, and report period flows never become valuations. The feed enriches cached reports during reads without rewriting stored reports, changing the current valuation pointer, or advancing collection freshness. Report summaries retain the supporting source evidence.

## Bounded backfills

`bridge scrape <company> --backfill-from YYYY-MM-DD` revisits history for one explicit company without the incremental last-success-minus-overlap floor. It preserves the configured start-date floor, all parked/backoff/login-attempt guards, normal profile locks, and the scraper's provider retention limit. It cannot be combined with `--from`; ordinary `--from` continues to narrow an incremental request.

In the installed `israeli-bank-scrapers` 6.12.0 implementation, CAL clamps retrieval to approximately 18 months and Hapoalim to approximately one year. Older history must come from preserved exports or budget archives. The option does not clear freshness, delete rows, reset authentication counters, or change schedules.

## Image publication checks

The Puppeteer base image must match the Puppeteer version actually resolved by the scraper in `yarn.lock`. Independent base-image upgrades are disabled in Renovate. When updating the scraper, update the base image in the same change and run `yarn check:browser-base`; CI runs this before merging. The image build also checks the installed driver's exact Chrome revision against the bundled binary.

Semantic Release supplies `GIT_SHA` and `GIT_TAG` to the Docker build. The resulting application revision and version labels identify the published code, instead of inheriting Puppeteer's labels. Verify these labels and the immutable image digest before deployment.
