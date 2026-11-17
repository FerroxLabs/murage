#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# ONECODE drain gate (design CLOUD-ONE-CODE-PROOF r7 test 37). Computes the earliest instant a one-code flag may be turned on:
#   start = T_drain + 604800 + 900     (E_max 7 days, M 900 s)
# and REFUSES (exit 1, REFUSE lines, no START line) when any premise fails. Times are UTC epoch seconds. Pure arithmetic, no
# network, no database.
#   sh onecode-drain-gate.sh --epoch-at N --commit N --t-drain N --postread ok --offset S [--skew-file supabase-jwt.ts]
# --postread is the outcome of the post-commit enforcement read (ok, failed or missing); --offset is the absolute seconds between
# GoTrue's clock (Date header of GET /auth/v1/health) and Postgres clock_timestamp().
EMAX=604800; M=900
epoch_at=""; commit=""; td=""; post=missing; off=""; skewfile="$(dirname "$0")/../src/supabase-jwt.ts"
while [ $# -gt 0 ]; do
  [ $# -ge 2 ] || { echo "REFUSE missing value for $1"; exit 2; }
  case $1 in
    --epoch-at) epoch_at=$2;; --commit) commit=$2;; --t-drain) td=$2;; --postread) post=$2;; --offset) off=$2;; --skew-file) skewfile=$2;;
    *) echo "REFUSE unknown argument $1"; exit 2;;
  esac; shift 2 || { echo "REFUSE missing value"; exit 2; }
done
bad=0
refuse() { echo "REFUSE $1"; bad=1; }
isint() {
  case $1 in ''|*[!0-9]*) return 1;; esac
  # test fails for values outside the shell's integer range. Never let an
  # overflowing comparison fall through to START.
  [ "$1" -le 9223372036854775807 ] 2>/dev/null
}
for v in epoch_at commit td off; do
  eval "x=\$$v"
  if isint "$x"; then
    # Shell arithmetic can interpret leading zeroes as octal.
    x=$(printf '%s\n' "$x" | sed 's/^0*//; s/^$/0/')
    eval "$v=\$x"
  else
    refuse "$v is not a whole number of seconds in the supported integer range"
  fi
done
[ "$bad" = 0 ] || exit 1
[ "$td" -le 9223372036854170107 ] || refuse "T_drain plus the drain duration would overflow"
[ "$td" -gt "$epoch_at" ] || refuse "T_drain is not after epoch_at (a start taken from epoch_at is the r6 error)"
[ "$td" -ge "$commit" ] || refuse "T_drain is earlier than the recorded E1 commit"
[ "$post" = ok ] || refuse "the post-commit enforcement read is $post (must be ok: hook enabled with the reviewed URI, body md5, catalog read, epoch count equal to E1)"
[ "$off" -le 60 ] || refuse "issuer clock offset ${off}s exceeds 60s"
skew=$(sed -n 's/^export const CLOCK_SKEW_SECONDS = \([0-9][0-9]*\);.*/\1/p' "$skewfile" 2>/dev/null | head -1)
if [ -z "$skew" ]; then refuse "CP CLOCK_SKEW_SECONDS not readable from $skewfile"
elif ! isint "$skew" || [ "$skew" -gt 30 ]; then refuse "CP CLOCK_SKEW_SECONDS is $skew, above 30 or outside the supported integer range"; fi
[ "$bad" = 0 ] || exit 1
start=$((td + EMAX + M))
iso=$(date -u -d "@$start" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -r "$start" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null) || {
  refuse "drain start is outside the supported date range"; exit 1;
}
echo "START $start $iso"
