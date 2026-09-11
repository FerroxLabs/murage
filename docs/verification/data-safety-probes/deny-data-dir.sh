#!/usr/bin/env bash
# deny-data-dir.sh <command...>
# Runs a command under a macOS seatbelt profile that denies every write
# (create, modify, unlink) under the real ~/.murage, ~/.murage-companion and
# ~/.opengrokbot of the invoking account. Everything else is allowed. A
# denied write surfaces as EPERM / "Operation not permitted" in the command's
# own output, which is both the protection and the signal.
# Used by repro.sh; also a sensible wrapper for any agent shell that runs
# tests on a machine with a live Murage (docs/verification/data-safety.md).
set -euo pipefail
acct=$(dscl . -read "/Users/$(id -un)" NFSHomeDirectory 2>/dev/null | awk '{print $2}')
acct=${acct:-$HOME}
profile=$(mktemp -t deny-data-dir).sb
{
  echo '(version 1)'
  echo '(allow default)'
  for d in "$acct/.murage" "$acct/.murage-companion" "$acct/.opengrokbot"; do
    printf '(deny file-write* (subpath "%s"))\n(deny file-write* (literal "%s"))\n' "$d" "$d"
  done
} > "$profile"
exec sandbox-exec -f "$profile" "$@"
