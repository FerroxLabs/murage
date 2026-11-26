#!/bin/bash
set -euo pipefail
cap=/root/fuigo-builds/swarm-b/busyloop-capture
for scenario in S1 S2 S3 S4; do
  for repeat in 1 2; do
    if [[ "$scenario-$repeat" == S1-1 ]]; then continue; fi
    while [ "$(cut -d. -f1 /proc/loadavg)" -ge 60 ]; do sleep 120; done
    docker run --rm --network none --cpus 2 --name bfix-busyloop-capture -v "$cap:/cap" -w /cap node:22-bookworm bash run-capture.sh "$scenario" "$repeat"
  done
done
