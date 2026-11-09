#!/bin/zsh
# Copyright 2026 Ferrox Labs
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Run the smoothness gate on the real-data box, in a container, against one commit, on a fresh copy of Sean's data.
#   scripts/smoothness/hz-smooth.sh <label> <commit> [idle|load] [extra docker -e flags...]
# e.g. scripts/smoothness/hz-smooth.sh smooth-base 58cca340d load
# The commit is exported with `git archive` (nothing is built here); node_modules are hard-linked from NODE_MODULES_FROM
# (a lane dir on the box whose pnpm-lock.yaml matches this commit's). The data source (SMOOTH_SOURCE, default the 10-19
# pristine copy) is cp -a'd into the lane dir, routines.json is deleted in the copy, nothing is written to the source, and
# the copy is deleted when the run ends, after keep-logs.sh copied the server log to $H/smoothness/logs/<run-id>/. "load" runs stress-ng on the host, pinned to the container's six cores at 80%.
# Results: /srv/murage-smooth/smooth-<label>/out; the log is .../gate.log and ends with REALEXIT=<gate exit>.
# Host rules: at most 2 containers per lane (the run and nothing else here), no ssh retry under 60 s (sshw waits 60 s
# between attempts), never prune. Preserve the previous run before the upload and remote driver script.
# SSH_JUMP=<host> routes both through a jump host (e.g. build-host) when the direct path is flaky.
set -euo pipefail
(( $# >= 2 )) || exit 4
RIG_HOST=${RIG_HOST:-root@178.104.176.107}
label=${1:?label}; commit=${2:?commit}; mode=${3:-idle}; (( $# >= 3 )) && shift 3 || shift 2
[[ "$label" =~ '^[a-z0-9-]+$' ]] || { echo "bad label"; exit 4; }
[[ "$mode" == idle || "$mode" == load ]] || { echo "mode is idle or load"; exit 4; }
here=${0:A:h}; top=$(git -C "$here" rev-parse --show-toplevel)
sha=$(git -C "$top" rev-parse --short=12 "$commit^{commit}")
H=${SMOOTH_HOST_ROOT:-/srv/murage-smooth}; L=$H/smooth-$label
SRC=${SMOOTH_SOURCE:-$H/rh3-data/pristine}
NM=${NODE_MODULES_FROM:-$H/self-overload/src}
CPUS=${SMOOTH_CPUSET:-0-5}
LOADENV=0; [[ $mode == load ]] && LOADENV=1
SSHO=(-o ControlMaster=no -o ControlPath=none -o ServerAliveInterval=30 -o ConnectTimeout=25)
[[ -n "${SSH_JUMP:-}" ]] && SSHO+=(-J "$SSH_JUMP")
# one ssh, retried at most twice, 60 s apart, only on a connection failure (255)
sshw() { local n; for n in 1 2 3; do if [[ -n "${SSHW_IN:-}" ]]; then ssh $SSHO $RIG_HOST "$@" < "$SSHW_IN" && return 0; else ssh $SSHO $RIG_HOST "$@" && return 0; fi; local rc=$?; (( rc == 255 && n < 3 )) || return $rc; echo "ssh connection failed; retrying in 60 s ($n)"; sleep 60; done; }
# Before ANY path replaces src or data, the reviewed local keeper is staged privately on the box (stage-keeper.sh: hash-verified,
# signal-trapped, Docker state fail-closed, per-lane lock) and preserves the previous run. The previous checkout's keep-logs.sh is never run.
umask 077
KEEPER=$here/keep-logs.sh; STAGER=$here/stage-keeper.sh
O=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
P=${SMOOTH_TXN:-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')}
[[ "$P" =~ '^[a-f0-9]{32}$' ]] || exit 4
RUN_ID="$label-$(date -u +%Y%m%dT%H%M%SZ)-$O"
local_stage=$(mktemp -d "${TMPDIR:-/tmp}/murage-launch.XXXXXXXX")
trap 'rc=$?; trap - EXIT; rm -rf -- "$local_stage" || { (( rc != 0 )) || rc=4; }; exit $rc' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
tar --format=ustar -cf "$local_stage/bundle.tar" -C "$here" keep-logs.sh keep-logs.mjs scrub-accounting.mjs
khash=$(for name in keep-logs.sh keep-logs.mjs scrub-accounting.mjs; do
  digest=$(shasum -a 256 "$here/$name"); printf '%s/%s\n' "$name" "${digest%% *}"
done | shasum -a 256); khash=${khash%% *}
stager_src=$(<"$STAGER")
lock=$H/smoothness/locks/$label.d
owned=0
keeper() { SSHW_IN="$local_stage/bundle.tar" sshw "SMOOTH_NODE=/usr/local/bin/node SMOOTH_OWNER=$O SMOOTH_TXN=$P bash -c ${(qq)stager_src} stage-keeper $L $H $label $khash $L/src $sha $1"; }
release_lock() {
  local rc=$?
  trap - EXIT
  if [[ "$owned" == 1 ]]; then
    SSHW_IN= sshw "SMOOTH_OWNER=$O bash -c ${(qq)stager_src} stage-keeper $L $H $label $khash $L/src $sha release" || { (( rc != 0 )) || rc=4; }
  fi
  rm -rf -- "$local_stage" || { (( rc != 0 )) || rc=4; }
  exit $rc
}
trap release_lock EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
if [[ -n "${SMOOTH_BREAK_LOCK:-}" ]]; then
  [[ "$SMOOTH_BREAK_LOCK" =~ '^[a-f0-9]{32}$' ]] || exit 4
  SSHW_IN= sshw "SMOOTH_OWNER=$O SMOOTH_BREAK_LOCK=$SMOOTH_BREAK_LOCK bash -c ${(qq)stager_src} stage-keeper $L $H $label $khash $L/src $sha break"
  exit $?
fi
if [[ "${SMOOTH_PRESERVE_ONLY:-}" == 1 ]]; then
  ready=$(keeper prepare) || exit $?
  [[ "$ready" == "keeper-ready:$sha:$khash:$O" ]] || exit 4
  echo "prepared $sha: use SMOOTH_TXN=$P SMOOTH_SYNC=present after replacement"; exit 0
elif [[ "${SMOOTH_SYNC:-}" == present ]]; then
  ready=$(keeper present) || exit $?
else
  ready=$(keeper archive) || exit $?
fi
[[ "$ready" == "keeper-ready:$sha:$khash:$O" ]] || exit 4
owned=1
runtime=$H/smoothness/runs/$O
tar --format=ustar -cf "$local_stage/runtime.tar" -C "$here" keep-logs.sh keep-logs.mjs scrub-accounting.mjs stage-keeper.sh follow-run.sh
SSHW_IN="$local_stage/runtime.tar" sshw "umask 077; mkdir -p $runtime; tar -xf - -C $runtime" || exit 4
# 1) the tree: upload only when the box does not already hold this sha (the check rides inside the upload connection)
# SMOOTH_SYNC=<path to hz-sync.sh> sends only the git delta through the build-host mirror instead of a tarball from here.
# SMOOTH_SYNC=present: the tree was placed at $L/src by other means (e.g. a patch applied on the box); only check its sha.
if [[ "${SMOOTH_SYNC:-}" == present ]]; then
  sshw "test \"\$(cat $L/src/.smooth-sha 2>$runtime/check.err)\" = $sha" || { echo "$L/src does not hold $sha"; exit 5; }
  echo "tree present $sha"
elif [[ -n "${SMOOTH_SYNC:-}" ]]; then
  have=$(sshw "mkdir -p $L/src $L/out; if [ \"\$(cat $L/src/.smooth-sha 2>$runtime/check.err)\" = $sha ]; then echo present; else find $L/src -mindepth 1 -maxdepth 1 -exec rm -rf {} +; echo empty; fi")
  if [[ "$have" != present ]]; then
    "$SMOOTH_SYNC" "$sha" "${RIG_HOST#*@}" "$L/src" || { echo "sync failed"; exit 5; }
    sshw "echo $sha > $L/src/.smooth-sha"; echo "synced $sha"
  else echo "tree present $sha"; fi
else
  git -C "$top" archive --format=tar "$sha" | gzip -1 > $local_stage/source.tgz
  sshw "set -e; mkdir -p $L/src $L/out; if [ \"\$(cat $L/src/.smooth-sha 2>$runtime/check.err)\" != $sha ]; then find $L/src -mindepth 1 -maxdepth 1 -exec rm -rf {} +; cat > $L/src.tgz; tar -xzf $L/src.tgz -C $L/src; rm -f $L/src.tgz; echo $sha > $L/src/.smooth-sha; echo uploaded $sha; else cat > $L/unused-upload.tgz; echo tree present $sha; fi" < $local_stage/source.tgz
  rm -f $local_stage/source.tgz
fi
# 2) everything else in one remote driver: checks, node_modules, the data copy, the container, the load, the log follower
extra="${(j: :)${(q)@}}"
set +e
sshw "bash -s" <<EOF
set -euo pipefail
umask 077
L=$L; H=$H; RUN_ID=$RUN_ID; O=$O; runtime=$runtime; SRC=$SRC; NM=$NM; label=$label; sha=$sha; CPUS=$CPUS; LOADENV=$LOADENV
df -h \$H | tail -1
test -d "\$SRC" || { echo "no data source \$SRC"; exit 4; }
test ! -f "\$SRC/config.json" || { echo "the data source has a config.json; refusing"; exit 4; }
test -d "\$NM/node_modules/.pnpm" || { echo "no node_modules at \$NM"; exit 4; }
cmp -s "\$NM/pnpm-lock.yaml" "\$L/src/pnpm-lock.yaml" || { echo "pnpm-lock differs from NODE_MODULES_FROM"; exit 4; }
running=\$(docker ps --format '{{.Names}}' | grep -c '^mm-smooth-' || true)
[ "\$running" -lt 2 ] || { echo "2 smoothness containers already run; wait"; exit 3; }
[ -d "\$L/src/node_modules/.pnpm" ] || cp -a "\$NM/node_modules" "\$L/src/node_modules"
# the keeper preserved this lane (lock marker); only now is the previous run's journal rotated, so the new run never appends to it (runId is also on every record)
if [ -f "\$H/smoothness/locks/\$label.d/preserved" ]; then
  for f in "\$L/out"/failed-turns-*.jsonl; do [ ! -f "\$f" ] || mv -- "\$f" "\$f.rotated-\$(date -u +%Y%m%dT%H%M%SZ)"; done
fi
rm -rf -- "\${L:?}/data"; mkdir -p "\$L/data"
cp -a "\$SRC" "\$L/data/murage"
rm -f "\$L/data/murage/routines.json"
test ! -f "\$L/data/murage/config.json"
chown -R 2001:2001 "\$L"
du -sh "\$L/data" | tail -1
rm -f "\$L/stress.pid"
if docker inspect "mm-smooth-\$label" > "\$runtime/old-container.log" 2>&1; then docker rm "mm-smooth-\$label" >> "\$runtime/old-container.log" 2>&1; fi
CID=\$(docker run -d --init --name "mm-smooth-\$label" --user 2001:2001 --cpus 6 --cpuset-cpus "\$CPUS" --memory 12g --network none \
  -e SMOOTH_RUN_ID="\$RUN_ID" -e HOME=/tmp/home -e CI=1 -e LABEL="\$label" -e TREE_SHA="\$sha" -e LOAD="\$LOADENV" $extra \
  -v "\$L/src:/work" -v "\$L/data:/smooth-data" -v "\$L/out:/out" -v "\$H/tools:/tools:ro" -v "\$H/passwd:/etc/passwd:ro" -v "\$H/group:/etc/group:ro" \
  -w /work node:24-bookworm bash /work/scripts/smoothness/run-container.sh)
[[ "\$CID" =~ ^[a-f0-9]{64}$ ]] || exit 4
exec 9>>"\$H/smoothness/locks/\$label.flock"; flock -x 9
read -r version phase p active rev utc < "\$H/smoothness/locks/\$label.d/owner"
[ "\$active" = "\$O" ] && [ "\$phase" = active ] || exit 4
printf '%s/%s/%s\n' "\$RUN_ID" "\$CID" "\$O" > "\$L/.run-id-\$O"
mv -- "\$L/.run-id-\$O" "\$L/run.id"
flock -u 9
if [ "\$LOADENV" = 1 ]; then
  setsid stress-ng --cpu 6 --cpu-load 80 --taskset "\$CPUS" --quiet < /dev/null > "\$runtime/stress.log" 2>&1 &
  pid=\$!
  start=\$(sed 's/.*) //' "/proc/\$pid/stat" | awk '{print \$20}')
  printf '%s %s %s\n' "\$RUN_ID" "\$pid" "\$start" > "\$L/stress.pid"
fi
setsid bash "\$runtime/follow-run.sh" "\$L" "\$H" "\$label" "\$sha" "$khash" "\$RUN_ID" "\$CID" "\$O" "\$runtime" < /dev/null > "\$runtime/follower.log" 2>&1 &
echo "launched mm-smooth-\$label at \$sha mode=$mode"
EOF
remote_rc=$?
if (( remote_rc != 0 )); then owned=0; exit $remote_rc; fi
