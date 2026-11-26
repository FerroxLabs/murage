#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Only baseline Vitest code is overlaid; never overlay tip product files.
set -euo pipefail
W=$(git rev-parse --show-toplevel)
JOB_DIR=${MURAGE_QUAL_JOB_DIR:-$(dirname "$W")}
source "$W/scripts/safe-wipe.sh"
BASE=$(git rev-parse b4dc27ea9^{commit})
R=$(mktemp -d "$JOB_DIR/base-archive.XXXXXX")
trap 'SAFE_WIPE_WITHIN="$JOB_DIR" safe_wipe "${R:?}"' EXIT
git archive "$BASE" | tar -x -C "$R"
mkdir -p "$R/scripts/qualify-search"
tar -C "$W/scripts/qualify-search" -cf - . | tar -x -C "$R/scripts/qualify-search"
mkdir -p "$JOB_DIR/evidence/r4"; chmod a+rwx "$JOB_DIR/evidence/r4"
# Record that every production byte is the base, then run only the baseline.
git archive "$BASE" | sha256sum > "$JOB_DIR/evidence/r4/base-archive.sha256"
printf '%s\n' "$BASE" > "$JOB_DIR/evidence/r4/base-identity.txt"
LH=$(sha256sum "$R/pnpm-lock.yaml" | cut -c1-16)
NM=$(readlink -f "/root/fuigo-builds/tools/nm/$LH")/node_modules
export IT_JOB=qual-fts-amend IT_W="$R" IT_ORIG=/root/fuigo-builds/tools/it-local-generic.sh
export NETARG="--network none --memory 16g --tmpfs /data:rw,size=12g,uid=2001,gid=2001,mode=0755 -v $NM:/nm:ro -v $JOB_DIR/evidence/r4:/qual-evidence"
COPY_ENV=''
if [ "${1:-legacy}" = copy ]; then
  test -n "${MURAGE_QUAL_COPY_SOURCE:?RC copy path required}"
  NETARG="$NETARG -v $MURAGE_QUAL_COPY_SOURCE:/copy-source:ro"
  COPY_ENV='MURAGE_QUAL_COPY_SOURCE=/copy-source '
elif [ "${1:-legacy}" != legacy ]; then echo 'usage: baseline.sh legacy|copy'; exit 2; fi
# Use the same lane lock as the other launchers (baseline is one container).
mkdir -p "$JOB_DIR/locks"; exec 8>"$JOB_DIR/locks/container-1"; flock 8
while [ "$(awk '{print int($1)}' /proc/loadavg)" -gt 60 ]; do sleep 20; done
SMOKE_ENV=''; [ "${MURAGE_QUAL_SMOKE:-0}" != 1 ] || SMOKE_ENV='MURAGE_QUAL_SMOKE=1 '
env 'IT_qual-fts-amend=qual-fts-amend' /root/fuigo-builds/tools/it-remote.sh \
  "mkdir -p node_modules; for f in /nm/* /nm/.[!.]*; do case \"\$f\" in */.vite-temp|*/.vite|*/.cache) ;; *) ln -sfn \"\$f\" node_modules/\$(basename \"\$f\");; esac; done; MURAGE_QUAL_BASELINE=1 MURAGE_QUAL_BASE_SHA=$BASE MURAGE_QUAL_STORAGE=/data MURAGE_QUAL_EVIDENCE=/qual-evidence $SMOKE_ENV$COPY_ENV node node_modules/vitest/vitest.mjs run --config scripts/qualify-search/vitest.config.ts --tags-filter=qual"
