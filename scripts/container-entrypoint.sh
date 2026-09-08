#!/bin/sh
set -eu

# A function's positional arguments are local: inspect options without changing
# the original argument vector that is eventually passed to the command.
needs_display() {
  [ "${1:-}" = bridge ] || return 1
  shift
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --config|--data-dir|--from|--to|--label|--account)
        [ "$#" -ge 2 ] || return 1
        shift 2
        ;;
      --config=*|--data-dir=*|--from=*|--to=*|--label=*|--account=*|--verbose|--force|--rotate) shift ;;
      --) shift; break ;;
      -h|--help) return 1 ;;
      -*) return 1 ;;
      *) break ;;
    esac
  done
  case "${1:-}" in
    serve|scrape|clal-login|clal-sync|clal-renew) return 0 ;;
    *) return 1 ;;
  esac
}

# Scheduled and manual scrapes need a display when a company uses showBrowser.
# Bank assisted login manages its own display; Clal uses hidden terminal OTP
# entry and this display wrapper. Metadata commands need none.
if needs_display "$@"; then
  exec xvfb-run --auto-servernum --server-num=98 \
    --server-args='-screen 0 1280x900x24 -nolisten tcp' "$@"
fi
exec "$@"
