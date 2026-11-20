#!/bin/bash
# Mutants of the park A tests (server core). usage: mutants.sh [NAME...]; default all. Runs one container at a time; each mutant must turn the named tests red on a copy of wt.
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$here/../../../scripts/safe-wipe.sh"
L=/root/fuigo-builds/park-A; cd "${L:?}" || exit 1
mut="$L/mut"
NAMES=${@:-T4 T4c T6 T22 T23 T26 T27 T29 C5 C7}
for n in $NAMES; do
  SAFE_WIPE_WITHIN="$L" safe_wipe "${mut:?}" || exit 1; mkdir mut; (cd wt && tar --exclude=./node_modules --exclude=./.git -cf - .) | tar -xf - -C mut
  python3 $L/mut.py $n || exit 1
  ./rr.sh mut-$n $L/mut "node node_modules/vitest/vitest.mjs run server/email/restore-park-a.test.ts server/email/restore-park-crash.test.ts --reporter=default" >/dev/null
  echo "== $n: $(grep -E 'Tests ' out-mut-$n/log.txt)"; grep -E "^ +× " out-mut-$n/log.txt | cut -c1-110
done
SAFE_WIPE_WITHIN="$L" safe_wipe "${mut:?}" || exit 1
