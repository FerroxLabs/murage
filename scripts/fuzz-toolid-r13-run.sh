#!/bin/bash
set -u
mkdir -p evidence/bld4-toolid-s4a
python3 scripts/fuzz-toolid-r13.py --inputs 1000000 --benign 50000 --seed 130019 --out evidence/bld4-toolid-s4a/fuzz-a.json > evidence/bld4-toolid-s4a/fuzz-a.log 2>&1 &
fuzz_a_pid=$!
python3 scripts/fuzz-toolid-r13.py --inputs 1000000 --benign 50000 --seed 130020 --out evidence/bld4-toolid-s4a/fuzz-b.json > evidence/bld4-toolid-s4a/fuzz-b.log 2>&1 &
fuzz_b_pid=$!
wait "$fuzz_a_pid"; fuzz_a_rc=$?
wait "$fuzz_b_pid"; fuzz_b_rc=$?
python3 scripts/summarize-toolid-r13-fuzz.py --out evidence/bld4-toolid-s4a/fuzz-total.json evidence/bld4-toolid-s4a/fuzz-a.json evidence/bld4-toolid-s4a/fuzz-b.json
fuzz_total_rc=$?
[ "$fuzz_a_rc" -eq 0 ] && [ "$fuzz_b_rc" -eq 0 ] && [ "$fuzz_total_rc" -eq 0 ]
