#!/bin/bash
# Private worker on the smoothness host. Called only by g8-smooth.sh.
set -Eeuo pipefail
umask 077
trap 'rc=$?; echo "g8-host: line $LINENO failed ($rc): $BASH_COMMAND" >&2; exit "$rc"' ERR
lane=${1:?lane}; label=${2:?label}; sha=${3:?overlay}; mode=${4:?mode}; pb=${5:?prebuild}
H=${G8_HOST_ROOT:?set G8_HOST_ROOT to the worker scratch root}
[[ $H == /* && $H != / && $H != /dev && $H != /dev/* && $label =~ ^v7-[a-z0-9-]+$ && $lane == "$H/smooth-$label" ]] || { echo 'g8-host: unsafe lane' >&2; exit 2; }
[[ $sha =~ ^[a-f0-9]{40}$ && ( $mode == idle || $mode == load ) && ( $pb == 0 || $pb == 1 ) ]] || { echo 'g8-host: invalid arguments' >&2; exit 2; }
source "$(dirname -- "${BASH_SOURCE[0]}")/../safe-wipe.sh"
container=mm-smooth-$label; started=0; stress=''; stress_start=''
cleanup() {
  local rc=$? now fields removed=1
  trap - EXIT ERR
  set +e
  if [[ -n $stress ]]; then
    now=$(cat "/proc/$stress/stat" 2> "$lane/stress-proc.err"); fields=${now##*) }
    if [[ $(awk '{print $20}' <<< "$fields") == "$stress_start" ]]; then
      kill -TERM "$stress" || rc=4
      wait "$stress"
    fi
  fi
  if [[ $started == 1 ]]; then
    docker logs "$container" > "$lane/gate.log" 2>&1 || rc=4
    if [[ $rc != 0 ]]; then tail -80 "$lane/gate.log" >&2; fi
    if ! docker rm -f "$container" >> "$lane/cleanup.log" 2>&1; then rc=4; removed=0; fi
  fi
  # Evidence is outside both source and data. Never delete another lane/cache.
  if [[ $removed == 1 ]]; then
    SAFE_WIPE_WITHIN="$lane" safe_wipe "${lane:?}/data" || rc=4
    SAFE_WIPE_WITHIN="$lane" safe_wipe "${lane:?}/src" || rc=4
  else
    echo 'g8-host: container removal failed; retaining its mounts' >&2
    cat "$lane/cleanup.log" >&2
  fi
  printf '%s\n' "$rc" > "$lane/done"
  echo "g8-host: exit=$rc evidence=$lane"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
exec 9> "$H/smoothness/g8-v7.lock"
flock -n 9 || { echo 'g8-host: another v7 leg is running' >&2; exit 3; }
running=$(docker ps --format '{{.Names}}')
if grep -q '^mm-smooth-' <<< "$running"; then echo 'g8-host: another smoothness container is running' >&2; exit 3; fi
if [[ $mode == load ]]; then command -v stress-ng > "$lane/stress-command.txt"; fi
test -d "$lane/src/scripts/smoothness"
manifest=${G8_FIXTURE_MANIFEST:-$lane/src/scripts/smoothness/fixtures-v7.json}
read -r fixture digest < <(python3 - "$manifest" <<'PY'
import json,sys
m=json.load(open(sys.argv[1]))
if m['drained']['status'] != 'ready':
    sys.exit('g8-host: drained fixture is not ready; refusing the backlog fixture')
print(m['drained']['archive'], m['drained']['sha256'])
PY
)
[[ $fixture == "$H/fixtures/"*.tar.gz && $digest =~ ^[a-f0-9]{64}$ ]] || { echo 'g8-host: invalid fixture manifest' >&2; exit 4; }
printf '%s  %s\n' "$digest" "$fixture" | sha256sum --check
cp "$manifest" "$lane/fixture.json"
mkdir "$lane/data" "$lane/evidence"
tar -xzf "$fixture" -C "$lane/data"
test -d "$lane/data/murage"
test ! -f "$lane/data/murage/config.json"
test ! -s "$lane/data/murage/messages.db-wal"
rm -f "${lane:?}/data/murage/routines.json"
# Count on the COPY only; immutable SELECTs do not touch even its WAL sidecars.
python3 - "$lane/data/murage/messages.db" <<'PY'
import sqlite3,sys
c=sqlite3.connect('file:'+sys.argv[1]+'?immutable=1',uri=True)
n=c.execute("SELECT count(*) FROM memory_revoke_jobs WHERE state='active'").fetchone()[0]
print('fixture activeJobs='+str(n))
if n: sys.exit('g8-host: fixture has active revoke jobs')
pending=c.execute("SELECT count(*) FROM memory_revoke_jobs WHERE state IN ('active','undoing','seeding')").fetchone()[0]
flips=c.execute('SELECT count(*) FROM memory_receipt_flips').fetchone()[0]
if pending or flips: sys.exit('g8-host: fixture has pending revoke work')
PY
lock=$(sha256sum "$lane/src/pnpm-lock.yaml"); lock=${lock:0:16}
nm=$H/gp18-nm/$lock
test -f "$nm/ok"
cmp "$nm/pnpm-lock.yaml" "$lane/src/pnpm-lock.yaml"
test -d "$nm/node_modules/.pnpm"
cp -al "$nm/node_modules" "$lane/src/node_modules"
# Reuse the already installed, root-owned cage, never download/build one here.
cage=${G8_CAGE:-$H/cage/linux-x64}
mkdir -p "$lane/src/dist-native/cage"
chmod 0755 "$lane/src/dist-native" "$lane/src/dist-native/cage"
cp -a "$cage" "$lane/src/dist-native/cage/linux-x64"
chown -R 2001:2001 "$lane/data" "$lane/out" "$lane/evidence"
chown 2001:2001 "$lane/src"
chown -R root:root "$lane/src/dist-native"
chmod -R go-w "$lane/src/dist-native"
sha256sum "$lane/src/dist-native/cage/linux-x64/bwrap" "$lane/src/dist-native/cage/linux-x64/murage-power.bpf" > "$lane/cage.sha256"
load=0; [[ $mode != load ]] || load=1
started=1
docker run -d --init --name "$container" --pull=never --user 2001:2001 --cpus 6 --cpuset-cpus 0-5 --memory 12g --network none \
  -e HOME=/tmp/home -e CI=1 -e LABEL="$label" -e TREE_SHA="$sha" -e LOAD="$load" \
  -e SMOOTH_ENGINES=fake -e SMOOTH_RUN_ID="$label" -e PREBUILD="$pb" \
  -v "$lane/src:/work:ro" -v "$lane/data:/smooth-data" -v "$lane/out:/out" -v "$lane/evidence:/evidence" \
  -v "$H/tools:/tools:ro" -v "$H/passwd:/etc/passwd:ro" -v "$H/group:/etc/group:ro" \
  -w /work node:24-bookworm bash /work/scripts/smoothness/g8-container.sh > "$lane/container.id"
while [[ ! -f $lane/out/prebuild.done ]]; do
  state=$(docker inspect --format '{{.State.Running}}' "$container")
  [[ $state == true ]] || { echo 'g8-host: container died before prebuild completed' >&2; exit 4; }
  sleep 1
done
if [[ $load == 1 ]]; then
  stress-ng --cpu 6 --cpu-load 80 --taskset 0-5 --quiet > "$lane/stress.log" 2>&1 &
  stress=$!
  stat=$(cat "/proc/$stress/stat"); fields=${stat##*) }; stress_start=$(awk '{print $20}' <<< "$fields")
fi
touch "$lane/out/load.ready"
rc=$(docker wait "$container")
[[ $rc =~ ^[0-9]+$ && $rc -le 255 ]] || { echo 'g8-host: invalid container exit' >&2; exit 4; }
echo "g8-host: container exit=$rc"
exit "$rc"
