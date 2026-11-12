#!/usr/bin/env bash
# Run the Linux Cloud home Node suite with the same prerequisites as CI.
set -euo pipefail

group=${1:---all}
if (( $# > 1 )) || [[ "$group" != --all && "$group" != --ordinary && "$group" != --app-health ]]; then
  printf 'Usage: %s [--all|--ordinary|--app-health]\n' "$0" >&2
  exit 2
fi

repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
image=${MURAGE_HOME_TEST_IMAGE:-node:24-bookworm}
scratch=$(mktemp -d "${TMPDIR:-/tmp}/murage-home-tests.XXXXXX")
container=
cleanup() {
  if [[ -n "$container" ]] && docker container inspect "$container" > /dev/null 2>&1; then
    docker stop "$container" > /dev/null
  fi
  rm -rf -- "${scratch:?}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cd -- "$repo"
# This step only reads the cache and shared pins. Stage it explicitly before
# starting an offline run; missing or changed tools stop before Docker starts.
age_directory=$(node scripts/verify-backup-test-fixtures.mjs "${MURAGE_BACKUP_TEST_AGE_DIR:-}")
docker image inspect "$image" > /dev/null
test -f node_modules/vitest/vitest.mjs
test -d cloudflare/control-plane/node_modules
mkdir -p node_modules/.vite node_modules/.vite-temp
# Preserve the current bytes of tracked files, including uncommitted edits.
# Extraction runs as the test user, so launcher fixtures can write in /work
# even when the source checkout belongs to root. The dependency store stays read-only.
# /work needs exec because several cases compile helpers or run fixture CLIs.
git ls-files -z | tar --null --files-from=- -cf "$scratch/source.tar"

run_tests() {
  local uid=$1
  shift
  container="mc63-basereds-home-${uid}-$$"
  until [ $(cut -d" " -f1 /proc/loadavg | cut -d. -f1) -lt 60 ]; do sleep 60; done
  docker run --rm --network none --user "$uid:$uid" \
    --name "$container" \
    --label owner=mc63 --label purpose=basereds-j5b --label expires_at=2026-11-14 \
    --mount "type=bind,source=$scratch/source.tar,target=/source.tar,readonly" \
    --tmpfs /work:rw,exec,uid=1000,gid=1000,mode=755 \
    --mount "type=bind,source=$repo/node_modules,target=/work/node_modules,readonly" \
    --mount "type=bind,source=$repo/cloudflare/control-plane/node_modules,target=/cp-node-modules,readonly" \
    --mount "type=bind,source=$age_directory,target=/backup-test-age,readonly" \
    --tmpfs /work/node_modules/.vite:rw,uid=1000,gid=1000,mode=700 \
    --tmpfs /work/node_modules/.vite-temp:rw,uid=1000,gid=1000,mode=700 \
    --env MURAGE_BACKUP_TEST_AGE_DIR=/backup-test-age \
    --workdir /work "$image" sh -c \
    'set -eu
     tar --no-same-owner -xf /source.tar -C /work
     cp -RP /cp-node-modules /work/cloudflare/control-plane/node_modules
     id
     node --version
     exec node node_modules/vitest/vitest.mjs run --maxWorkers=1 --reporter=verbose "$@"' sh "$@"
}

status=0
if [[ "$group" != --app-health ]]; then
  run_tests 1000 server/cloud-home --exclude server/cloud-home/app-health.test.ts || status=1
fi
# CI also separates this file: its volume fixture needs root-owned directories
# and chown on a real mount. It already asserts these prerequisites.
if [[ "$group" != --ordinary ]]; then
  printf '%s\n' 'App-health step: starting a separate uid 0 container for server/cloud-home/app-health.test.ts'
  run_tests 0 server/cloud-home/app-health.test.ts || status=1
fi
exit "$status"
