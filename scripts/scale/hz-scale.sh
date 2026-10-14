#!/bin/zsh
# Copyright 2026 Ferrox Labs
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Run the scale rig on build-host, in a container, against one commit of Murage.
#   scripts/scale/hz-scale.sh <label> <commit> <pr|extreme> [extra docker -e flags...]
# e.g. scripts/scale/hz-scale.sh int102 fea681604 extreme -e LOAD=1 -e SLOW_DISK=1
# The commit is exported with `git archive` from this repo (nothing is built here). The rig scripts
# come from this checkout's scripts/scale. Results: /root/mb-0161-hz/scale-<label>/out on the host;
# the log is /root/mb-0161-hz/scale-<label>/gate.log and ends with REALEXIT=<gate exit>.
# Generated data is cached in /root/mb-0161-hz/scale-data/cache, keyed by shape, seed, commit and generator.
# Host rules: at most 2 rig containers at once, no ssh retry faster than 60 s, never prune.
set -eu
RIG_HOST=${RIG_HOST:-build-host}   # any ssh host with the rig layout (see README, "Other hosts")
label=${1:?label}; commit=${2:?commit}; shape=${3:?shape}; shift 3
[[ "$label" =~ '^[a-z0-9-]+$' ]] || { echo "bad label"; exit 2; }
[[ "$shape" == pr || "$shape" == extreme || "$shape" == owner ]] || { echo "shape is pr, extreme or owner"; exit 2; }
here=${0:A:h}
top=$(git -C "$here" rev-parse --show-toplevel)
sha=$(git -C "$top" rev-parse --short=12 "$commit^{commit}")
H=/root/mb-0161-hz
SSHO=(-o ControlMaster=no -o ControlPath=none -o ServerAliveInterval=30 -o ConnectTimeout=20)
running=$(ssh $SSHO $RIG_HOST "docker ps --format '{{.Names}}' | grep -c '^mm-scale-' || true")
(( running < ${RIG_MAX:-2} )) || { echo "${RIG_MAX:-2} scale container(s) already run on $RIG_HOST; wait"; exit 3; }
ssh $SSHO $RIG_HOST "mkdir -p $H/scale-$label/src $H/scale-$label/out $H/scale-rig/files $H/scale-rig/tools $H/scale-data/cache $H/scale-data/run/$label && df -h $H | tail -1"
if ! ssh $SSHO $RIG_HOST "test -f $H/scale-$label/src/package.json && test \"\$(cat $H/scale-$label/src/.scale-sha 2>/dev/null)\" = $sha"; then
  ssh $SSHO $RIG_HOST "find $H/scale-$label/src -mindepth 1 -maxdepth 1 -exec rm -rf {} +"
  git -C "$top" archive --format=tar "$sha" | gzip -1 | ssh $SSHO $RIG_HOST "tar -xz -C $H/scale-$label/src && echo $sha > $H/scale-$label/src/.scale-sha"
fi
rsync -e "ssh ${SSHO[*]}" -a --delete --exclude '*.test.mjs' "$here/" "$RIG_HOST:$H/scale-rig/files/"
ssh $SSHO $RIG_HOST "test -f $H/scale-rig/tools/fsync-delay.so || cc -O2 -shared -fPIC -o $H/scale-rig/tools/fsync-delay.so $H/scale-rig/files/fsync-delay.c -ldl"
cpus=6; mem=24g
[[ $shape == pr || $shape == owner ]] && { cpus=4; mem=12g; }
ssh $SSHO $RIG_HOST "chown -R 2001:2001 $H/scale-$label $H/scale-data $H/store && rm -f $H/scale-$label/gate.log && docker rm -f mm-scale-$label >/dev/null 2>&1 || true; \
 docker run -d --init --name mm-scale-$label --user 2001:2001 --cpus $cpus --memory $mem --ipc=host \
  -e HOME=/tmp/home -e CI=1 -e ELECTRON_SKIP_BINARY_DOWNLOAD=1 -e npm_config_store_dir=/store -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
  -e LABEL=$label -e SHAPE=$shape -e TREE_SHA=$sha -e FLUX_KEY_FILE=/secrets/flux.key ${(j: :)${(q)@}} \
  -v $H/scale-$label/src:/work -v $H/scale-$label/out:/out -v $H/scale-rig/files:/scale-rig:ro -v $H/scale-rig/tools:/scale-tools:ro \
  -v $H/scale-data/cache:/scale/cache -v $H/scale-data/run/$label:/scale/data -v $H/perf102-rig/secrets:/secrets:ro -v $H/store:/store -v $H/tools:/tools:ro \
  -v $H/passwd:/etc/passwd:ro -v $H/group:/etc/group:ro -w /work mcr.microsoft.com/playwright:v1.57.0-noble bash /scale-rig/run-container.sh >/dev/null && \
 setsid sh -c 'docker logs -f mm-scale-$label > $H/scale-$label/gate.log 2>&1; docker rm mm-scale-$label >/dev/null 2>&1' </dev/null >/dev/null 2>&1 & echo launched mm-scale-$label at $sha"
