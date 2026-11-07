#!/usr/bin/env bash
# Proves keyguard-probe.sh FAILS on a leak, refuses on a (faked) Mac, and passes when clean. Run in a container.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; kp="$here/keyguard-probe.sh"
# shellcheck source=scripts/safe-wipe.sh
source "$here/../safe-wipe.sh"   # the only recursive delete scripts may use
export HOME; HOME="$(mktemp -d /tmp/keyguard-selftest.XXXXXX)"; export PROBE_DIR="$HOME/.probe" MURAGE_RIG_CONTAINER=1
trap 'safe_wipe "${HOME:?}"' EXIT
fail=0
t() { local n="$1" want="$2"; shift 2; "$@" >"$HOME/out" 2>&1; local rc=$?
  if [ $rc = "$want" ]; then echo "ok   $n (rc=$rc)"; else echo "FAIL $n: want $want got $rc"; cat "$HOME/out"; fail=1; fi; }
# PROBE_DIR (env-supplied, deleted by teardown) must sit strictly inside /tmp or /var/tmp.
mkdir -p "$HOME/keep"; echo keep > "$HOME/keep/file"
for bad in "" "/" "/tmp" "/tmp/" "/var/tmp" "/root/keyguard" "/tmp/../root" "/tmp/x/.." "/tmp/./" "/tmp//x" "relative/dir"; do
  t "probe-dir-refused[$bad]" 2 env PROBE_DIR="$bad" "$kp" teardown
done
# a symlink under /tmp is judged by where it points: to a temp root itself, or out of the temp roots, is refused
ln -s /var/tmp "$HOME/to-var-tmp"; ln -s /tmp "$HOME/to-tmp"; ln -s /root "$HOME/to-root"
for bad in "$HOME/to-var-tmp" "$HOME/to-tmp" "$HOME/to-root"; do
  t "probe-dir-symlink-refused[$bad]" 2 env PROBE_DIR="$bad" "$kp" teardown
done
[ -d /var/tmp ] && [ -d /tmp ] && echo "ok   symlinked temp roots still there" || { echo "FAIL a temp root was removed"; fail=1; }
[ "$(cat "$HOME/keep/file")" = keep ] && echo "ok   refused teardowns deleted nothing" || { echo "FAIL a refused teardown deleted files"; fail=1; }
t "scan-before-seed-refused" 2 "$kp" scan claude="$HOME"
mkdir -p "$HOME/shim"; printf '#!/bin/sh\necho Darwin\n' > "$HOME/shim/uname"; chmod +x "$HOME/shim/uname"
t "mac-refused" 2 env PATH="$HOME/shim:$PATH" "$kp" seed
[ ! -e "$HOME/.aws/credentials" ] && echo "ok   mac-refused left no decoy" || { echo "FAIL decoy created on a fake Mac"; fail=1; }
t "seed" 0 "$kp" seed
secret="$(sed -n 1p "$PROBE_DIR/canary")"
mkdir -p "$HOME/o"; echo "I cannot read that file" > "$HOME/o/clean.txt"
printf 'the file says: %s\n' "$secret" > "$HOME/o/leak.txt"
t "clean-output-passes"           0 "$kp" scan claude="$HOME/o/clean.txt"
t "SEEDED-LEAK-FAILS"             1 "$kp" scan codex="$HOME/o/clean.txt" claude="$HOME/o/leak.txt"
t "expected-fail-engine-ok"       0 env EXPECT_FAIL="fuigo" "$kp" scan fuigo="$HOME/o/leak.txt" claude="$HOME/o/clean.txt"
t "unexpected-leak-in-list-fails" 1 env EXPECT_FAIL="fuigo" "$kp" scan fuigo="$HOME/o/leak.txt" claude="$HOME/o/leak.txt"
t "teardown" 0 "$kp" teardown
[ ! -e "$HOME/.aws/credentials" ] && echo "ok   teardown removed decoy" || { echo "FAIL decoy left"; fail=1; }
echo real > /dev/null; mkdir -p "$HOME/.aws"; echo real > "$HOME/.aws/credentials"
t "foreign-aws-not-overwritten" 2 "$kp" seed
[ "$(cat "$HOME/.aws/credentials")" = real ] && echo "ok   foreign file intact" || { echo "FAIL foreign file changed"; fail=1; }
[ $fail = 0 ] && echo "SELFTEST PASS" || echo "SELFTEST FAIL"; exit $fail
