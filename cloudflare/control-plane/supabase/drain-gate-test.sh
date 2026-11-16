#!/bin/sh
# Test 37 (design r7 section 3): the drain gate arithmetic and each refusal. No database, no network.
#   docker run --rm --network none -v "$PWD":/w -v "$PWD/../src":/src:ro postgres:16-alpine sh /w/drain-gate-test.sh   (or any POSIX sh)
cd "$(dirname "$0")"
G=./onecode-drain-gate.sh; SK=${SKEW_FILE:-../src/supabase-jwt.ts}
[ -f /src/supabase-jwt.ts ] && SK=/src/supabase-jwt.ts
pass=0; failn=0
chk() { if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "ok   $1 -> $2"; else failn=$((failn+1)); echo "FAIL $1 -> got '$2' want '$3'"; fi; }
run() { sh $G --skew-file "$SK" "$@" 2>&1 | tr '\n' ' ' | sed 's/ $//'; }
echo "== 37 drain gate"
TD=1800000000
chk "good inputs: start is T_drain + 604800 + 900" "$(run --epoch-at $((TD-60)) --commit $((TD-30)) --t-drain $TD --postread ok --offset 5 | cut -d' ' -f1,2)" "START $((TD+605700))"
chk "start taken from epoch_at is refused" "$(run --epoch-at $TD --commit $((TD-30)) --t-drain $TD --postread ok --offset 5 | grep -c -F "REFUSE T_drain is not")" 1
chk "T_drain before the E1 commit is refused" "$(run --epoch-at $((TD-90)) --commit $((TD+10)) --t-drain $TD --postread ok --offset 5 | grep -c -F "REFUSE T_drain is earlier than")" 1
chk "missing post-commit read is refused" "$(run --epoch-at $((TD-60)) --commit $((TD-30)) --t-drain $TD --postread missing --offset 5 | grep -c -F "REFUSE the post-commit enforcement read i")" 1
chk "failed post-commit read is refused" "$(run --epoch-at $((TD-60)) --commit $((TD-30)) --t-drain $TD --postread failed --offset 5 | grep -c 'is failed')" 1
chk "issuer offset 61 s is refused" "$(run --epoch-at $((TD-60)) --commit $((TD-30)) --t-drain $TD --postread ok --offset 61 | grep -c -F "REFUSE issuer clock offset 61")" 1
chk "issuer offset exactly 60 s is accepted" "$(run --epoch-at $((TD-60)) --commit $((TD-30)) --t-drain $TD --postread ok --offset 60 | cut -d' ' -f1)" START
printf 'export const CLOCK_SKEW_SECONDS = 31;\n' > /tmp/skew31.ts
chk "CP CLOCK_SKEW_SECONDS above 30 is refused" "$(SK=/tmp/skew31.ts; sh $G --skew-file /tmp/skew31.ts --epoch-at $((TD-60)) --commit $((TD-30)) --t-drain $TD --postread ok --offset 5 | grep -c -F "REFUSE CP CLOCK_SKEW_SECONDS is 31, above")" 1
chk "unreadable skew constant is refused" "$(sh $G --skew-file /nonexistent --epoch-at $((TD-60)) --commit $((TD-30)) --t-drain $TD --postread ok --offset 5 | grep -c -F "REFUSE CP CLOCK_SKEW_SECONDS")" 1
chk "the real CP constant is 30 or less" "$(sed -n 's/^export const CLOCK_SKEW_SECONDS = \([0-9]*\);.*/\1/p' "$SK" | awk '{print ($1<=30)?"ok":"high"}')" ok
chk "non-numeric input is refused" "$(run --epoch-at x --commit 1 --t-drain 2 --postread ok --offset 5 | grep -c -F "REFUSE epoch_at")" 1
# Refusal includes both the machine-readable verdict and a nonzero exit; an error
# from test/date/arithmetic must never accidentally enable a flag.
refused() {
  output=$(sh "$G" --skew-file "$SK" "$@" 2>&1); rc=$?
  if [ "$rc" -ne 0 ] && printf '%s\n' "$output" | grep -q '^REFUSE ' && ! printf '%s\n' "$output" | grep -q '^START '; then
    printf ok
  else
    printf 'rc=%s output=%s' "$rc" "$output"
  fi
}
chk "missing option value has a refusal verdict" "$(refused --epoch-at 1 --commit 2 --t-drain 3 --postread ok --offset)" ok
chk "oversized timestamps cannot wrap into START" "$(refused --epoch-at 1 --commit 2 --t-drain 9223372036854775807 --postread ok --offset 5)" ok
printf 'export const CLOCK_SKEW_SECONDS = 18446744073709551616;\n' > /tmp/skew-overflow.ts
chk "oversized CP skew cannot bypass the limit" "$(SK=/tmp/skew-overflow.ts; refused --epoch-at 1 --commit 2 --t-drain 3 --postread ok --offset 5)" ok
echo "ONECODE-DRAIN-GATE: passed $pass failed $failn"
[ "$failn" = 0 ]
