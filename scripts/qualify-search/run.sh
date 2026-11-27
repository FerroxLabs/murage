#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
set -euo pipefail
W=$(git rev-parse --show-toplevel)
JOB_DIR=${MURAGE_QUAL_JOB_DIR:-$(dirname "$W")}
mkdir -p "$JOB_DIR/evidence/r4" "$JOB_DIR/locks"
export IT_JOB=qual-fts-amend
export IT_W="$W" IT_ORIG=/root/fuigo-builds/tools/it-local-generic.sh
LH=$(sha256sum "$W/pnpm-lock.yaml" | cut -c1-16)
NM=$(readlink -f "/root/fuigo-builds/tools/nm/$LH")/node_modules
test -d "$NM" || { echo 'shared dependencies missing for lockfile'; exit 2; }
# Preserve the caller's git configuration. This job never changes HOME/config.
while [ "$(awk '{print int($1)}' /proc/loadavg)" -gt 60 ]; do sleep 20; done
slot() {
  while :; do
    exec 8>"$JOB_DIR/locks/container-1"; flock -n 8 && return
    exec 8>&-
    exec 8>"$JOB_DIR/locks/container-2"; flock -n 8 && return
    exec 8>&-; sleep 5
  done
}
# Shell words passed to it-remote are fixed here; caller data paths are mounted
# by Docker and never interpolated into a command evaluated in the container.
inside() {
  local size=$1 cmd=$2
  slot
  while [ "$(awk '{print int($1)}' /proc/loadavg)" -gt 60 ]; do sleep 20; done
  # Extra tmpfs/memory mounts make it-remote select its authorized local
  # generic fallback. It still owns the UID, image, network and cleanup.
  export NETARG="--network none --memory 16g --tmpfs /data:rw,size=$size,uid=2001,gid=2001,mode=0755 -v $NM:/nm:ro -v $JOB_DIR/evidence/r4:/qual-evidence ${QUAL_EXTRA_MOUNTS:-}"
  chmod a+rwx "$JOB_DIR/evidence/r4"
  local pre='mkdir -p node_modules; for f in /nm/* /nm/.[!.]*; do case "$f" in */.vite-temp|*/.vite|*/.cache) ;; *) ln -sfn "$f" node_modules/$(basename "$f");; esac; done; '
  local rc=0
  env 'IT_qual-fts-amend=qual-fts-amend' /root/fuigo-builds/tools/it-remote.sh "$pre$cmd" || rc=$?
  flock -u 8; exec 8>&-
  return "$rc"
}
VT='node node_modules/vitest/vitest.mjs run --config scripts/qualify-search/vitest.config.ts --tags-filter=qual'
case "${1:-smoke}" in
  inventory)
    inside 192m 'node scripts/qualify-search/english-inventory.mjs'
    ;;
  mutations)
    bash scripts/qualify-search/review-red.sh mutants
    ;;
  review)
    inside 192m "MURAGE_QUAL_STORAGE=/data MURAGE_QUAL_SMOKE=1 MURAGE_QUAL=review MURAGE_QUAL_FAIL_BAR=integrity $VT --reporter=json --outputFile=/qual-evidence/review.json"
    ;;
  check-harness)
    inside 192m 'node node_modules/typescript/bin/tsc -p scripts/qualify-search/tsconfig.json'
    ;;
  typecheck)
    inside 192m 'pnpm typecheck && node node_modules/typescript/bin/tsc -p scripts/qualify-search/tsconfig.json'
    ;;
  smoke|smoke-1m|smoke-rig|smoke-diskfull|smoke-copy)
    # Every negative must fail at the named bar, and leave an actual report;
    # a TypeError, exhausted fixture disk, or a setup failure cannot count.
    specs='q1-103k:main-fts q2-diskfull:integrity q3-copy:parity rig-smoke:new-fails'
    [ "${1:-smoke}" != smoke-1m ] || specs='q1-1m:main-fts'
    [ "${1:-smoke}" != smoke-copy ] || specs='q3-copy:parity'
    [ "${1:-smoke}" != smoke-rig ] || specs='rig-smoke:new-fails'
    [ "${1:-smoke}" != smoke-diskfull ] || specs='q2-diskfull:integrity'
    for spec in $specs; do
      leg=${spec%:*}; bar=${spec#*:}
      for variant in pass fail; do
        relative=smoke/$leg-$variant
        mkdir -p "$JOB_DIR/evidence/r4/$relative"; chmod a+rwx "$JOB_DIR/evidence/r4/$relative"
        for artifact in "$leg.json" "$leg-bound.json" vitest.json; do
          target="$JOB_DIR/evidence/r4/$relative/$artifact"; rm -f "${target:?}"
        done
        injection=''; [ "$variant" = pass ] || injection="MURAGE_QUAL_FAIL_BAR=$bar "
        rc=0
        inside 192m "MURAGE_QUAL_STORAGE=/data MURAGE_QUAL_SMOKE=1 MURAGE_QUAL=$leg MURAGE_QUAL_EVIDENCE=/qual-evidence/$relative $injection$VT --reporter=json --outputFile=/qual-evidence/$relative/vitest.json" > "$JOB_DIR/evidence/r4/$leg-$variant.log" 2>&1 || rc=$?
        if [ "$variant" = fail ] && [ "$rc" = 0 ]; then
          echo "negative unexpectedly passed: $leg"; exit 1
        fi
        python3 scripts/qualify-search/check-smoke.py "$JOB_DIR/evidence/r4/$relative" "$leg" "$variant" "$bar"
        echo "smoke $leg $variant: expected result observed"
      done
    done
    ;;
  q1)
    test -f "$JOB_DIR/evidence/r4/q1-legacy.json" || { echo 'run baseline.sh legacy first'; exit 2; }
    # Exactly two legs/containers; no rig or disk-full in this interval.
    inside 12g "MURAGE_QUAL_STORAGE=/data MURAGE_QUAL=q1-103k MURAGE_QUAL_EVIDENCE=/qual-evidence MURAGE_QUAL_LEGACY_REPORT=/qual-evidence/q1-legacy.json $VT" > "$JOB_DIR/evidence/r4/q1-103k.log" 2>&1 & one=$!
    inside 12g "MURAGE_QUAL_STORAGE=/data MURAGE_QUAL=q1-1m MURAGE_QUAL_EVIDENCE=/qual-evidence MURAGE_QUAL_LEGACY_REPORT=/qual-evidence/q1-legacy.json $VT" > "$JOB_DIR/evidence/r4/q1-1m.log" 2>&1 & two=$!
    rc=0; wait "$one" || rc=1; wait "$two" || rc=1
    inside 192m 'node scripts/qualify-search/compare.mjs /qual-evidence' || rc=1
    exit "$rc"
    ;;
  q2-diskfull)
    inside 192m "MURAGE_QUAL_STORAGE=/data MURAGE_QUAL=q2-diskfull MURAGE_QUAL_EVIDENCE=/qual-evidence $VT"
    ;;
  q3-bound-1k)
    inside 192m "MURAGE_QUAL_STORAGE=/data MURAGE_QUAL=q3-bound-1k MURAGE_QUAL_EVIDENCE=/qual-evidence $VT"
    ;;
  q3-copy)
    source=${MURAGE_QUAL_COPY_SOURCE:?RC copy path required}
    private=${MURAGE_QUAL_PRIVATE_CASES:?four-case manifest required}
    case "$source$private" in *[[:space:],:]* ) echo 'mount paths must have no whitespace, comma or colon'; exit 2;; esac
    test -d "$source"; test -f "$private"
    test -f "$JOB_DIR/evidence/r4/q3-base.json"; test -f "$JOB_DIR/evidence/r4/q3-1k-bound.json"
    # inside() appends only these fixed read-only copy-gate mounts.
    QUAL_EXTRA_MOUNTS="-v $source:/copy-source:ro -v $private:/qual-private.json:ro"
    inside 12g "MURAGE_QUAL_STORAGE=/data MURAGE_QUAL=q3-copy MURAGE_QUAL_EVIDENCE=/qual-evidence MURAGE_QUAL_COPY_SOURCE=/copy-source MURAGE_QUAL_COPY_REFERENCE=/qual-evidence/q3-base.json MURAGE_QUAL_1K_BOUND=/qual-evidence/q3-1k-bound.json MURAGE_QUAL_PRIVATE_CASES=/qual-private.json $VT"
    ;;
  *) echo 'usage: run.sh smoke|typecheck|q1|q2-diskfull|q3-bound-1k|q3-copy'; exit 2;;
esac
