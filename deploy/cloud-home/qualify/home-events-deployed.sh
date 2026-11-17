#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# J5b r7 deployed rig (DESIGN-J5b-r7.md section 9). WRITTEN, SYNTAX CHECKED, NOT RUN: it needs the Vultr VM that qualify/j5b-vm.sh would create (no VM
# exists). Runs ON the VM as root.
#   home-events-deployed.sh install        install units and drop-ins, enable them in order, verify, reboot once (steps 1 to 10)
#   home-events-deployed.sh d1 .. d9 | d4b run one deployed test
#   home-events-deployed.sh all
# Barrier paths (r7, so D2's sandbox list stays unchanged: each is already writable by its unit):
#   control  /run/murage-control/j5b/   (RuntimeDirectory; ReadWritePaths=/run/murage-control)
#   home     /run/j5b-home/             (tmpfiles.d j5b.conf: 0700 murage; murage-home.service is ProtectSystem=full, /run is writable)
#   miner    /var/lib/murage-home/j5b/  (the only path murage-miner-watch.service can write)
# A fault point NOTES (creates <dir>/barrier-<name> and continues) or STALLS (creates it, then blocks until <dir>/release-<name> exists). Every wait is
# ONE blocking command: j5b-wait DIR NAME LIMIT (armed race-tight). Holds: control/hold-intake (control skips probes), home/hold-ack (the app skips ACK reads
# once extended mode is set).
set -euo pipefail
CTL=${J5B_CTL_DIR:-/run/murage-control/j5b}
HOME_DIR=${J5B_HOME_BARRIER_DIR:-/run/j5b-home}
MINER_DIR=${J5B_MINER_DIR:-/var/lib/murage-home/j5b}
UNITS=/etc/systemd/system
QUAL=${J5B_QUAL_DIR:-/opt/j5b/qualify}
ART=${J5B_ARTIFACTS:-/opt/j5b/artifacts}
LIBEXEC=/usr/local/libexec
CP_URL=${J5B_CP_URL:-http://127.0.0.1:8787}

wait_for_barrier() { "$LIBEXEC/j5b-wait" "$1" "$2" "${3:-60}"; }     # DIR NAME [LIMIT]
fresh() { rm -f "$1"/barrier-* "$1"/release-*; }                    # the runner deletes stale barrier files before each trigger
release() { : > "$1/release-$2"; }
hold() { : > "$1"; }
unhold() { rm -f "$1"; }
main_pid() { systemctl show "$1" -p MainPID --value; }
cp_sql() { (cd "$ART/cp" && ./node_modules/.bin/wrangler d1 execute DB --local --persist-to /var/lib/j5b-cp --json --command "$1"); }
alert_count() { cp_sql "SELECT count(*) AS n FROM cloud_alerts WHERE home_id='home-test' AND resolved_at IS NULL" | python3 -I -c 'import json,sys; print(json.load(sys.stdin)[0]["results"][0]["n"])'; }
receipts() { cat /var/lib/j5b/receipts.jsonl 2>/dev/null || true; }   # the control harness request adapter counts receipts per key
dropin() { # UNIT : every ExecStart drop-in begins with an empty ExecStart= (step 6)
  install -d "$UNITS/$1.d"; cat > "$UNITS/$1.d/j5b.conf"
}

install_rig() {
  # 1. artifacts from the build host arrive under $ART: built server, murage-clock, CP Worker with node_modules, wrangler 4.125.0, murage-control-20f95f742a
  install -d "$LIBEXEC" "$CTL" "$HOME_DIR" "$MINER_DIR" /var/lib/j5b
  # 2. the r5 prerequisites
  getent group murage >/dev/null || groupadd --system murage
  id murage >/dev/null 2>&1 || useradd --system --gid murage --home-dir /var/lib/murage-home --shell /usr/sbin/nologin murage
  install -d -o root -g root -m 0755 /var/lib/murage-home /etc/murage-home
  install -d -o root -g root -m 0700 /var/lib/murage-home/credential.d
  head -c 32 /dev/urandom | base64 -w0 > /var/lib/murage-home/credential && chmod 0600 /var/lib/murage-home/credential && chown root:root /var/lib/murage-home/credential
  echo 1 > /var/lib/murage-home/generation
  install -m 0644 "$ART/fixtures/home.env" /etc/murage-home/home.env
  install -m 0644 "$ART/fixtures/control-plane-public-key.json" /etc/murage-home/control-plane-public-key.json   # the trust key
  "$ART/fixtures/seed-home-identity.sh"                                                                          # seeded home identity
  (cd "$ART/cp" && for f in migrations/*.sql; do ./node_modules/.bin/wrangler d1 execute DB --local --persist-to /var/lib/j5b-cp --file "$f"; done)   # ALL migrations through 0158
  cp_sql "INSERT INTO cloud_homes (id) VALUES ('home-test')" >/dev/null 2>&1 || true                              # a seeded home row (column list per the CP schema at integration)
  # the control harness `request` adapter forwards to the local CP at $CP_URL and appends one line per receipt (key) to /var/lib/j5b/receipts.jsonl
  # 3. the unit files are installed unedited from the image sources (copied by the caller into $ART/units); only drop-ins differ
  for u in data.mount murage-volume.service murage-egress.service murage-home.service murage-control.service murage-miner-watch.service; do
    install -m 0644 "$ART/units/$u" "$UNITS/$u"
  done
  install -m 0755 "$QUAL/j5b-volume" "$LIBEXEC/j5b-volume"; install -m 0755 "$QUAL/j5b-wait" "$LIBEXEC/j5b-wait"
  install -m 0755 "$QUAL/j5b-cp-ready" "$LIBEXEC/j5b-cp-ready"; install -m 0755 "$QUAL/j5b-journal-edit" "$LIBEXEC/j5b-journal-edit"
  # 4. murage-volume.service: ExecStart= then the loop-backed attach (64 MB loop file on the root disk, dmsetup create murage-data, ext4 made once)
  dropin murage-volume.service <<'UNIT'
[Service]
ExecStart=
ExecStart=/usr/local/libexec/j5b-volume
UNIT
  # 5. murage-egress.service: D2 lists exactly these resets as the only differences
  dropin murage-egress.service <<'UNIT'
[Service]
ExecStart=
ExecStart=/bin/true
ExecStartPost=
ExecReload=
UNIT
  # 6. every other ExecStart drop-in begins with an empty ExecStart=
  dropin murage-home.service <<UNIT
[Service]
ExecStart=
ExecStart=/usr/bin/node $QUAL/home-harness-supervisor.mjs $ART/server/cloud-home/supervisor.js $QUAL/home-events-harness.mjs
Environment=J5B_HOME_EVENTS_JS=$ART/server/home-events.js J5B_HOME_BARRIER_DIR=$HOME_DIR
UNIT
  dropin murage-control.service <<UNIT
[Service]
ExecStart=
ExecStart=/usr/bin/python3 -I $QUAL/control-deployed-harness.py
Environment=J5B_DEPLOYED=1 J5B_ROOT=$CTL
UNIT
  dropin murage-miner-watch.service <<UNIT
[Service]
Environment=J5B_MINER_DIR=$MINER_DIR
UNIT
  # 7. tmpfiles.d/j5b.conf
  install -m 0644 "$QUAL/j5b.conf" /etc/tmpfiles.d/j5b.conf; systemd-tmpfiles --create /etc/tmpfiles.d/j5b.conf
  # 8. j5b-cp.service: wrangler dev --local on loopback; ExecStartPost blocks until the Worker answers, so ordering implies readiness
  cat > "$UNITS/j5b-cp.service" <<UNIT
[Unit]
Description=J5b rig control plane (wrangler dev, local D1)
Before=murage-home.service
[Service]
WorkingDirectory=$ART/cp
ExecStart=$ART/cp/node_modules/.bin/wrangler dev --local --persist-to /var/lib/j5b-cp --ip 127.0.0.1
ExecStartPost=$LIBEXEC/j5b-cp-ready
TimeoutStartSec=150
Restart=on-failure
[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  # 9. enable every unit in the chain plus j5b-cp, record the dependency chain, reboot once to prove it comes up unaided
  systemctl enable murage-volume.service data.mount murage-egress.service murage-home.service murage-control.service murage-miner-watch.service j5b-cp.service
  systemctl list-dependencies --after murage-control.service > /var/lib/j5b/deps-after-control.txt
  # 10. systemd-analyze verify all units; every sandbox property with and without drop-ins is compared by D2. No new ReadWritePaths (every barrier path is writable already).
  for u in data.mount murage-volume.service murage-egress.service murage-home.service murage-control.service murage-miner-watch.service j5b-cp.service; do systemd-analyze verify "$UNITS/$u"; done
  echo "install done; reboot once now to prove the chain"
}

d1() { # StateDirectory exact, journal append + fsync in the real unit, ACK file read by the murage uid at the maximum
  [ "$(systemctl show murage-control -p StateDirectory --value)" = "murage-control" ]
  findmnt -N "$(main_pid murage-control)" /var/lib/murage-control > /var/lib/j5b/d1-findmnt.txt
  nsenter -t "$(main_pid murage-control)" -m -S 0 -G 0 test -w /var/lib/murage-control          # checked from the control namespace
  echo "(the control harness retains ids up to the maximum, 512 in total)"                                                              # the control harness retains ids up to the maximum (512 in total)
  setpriv --reuid murage --regid murage --clear-groups python3 -I - <<'PY'
import json, re
ack = json.load(open("/run/murage-control/home-events-ack.json"))
ids = ack["acked"] + ack["accepted"]
assert len(ids) <= 512 and len(set(ids)) == len(ids) and all(re.fullmatch(r"[0-9a-f]{16}", i) for i in ids)
PY
}
d2() { # sandbox equivalence with and without the drop-ins (guard: passes at base). Identical except the listed ExecStart, ExecStartPost, ExecReload resets.
  for u in murage-control murage-home murage-egress murage-volume murage-miner-watch; do systemctl show "$u" -p ReadWritePaths -p ProtectSystem -p PrivateTmp -p StateDirectory -p RuntimeDirectory; done > /var/lib/j5b/d2.txt
}
d3() { # MU-54 build: zero deliveries in (i). Hold intake; abort; NOTE after_outbox_fsync; DISMISS (restore journal deleted); (i) whole-unit SIGKILL; (ii) child-only exit 75.
  fresh "$HOME_DIR"; fresh "$CTL"; hold "$CTL/hold-intake"
  curl -fsS -X POST http://127.0.0.1:8830/rig/abort -d '{"job":{"id":"job-d3","at":1800000000123}}' >/dev/null
  wait_for_barrier "$HOME_DIR" after_outbox_fsync 60 || true            # bounded and non-fatal: on timeout the behavioral check below decides
  rm -f /data/restore/jobs/*.json                                         # the restore is dismissed: boot re-assertion has no source
  local before; before=$(main_pid murage-control)
  kill -KILL "$(main_pid murage-home)"                                    # (i) whole unit: murage-home fails, murage-control stops with it (BindsTo/PartOf)
  systemctl is-active --wait murage-control >/dev/null || true
  [ "$(main_pid murage-control)" != "$before" ]
  unhold "$CTL/hold-intake"
  test "$(receipts | grep -c '"at":1800000000123')" = 1                    # reaches the CP once, at job.at
  curl -fsS -X POST http://127.0.0.1:8830/rig/abort -d '{"job":{"id":"job-d3b","at":1800000000456}}' >/dev/null   # (ii) child only
  local pid; pid=$(main_pid murage-control)
  curl -fsS -X POST http://127.0.0.1:8830/rig/finish >/dev/null
  sleep 2; [ "$(main_pid murage-control)" = "$pid" ]                      # exit 75 restarts the child only
  test "$(receipts | grep -c '"at":1800000000456')" = 1
  ! strace -f -e trace=openat -p "$pid" -o /dev/null -c 2>&1 | grep -q /data/.murage-events   # no control open of a murage-owned path (strace sample, see the report)
}
d4() { # MU-68 build. Full control state (16 KB tmpfs .mount, ENOSPC confirmed in the namespace); overflow item not in acked, sent from memory.
  mount -t tmpfs -o size=16k tmpfs /var/lib/murage-control
  nsenter -t "$(main_pid murage-control)" -m sh -c 'dd if=/dev/zero of=/var/lib/murage-control/fill bs=1k 2>&1 | grep -q "No space"'
  fresh "$HOME_DIR"
  # (i) child exit 75: control keeps its dirty key, no resend
  curl -fsS -X POST http://127.0.0.1:8830/rig/finish >/dev/null; sleep 3
  # (ii-a) hold-ack present: accepted is published but not consumed; whole-unit SIGKILL reloads the item from the outbox, control re-takes it from memory, alert count stays 1
  hold "$HOME_DIR/hold-ack"
  sleep 3; kill -KILL "$(main_pid murage-home)"; sleep 5
  [ "$(alert_count)" = 1 ]
  # (ii-b) no hold: the app consumes accepted and writes done; whole-unit SIGKILL: the item is not reloaded and no further body carries it
  unhold "$HOME_DIR/hold-ack"; sleep 3; kill -KILL "$(main_pid murage-home)"; sleep 5
  # a second overflow after acceptance yields a second, distinct key (r4-M8); filler removed: add and sent land with the same key
  rm -f /var/lib/murage-control/fill
}
d4b() { # MR in the real units (MU-51 build): outbox volume ro and control state ro; heartbeat 1 answered 503, heartbeat 2 carries no extended event, heartbeat 3 the same key
  mount -o remount,ro /data; mount -o remount,ro /var/lib/murage-control || true
  curl -fsS -X POST "$CP_URL/__j5b/fault" -d '{"heartbeat":[503]}' >/dev/null   # the j5b-cp fault route (defined at integration): heartbeat 1 -> 503, then accepted
  sleep 20
  [ "$(alert_count)" = 1 ]
  mount -o remount,rw /data
}
until_ge() { # until_ge LIMIT_SECONDS COMMAND... : re-runs COMMAND once a second until it succeeds or the limit passes (bounded, non-fatal wait)
  local end=$((SECONDS + $1)); shift; until "$@"; do [ "$SECONDS" -lt "$end" ] || return 1; sleep 1; done
}
receipt_count() { receipts | python3 -I -c 'import json,sys; k=sys.argv[1]; print(sum(1 for l in sys.stdin if l.strip() and json.loads(l).get("key")==k))' "$1"; }
first_receipt_key() { receipts | python3 -I -c 'import json,sys; print(next((json.loads(l)["key"] for l in sys.stdin if l.strip()), ""))'; }
d5() { # MU-40 build (r8 M5). Read-only control state, hold-ack so the app keeps offering K; control accepts K from memory and alert A opens. Then, in this order:
  # (1) RESOLVE A and confirm it with a SELECT, (2) create hold-intake, (3) restart control (app alive), wait for the new MainPID and the ACK file's fresh control:1,
  # (4) remove hold-intake and wait for the request adapter's receipt count for K to reach 2: the CP must answer duplicate and open no new alert row.
  mount -o remount,ro /var/lib/murage-control || true
  hold "$HOME_DIR/hold-ack"; fresh "$CTL"
  curl -fsS -X POST http://127.0.0.1:8830/rig/abort >/dev/null
  until_ge 60 test "$(alert_count)" = 1
  local key; key=$(first_receipt_key); [ -n "$key" ]
  cp_sql "UPDATE cloud_alerts SET resolved_at = CAST(strftime('%s','now') AS INTEGER) * 1000 WHERE home_id='home-test' AND resolved_at IS NULL" >/dev/null
  [ "$(cp_sql "SELECT count(*) AS n FROM cloud_alerts WHERE home_id='home-test' AND resolved_at IS NOT NULL" | python3 -I -c 'import json,sys; print(json.load(sys.stdin)[0]["results"][0]["n"])')" = 1 ]
  hold "$CTL/hold-intake"
  local before; before=$(main_pid murage-control)
  systemctl restart murage-control
  until_ge 60 test "$(main_pid murage-control)" != "$before"
  until_ge 60 grep -q '"control":1' /run/murage-control/home-events-ack.json
  unhold "$CTL/hold-intake"
  until_ge 90 test "$(receipt_count "$key")" -ge 2
  [ "$(alert_count)" = 0 ]
  [ "$(cp_sql "SELECT count(*) AS n FROM cloud_alerts WHERE home_id='home-test'" | python3 -I -c 'import json,sys; print(json.load(sys.stdin)[0]["results"][0]["n"])')" = 1 ]
  unhold "$HOME_DIR/hold-ack"; mount -o remount,rw /var/lib/murage-control || true
}
d10_waiting_count() { curl -fsS http://127.0.0.1:8830/api/health | python3 -I -c 'import json,sys; print(json.load(sys.stdin).get("opsAlertsWaiting", 0))'; }
d10_is_waiting() { [ "$(d10_waiting_count)" -ge 1 ]; }
d10_recovered() { [ "$(d10_waiting_count)" = 0 ]; }
d10_owned_count() { cp_sql "SELECT count(*) AS n FROM cloud_alerts WHERE home_id='home-test' AND kind='home.event_spool_failed'" | python3 -I -c 'import json,sys; print(json.load(sys.stdin)[0]["results"][0]["n"])'; }
d10_open_count() { cp_sql "SELECT count(*) AS n FROM cloud_alerts WHERE home_id='home-test' AND kind='home.event_spool_failed' AND resolved_at IS NULL" | python3 -I -c 'import json,sys; print(json.load(sys.stdin)[0]["results"][0]["n"])'; }
d10_has_page() { [ "$(d10_owned_count)" -ge "$(( $1 + 1 ))" ] && [ "$(d10_open_count)" -ge 1 ]; }
d10_item_durable() {
  curl -fsS http://127.0.0.1:8830/api/health | python3 -I -c 'import json,sys; h=json.load(sys.stdin).get("homeEvents", {}); sys.exit(0 if h.get("outboxDegraded") == 0 and any(i.get("type") == "restore.aborted" and i.get("at") == int(sys.argv[1]) for i in h.get("items", [])) else 1)' "$1"
}
d10() ( # MU-H1b: detect the hold, observe delivery on the normal cadence, then observe recovery.
  # Three probes can take 30 s including their 5 s timeout. The next heartbeat is at most
  # 60 s away; lease, app probe and heartbeat requests add at most 35 s. Budget 150 s.
  # Cleanup also runs when an observation rejects the deployment.
  trap 'unhold "$CTL/hold-intake"; mount -o remount,rw /data' EXIT
  local baseline at
  baseline=$(d10_owned_count)
  at=$(date +%s%3N)
  hold "$CTL/hold-intake"
  curl -fsS -X POST http://127.0.0.1:8830/rig/abort -d "{\"job\":{\"id\":\"job-d10-$at\",\"at\":$at}}" >/dev/null
  until_ge 30 d10_item_durable "$at"
  mount -o remount,ro /data
  unhold "$CTL/hold-intake"
  until_ge 30 d10_is_waiting
  curl -fsS -X POST http://127.0.0.1:8830/rig/abort -d "{\"job\":{\"id\":\"job-d10-held-$at\",\"at\":$((at + 1))}}" >/dev/null
  until_ge 150 d10_has_page "$baseline"
  d10_is_waiting
  mount -o remount,rw /data
  until_ge 30 d10_recovered
  sleep 75
  [ "$(d10_owned_count)" = "$((baseline + 1))" ]
)
d6() { # ACK-file-only isolation (MU-9 build): the harness writes the ACK file 0600 after the advertisement was read; one add per id; RESOLVE; drop-sent; restart: resent key opens nothing
  systemctl set-environment J5B_ACK_MODE=0600
  systemctl restart murage-control; sleep 6
  cp_sql "UPDATE cloud_alerts SET resolved_at=strftime('%s','now')*1000 WHERE home_id='home-test' AND resolved_at IS NULL" >/dev/null
  systemctl stop murage-control
  "$LIBEXEC/j5b-journal-edit" drop-sent /var/lib/murage-control/home-events.journal
  systemctl start murage-control; sleep 8
  [ "$(alert_count)" = 0 ]
}
d7() { # MU-62 build. Control: STALL journal_midline then SIGKILL; short append at the page boundary then ENOSPC; app: the same two cuts via the harness fs.writeSync fault point
  fresh "$CTL"; : > "$CTL/ctl/fault-stall-midline"
  wait_for_barrier "$CTL" journal_midline 60 || true
  kill -KILL "$(main_pid murage-control)"; sleep 5
  # restart: truncated to the valid prefix, one add, one alert
  [ "$(alert_count)" = 1 ]
  # short append, deterministic: valid records until length mod 4096 is within 40 bytes of the page end, then fill the 16 KB tmpfs to ENOSPC; the next record (over 40 bytes) is short
  python3 -I - <<'PY'
import os
size = os.path.getsize("/var/lib/murage-control/home-events.journal")
print("journal length", size, "to page end", 4096 - size % 4096)
PY
  # miner temp stall as r5 (NOTE/STALL under $MINER_DIR)
  fresh "$MINER_DIR"
}
d8() { # no mutant claimed. Journal on the root disk (default StateDirectory), outbox on the loop-backed /data; sysrq b at an ACK publish and at STALL overflow_record_written before its fsync
  fresh "$CTL"; : > "$CTL/ctl/fault-stall-overflow"
  wait_for_barrier "$CTL" overflow_record_written 120 || true
  echo b > /proc/sysrq-trigger
}
d9() { # MU-49 build. (i) legacy r2/r3 files then the fsync-before-unlink cut; (ii) new app with the REAL 20f95f742a control for 10 minutes, then the new control; (iii) new control with 1.0.18-shape app and r3 counter app
  install -m 0755 "$ART/murage-control-20f95f742a" /opt/j5b/murage-control-old
  dropin murage-control.service <<UNIT
[Service]
ExecStart=
ExecStart=/usr/bin/python3 -I /opt/j5b/murage-control-old
UNIT
  systemctl daemon-reload; systemctl restart murage-control
  sleep 600                                                                 # one bounded wait of the 10 minute soak
  dropin murage-control.service <<UNIT
[Service]
ExecStart=
ExecStart=/usr/bin/python3 -I $QUAL/control-deployed-harness.py
Environment=J5B_DEPLOYED=1 J5B_ROOT=$CTL
UNIT
  systemctl daemon-reload; systemctl restart murage-control
}

case "${1:-}" in
  install) install_rig ;;
  d1|d2|d3|d4|d4b|d5|d6|d7|d8|d9|d10) "$1" ;;
  all) for t in d1 d2 d3 d4 d4b d5 d6 d7 d8 d9 d10; do echo "== $t"; "$t"; done ;;
  *) echo "usage: home-events-deployed.sh install | d1..d9 | d4b | all" >&2; exit 2 ;;
esac
