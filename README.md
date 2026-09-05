# israeli-banks-simplefin-bridge

Self-hosted [SimpleFIN](https://www.simplefin.org/protocol.html) bridge for Israeli banks and credit cards.
It scrapes your accounts with [israeli-bank-scrapers](https://github.com/eshaham/israeli-bank-scrapers),
keeps a local ledger, and serves it to any SimpleFIN-capable money manager, such as
[Securo](https://usesecuro.com) or Actual Budget, on your own network. Your consumer app thinks it is talking to
the SimpleFIN Bridge; no app-side code or API tokens are needed.

Successor of [israeli-banks-sure-importer](https://github.com/tomerh2001/israeli-banks-sure-importer) and
[israeli-banks-actual-budget-importer](https://github.com/tomerh2001/israeli-banks-actual-budget-importer).

See [docs/architecture.md](docs/architecture.md) and [docs/securo-simplefin-contract.md](docs/securo-simplefin-contract.md).

_This README is completed by the ops module; the sections below are the required outline._

## Features
## Quick start (Docker)
## Configuration
## Connecting Securo
## Connecting Actual Budget
## Credentials and 1Password
## Assisted login (OTP)
## CLI
## Health and monitoring
## Development
## License
