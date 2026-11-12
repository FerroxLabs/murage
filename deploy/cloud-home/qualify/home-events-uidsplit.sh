#!/bin/bash
# Runs INSIDE a root container (node:24-bookworm, --network none, repo copy at /work). Root prepares the dirs exactly as the shipped code does, then the
# test runs as uid 2001, then root checks murage-control sees what the server wrote.
cd /work
rm -rf /var/lib/murage-home /data; mkdir -p /var/lib /data
python3 -I - <<'PY' || exit 4
import importlib.machinery, importlib.util, os
def load(n, p):
    l = importlib.machinery.SourceFileLoader(n, p); s = importlib.util.spec_from_loader(n, l); m = importlib.util.module_from_spec(s); l.exec_module(m); return m
enroll = load("enroll", "deploy/cloud-home/murage-enroll")
watch = load("watch", "deploy/cloud-home/murage-miner-watch.py")
enroll.private_directory("/var/lib/murage-home", 0)                    # murage-enroll:45  root 0700
watch.write_event(1, now_ms=1, events="/var/lib/murage-home/events")   # miner-watch:93    root 0755 events/
for f in os.listdir("/var/lib/murage-home/events"): os.unlink("/var/lib/murage-home/events/" + f)
PY
chown root:2001 /data; chmod 1771 /data                                # bindHomeVolume: root:gid 1771
if grep -q "export function prepareHomeEventsDir" server/cloud-home/supervisor.ts; then
  node --input-type=module -e 'import { prepareHomeEventsDir } from "/work/server/cloud-home/supervisor.ts"; prepareHomeEventsDir("/data", 2001);' || exit 3
fi
ls -ld /var/lib/murage-home /var/lib/murage-home/events /data /data/.murage-events 2>&1
export MURAGE_UIDSPLIT=1
setpriv --reuid 2001 --regid 2001 --clear-groups node node_modules/vitest/vitest.mjs run server/cloud-home/home-events-uidsplit.test.ts --maxWorkers=1; rc=$?
python3 -I - <<'PY' || rc=5
import importlib.machinery, importlib.util, json
l = importlib.machinery.SourceFileLoader("c", "deploy/cloud-home/murage-control"); s = importlib.util.spec_from_loader("c", l); m = importlib.util.module_from_spec(s); l.exec_module(m)
h, consumed = m.collect_health(allowed_events=m.EVENT_TYPES)  # restore types ride only once advertised; this check is about uid visibility; print("CONTROL SEES", json.dumps(h))
assert h and len(h["events"]) == 2, "control did not see the server's events"
PY
echo "UIDSPLIT rc=$rc"
exit $rc
