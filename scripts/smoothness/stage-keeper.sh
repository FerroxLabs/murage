#!/bin/bash
# All ownership transitions use the persistent mutex, including operator recovery.
set -euo pipefail
umask 077
[ "$#" -eq 7 ] || exit 4
lane=${1:?lane}; hostroot=${2:?host-root}; label=${3:?label}; expected=${4:?bundle hash}
new_checkout=${5:?checkout}; revision=${6:?revision}; action=${7:?action}
[[ "$expected" =~ ^[a-f0-9]{64}$ && "$label" =~ ^[a-z0-9-]+$ && "$revision" =~ ^[a-f0-9]{12}$ ]] || exit 4
O=${SMOOTH_OWNER:-}; P=${SMOOTH_TXN:-}
[[ "$O" =~ ^[a-f0-9]{32}$ ]] || exit 4
case "$action" in archive|prepare|present|release|break|acquire) ;; *) exit 4 ;; esac
locks="$hostroot/smoothness/locks"; lock="$locks/$label.d"
# A directory-key index joins real launches to the unchanged hz label namespace.
canonical=$(realpath -m -- "$lane") || exit 4
key=$(printf %s "$canonical" | sha256sum) || exit 4; key=real-${key:0:16}
# The index and its mutex live in R itself, so every launcher of the same canonical directory meets in one place whatever host root it
# chose. The index names the holder's label AND host root; the label's own lock dir stays under that host root.
hostp=$(realpath -m -- "$hostroot") || exit 4
laneguard="$canonical/.lane-lock"
index="$laneguard/index"
stage=; owned=0; prepared=0
detach() {
  local token=$1 trash
  read_owner || return 4
  if [ "$phase" = prepared ]; then [ "$token" = "$owner_p" ] || return 4
  else [ "$token" = "$owner_o" ] || return 4; fi
  trash=$(mktemp -d "$locks/.$label.$token.trash.XXXXXXXX") || return 4
  mv -- "$lock" "$trash/owner" || { rmdir "$trash"; return 4; }
  rm -rf -- "$trash" || return 4
  if [ -f "$index" ] && [ "$(cat "$index")" = "$(printf '%s\n%s' "$label" "$hostp")" ]; then rm -f -- "$index"; fi
}
cleanup() {
  local rc=$?
  trap - EXIT
  if [ "$owned" = 1 ] && [ "$prepared" = 0 ] && [ "$rc" -ne 0 ]; then
    mutex
    detach "$O" || { [ "$rc" -ne 0 ] || rc=4; }
    flock -u 9; flock -u 8
  fi
  if [ -n "$stage" ]; then rm -rf -- "$stage" || { [ "$rc" -ne 0 ] || rc=4; }; fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
read_owner() {
  local extra version utc
  [ -d "$lock" ] && [ ! -L "$lock" ] && [ -f "$lock/owner" ] && [ ! -L "$lock/owner" ] || return 4
  read -r version phase owner_p owner_o owner_rev utc extra < "$lock/owner" || return 4
  [[ "$version" = v1 && "$owner_p" =~ ^[a-f0-9]{32}$ && "$owner_rev" =~ ^[a-f0-9]{12}$ && "$utc" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ && -z "$extra" ]] || return 4
  case "$phase" in
    prepared) [ "$owner_o" = - ] || return 4 ;;
    active) [[ "$owner_o" =~ ^[a-f0-9]{32}$ ]] || return 4 ;;
    *) return 4 ;;
  esac
  [ "$(wc -l < "$lock/owner")" = 1 ] || return 4
  [ "$(cat "$lock/owner")" = "v1 $phase $owner_p $owner_o $owner_rev $utc" ] || return 4
}
publish_owner() {
  local phase=$1 active=$2
  printf 'v1 %s %s %s %s %s\n' "$phase" "$P" "$active" "$revision" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$lock/.owner-$O" || return 4
  mv -- "$lock/.owner-$O" "$lock/owner" || return 4
}
mutex() {
  mkdir -p "$locks" "$laneguard" || exit 4
  if [ "${mutex_open:-0}" = 0 ]; then
    exec 8>>"$laneguard/mutex"
    exec 9>>"$locks/$label.flock"
    mutex_open=1
  fi
  flock -x 8
  flock -x 9
}
# Reclaims an active real lock under host root $1, label $2, only when its recorded owner pid is verifiably dead (no /proc entry and
# kill -0 fails). Runs under the lane mutex; the globals it borrows are restored before it returns.
reclaim_dead() {
  local s_locks=$locks s_lock=$lock s_label=$label s_hostp=$hostp m p rc=0
  hostp=$1; label=$2; locks="$1/smoothness/locks"; lock="$locks/$label.d"
  if read_owner && [ "$phase" = active ]; then
    m="$locks/owners/$owner_o"
    if [ -f "$m" ] && [ ! -L "$m" ]; then
      p=$(cat "$m")
      if [[ "$p" =~ ^[1-9][0-9]*$ ]] && [ -d /proc/self ] && [ ! -e "/proc/$p" ] && ! kill -0 "$p"; then
        { detach "$owner_o" && rm -f -- "$m"; } || rc=4
      fi
    fi
  fi
  locks=$s_locks; lock=$s_lock; label=$s_label; hostp=$s_hostp
  return "$rc"
}
if [[ "$action" = release || "$action" = break ]]; then
  mutex
  if [ "$action" = release ] && [ "${SMOOTH_RELEASE_IF_OWNED:-}" = 1 ]; then
    # Cancel a pending acquiring child under the same directory mutex.
    rm -f -- "$locks/owners/$O"
    read_owner || exit 0
    [ "$phase" = active ] && [ "$owner_o" = "$O" ] || exit 0
  else read_owner || exit 4; fi
  if [ "$action" = break ]; then
    [[ "${SMOOTH_BREAK_LOCK:-}" =~ ^[a-f0-9]{32}$ ]] || exit 4
    cat "$lock/owner"
    detach "$SMOOTH_BREAK_LOCK" || exit 4
  else detach "$O" || exit 4; fi
  exit 0
fi
if [ "$action" != acquire ]; then
  node_path=${SMOOTH_NODE:-/usr/local/bin/node}
  [ -x "$node_path" ] || { echo 'explicit Node unavailable' >&2; exit 4; }
  stage=$(mktemp -d "${TMPDIR:-/tmp}/murage-keeper.XXXXXXXX") || exit 4
  stagep=$(realpath -m -- "$stage") || exit 4
  for root in "$lane" "$hostroot" "$new_checkout"; do
    rootp=$(realpath -m -- "$root") || exit 4
    rootp=${rootp%/}
    case "$stagep/" in "$rootp/"*) echo 'stage overlaps replacement root' >&2; exit 4 ;; esac
    case "$rootp/" in "$stagep/"*) echo 'replacement root overlaps stage' >&2; exit 4 ;; esac
  done
  cat > "$stage/bundle.tar" || exit 4
  # Only a plain ustar bundle is accepted. Validate every header before writing members.
  "$node_path" --input-type=module - "$stage" "$expected" <<'JS' || exit 4
import * as fs from "node:fs";
import { createHash } from "node:crypto";
const [dir, expected] = process.argv.slice(2);
const names = ["keep-logs.sh", "keep-logs.mjs", "scrub-accounting.mjs"];
const sha = b => createHash("sha256").update(b).digest("hex");
const tar = fs.readFileSync(dir + "/bundle.tar"), members = new Map();
const str = b => b.toString("utf8").replace(/\0.*$/s, "");
let at = 0, ended = false;
while (at + 512 <= tar.length) {
  const h = tar.subarray(at, at + 512); at += 512;
  if (h.every(b => b === 0)) { ended = true; if (tar.subarray(at).some(b => b !== 0)) throw Error("trailing tar data"); break; }
  const name = str(h.subarray(0, 100)), prefix = str(h.subarray(345, 500));
  const sizeText = str(h.subarray(124, 136)).trim(), check = str(h.subarray(148, 156)).trim();
  if (!/^[0-7]+$/.test(sizeText) || !/^[0-7]+$/.test(check)) throw Error("invalid tar number");
  const size = parseInt(sizeText, 8), sum = h.reduce((n, b, i) => n + (i >= 148 && i < 156 ? 32 : b), 0);
  if (sum !== parseInt(check, 8) || prefix || !names.includes(name) || members.has(name) || ![0, 48].includes(h[156]) || str(h.subarray(157, 257))) throw Error("invalid bundle member");
  if (at + size > tar.length) throw Error("short bundle");
  members.set(name, tar.subarray(at, at + size)); at += Math.ceil(size / 512) * 512;
}
if (!ended || members.size !== names.length) throw Error("incomplete bundle");
const manifest = names.map(n => n + "/" + sha(members.get(n)) + "\n").join("");
if (sha(manifest) !== expected) throw Error("bundle identity mismatch");
for (const n of names) fs.writeFileSync(dir + "/" + n, members.get(n), { mode: 0o600, flag: "wx" });
if (sha(names.map(n => n + "/" + sha(fs.readFileSync(dir + "/" + n)) + "\n").join("")) !== expected) throw Error("extracted bundle changed");
JS
  : > "$stage/manifest"
  for name in keep-logs.sh keep-logs.mjs scrub-accounting.mjs; do
    digest=$(sha256sum "$stage/$name") || exit 4
    printf '%s/%s\n' "$name" "${digest%% *}" >> "$stage/manifest" || exit 4
  done
  digest=$(sha256sum "$stage/manifest") || exit 4
  [ "${digest%% *}" = "$expected" ] || exit 4
fi
mutex
if [ "$action" = present ]; then
  read_owner || exit 4
  [ "$phase" = prepared ] && [ "$owner_p" = "$P" ] && [ "$owner_rev" = "$revision" ] || exit 4
  [ -f "$lock/receipt" ] && [ ! -L "$lock/receipt" ] || exit 4
  read -r version r_hash r_snap r_p r_rev extra < "$lock/receipt" || exit 4
  [[ "$version" = v2 && "$r_hash" = "$expected" && "$r_snap" =~ ^[a-f0-9]{64}$ && "$r_p" = "$P" && "$r_rev" = "$revision" && -z "$extra" ]] || exit 4
  [ "$(wc -l < "$lock/receipt")" = 1 ] || exit 4
  [ "$(cat "$lock/receipt")" = "v2 $r_hash $r_snap $r_p $r_rev" ] || exit 4
  # O_EXCL makes a failed or interrupted claim unavailable for replay.
  "$node_path" --input-type=module - "$lock/claim" "$O" <<'JS' || exit 4
import { writeFileSync } from "node:fs";
writeFileSync(process.argv[2], process.argv[3] + "\n", { flag: "wx", mode: 0o600 });
JS
  publish_owner active "$O" || exit 4
  # Keep a claimed owner for explicit recovery on every later failure.
  prepared=1
  rm -- "$lock/receipt" || exit 4
else
  [[ "$P" =~ ^[a-f0-9]{32}$ ]] || exit 4
  if [ "${SMOOTH_REAL_OWNER:-}" = 1 ]; then
    [ -f "$locks/owners/$O" ] && [ ! -L "$locks/owners/$O" ] || exit 4
    pid=$(cat "$locks/owners/$O")
    [[ "$pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$pid" || exit 4
  fi
  # Consult the other launcher's lane before touching this run's files.
  if [ -f "$index" ]; then
    { IFS= read -r other && IFS= read -r ohost; } < "$index" || exit 4
    [[ "$other" =~ ^[a-z0-9-]+$ && "$ohost" = /* ]] || exit 4
    # A real run that died under another host root is reclaimed from that root's own marker, never from this one's.
    if [ "$action" = acquire ] && [ "$label" = "$key" ] && [ "$other" = "$key" ] && [ "$ohost" != "$hostp" ]; then
      reclaim_dead "$ohost" "$other" || exit 4
    fi
    if { [ "$other" != "$label" ] || [ "$ohost" != "$hostp" ]; } && [ -e "$ohost/smoothness/locks/$other.d" ]; then
      echo 'this lane is busy (lock held)' >&2; exit 3
    fi
  fi
  # Only real host owners carry a PID marker. Unknown/container owners fail closed.
  if [ "$action" = acquire ] && [ "$label" = "$key" ]; then reclaim_dead "$hostp" "$label" || exit 4; fi
  if ! mkdir "$lock"; then echo 'this lane is busy (lock held)' >&2; exit 3; fi
  if ! publish_owner active "$O"; then
    trash=$(mktemp -d "$locks/.$label.$O.trash.XXXXXXXX") || exit 4
    mv -- "$lock" "$trash/owner" && rm -rf -- "$trash"
    exit 4
  fi
fi
owned=1
printf '%s\n%s\n' "$label" "$hostp" > "$index" || exit 4
flock -u 9; flock -u 8
if [ "$action" = acquire ]; then printf 'keeper-ready:%s:%s:%s\n' "$revision" "$expected" "$O"; exit 0; fi
if state=$(docker inspect -f '{{.State.Running}}' "mm-smooth-$label" 2>&1); then
  case "$state" in true) exit 3 ;; false) ;; *) echo 'unknown Docker state' >&2; exit 4 ;; esac
else
  case "${state,,}" in *"no such object"*|*"no such container"*) ;; *) echo 'unknown Docker state' >&2; exit 4 ;; esac
fi
mkdir "$stage/view"
now=$("$node_path" "$stage/keep-logs.mjs" --capture "$lane/out" "$stage/view") || exit 4
archive_now() {
  local found=0 file
  for file in "$stage/view"/server-*.log "$stage/view"/failed-turns-*.jsonl; do [ ! -f "$file" ] || found=1; done
  if [ "$found" = 0 ]; then
    remaining=$(find "$stage/view" -type f -print -quit) || exit 4
    [ -z "$remaining" ] || { echo 'selected evidence has no server log or journal' >&2; exit 4; }
  fi
  if [ "$found" = 1 ]; then
    bash "$stage/keep-logs.sh" "$stage/view" "$hostroot/smoothness/logs" "orphan-$label-$(date -u +%Y%m%dT%H%M%SZ)-$O" "$node_path" || exit 4
  fi
}
if [ "$action" != present ] || [ "$r_snap" != "$now" ]; then archive_now; fi
mutex
read_owner && [ "$owner_o" = "$O" ] || exit 4
if [ "$action" = prepare ]; then
  printf 'v2 %s %s %s %s\n' "$expected" "$now" "$P" "$revision" > "$lock/.receipt-$O" || exit 4
  mv -- "$lock/.receipt-$O" "$lock/receipt" || exit 4
  publish_owner prepared - || exit 4
  prepared=1
fi
: > "$lock/preserved" || exit 4
flock -u 9; flock -u 8
printf 'keeper-ready:%s:%s:%s\n' "$revision" "$expected" "$O"
