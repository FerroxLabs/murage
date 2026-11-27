#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
set -euo pipefail
W=$(git rev-parse --show-toplevel)
JOB_DIR=${MURAGE_QUAL_JOB_DIR:-$(dirname "$W")}
source "$W/scripts/safe-wipe.sh"
MODE=${1:-red}
case "$MODE" in red|mutants) ;; *) echo 'usage: review-red.sh red|mutants'; exit 2;; esac
PRIOR=${MURAGE_QUAL_REVIEW_BASE:-da2ca6b8b23f69e2340b7a97cc7a007fa771ace3}
R=$(mktemp -d "$JOB_DIR/review-red-archive.XXXXXX")
trap 'SAFE_WIPE_WITHIN="$JOB_DIR" safe_wipe "${R:?}"' EXIT
git archive "$PRIOR" | tar -x -C "$R"
for file in review.qual.test.ts review-mutations.py vitest.config.ts; do
  cp "$W/scripts/qualify-search/$file" "$R/scripts/qualify-search/$file"
done
if [ "$MODE" = mutants ]; then
  tar -C "$W/scripts/qualify-search" -cf - . | tar -x -C "$R/scripts/qualify-search"
  cp "$W/scripts/evidence-path.mjs" "$R/scripts/evidence-path.mjs"
  cp "$W/docs/verification/search-qualification-amend.md" "$R/docs/verification/search-qualification-amend.md"
fi
LH=$(sha256sum "$R/pnpm-lock.yaml" | cut -c1-16)
NM=$(readlink -f "/root/fuigo-builds/tools/nm/$LH")/node_modules
mkdir -p "$JOB_DIR/evidence/r4" "$JOB_DIR/locks"
chmod a+rwx "$JOB_DIR/evidence/r4"
exec 8>"$JOB_DIR/locks/container-1"; flock 8
while [ "$(awk '{print int($1)}' /proc/loadavg)" -gt 60 ]; do sleep 20; done
export IT_JOB=qual-fts-amend IT_W="$R" IT_ORIG=/root/fuigo-builds/tools/it-local-generic.sh
export NETARG="--network none --memory 16g --tmpfs /data:rw,size=192m,uid=2001,gid=2001,mode=0755 -v $NM:/nm:ro -v $JOB_DIR/evidence/r4:/qual-evidence"
git archive "$PRIOR" | sha256sum > "$JOB_DIR/evidence/r4/review-$MODE-archive.sha256"
printf '%s\n' "$PRIOR" > "$JOB_DIR/evidence/r4/review-red-prior.txt"
env 'IT_qual-fts-amend=qual-fts-amend' /root/fuigo-builds/tools/it-remote.sh \
  "mkdir -p node_modules; for f in /nm/* /nm/.[!.]*; do case \"\$f\" in */.vite-temp|*/.vite|*/.cache) ;; *) ln -sfn \"\$f\" node_modules/\$(basename \"\$f\");; esac; done; MURAGE_QUAL_EVIDENCE=/qual-evidence/afix-$MODE python3 scripts/qualify-search/review-mutations.py $MODE"
