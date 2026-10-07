#!/usr/bin/env bash
# Builds the web UI that the isolated host serves, on the build host (Plan 1's rule:
# no vite build of the full UI on the Mac), and copies dist back.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
APP=$(cd "$HERE/../../../.." && pwd)
# shellcheck source=scripts/safe-wipe.sh
source "$APP/scripts/safe-wipe.sh"   # the only recursive delete scripts may use
HOST=build-host
LANE=/root/mb-mobile/plan2-web
ssh "$HOST" "df -h / | tail -1; mkdir -p $LANE"
rsync -a --delete --exclude node_modules --exclude .git --exclude '/dist*' --exclude apps/mobile --exclude release \
  --exclude /.planning --exclude /.superpowers --exclude /.ijfw "$APP/" "$HOST:$LANE/repo/"
# The image ships pnpm and runs as its ci user (uid 2001), so the lane is
# handed to that uid; it is scratch, under /root/mb-mobile only.
ssh "$HOST" "mkdir -p $LANE/pnpm-store && chown -R 2001:2001 $LANE/repo $LANE/pnpm-store"
ssh "$HOST" "docker run --rm -v $LANE/repo:/w -v $LANE/pnpm-store:/pnpm-store -w /w murage-ci:node24 \
  bash -c 'pnpm install --frozen-lockfile --ignore-scripts && pnpm exec vite build'"
SAFE_WIPE_WITHIN="$HERE" safe_wipe "$HERE/web-dist"
rsync -a "$HOST:$LANE/repo/dist/" "$HERE/web-dist/"
ls "$HERE/web-dist/index.html"
