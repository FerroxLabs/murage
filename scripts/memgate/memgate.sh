#!/bin/bash
# q1024-memgate: the REAL-DATA MEMORY GATE on a copy of the owner's real store (owner: q1024-memgate; rulings: MAIN 2026-11-27).
# usage: memgate.sh <sha|ref>            foreground;  memgate.sh --detach <sha|ref>  under systemd-run --scope, prints the log path
#   env: BG_SYNTH=1 = rig smoke test on a store the rig makes itself (never a gate result); POST=1 appends the MEMGATE-1024 line to the board;
#        MG_SEARCH_BUDGET_MS (5000) / MG_SAVE_BUDGET_MS (30000) / MG_RETRY_WINDOW_MS (120000, diagnosis only).
# Private: same rules as bannergate.sh (snapshot and copies under seandb-1126 mode 700, deleted after the run; kept evidence = counts and codes only).
# Evidence: _small/memgate-runs/<sha10>-<stamp>/{verdict.txt,result.json,out.txt}
set -u
SM=/root/fuigo-builds/swarm-b/_small; RIG=$SM/bannergate-rig; HUB=/root/mb-105-git.git
SNAP=/root/fuigo-builds/seandb-1126/messages-snap.db; PRIV=/root/fuigo-builds/seandb-1126/runs
BOARD=/root/fuigo-builds/swarm-b/int-1021-n4/QUESTIONS-FOR-MAIN.md
if [ "${1:-}" = "--detach" ]; then
  shift; [ -n "${1:-}" ] || { echo "usage: $0 --detach <sha>"; exit 2; }
  mkdir -p $SM/memgate-runs; L=$SM/memgate-runs/detached-$(date -u +%Y%m%dT%H%M%SZ).log
  systemd-run --scope -q --unit=memgate-$(date +%s) nohup bash "$0" "$1" > "$L" 2>&1 < /dev/null &
  echo "$L"; exit 0
fi
REF=${1:?usage: memgate.sh <sha>}
SHA=$(git --git-dir=$HUB rev-parse --verify "$REF^{commit}" 2>/dev/null) || { echo "MEMGATE-ERR unknown ref $REF"; exit 2; }
S10=${SHA:0:10}; STAMP=$(date -u +%Y%m%dT%H%M%SZ)-$$; NAME=memgate-$S10-$STAMP
EV=$SM/memgate-runs/$S10-$STAMP; RUN=$PRIV/$S10-$STAMP; mkdir -p "$EV"
finish() { echo "rc=$1" > "$EV/exit.txt"; echo "$2" | tee -a "$EV/verdict.txt"; }
# ---- preconditions
# q1024-capcounter: the verdict must never lack a written/idle field when the container figures exist (verdict.py:73/:76 class); a failing self-check is a rig error
FREE=$(df -BG --output=avail / | tail -1 | tr -dc 0-9); [ "$FREE" -ge 62 ] || { finish 3 "MEMGATE-ERR $S10 disk ${FREE}G < 62G"; exit 3; }
[ "$(docker ps -q --filter name=^memgate- | wc -l)" -lt 2 ] || { finish 3 "MEMGATE-ERR $S10 two memgate containers already running"; exit 3; }
if [ "${BG_SYNTH:-0}" != 1 ]; then
SZ=$(stat -c %s "$SNAP" 2>/dev/null || echo 0); sleep 20; SZ2=$(stat -c %s "$SNAP" 2>/dev/null || echo 0)
WANT=$(python3 -I -c 'import struct,sys; h=open(sys.argv[1],"rb").read(100); ps=struct.unpack(">H",h[16:18])[0]; print((65536 if ps==1 else ps)*struct.unpack(">I",h[28:32])[0])' "$SNAP" 2>/dev/null || echo -1)
# complete = exactly the header's page_size x page_count and not growing (the copy arrives by sftp)
[ "$SZ" = "$WANT" ] && [ "$SZ" = "$SZ2" ] || { finish 4 "MEMGATE-ERR $S10 snapshot not complete (size $SZ2 of $WANT, still copying or short)"; exit 4; }
QC=/root/fuigo-builds/seandb-1126/quick_check.ok; KEY="$SZ $(stat -c %Y "$SNAP")"
if [ "$(cat $QC 2>/dev/null)" != "$KEY" ]; then
  R=$(python3 -I -c 'import sqlite3,sys; c=sqlite3.connect("file:%s?immutable=1&mode=ro"%sys.argv[1],uri=True); print(c.execute("pragma quick_check").fetchone()[0])' "$SNAP" 2>&1)
  [ "$R" = "ok" ] || { finish 4 "MEMGATE-ERR $S10 snapshot quick_check: ${R:0:60}"; exit 4; }
  echo "$KEY" > $QC
fi
fi
LH=$(git --git-dir=$HUB show $SHA:pnpm-lock.yaml | sha256sum | cut -c1-16); NM=/root/fuigo-builds/tools/nm/$LH/node_modules
[ -d "$NM" ] || { finish 5 "MEMGATE-ERR $S10 no shared node_modules for lockfile $LH"; exit 5; }
# ---- a run killed with SIGKILL skips its trap (review M8): remove private run dirs older than 3 h whose container is gone
# only this script's own run dirs (<sha10>-<stamp>-<pid>); other lanes keep their own dirs here and are never touched
for old in $(find "$PRIV" -mindepth 1 -maxdepth 1 -type d -mmin +180 -regextype posix-extended -regex '.*/[0-9a-f]{10}-[0-9]{8}T[0-9]{6}Z-[0-9]+' 2>/dev/null); do
  [ -z "$(docker ps -q --filter name=$(basename "$old")\$)" ] && rm -rf "${old:?}"
done
# ---- private run dir: tree export + store copy
mkdir -p "$RUN/tree" "$RUN/data/snap"; chmod 700 "$PRIV"
STARTED=0
cleanup() { [ "$STARTED" = 1 ] && docker rm -f "$NAME" >/dev/null 2>&1; [ -d "$RUN" ] && rm -rf "${RUN:?}"; }
trap cleanup EXIT
git --git-dir=$HUB archive "$SHA" | tar -x -C "$RUN/tree"
cp "$RIG/memgate-1024.test.ts" "$RUN/tree/server/"
# q1023-wstart (MAIN 2026-11-27): the engine-exclusion addon. A packaged build cannot be assembled without it (engine-exclusion.ts:204),
# but a git archive has none, so every memory helper the rig started threw BG_ENFORCEMENT_UNAVAILABLE at load (helper-admission.ts:36 ->
# io-meter.ts:178) and exited 1 before ready: START_FAILED, the capture helper never ran. The rig now ships the same verified addon every
# test container gets (tools/it-remote.sh: key = native source + build recipe, build.json sourceSha256/image/sha256 checked). No build here:
# a cache miss is a rig error, never a run without the addon. BG_ADDON=0 reproduces the old rig (no addon) for comparison only.
if [ "${BG_ADDON:-1}" = 1 ] && [ -f "$RUN/tree/native/engine-exclusion/exclusion.c" ]; then
  NAD=/root/fuigo-builds/tools/native-addons; D=$RUN/tree
  ASRC=$(cat "$D/native/engine-exclusion/exclusion.c" "$D/native/engine-exclusion/meter.c" "$D/native/engine-exclusion/sqlite/sqlite3.h" "$D/native/engine-exclusion/sqlite/sqlite3ext.h" "$D/native/engine-exclusion/sentinel-io.h" | sha256sum | cut -c1-64)
  AKEY=$( { ( cd "$D/native/engine-exclusion" && find . -type f ! -path './test/*' ! -name '*.node-test.mjs' -print0 | LC_ALL=C sort -z | xargs -0 sha256sum ); sha256sum "$D/scripts/build-engine-exclusion.mjs" "$D/scripts/linux-floor.mjs" | cut -c1-64; } | sha256sum | cut -c1-16)
  AIMG=$(sed -n 's/^export const LINUX_FLOOR_IMAGE = "\(docker\.io\/library\/almalinux:8@sha256:[0-9a-f]\{64\}\)";$/\1/p' "$D/scripts/linux-floor.mjs")
  AR=$NAD/src-$ASRC-k$AKEY/engine-exclusion/linux-x64; aj() { sed -n "s/^ *\"$1\": *\"\([^\"]*\)\".*/\1/p" "$AR/build.json" | head -1; }
  if [ -s "$AR/build.json" ] && [ -s "$AR/engine-exclusion.node" ] && [ "$(aj sourceSha256)" = "$ASRC" ] && [ -n "$AIMG" ] && [ "$(aj containerImage)" = "$AIMG" ] && [ "$(aj target)" = linux-x64 ] && [ "$(sha256sum "$AR/engine-exclusion.node" | cut -c1-64)" = "$(aj sha256)" ]; then
    mkdir -p "$D/dist-native/engine-exclusion/linux-x64" && cp -p "$AR/build.json" "$AR/engine-exclusion.node" "$D/dist-native/engine-exclusion/linux-x64/"
    echo "addon=src-${ASRC:0:12}-k$AKEY sha256=$(aj sha256 | cut -c1-16)" > "$EV/addon.txt"
  else finish 5 "MEMGATE-ERR $S10 no verified engine-exclusion addon for src-${ASRC:0:12}-k$AKEY (run any tools/it-remote.sh job on this sha first; never a run without it)"; exit 5; fi
else echo "addon=none BG_ADDON=${BG_ADDON:-1}" > "$EV/addon.txt"; fi
[ "${BG_SYNTH:-0}" = 1 ] || cp --sparse=always "$SNAP" "$RUN/data/snap/messages.db"
chown -R 2001:2001 "$RUN/tree" "$RUN/data"
echo "$(date -u +%FT%TZ) $S10 start (nm $LH, container $NAME)"; STARTED=1
docker run --init --rm --name "$NAME" --label owner=swarm-q1024-memgate --label purpose=test --label expires_at=2026-11-28 \
  --cap-add SYS_PTRACE --user 2001:2001 --cpus 6 --memory 14g --ipc=host --network none \
  -e HOME=/tmp/home -e CI=1 -e NO_COLOR=1 -e TMPDIR=/data/tmp -e NODE_OPTIONS=--max-old-space-size=12000 \
  -e BG_SYNTH=${BG_SYNTH:-0} -e MG_NO_RAISE=${MG_NO_RAISE:-0} -e MG_RECALL_BUDGET_MS=${MG_RECALL_BUDGET_MS:-30000} -e MG_SEARCH_BUDGET_MS=${MG_SEARCH_BUDGET_MS:-5000} -e MG_SAVE_BUDGET_MS=${MG_SAVE_BUDGET_MS:-30000} -e MG_RETRY_WINDOW_MS=${MG_RETRY_WINDOW_MS:-120000} \
  -v "$RUN/tree":/work -v "$NM":/nm:ro -v /root/mb-0161-hz/tools:/tools:ro -v /root/mb-0161-hz/passwd:/etc/passwd:ro -v /root/mb-0161-hz/group:/etc/group:ro \
  -v "$RUN/data":/data -w /work node:24-bookworm \
  bash -c 'mkdir -p /tmp/home /data/tmp; export PATH=/tools/bin:$PATH; mkdir -p node_modules; for f in /nm/* /nm/.[!.]*; do case $f in */.vite-temp|*/.vite|*/.cache) ;; *) ln -sfn $f node_modules/$(basename $f);; esac; done; npx vitest run server/memgate-1024.test.ts' > "$RUN/vitest.log" 2>&1
RC=$?
for f in result.json out.txt; do [ -f "$RUN/data/$f" ] && cp "$RUN/data/$f" "$EV/"; done
tail -c 4000 "$RUN/vitest.log" | grep -E 'Test Files|Tests |✓|×|FAIL|Error:' | cut -c1-200 > "$EV/vitest-tail.txt"
# server.log may hold store text: only fixed codes leave the private dir
python3 -I - "$RUN/data/server.log" > "$EV/server-codes.log" <<'PY'
import re, sys
pats = [(r"turn dispatch recall=(\w+)", "turn dispatch recall={}"), (r"MEMORY_WORKER_[A-Z_]+", "{}"), (r"index drain failed", "index drain failed"), (r"Source capture is still pending", "capture-pending"),
        (r"writer-card-without-hold", "writer-card-without-hold"), (r"\[writer\] recovery failed", "writer recovery failed")]
try: lines = open(sys.argv[1], errors="replace")
except OSError: sys.exit(0)
tok = re.compile(r"\b(?:(?:Range|Reference|Syntax|Type|URI|Eval|Assertion|Aggregate|System)?Error|ERR_[A-Z0-9_]{3,60}|SQLITE_[A-Z_]{2,40}|MEMORY_[A-Z0-9_]{3,60}|BG_[A-Z_]{3,40}|E(?:PIPE|NOENT|ACCES|PERM|BUSY|AGAIN|CONNRESET|NOSPC|IO|EXIST|MFILE|INVAL)|SIG(?:TERM|KILL|ABRT|SEGV|BUS|ILL|INT|HUP))\b")
frame = re.compile(r"([\w@.+-]+\.(?:ts|mts|js|mjs|cjs|node)):(\d+)")
for line in lines:
    for pat, fmt in pats:
        m = re.search(pat, line)
        if m: print(fmt.format(*(m.groups() or [m.group(0)]))); break
    else:
        # lines about the memory mount / proxy / engine child: fixed tokens only (error classes, codes, file:line), never the text
        if re.search(r"murage-memory|memory-proxy|io-proxy|\[claude\]|cli-mount|relay", line) and tok.search(line):
            print("MOUNT-TOKENS", " ".join(sorted(set(tok.findall(line)))), " ".join(f"{a}:{b}" for a, b in frame.findall(line))[:200])
PY
if [ -f "$EV/result.json" ]; then LINE=$(python3 -I "$RIG/memgate-verdict.py" "$EV/result.json" "$S10" "$RC" "$([ "${BG_SYNTH:-0}" = 1 ] && echo synth || echo real)"); else LINE="MEMGATE-1024 $S10 FAIL rig-error vitest-rc=$RC (see $EV/vitest-tail.txt)"; fi
LINE="$LINE $(cut -d' ' -f1 "$EV/addon.txt" 2>/dev/null)"
case "$LINE" in *" PASS "*) RCV=0;; *) RCV=1;; esac
finish $RCV "$LINE"
[ "${POST:-0}" = 1 ] && [ "${BG_SYNTH:-0}" != 1 ] && echo "$LINE $(date -u +%FT%TZ) (owner: q1024-memgate; rig _small/memgate.sh; evidence _small/memgate-runs/$S10-$STAMP)" >> "$BOARD"
exit $RCV
