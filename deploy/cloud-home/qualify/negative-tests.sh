#!/usr/bin/env bash
# Murage Cloud B1 on-VM negative security tests. Run as root ON THE HOME VM.
# Usage: negative-tests.sh [outdir]   (default /root/negative-tests-out)
# Output: one line per check: PASS|FAIL|SKIP <id> <desc> [:: observed]
#         final line: SUMMARY pass=N fail=M skip=K ; exit 0 only if fail=0 AND skip=0
#         (a SKIP means a boundary was not exercised, so it counts against the run).
# "Fail closed": the access attempt must FAIL for the check to PASS.
#
# EGRESS TRAP (read before loading the ruleset on a VM you reach over ssh): deploy/cloud-home/murage-egress.nft
# loads `inet murage_home input` with policy drop and accepts new tcp/22 only from the qual_ssh / qual_ssh_v6
# sets, which are EMPTY by default. Loading the ruleset (murage-egress.service, or a reboot of the built image)
# therefore closes NEW ssh logins; an ssh session that was already open survives (ct established). This gate
# adds the runner's address to the sets before it does anything else: QUAL_SSH_ADDR (space-separated, set it
# when the runner is not the ssh peer, e.g. behind sudo), $SSH_CONNECTION's client address, and the peers of
# the established tcp/22 connections. The sets are not flushed by a ruleset reload (murage-browser-network).
# Keep one ssh session open from the build until this gate has run; if the table is not loaded yet, add the
# runner right after loading it:  nft add element inet murage_home qual_ssh { <runner-ipv4> }   (qual_ssh_v6 for IPv6).
set -u
OUT=${1:-/root/negative-tests-out}
[ "$(id -u)" = 0 ] || { echo "FAIL ENV.root must run as root :: uid=$(id -u)"; echo "SUMMARY pass=0 fail=1 skip=0"; exit 1; }
mkdir -p "$OUT" || exit 1
LOG="$OUT/negative-tests.log"; : >"$LOG"
PASS=0; FAIL=0; SKIP=0
emit() { echo "$*" | tee -a "$LOG"; }
# Open the runner's ssh path in the egress ruleset (see EGRESS TRAP above) before any check can disturb it.
qual_ssh_open() {
  command -v nft >/dev/null && nft list table inet murage_home >/dev/null 2>&1 || { emit "# qual_ssh: inet murage_home not loaded, nothing to open"; return 0; }
  local a set added="" conn=${SSH_CONNECTION:-}
  for a in ${QUAL_SSH_ADDR:-} "${conn%% *}" $(ss -tnH state established '( sport = :22 )' 2>/dev/null | awk '{print $NF}' | sed -E 's/%[^:]*//; s/^\[(.*)\]:[0-9]+$/\1/; s/:[0-9]+$//'); do
    case "$a" in *.*.*.*) set=qual_ssh;; *:*) set=qual_ssh_v6;; *) continue;; esac
    case "$a" in *[!0-9a-fA-F:.]*) continue;; esac
    case " $added " in *" $a "*) continue;; esac
    nft add element inet murage_home "$set" "{ $a }" 2>/dev/null && added="$added $a"
  done
  emit "# qual_ssh: opened for${added:- nobody (no runner address found; set QUAL_SSH_ADDR)}"
}
qual_ssh_open
pass() { PASS=$((PASS+1)); emit "PASS $1 $2"; }
fail() { FAIL=$((FAIL+1)); emit "FAIL $1 $2 :: $3"; }
skip() { SKIP=$((SKIP+1)); emit "SKIP $1 $2 :: $3"; }
asu() { local u=$1; shift; runuser -u "$u" -- "$@"; }

# Probe: python (as user) tries open/listdir/unlink; prints "OK" or the errno name.
PROBE='
import os,sys,errno
mode,path=sys.argv[1],sys.argv[2]
try:
    if mode=="read": os.close(os.open(path,os.O_RDONLY))
    elif mode=="rdwr": os.close(os.open(path,os.O_RDWR))
    elif mode=="list": os.listdir(path)
    elif mode=="unlink": os.unlink(path)
    print("OK")
except OSError as e:
    print(errno.errorcode.get(e.errno,str(e.errno)))
'
# denied <id> <desc> <user> <mode> <path>  : PASS only on EACCES/EPERM; SKIP if path absent (as root)
denied() {
  local id=$1 desc=$2 user=$3 mode=$4 path=$5 r
  if [ ! -e "$path" ]; then skip "$id" "$desc" "path $path absent"; return; fi
  r=$(asu "$user" python3 -I -c "$PROBE" "$mode" "$path" 2>&1 | tail -1)
  case "$r" in EACCES|EPERM) pass "$id" "$desc";;
    # /proc is hidepid=invisible: another user's process is not even visible.
    ENOENT) case "$path" in /proc/*) if [ -n "$HIDEPID" ]; then pass "$id" "$desc (hidden by hidepid)"; else fail "$id" "$desc" "$user $mode $path -> $r"; fi;; *) fail "$id" "$desc" "$user $mode $path -> $r";; esac;;
    *) fail "$id" "$desc" "$user $mode $path -> $r";; esac
}
HIDEPID=$(awk '$2=="/proc" && $4 ~ /hidepid=(2|invisible)/ {print "yes"}' /proc/mounts)
# connect_blocked <id> <desc> <user> <host> <port>: PASS if TCP connect fails/times out
connect_blocked() {
  local id=$1 desc=$2 user=$3 host=$4 port=$5
  if asu "$user" timeout 3 bash -c "</dev/tcp/$host/$port" >/dev/null 2>&1; then
    fail "$id" "$desc" "$user connected to $host:$port"
  else pass "$id" "$desc"; fi
}

REPO_NOTE="sources: deploy/cloud-home/{build-image.sh,murage-egress.nft,*.apparmor,murage-turn-launch.py,*.service}, server/cloud-home/supervisor.ts"
emit "# negative-tests start $(date -u +%FT%TZ) host=$(hostname) $REPO_NOTE"

# Users: deploy/cloud-home/build-image.sh lines 52-55 (useradd murage, murage-turn, murage-browser, murage-proxy)
for u in murage murage-turn murage-browser murage-proxy; do
  id "$u" >/dev/null 2>&1 || { skip ENV.user.$u "user $u exists" "missing"; }
done

main_pid() { systemctl show -p MainPID --value "$1" 2>/dev/null; }
PROXY_PID=$(main_pid murage-proxy)   # deploy/cloud-home/murage-proxy.service (User=murage-proxy)
HOME_PID=$(main_pid murage-home)     # deploy/cloud-home/murage-home.service (supervisor, root)

# ---- as murage ---------------------------------------------------------------
# /proc/<pid>/mem open + PTRACE_ATTACH against supervisor (murage-home.service) and murage-proxy.
PTRACE_PY='
import ctypes,sys,errno
libc=ctypes.CDLL(None,use_errno=True)
libc.ptrace.argtypes=[ctypes.c_long,ctypes.c_long,ctypes.c_void_p,ctypes.c_void_p]
r=libc.ptrace(16,int(sys.argv[1]),None,None)  # PTRACE_ATTACH
e=ctypes.get_errno()
if r==0:
    libc.ptrace(17,int(sys.argv[1]),None,None); print("OK")  # DETACH
else: print(errno.errorcode.get(e,str(e)))
'
for pair in "supervisor:$HOME_PID" "proxy:$PROXY_PID"; do
  nm=${pair%%:*}; pid=${pair##*:}
  if [ -z "$pid" ] || [ "$pid" = 0 ] || [ ! -d "/proc/$pid" ]; then
    skip "murage.ptrace.$nm" "murage cannot ptrace/open mem of $nm" "no running pid"; continue; fi
  denied "murage.procmem.$nm" "murage cannot open /proc/$pid/mem ($nm) rdwr" murage rdwr "/proc/$pid/mem"
  r=$(asu murage python3 -I -c "$PTRACE_PY" "$pid" 2>&1 | tail -1)
  case "$r" in EPERM|EACCES|ESRCH) pass "murage.ptrace.$nm" "murage cannot PTRACE_ATTACH $nm pid $pid ($r)";;
    *) fail "murage.ptrace.$nm" "murage cannot PTRACE_ATTACH $nm pid $pid" "result=$r";; esac
done

# Machine marker: server/cloud-home/supervisor.ts bindHomeVolume: join(dataDir,".murage-home-machine"), dataDir=/data
MARKER=/data/.murage-home-machine
if [ -e "$MARKER" ]; then
  cp -p "$MARKER" "$OUT/marker.bak" 2>/dev/null
  mown=$(stat -c %u:%g "$MARKER"); mmode=$(stat -c %a "$MARKER")
  r=$(asu murage python3 -I -c "$PROBE" unlink "$MARKER" 2>&1 | tail -1)
  case "$r" in
    EACCES|EPERM) pass murage.marker "murage cannot unlink $MARKER";;
    *) fail murage.marker "murage cannot unlink $MARKER" "result=$r"
       [ -e "$MARKER" ] || { install -m "$mmode" -o "${mown%:*}" -g "${mown#*:}" "$OUT/marker.bak" "$MARKER" && emit "# restored $MARKER from backup"; };;
  esac
else skip murage.marker "murage cannot unlink machine marker" "$MARKER absent"; fi

# Credential: deploy/cloud-home/murage-control STATE="/var/lib/murage-home", file "credential" (read_secure)
denied murage.credential "murage cannot read /var/lib/murage-home/credential" murage read /var/lib/murage-home/credential

# ---- as murage-turn ----------------------------------------------------------
# Egress rules: deploy/cloud-home/murage-egress.nft chain output (169.254.169.254, RFC1918, 25/465, loopback drops for murage-turn except 8799)
# Port 8800 (WEBHOOK_PORT in murage-proxy.service); closed port also blocks, so these are fail-closed, not proof of the nft rule alone.
# Port 8799 (MURAGE_PORT, server/cloud-home/boot.ts) is deliberately ALLOWED for murage-turn (murage-egress.nft), so it is not checked here.
# Port 2019: Caddyfile has `admin off`; nothing may listen on it at all.
if [ -z "$(ss -ltnH 'sport = :2019' 2>/dev/null)" ]; then pass admin.2019.closed "nothing listens on port 2019 (Caddy admin off)"; else fail admin.2019.closed "nothing listens on port 2019 (Caddy admin off)" "$(ss -ltnH 'sport = :2019' | head -1)"; fi
for t in 127.0.0.1:8800 169.254.169.254:80 10.0.0.1:80 192.168.0.1:80 172.16.0.1:80 1.1.1.1:25 1.1.1.1:465 8.8.8.8:25 8.8.8.8:465; do
  h=${t%%:*}; p=${t##*:}
  connect_blocked "turn.connect.$h.$p" "murage-turn cannot connect to $h:$p" murage-turn "$h" "$p"
done
# Engine homes: server/cloud-home/supervisor.ts creates /data/engine-homes/<engine> as root:murage-eng-<engine> 2770. Neither murage
# nor murage-turn is a member (runuser gives no supplementary engine group), so outside bwrap both must get EACCES on list and read.
# Only the launcher adds exactly one engine group inside the sandbox. Credential paths from murage-turn-launch.py RECOVERY_CREDENTIALS.
declare -A CRED=( [claudeAgent]=.claude/.credentials.json [codex]=.codex/auth.json [grokAgent]=.grok/auth.json [kimiAgent]=.kimi-code/credentials [opencodeGo]=.local/share/opencode/auth.json )
ENGINES=(claudeAgent codex pi antigravity grokAgent geminiAgent kimiAgent droidAgent cursorAgent customAcp fuigoAgent hermesAgent opencodeGo qwenAgent)
engine_home_denied() {
  local u=$1 eng f
  for eng in "${ENGINES[@]}"; do
    denied "$u.engine-home.list.$eng" "$u cannot list /data/engine-homes/$eng" "$u" list "/data/engine-homes/$eng"
    denied "$u.engine-home.read.$eng" "$u cannot open /data/engine-homes/$eng" "$u" read "/data/engine-homes/$eng"
    f=/data/engine-homes/$eng/${CRED[$eng]:-}
    if [ -n "${CRED[$eng]:-}" ] && [ -e "$f" ]; then denied "$u.engine-cred.$eng" "$u cannot read engine credential $f" "$u" read "$f"; fi
  done
}
engine_home_denied murage-turn
# ---- as murage (server uid) ---- same denial expected
engine_home_denied murage
# ---- through the launcher, with the pinned qualification probe ---------------
# probe.c is compiled here (static), installed root:root 0755, and TEMPORARILY pinned in the engine
# manifest for codex and claudeAgent. The original manifest is restored byte-for-byte on exit.
MANIFEST=/opt/murage/engine-manifest.json
PROBE_SRC=$(cd "$(dirname "$0")" && pwd)/probe.c
PROBE_BIN=/usr/local/libexec/murage-qual-probe
MANIFEST_BAK="$OUT/engine-manifest.orig"; MANIFEST_HAD=0; MANIFEST_TOUCHED=0
restore_manifest() {
  [ "$MANIFEST_TOUCHED" = 1 ] || return 0
  if [ "$MANIFEST_HAD" = 1 ]; then cp -p "$MANIFEST_BAK" "$MANIFEST" && cmp -s "$MANIFEST_BAK" "$MANIFEST" || echo "FAIL ENV.manifest-restore manifest not restored byte-for-byte :: see $MANIFEST_BAK" >&2
  else rm -f "$MANIFEST"; fi
  MANIFEST_TOUCHED=0
}
trap restore_manifest EXIT
trap 'restore_manifest; exit 130' INT TERM
LAUNCH_OK=0
if [ ! -r "$PROBE_SRC" ]; then fail launcher.probe-build "probe.c present" "$PROBE_SRC missing"
elif ! command -v gcc >/dev/null; then fail launcher.probe-build "gcc available on VM" "gcc missing"
elif ! gcc -static -O2 -o "$OUT/murage-qual-probe" "$PROBE_SRC" >"$OUT/probe-build.log" 2>&1; then fail launcher.probe-build "probe.c compiles" "see $OUT/probe-build.log"
else
  install -o root -g root -m 0755 "$OUT/murage-qual-probe" "$PROBE_BIN"
  PSHA=$(sha256sum "$PROBE_BIN" | cut -d' ' -f1)
  if [ -e "$MANIFEST" ]; then cp -p "$MANIFEST" "$MANIFEST_BAK"; MANIFEST_HAD=1; fi
  MANIFEST_TOUCHED=1
  if python3 -I - "$MANIFEST" "$PROBE_BIN" "$PSHA" "$MANIFEST_HAD" <<'PY'
import json,os,sys
path,probe,sha,had=sys.argv[1:5]
m=json.load(open(path)) if had=="1" else {}
for e in ("codex","claudeAgent"):
    m.setdefault(e,[])
    m[e]=[x for x in m[e] if x.get("path")!=probe]+[{"path":probe,"sha256":sha}]
tmp=path+".qual.tmp"
with open(tmp,"w") as f: json.dump(m,f)
os.chmod(tmp,0o644); os.chown(tmp,0,0); os.replace(tmp,path)
PY
  then LAUNCH_OK=1; pass launcher.probe-pinned "probe $PSHA pinned for codex+claudeAgent (temporary)"
  else fail launcher.probe-pinned "probe pinned in manifest" "manifest edit failed"; fi
fi
# turn <engine> <args...>: invoke the probe exactly as server/cloud-home/turn-process.ts does (sudo -n -C 4 + request on FD 3).
# The launcher renders the engine's config itself and accepts only the engine's argv grammar,
# so the probe runs under that argv and reads its command from stdin (probe.c).
# Every turn names its bot (murage-turn-launch.py: "Cloud turn names no bot"); QUAL_BOT is provisioned
# below the way a real home does it. TURN_CWD (default: the engine home) is the turn's cwd; a workspace
# cwd is reached the way a real turn reaches it: the launcher (root) opens it and anchors it under
# /run/murage-turn before it drops to murage-turn, so /data/home stays 0700 for murage.
QUAL_BOT=qualbot-0001
TURN_CWD=
turn() {
  local eng=$1; shift
  local req; req=$(mktemp "$OUT/req.XXXXXX"); chmod 0644 "$req"
  python3 -I - "$eng" "$PROBE_BIN" "$QUAL_BOT" "$TURN_CWD" >"$req" <<'PY'
import json,sys
eng,cmd,bot,cwd=sys.argv[1:5]
home="/data/engine-homes/"+eng
args={"codex":["app-server"],"claudeAgent":["-p","--output-format","stream-json","--input-format","stream-json","--verbose","--include-partial-messages","--permission-mode","acceptEdits","--strict-mcp-config"]}[eng]
print(json.dumps({"engine":eng,"command":cmd,"args":args,"cwd":cwd or home,"bot":bot,"env":{"LANG":"C.UTF-8"}}))
PY
  printf '%s\n' "$*" | timeout 30 runuser -u murage -- /usr/bin/sudo -n -C 4 -- /usr/local/libexec/murage-turn-launch 3<"$req" 2>&1
  local rc=$?; rm -f "$req"; return $rc
}
# lr <id> <desc> <acceptable-regex> <engine> <probe args...>: FAIL unless the probe's last output line matches.
lr() {
  local id=$1 desc=$2 ok=$3 eng=$4; shift 4
  local r; r=$(turn "$eng" "$@" | tr -d '\r' | tail -1)
  if printf '%s' "$r" | grep -Eq "^($ok)$"; then pass "$id" "$desc ($r)"; else fail "$id" "$desc" "got: ${r:-<empty>}"; fi
}
if [ "$LAUNCH_OK" = 1 ]; then
  ST=$(turn codex status | tr -d '\r')
  printf '%s\n' "$ST" | grep -Eq '^Seccomp:[[:space:]]+2$' && pass launcher.seccomp "turn runs with Seccomp=2" || fail launcher.seccomp "turn runs with Seccomp=2" "$(printf '%s' "$ST" | tr '\n' ' ')"
  printf '%s\n' "$ST" | grep -Eq '^NoNewPrivs:[[:space:]]+1$' && pass launcher.nonewprivs "turn runs with NoNewPrivs=1" || fail launcher.nonewprivs "turn runs with NoNewPrivs=1" "$(printf '%s' "$ST" | tr '\n' ' ')"
  printf '%s\n' "$ST" | grep -Eq '^CapEff:[[:space:]]+0+$' && pass launcher.capeff "turn runs with CapEff=0" || fail launcher.capeff "turn runs with CapEff=0" "$(printf '%s' "$ST" | tr '\n' ' ')"
  lr launcher.unshare-user "unshare(CLONE_NEWUSER) inside a turn fails" 'EPERM|ENOSPC|EINVAL' codex unshare-user
  lr launcher.cross-engine.codex "turn for codex cannot see /data/engine-homes/claudeAgent" 'ENOENT|EACCES' codex stat /data/engine-homes/claudeAgent
  lr launcher.cross-engine.claude "turn for claudeAgent cannot see /data/engine-homes/codex" 'ENOENT|EACCES' claudeAgent stat /data/engine-homes/codex
  lr launcher.connect.metadata "turn cannot connect to 169.254.169.254:80" 'E[A-Z]+' codex connect 169.254.169.254 80
  lr launcher.connect.proxy "turn cannot connect to 127.0.0.1:8800" 'E[A-Z]+' codex connect 127.0.0.1 8800
  # Binds inside the turn must not touch the host: real server keeps 8799, nothing from the turn listens afterwards.
  turn codex bind 8799 >"$OUT/bind-8799.txt" 2>&1; turn codex bind 8800 >"$OUT/bind-8800.txt" 2>&1
  L=$(ss -ltnpH 2>/dev/null)
  if printf '%s\n' "$L" | grep -E '[:.]8799[[:space:]]' | grep -q .; then
    if printf '%s\n' "$L" | grep -E '[:.]8799[[:space:]]' | grep -q 'murage-qual-probe'; then fail launcher.bind.8799 "real server still owns 8799 after turn bind" "probe holds 8799"; else pass launcher.bind.8799 "host 8799 listener unchanged after turn bind"; fi
  else fail launcher.bind.8799 "real server still owns 8799 after turn bind" "no listener on 8799"; fi
  if printf '%s\n' "$L" | grep -Eq 'murage-qual-probe|murage-turn'; then fail launcher.bind.leak "nothing from murage-turn listens on the host" "$(printf '%s\n' "$L" | grep -E 'murage-qual-probe|murage-turn' | head -2 | tr '\n' ' ')"; else pass launcher.bind.leak "nothing from murage-turn listens on the host"; fi
else
  for c in seccomp nonewprivs capeff unshare-user cross-engine.codex cross-engine.claude connect.metadata connect.proxy bind.8799 bind.leak; do fail "launcher.$c" "through-the-launcher check" "probe not built/pinned"; done
fi
# (the probe stays pinned through the placeholder section below, which also runs its turns through the launcher)
# A2: the host stub is no longer reachable by a turn. A plain murage-turn process (no engine gid) is
# not redirected and not accepted, so its query to 127.0.0.53 gets no answer. The per-engine
# redirect to the synthetic forwarder is proven by the home-level DNS checks, not here.
DNSPY='
import socket,struct
q=struct.pack(">HHHHHH",0x1234,0x0100,1,0,0,0)+b"\x07example\x03com\x00"+struct.pack(">HH",1,1)
s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); s.settimeout(3)
try:
    s.sendto(q,("127.0.0.53",53)); d=s.recv(512); print("ANSWERED")
except OSError:
    print("BLOCKED")
'
r=$(asu murage-turn python3 -I -c "$DNSPY" 2>&1 | tail -1)
[ "$r" = BLOCKED ] && pass turn.dns.stub-closed "murage-turn cannot reach the host stub 127.0.0.53" || fail turn.dns.stub-closed "murage-turn cannot reach the host stub 127.0.0.53" "$r"

# ---- r5 R5.1 workspace placeholders (real-home gate: root, ext4) ------------
# The immutable flag needs CAP_LINUX_IMMUTABLE in the initial user namespace, so only the
# home proves it (design r5 fixture 2, r6). Every sandbox here is a real launcher turn: the bot's
# workspace is provisioned the way the server does (created by murage, which owns /data/home 0700),
# and the launcher, as root, opens it, anchors it under /run/murage-turn, places the placeholders
# with its own ensure_placeholder and only then drops to murage-turn (a bare bwrap as murage-turn
# cannot walk /data/home). The probe (probe.c mask|chattr) then runs the operations inside the turn:
#   cwd:    a turn whose cwd holds the placeholders. The launcher mounts a read-only tmpfs mask over every
#           MASK_NAMES name of every directory it binds, so the sandbox meets the mask, not the bare
#           placeholder: rmdir and rename get EPERM (or EBUSY), mkdir inside and chattr get EROFS (or EPERM);
#   parent: a turn whose cwd is the workspace's parent, the writer in another namespace that could take
#           a child's mask away. It meets the bare immutable placeholder: EPERM on rmdir, rename (both
#           directions), mkdir inside and chattr -i, and the flag stays set.
# Root's own mkdir inside a placeholder gets EPERM too; a tmpfs mounts over one; nothing lands on disk
# under the launcher's mask.
WS=/data/home/workspaces/$QUAL_BOT
qm_clean() {
  [ -d "$WS" ] || return 0
  # Only the qualification bot's own workspace, never another bot's or the workspaces root.
  case "${WS:?}" in /data/home/workspaces/qualbot-[0-9][0-9][0-9][0-9]) ;; *) emit "# qm_clean: refused $WS"; return 1 ;; esac
  [ -L "$WS" ] && { emit "# qm_clean: refused symlink $WS"; return 1; }
  find "$WS" -xdev -maxdepth 3 -type d -exec chattr -i {} + 2>/dev/null
  rm -rf -- "${WS:?}"
}
mask_ops() { # <engine> <cwd> <path>: the probe's `mask` lines, one "op ERRNO" each
  TURN_CWD=$2 turn "$1" mask "$3" | tr -d '\r'
}
qm_clean
if [ "$LAUNCH_OK" != 1 ]; then
  fail placeholder.env "placeholder gate needs the pinned probe" "probe not built/pinned"
elif [ ! -d /data/home ] || ! command -v chattr >/dev/null || ! command -v lsattr >/dev/null; then
  fail placeholder.env "placeholder gate prerequisites (/data/home, chattr, lsattr)" "missing"
elif ! runuser -u murage -- sh -c 'mkdir -p "$1/proj" && chmod 0770 "$1" "$1/proj"' sh "$WS"; then
  fail placeholder.env "placeholder gate workspace provisioned as the server uid" "could not create $WS/proj as murage"
else
  NAMES=".claude .codex .fuigo .grok .kimi-code .opencode"
  # The first turn of the bot: the launcher itself places every placeholder in its cwd.
  TURN_CWD=$WS/proj turn claudeAgent status >"$OUT/placeholder-ensure.txt" 2>&1
  TURN_CWD=$WS turn codex status >>"$OUT/placeholder-ensure.txt" 2>&1
  for n in $NAMES; do
    P="$WS/proj/$n"
    if [[ "$(stat -c '%u %a' "$P" 2>/dev/null)" =~ ^0\ 2?555$ ]] && lsattr -d "$P" 2>/dev/null | cut -d' ' -f1 | grep -q i; then pass "placeholder.ensure.$n" "the launcher placed $n as root 0555 (setgid inherited) immutable"
    else fail "placeholder.ensure.$n" "the launcher placed $n as root 0555 immutable" "$(stat -c '%u %a' "$P" 2>&1) $(lsattr -d "$P" 2>&1) $(tail -1 "$OUT/placeholder-ensure.txt")"; fi
  done
  for who in cwd parent; do
    for n in $NAMES; do
      P="$WS/proj/$n"
      eng=codex; if [ "$who" = cwd ]; then dir=$WS/proj; okre='EPERM|EBUSY'; mkre='EPERM|EROFS'; else dir=$WS; okre=EPERM; mkre=EPERM; fi
      R=$(mask_ops "$eng" "$dir" "$P")
      for op in rmdir rename-away rename-onto mkdir-inside; do
        got=$(printf '%s\n' "$R" | awk -v op="$op" '$1==op {print $2}')
        re=$okre; [ "$op" = mkdir-inside ] && re=$mkre
        printf '%s' "$got" | grep -Eq "^($re)$" && pass "placeholder.$who.$op.$n" "sandbox with $who cwd gets $re on $op of $n" || fail "placeholder.$who.$op.$n" "sandbox with $who cwd gets $re on $op of $n" "got: ${got:-$(printf '%s' "$R" | tail -1)}"
      done
      C=$(TURN_CWD=$dir turn "$eng" chattr "$P" | tr -d '\r' | tail -1)
      if printf '%s' "$C" | grep -Eq "^($mkre)$" && lsattr -d "$P" 2>/dev/null | cut -d' ' -f1 | grep -q i; then pass "placeholder.$who.chattr.$n" "sandbox with $who cwd gets $mkre on chattr -i $n"
      else fail "placeholder.$who.chattr.$n" "sandbox with $who cwd gets $mkre on chattr -i $n and the flag stays set" "got: ${C:-<none>}; $(lsattr -d "$P" 2>&1)"; fi
    done
  done
  P="$WS/proj/.claude"
  r=$(python3 -I -c 'import os,sys,errno
try: os.mkdir(sys.argv[1]+"/x"); print("OK")
except OSError as e: print(errno.errorcode.get(e.errno,str(e.errno)))' "$P" 2>&1 | tail -1)
  [ "$r" = EPERM ] && pass placeholder.root.mkdir "the launcher's own (root) mkdir inside a placeholder gets EPERM" || fail placeholder.root.mkdir "the launcher's own (root) mkdir inside a placeholder gets EPERM" "got: $r"
  if unshare --mount --propagation private /bin/sh -c 'mount -t tmpfs -o size=1m tmpfs "$1" && touch "$1/probe" && umount "$1"' sh "$P" >"$OUT/placeholder-tmpfs.txt" 2>&1; then pass placeholder.tmpfs "a tmpfs mounts over an immutable placeholder"
  else fail placeholder.tmpfs "a tmpfs mounts over an immutable placeholder" "$(tr '\n' ' ' <"$OUT/placeholder-tmpfs.txt")"; fi
  # The launcher's own mask: a turn at cwd=proj mounts a read-only tmpfs over proj/.claude.
  R=$(mask_ops claudeAgent "$WS/proj" "$P")
  bad=""
  for pair in rmdir:EPERM\|EBUSY rename-away:EPERM\|EBUSY mkdir-inside:EROFS; do
    got=$(printf '%s\n' "$R" | awk -v op="${pair%%:*}" '$1==op {print $2}'); printf '%s' "$got" | grep -Eq "^(${pair##*:})$" || bad="$bad ${pair%%:*}=${got:-?}"
  done
  if [ -z "$bad" ] && [ -z "$(ls -A "$P")" ]; then pass placeholder.launcher-mask "the launcher's mask over a placeholder cannot be removed or renamed and nothing lands on disk"
  else fail placeholder.launcher-mask "the launcher's mask over a placeholder cannot be removed or renamed and nothing lands on disk" "unexpected:$bad; on disk: $(ls -A "$P" | tr '\n' ' ')"; fi
fi
qm_clean
[ -e "$WS" ] && fail placeholder.cleanup "the gate's placeholders are released and removed" "$WS remains"
restore_manifest

# ---- as murage-browser -------------------------------------------------------
# Data layout: server/cloud-home/supervisor.ts (/data/home, /data/home/secrets, /data/engine-homes/<engine>)
denied browser.home.secrets "murage-browser cannot list /data/home/secrets" murage-browser list /data/home/secrets
n=0; for f in /data/home/*.sqlite; do [ -e "$f" ] || continue; n=$((n+1)); denied "browser.sqlite.$n" "murage-browser cannot read $f" murage-browser read "$f"; done
if [ "$n" -eq 0 ] && [ -d /data/home ]; then
  # Fresh home: a canary written by murage with its own umask stands in for the server's databases.
  canary=/data/home/qual-canary.sqlite
  if runuser -u murage -- sh -c "printf x > $canary" 2>/dev/null; then
    denied browser.sqlite "murage-browser cannot read a murage-written /data/home/*.sqlite (canary)" murage-browser read "$canary"; rm -f "$canary"
  else skip browser.sqlite "murage-browser cannot read /data/home/*.sqlite" "no *.sqlite and canary write failed"; fi
elif [ "$n" -eq 0 ]; then skip browser.sqlite "murage-browser cannot read /data/home/*.sqlite" "no /data/home"; fi
denied browser.engine-homes "murage-browser cannot list /data/engine-homes" murage-browser list /data/engine-homes
for d in /data/engine-homes/*/; do [ -d "$d" ] || continue; denied "browser.engine-home.$(basename "$d")" "murage-browser cannot list $d" murage-browser list "$d"; done
# 8799 (MURAGE_PORT) is allowed for murage-turn by design; murage-browser loopback is dropped (nft).
connect_blocked browser.connect.8799 "murage-browser cannot connect to 127.0.0.1:8799" murage-browser 127.0.0.1 8799
if command -v sudo >/dev/null; then
  if asu murage-browser sudo -n true >/dev/null 2>&1; then fail browser.sudo "murage-browser sudo -n true fails" "sudo succeeded"; else pass browser.sudo "murage-browser sudo -n true fails"; fi
else skip browser.sudo "murage-browser sudo -n true fails" "sudo not installed"; fi

# ---- as murage-proxy ---------------------------------------------------------
denied proxy.data-home "murage-proxy cannot list /data/home" murage-proxy list /data/home
denied proxy.home-secrets "murage-proxy cannot list /data/home/secrets" murage-proxy list /data/home/secrets

# ---- port 587 meter ----------------------------------------------------------
# murage-egress.nft: limit smtp_new_home { rate over 30/hour; burst 1 packets; } on "ct state new tcp dport 587 ... drop"
NFT=/etc/murage-home/murage-egress.nft; [ -r "$NFT" ] || NFT=$(dirname "$0")/../murage-egress.nft
RATE=$(grep -o 'smtp_new_home { rate over [0-9]*/[a-z]*; burst [0-9]*' "$NFT" 2>/dev/null | head -1)
cnt() { nft list chain inet murage_home output 2>/dev/null | awk '/murage smtp blocked/ { for(i=1;i<=NF;i++) if($i=="packets"){print $(i+1); exit} }'; }
b=$(cnt)
if [ -z "$b" ]; then skip port587.meter "excess new flows to :587 are dropped" "smtp drop rule/counter not in live ruleset"; else
  asu murage-turn python3 -I -c '
import socket,select
ss=[]
for _ in range(45):
    s=socket.socket(); s.setblocking(False)
    try: s.connect_ex(("1.1.1.1",587))
    except OSError: pass
    ss.append(s)
select.select([],[],[],2)
' >/dev/null 2>&1
  a=$(cnt); d=$(( ${a:-0} - b ))
  if [ "$d" -gt 0 ]; then pass port587.meter "45 new flows to :587 as murage-turn, meter [$RATE] dropped $d"; else fail port587.meter "excess new flows to :587 are dropped" "counter delta=$d (meter: $RATE)"; fi
fi

# ---- Chromium sandbox --------------------------------------------------------
# --no-sandbox is a blocked flag in murage-turn-launch.py (line ~38); verify no live process has it.
bad=""; chrome_pids=""
for p in /proc/[0-9]*; do
  c=$(tr '\0' ' ' <"$p/cmdline" 2>/dev/null) || continue
  case "$c" in *chrome*|*chromium*) chrome_pids="$chrome_pids ${p#/proc/}"; case "$c" in *--no-sandbox*) bad="$bad ${p#/proc/}";; esac;; esac
done
[ -z "$bad" ] && pass chromium.nosandbox "no chromium process has --no-sandbox" || fail chromium.nosandbox "no chromium process has --no-sandbox" "pids:$bad"
# deploy/cloud-home/chromium.apparmor / bwrap.apparmor
# Ubuntu restricts unprivileged user namespaces: a bare unshare as the browser
# uid must fail, while bwrap (0750 root:murage-sandbox, AppArmor "bwrap") may.
if asu murage-browser unshare -Ur true >/dev/null 2>&1; then fail chromium.userns.bare "bare unshare -Ur as murage-browser is denied" "unshare succeeded"; else pass chromium.userns.bare "bare unshare -Ur as murage-browser is denied"; fi
BB=/usr/local/libexec/murage-browser-bwrap
if runuser -u murage-browser -- $BB --unshare-user --ro-bind / / --proc /proc --dev /dev -- unshare -Urnp -f true >/dev/null 2>&1; then pass chromium.userns.bwrap "murage-browser's bwrap allows the nested user/net/pid namespaces Chromium's sandbox needs"; else fail chromium.userns.bwrap "murage-browser's bwrap allows the nested user/net/pid namespaces Chromium's sandbox needs" "nested unshare failed"; fi
# The browser bwrap is murage-browser's alone; turns and the home server keep /usr/bin/bwrap or nothing.
for u in murage-turn murage murage-proxy; do
  if runuser -u $u -- $BB --ro-bind / / -- /bin/true >/dev/null 2>&1; then fail browser.bwrap.$u "$u cannot execute the browser bwrap" "executed"; else pass browser.bwrap.$u "$u cannot execute the browser bwrap"; fi
done
if runuser -u murage-browser -- /usr/bin/bwrap --ro-bind / / -- /bin/true >/dev/null 2>&1; then fail browser.turnbwrap "murage-browser cannot execute the turn bwrap" "executed"; else pass browser.turnbwrap "murage-browser cannot execute the turn bwrap"; fi
if command -v aa-status >/dev/null; then
  AA=$(aa-status 2>&1)
  for prof in bwrap unpriv_bwrap murage-pasta murage-browser-bwrap murage-browser; do
    echo "$AA" | grep -qE "^[[:space:]]+$prof\$" && pass "apparmor.$prof" "apparmor profile $prof loaded" || fail "apparmor.$prof" "apparmor profile $prof loaded" "not in aa-status"
  done
else skip apparmor "chromium/bwrap profiles loaded" "aa-status not installed"; fi
# Distinct net namespaces per bot (browsers started by murage-browser-namespace.py)
hostns=$(readlink /proc/1/ns/net); declare -A NS=(); hostshare=""
nchrome=0
for p in $chrome_pids; do
  [ "$(stat -c %U "/proc/$p" 2>/dev/null)" = murage-browser ] || continue
  nchrome=$((nchrome+1)); ns=$(readlink "/proc/$p/ns/net" 2>/dev/null) || continue
  [ "$ns" = "$hostns" ] && hostshare="$hostshare $p" || NS[$ns]=1
done
if [ -n "$hostshare" ]; then fail chromium.netns "browser processes are in non-host net namespaces" "in host netns, pids:$hostshare"
elif [ "${#NS[@]}" -ge 2 ]; then pass chromium.netns "two+ bots' browsers are in different net namespaces (${#NS[@]} distinct)"
else skip chromium.netns "two bots' browsers in different net namespaces" "fewer than two browser netns (browser procs=$nchrome, distinct ns=${#NS[@]})"; fi

# ---- nft ruleset -------------------------------------------------------------
nft list ruleset >"$OUT/nft-ruleset.txt" 2>&1
# Table names from deploy/cloud-home/murage-egress.nft: inet murage_home, ip murage_browser_nat
for t in "inet murage_home" "ip murage_browser_nat"; do
  grep -q "^table $t " "$OUT/nft-ruleset.txt" && pass "nft.table.${t##* }" "nft ruleset contains table $t" || fail "nft.table.${t##* }" "nft ruleset contains table $t" "missing"
done

# HOME-02: no cp_endpoints exception may be reachable by murage-turn/browser/proxy.
# The private-range drop for every uid except root and "murage" must be unconditional
# (no "@cp_endpoints" on its line); only the uid "murage" rules may reference the sets.
OUTR=$(nft list chain inet murage_home output 2>&1)
MU=$(id -u murage)   # nft prints meta skuid as a number
if printf '%s\n' "$OUTR" | grep -E '10\.0\.0\.0/8|fc00::/7' | grep -E 'cp_endpoints' | grep -vE "skuid (\"?murage\"?|$MU) " >/dev/null; then
  fail nft.cp_endpoints.scope "cp_endpoints exception applies only to uid murage" "$(printf '%s\n' "$OUTR" | grep cp_endpoints | head -3 | tr '\n' ' ')"
elif printf '%s\n' "$OUTR" | grep -E '10\.0\.0\.0/8' | grep -Eq "skuid != \{ ?0, (\"?murage\"?|$MU) ?\}.* drop\$" ; then
  pass nft.cp_endpoints.scope "private-range drop for non-root/non-murage uids has no cp_endpoints exception"
else fail nft.cp_endpoints.scope "unconditional private-range drop for uids other than root/murage" "rule not found in listed output chain"; fi

# ---- host firewall input policy and AppArmor userns -------------------------
# murage-egress.nft: table inet murage_home. A default-drop `input` chain is added by another builder; FAIL until present.
IN=$(nft list chain inet murage_home input 2>&1)
if printf '%s' "$IN" | grep -Eq 'policy drop'; then pass nft.input.policy "inet murage_home input chain has policy drop"
else fail nft.input.policy "inet murage_home input chain has policy drop" "$(printf '%s' "$IN" | head -2 | tr '\n' ' ')"; fi
if command -v aa-status >/dev/null; then
  AAF=$(aa-status 2>&1)
  UNC=$(grep -lE 'flags=\([^)]*unconfined' /etc/apparmor.d/* 2>/dev/null | xargs -r grep -lE 'bwrap' 2>/dev/null | head -3 | tr '\n' ' ')
  if [ -n "$UNC" ]; then fail apparmor.bwrap.userns "bwrap profile is not the unconfined userns-allow flags profile" "unconfined-flags profile for bwrap: $UNC"
  elif printf '%s\n' "$AAF" | grep -Eq 'bwrap'; then pass apparmor.bwrap.userns "loaded bwrap profile is not an unconfined flags profile"
  else fail apparmor.bwrap.userns "bwrap child profile loaded and denies userns" "no bwrap profile in aa-status"; fi
else fail apparmor.bwrap.userns "bwrap child profile denies userns" "aa-status not installed"; fi

# ---- systemd descriptor passage (r9 "R8 fixture 16") -------------------------
# The turn supervisor hands its admission locks through `systemd-run --scope` (murage-turn-launch.py
# admit/remap_admission/enter_scope). The stand-in fixture cannot qualify systemd itself: here an
# inheritable flock descriptor must arrive open inside the scope and still be the lock holder
# (fcntl F_GETFD succeeds, LOCK_EX|LOCK_NB on it succeeds, a fresh open of the file is refused).
if command -v systemd-run >/dev/null; then
  FDLOCK="$OUT/fd-passage.lock"; : >"$FDLOCK"
  FDR=$(python3 -I - "$FDLOCK" 2>&1 <<'PY'
import fcntl, os, subprocess, sys
fd = os.open(sys.argv[1], os.O_RDWR)
fcntl.flock(fd, fcntl.LOCK_EX)
os.dup2(fd, 9, inheritable=True)
inner = """import fcntl, os, sys
fcntl.fcntl(9, fcntl.F_GETFD)
fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)
try:
    fcntl.flock(os.open(sys.argv[1], os.O_RDWR), fcntl.LOCK_EX | fcntl.LOCK_NB)
    print("NOT-LOCKED")
except BlockingIOError:
    print("OPEN-LOCKED")
"""
r = subprocess.run(["systemd-run", "--scope", "--quiet", "--", "/usr/bin/python3", "-I", "-c", inner, sys.argv[1]], pass_fds=(9,), capture_output=True, text=True, timeout=60)
print(((r.stdout + r.stderr).strip().splitlines() or ["no output"])[-1] + " exit=" + str(r.returncode))
PY
)
  case "$FDR" in "OPEN-LOCKED exit=0") pass systemd.fd.passage "inheritable flock descriptor is open and locked inside a systemd-run scope";;
    *) fail systemd.fd.passage "inheritable flock descriptor is open and locked inside a systemd-run scope" "$FDR";; esac
  rm -f "$FDLOCK"
else fail systemd.fd.passage "inheritable flock descriptor is open and locked inside a systemd-run scope" "systemd-run not installed"; fi


# ---- LANE-G r3: no release-slot byte as uid 0 (T-P1, T-P3, T-P4, T-G5, T-L1') -------------------------------
# T-P1: for the life of this run, no process in murage-home.service's cgroup or the turn/browser slices runs with uid 0 and an
# executable or a mapped file under /opt/murage-releases (the image's root launchers in /usr/local/libexec are the only root code).
P1_HITS=$(python3 -I - <<'PY'
import os, re
hits = []
for pid in [p for p in os.listdir("/proc") if p.isdigit()]:
    try:
        with open("/proc/%s/cgroup" % pid) as stream:
            cgroup = stream.read()
        if "murage-home.service" not in cgroup and "murage-turns.slice" not in cgroup and "murage-browsers.slice" not in cgroup:
            continue
        with open("/proc/%s/status" % pid) as stream:
            uid = [l.split()[1] for l in stream if l.startswith("Uid:")][0]
        if uid != "0":
            continue
        exe = os.path.realpath("/proc/%s/exe" % pid)
        with open("/proc/%s/maps" % pid) as stream:
            mapped = [l.split()[-1] for l in stream if "/opt/murage" in l]
        if exe.startswith("/opt/murage") or mapped:
            hits.append((pid, exe, mapped[:3]))
    except OSError:
        continue
print(hits)
PY
)
case "$P1_HITS" in "[]") pass laneg.p1.no_root_slot_code "no uid-0 process in the home unit or the slices runs or maps release-slot bytes";;
  *) fail laneg.p1.no_root_slot_code "no uid-0 process in the home unit or the slices runs or maps release-slot bytes" "$P1_HITS";; esac
# T-P3: slot code (murage, murage-browser, murage-turn) cannot ask PID 1 for a transient unit; none is in an admin group.
for u in murage murage-browser murage-turn; do
  r=$(asu "$u" systemd-run --system --quiet --collect true 2>&1 | tail -1)
  case "$r" in *"Access denied"*|*"Interactive authentication required"*|*"Permission denied"*|*"not permitted"*|*"Failed to"*) pass "laneg.p3.systemd_run.$u" "$u cannot start a transient unit";;
    "") fail "laneg.p3.systemd_run.$u" "$u cannot start a transient unit" "systemd-run succeeded";;
    *) fail "laneg.p3.systemd_run.$u" "$u cannot start a transient unit" "result=$r";; esac
  g=$(id -Gn "$u" 2>/dev/null | tr ' ' '\n' | grep -Ex 'sudo|wheel|admin|adm' | tr '\n' ' ')
  if [ -z "$g" ]; then pass "laneg.p3.groups.$u" "$u is in no admin group"; else fail "laneg.p3.groups.$u" "$u is in no admin group" "groups: $g"; fi
done
# T-P4: the live slot is FS_IMMUTABLE_FL root inodes: write, chattr -i, rename and unlink are refused for the service user.
LIVE=/opt/murage-releases/$(readlink /opt/murage-releases/current 2>/dev/null)
if [ -d "$LIVE" ]; then
  denied laneg.p4.write "murage cannot open a live-slot file for writing" murage rdwr "$LIVE/dist-server/index.js"
  denied laneg.p4.unlink "murage cannot unlink a live-slot file" murage unlink "$LIVE/dist-server/index.js"
  r=$(asu murage chattr -i "$LIVE/dist-server/index.js" 2>&1 | tail -1)
  case "$r" in *"Operation not permitted"*|*"Permission denied"*) pass laneg.p4.chattr "murage cannot clear +i on a live-slot file";;
    *) fail laneg.p4.chattr "murage cannot clear +i on a live-slot file" "result=$r";; esac
  r=$(asu murage python3 -I -c 'import os,sys,errno
try:
    os.rename(sys.argv[1], sys.argv[1] + ".moved"); print("OK")
except OSError as e:
    print(errno.errorcode.get(e.errno, str(e.errno)))' "$LIVE/dist-server/index.js" 2>&1 | tail -1)
  case "$r" in EPERM|EACCES|EROFS) pass laneg.p4.rename "murage cannot rename a live-slot file ($r)";;
    *) fail laneg.p4.rename "murage cannot rename a live-slot file" "result=$r";; esac
  flags=$(lsattr -d "$LIVE" 2>/dev/null | cut -d' ' -f1)
  case "$flags" in *i*) pass laneg.p4.sealed "the live slot root carries +i";; *) fail laneg.p4.sealed "the live slot root carries +i" "flags=$flags";; esac
else skip laneg.p4.write "murage cannot write the live slot" "no /opt/murage-releases/current"; fi
# T-L1': the four root launchers are image-owned regular files, root 0755, +i; a copy of murage-turn-launch refuses to run.
for l in murage-turn-launch murage-browser-namespace murage-browser-network murage-home-launch; do
  f=/usr/local/libexec/$l
  if [ -f "$f" ] && [ ! -L "$f" ] && [ "$(stat -c %u:%a "$f")" = 0:755 ] && lsattr -d "$f" | cut -d' ' -f1 | grep -q i; then pass "laneg.l1.$l" "$l is an immutable root 0755 regular file"
  else fail "laneg.l1.$l" "$l is an immutable root 0755 regular file" "$(stat -c '%F %u:%a' "$f" 2>&1) $(lsattr -d "$f" 2>&1 | cut -d' ' -f1)"; fi
done
COPY="$OUT/murage-turn-launch.copy"; cp /usr/local/libexec/murage-turn-launch "$COPY" 2>/dev/null
r=$(SUDO_UID=$(id -u murage) python3 -I "$COPY" </dev/null 2>&1 | tail -1); rm -f "$COPY"
case "$r" in *"refused"*|*"must run from the image"*) pass laneg.l1.copy "a copy of murage-turn-launch refuses to run (self-inode check)";;
  *) fail laneg.l1.copy "a copy of murage-turn-launch refuses to run (self-inode check)" "result=$r";; esac
# T-G5: Wants=, not Requires=: restarting the updater while the home is idle and running does not restart the home.
if systemctl is-active --quiet murage-home.service && systemctl is-active --quiet murage-commands.service; then
  HOME_START=$(systemctl show -p ExecMainStartTimestampMonotonic --value murage-home.service)
  systemctl restart murage-commands.service; sleep 3
  if systemctl is-active --quiet murage-home.service && [ "$(systemctl show -p ExecMainStartTimestampMonotonic --value murage-home.service)" = "$HOME_START" ]; then
    pass laneg.g5.wants "restarting murage-commands leaves the running home alone (Wants=, not Requires=)"
  else fail laneg.g5.wants "restarting murage-commands leaves the running home alone (Wants=, not Requires=)" "home restarted or stopped"; fi
else skip laneg.g5.wants "restarting murage-commands leaves the running home alone" "home or updater not active"; fi

emit "SUMMARY pass=$PASS fail=$FAIL skip=$SKIP"
[ "$FAIL" -eq 0 ] && [ "$SKIP" -eq 0 ]
