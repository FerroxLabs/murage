#!/bin/bash
# Copyright 2026 Ferrox Labs
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Scale rig, container entry. Mounts: /work = tree under test, /scale-rig = these scripts (read-only),
# /scale/cache = generated data cache, /scale/data = this container's data dir, /out = results, /store = pnpm store.
# env: LABEL, SHAPE (pr|extreme), SEED, TREE_SHA, LOAD, SLOW_DISK, SCALE_SCENARIOS, BASELINE (results file in /out)
set -u
LABEL=${LABEL:?}; SHAPE=${SHAPE:-pr}; SEED=${SEED:-1}
mkdir -p /tmp/home /out; export PATH=/tools/bin:$PATH HOME=/tmp/home
cd /work
echo "STEP install $(date +%T)"
pnpm install --frozen-lockfile --prefer-offline >/out/install-$LABEL.log 2>&1 || { tail -20 /out/install-$LABEL.log; echo REALEXIT=3; exit 3; }
echo "STEP vite build $(date +%T)"
[ -d dist ] || pnpm exec vite build >/out/vite-$LABEL.log 2>&1 || { tail -20 /out/vite-$LABEL.log; echo "vite build failed: the UI scenarios will fail"; }

# generated data, cached by shape, seed, tree and generator source. The data dir always lives at the same
# absolute path (/scale/data/murage, a per-container mount) because bots.json keeps absolute workspace paths.
# the key covers the generator and the chosen shape's values (with any SCALE_* override), not the other shape
GENHASH=$( { cat /scale-rig/gen.ts; SHAPE=$SHAPE node --input-type=module -e 'const m = await import("/scale-rig/shapes.mjs"); process.stdout.write(JSON.stringify(m.shape(process.env.SHAPE)))'; } | sha256sum | cut -c1-12)
KEY="$SHAPE-s$SEED-${TREE_SHA:-unknown}-$GENHASH"
CACHE="/scale/cache/$KEY"
DATA=/scale/data/murage
export SCALE_SHAPE=$SHAPE SCALE_SEED=$SEED SCALE_LABEL=$LABEL SCALE_WORK=/work SCALE_ROOT=/scale FAKE_ACP_UNIQUE_SESSIONS=1
rm -rf -- "${DATA:?}"
if [ ! -f "$CACHE/ready" ]; then
  echo "STEP generate $KEY $(date +%T)"
  MURAGE_DATA_DIR="$DATA" node --experimental-strip-types /scale-rig/gen.ts base || { echo REALEXIT=4; exit 4; }
  echo "STEP prime $(date +%T)"
  MURAGE_DATA_DIR="$DATA" SCALE_OUT=/out node /scale-rig/rig.mjs prime || { echo REALEXIT=5; exit 5; }
  echo "STEP hot session $(date +%T)"
  MURAGE_DATA_DIR="$DATA" node --experimental-strip-types /scale-rig/gen.ts hot || { echo REALEXIT=6; exit 6; }
  MURAGE_DATA_DIR="$DATA" node --experimental-strip-types /scale-rig/gen.ts manifest | tee /out/manifest-$LABEL.txt
  if [ "${SCALE_CACHE:-1}" = 1 ]; then
    echo "STEP cache $(date +%T)"
    rm -rf -- "${CACHE:?}.tmp"; mkdir -p "$CACHE.tmp"; cp -a "$DATA" "$CACHE.tmp/data"
    cp /out/results-$LABEL-prime.json /out/manifest-$LABEL.txt "$CACHE.tmp/" 2>/dev/null || true
    rm -rf -- "${CACHE:?}"; mv "$CACHE.tmp" "$CACHE"; date +%s > "$CACHE/ready"
  fi
else
  echo "STEP cached $KEY $(date +%T)"
  cp -a "$CACHE/data" "$DATA"; cp "$CACHE/manifest-$LABEL.txt" /out/ 2>/dev/null || cp "$CACHE"/manifest-*.txt /out/ 2>/dev/null || true
fi
echo "STEP rig $(date +%T)"
MURAGE_DATA_DIR="$DATA" SCALE_OUT=/out node /scale-rig/rig.mjs run
echo "rig exit $?"
echo "STEP gate $(date +%T)"
node /scale-rig/gate.mjs /out/results-$LABEL.json --md /out/gate-$LABEL.md ${BASELINE:+--baseline /out/$BASELINE}
GATE=$?
rm -rf -- "${DATA:?}"
echo "REALEXIT=$GATE"
exit $GATE
