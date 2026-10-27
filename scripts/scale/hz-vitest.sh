#!/bin/zsh
# Copyright 2026 Ferrox Labs
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Run tagged Vitest tests on build-host (dedicated hardware), in a throwaway container, against one commit.
#   scripts/scale/hz-vitest.sh <label> <commit> <tags filter>
# e.g. scripts/scale/hz-vitest.sh ci-123 "$GITHUB_SHA" perf-budget
# The perf-budget tag (vite.config.ts) marks tests that assert a wall-clock budget measured on this kind of
# machine; hosted runners are several times slower and noisier, so those tests run here, from nightly.yml.
# The commit is exported with `git archive`; build its Linux cage on the caller first with
# `pnpm build:murage-cage` (Linux x64, Docker and the host build tools). Output streams back and the exit
# code is Vitest's. The tree is removed afterwards. Host rules: at most 2 such containers, never prune.
set -euo pipefail
RIG_HOST=${RIG_HOST:-build-host}
label=${1:?label}; commit=${2:?commit}; filter=${3:?tags filter}
[[ "$label" =~ '^[a-z0-9-]+$' ]] || { echo "bad label"; exit 2; }
[[ "$filter" =~ '^[a-z0-9 !&|()-]+$' ]] || { echo "bad tags filter"; exit 2; }
here=${0:A:h}
top=$(git -C "$here" rev-parse --show-toplevel)
sha=$(git -C "$top" rev-parse "$commit^{commit}")
H=/root/mb-0161-hz
dir="$H/vitest-$label"
SSHO=(-o ControlMaster=no -o ControlPath=none -o ServerAliveInterval=30 -o ConnectTimeout=20)
running=$(ssh $SSHO $RIG_HOST "docker ps --format '{{.Names}}' | grep -c '^mm-vitest-' || true")
(( running < ${RIG_MAX:-2} )) || { echo "${RIG_MAX:-2} vitest container(s) already run on $RIG_HOST; wait"; exit 3; }
cleanup() { ssh $SSHO $RIG_HOST "docker rm -f mm-vitest-$label >/dev/null 2>&1; rm -rf -- '${dir:?}'" || true; }
trap cleanup EXIT
ssh $SSHO $RIG_HOST "mkdir -p '$dir/src' $H/store && df -h $H | tail -1"
git -C "$top" archive --format=tar "$sha" | gzip -1 | ssh $SSHO $RIG_HOST "tar -xz -C '$dir/src'"
# The caller builds the cage on Linux. Carry that exact output into the
# exported checkout; the unprivileged test container does not run Docker.
tar -C "$top" -czf - dist-native/cage/linux-x64 | ssh $SSHO $RIG_HOST "tar -xz -C '$dir/src'"
echo "running Vitest --tags-filter='$filter' at $sha on $RIG_HOST"
ssh $SSHO $RIG_HOST "chown -R 2001:2001 '$dir' $H/store && docker run --init --rm --name mm-vitest-$label --user 2001:2001 --cpus 8 --memory 16g \
  -e HOME=/tmp/home -e CI=1 -e ELECTRON_SKIP_BINARY_DOWNLOAD=1 -e npm_config_store_dir=/store \
  -v '$dir/src':/work -v $H/store:/store -v $H/tools:/tools:ro -v $H/passwd:/etc/passwd:ro -v $H/group:/etc/group:ro -w /work node:24-bookworm \
  bash -lc 'set -e; mkdir -p /tmp/home; export PATH=/tools/bin:\$PATH; pnpm install --frozen-lockfile --prefer-offline >/tmp/install.log 2>&1 || { tail -20 /tmp/install.log; exit 3; }; pnpm build:server >/tmp/build.log 2>&1 || { tail -20 /tmp/build.log; exit 3; }; pnpm exec vitest run --tags-filter=\"$filter\"'"
