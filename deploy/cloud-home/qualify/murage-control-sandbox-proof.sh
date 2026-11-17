#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Runs INSIDE a disposable container (root), never on a home or a developer Mac. Proves the Flux sub-key hand-off survives the properties
# murage-control.service gives the poller: root, NO capabilities (setpriv bounding and inheritable sets emptied, no_new_privs, the same
# mechanism systemd's CapabilityBoundingSet= uses), the supplementary group SupplementaryGroups=murage gives it, and a read-only
# /var/lib/murage-home (mode 0555: without CAP_DAC_OVERRIDE root obeys it, the same refusal ProtectSystem=strict gives as EROFS).
# Usage: murage-control-sandbox-proof.sh <tree> [<old-murage-control>]   (tree mounted read-only; node on PATH)
# With a second argument the old poller runs the same steps and is EXPECTED to fail (negative control).
set -u
TREE=$1; OLD=${2:-}
fail() { echo "PROOF FAIL: $*"; exit 1; }
# A bare container has no ids near 990, but a stock VM image does (Ubuntu 24.04 cloud images: crontab 990, polkitd 991), so take the
# first free id at or below 990 for each account instead of assuming it, and use the same numbers everywhere below.
free_id() { local i=$1; while getent passwd "$i" >/dev/null || getent group "$i" >/dev/null; do i=$((i-1)); done; echo "$i"; }
if getent group murage >/dev/null && id murage >/dev/null 2>&1; then MU=$(id -u murage); MG=$(id -g murage); else MU=$(free_id 990); MG=$MU; groupadd -g "$MG" murage; useradd -r -u "$MU" -g "$MG" -M -s /usr/sbin/nologin murage; fi
if getent group murage-turn >/dev/null && id murage-turn >/dev/null 2>&1; then TU=$(id -u murage-turn); TG=$(id -g murage-turn); else TU=$(free_id $((MU-1))); TG=$TU; groupadd -g "$TG" murage-turn; useradd -r -u "$TU" -g "$TG" -M -s /usr/sbin/nologin murage-turn; fi
PU=$(free_id $((TU-1)))
rm -rf /etc/murage-home /run/murage-control /var/lib/murage-control /var/lib/murage-home /work
mkdir -p /etc/murage-home /run/murage-control /var/lib/murage-control /var/lib/murage-home /work
chmod 0755 /etc/murage-home /run/murage-control; chmod 0700 /var/lib/murage-control; chmod 0555 /var/lib/murage-home
printf '{"uid":%s,"gid":%s,"turnGid":%s,"proxyUid":%s,"proxyGid":%s,"engineGids":{}}\n' "$MU" "$MG" "$TG" "$PU" "$PU" > /etc/murage-home/identity.json
chmod 0600 /etc/murage-home/identity.json
POLLER="setpriv --reuid 0 --regid 0 --groups $MG --bounding-set=-all --inh-caps=-all --no-new-privs"
SUPERVISOR="setpriv --reuid $MU --regid $MG --clear-groups --no-new-privs"
TURN="setpriv --reuid $TU --regid $TG --clear-groups --no-new-privs"

cat > /work/poller.py <<'PY'
import importlib.machinery, importlib.util, json, sys, os, urllib.error
path, phase = sys.argv[1], sys.argv[2]
l = importlib.machinery.SourceFileLoader("mc", path); spec = importlib.util.spec_from_loader("mc", l); m = importlib.util.module_from_spec(spec); l.exec_module(m)
caps = [line for line in open("/proc/self/status") if line.startswith(("CapEff", "CapBnd", "Uid", "Groups"))]
OP = "renew:proof-home:1:1"
SUB = {"key": "sk-flux-home-" + "S" * 40, "generation": 2, "expiresAt": "2030-01-01T00:00:00Z", "capUsd": 5.0}
calls = []
def request(binding, op, body=None):
    calls.append(op)
    if op == "flux/subkey/ack":
        open("/work/acked", "w").close()  # the control plane moves the expiry: no longer due
    if op == "flux/renewal-due" and os.path.exists("/work/acked"):
        return {"due": False}
    return {"flux/renewal-due": {"due": True, "op_id": OP}, "flux/subkey": SUB, "flux/subkey/ack": {"acked": True}}[op]
try:
    m.renew_flux_subkey({"generation": 1}, {"fluxRenewalDue": True}, request)
    print(json.dumps({"phase": phase, "ok": True, "calls": calls, "caps": [c.strip() for c in caps]}))
except Exception as e:
    print(json.dumps({"phase": phase, "ok": False, "error": type(e).__name__ + ": " + str(e), "calls": calls, "caps": [c.strip() for c in caps]}))
PY
cat > /work/supervisor.mts <<TS
import { peekFluxSubkey, completeFluxSubkey } from "$TREE/server/cloud-home/flux-subkey-delivery.ts";
const delivery = peekFluxSubkey();
if (!delivery) { console.log("NOKEY"); process.exit(2); }
completeFluxSubkey(delivery);
console.log("SEALED " + delivery.op_id);
TS

run_poller() { $POLLER python3 -I /work/poller.py "$1" "$2"; }
if [ -n "$OLD" ]; then
  echo "--- negative control: the old poller under the same sandbox"
  out=$(run_poller "$OLD" old); echo "$out"
  echo "$out" | /usr/bin/grep -q '"ok": false' || fail "the old poller was expected to fail under the sandbox"
  echo "NEGATIVE CONTROL OK: old code refused by the sandbox"; exit 0
fi

echo "--- 1. poller mints and hands off (no capabilities)"
out=$(run_poller "$TREE/deploy/cloud-home/murage-control" new); echo "$out"
echo "$out" | /usr/bin/grep -q '"ok": true' || fail "hand-off failed under the sandbox"
echo "$out" | /usr/bin/grep -q '"CapEff:\\t0000000000000000"' || fail "poller kept a capability"
stat -c '%A %U:%G %n' /run/murage-control/flux-subkey /run/murage-control/flux-subkey/key.json
[ "$(stat -c '%a %U %G' /run/murage-control/flux-subkey)" = "770 root murage" ] || fail "directory ownership"
[ "$(stat -c '%a %U %G' /run/murage-control/flux-subkey/key.json)" = "640 root murage" ] || fail "key ownership"
ls -l /var/lib/murage-control/flux-ack-pending.json; [ "$(stat -c '%a %U' /var/lib/murage-control/flux-ack-pending.json)" = "600 root" ] || fail "pending record"

echo "--- 2. a turn (another user and group) can neither list the directory nor read the key"
$TURN cat /run/murage-control/flux-subkey/key.json 2>&1 && fail "a turn read the key"
$TURN ls /run/murage-control/flux-subkey 2>&1 && fail "a turn listed the directory"

echo "--- 3. no receipt yet: the poller neither mints again nor acks"
out=$(run_poller "$TREE/deploy/cloud-home/murage-control" again); echo "$out"
echo "$out" | /usr/bin/grep -q '"calls": \[\]' || fail "the poller called the control plane before the receipt"

echo "--- 4. the supervisor (real TypeScript, uid murage) reads the key, writes its receipt, removes the key"
$SUPERVISOR node "/work/supervisor.mts" || fail "supervisor could not take the hand-off"
[ ! -e /run/murage-control/flux-subkey/key.json ] || fail "key still present after the receipt"
stat -c '%a %U:%G %n' /run/murage-control/flux-subkey/receipt.json

echo "--- 5. the poller (no capabilities) reads the receipt, acks, and clears its record and the receipt"
out=$(run_poller "$TREE/deploy/cloud-home/murage-control" ack); echo "$out"
echo "$out" | /usr/bin/grep -q '"ok": true' || fail "ack step failed"
echo "$out" | /usr/bin/grep -q 'flux/subkey/ack' || fail "no ack sent"
[ ! -e /var/lib/murage-control/flux-ack-pending.json ] || fail "pending record not cleared"
[ ! -e /run/murage-control/flux-subkey/receipt.json ] || fail "receipt not cleared"
echo "PROOF OK"
