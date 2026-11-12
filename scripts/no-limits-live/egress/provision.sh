#!/bin/bash
set -euo pipefail
OUT=${1:?report path}; SHA=${2:?candidate sha}; MUTANT=${3:-none}
while [ "$(cut -d. -f1 /proc/loadavg)" -gt 60 ]; do sleep 30; done
ROOT=$(cd -- "$(dirname -- "$0")" && pwd)
NET=nolim-j2-${SHA:0:8}-$$; PROXY=$NET-proxy; PROBE=$NET-probe
cleanup(){ docker rm -f "$PROBE" "$PROXY" > /dev/null 2>&1 || true; docker network rm "$NET" > /dev/null 2>&1 || true; }
trap cleanup EXIT
# Uses only the existing lane image; never pulls.
docker image inspect node:24-bookworm > /dev/null
# Shared hosts may have exhausted Docker's automatic pools. Docker itself rejects overlap.
CREATED=0
for OCTET in 241 242 243 244 245; do
  if docker network create --internal --subnet "198.18.$OCTET.0/29" "$NET" > /dev/null; then CREATED=1; break; fi
done
[ "$CREATED" = 1 ]
docker run --pull never -d --name "$PROXY" --label owner=bld-nolim-s3r3 --network bridge -e NOLIM_PROXY_MUTANT="$MUTANT" -v "$ROOT:/egress:ro" node:24-bookworm node /egress/proxy.mjs > /dev/null
docker network connect --alias "$PROXY" "$NET" "$PROXY"
NETWORK=$NET; [ "$MUTANT" != bridge ] || NETWORK=bridge
DNS=(--dns 127.0.0.1); [ "$MUTANT" != dns ] || DNS=()
docker run --pull never -d --name "$PROBE" --label owner=bld-nolim-s3r3 --network "$NETWORK" "${DNS[@]}" -e HTTPS_PROXY="http://$PROXY:3128" -v "$ROOT:/egress:ro" node:24-bookworm node -e 'setInterval(()=>{},100000)' > /dev/null
# A bridge mutant still reaches the proxy by its actual bridge address.
if [ "$MUTANT" = bridge ]; then
  IP=$(docker inspect -f '{{.NetworkSettings.Networks.bridge.IPAddress}}' "$PROXY")
  docker exec "$PROBE" sh -c 'printf "%s %s\n" "$1" "$2" >> /etc/hosts' sh "$IP" "$PROXY"
fi
node "$ROOT/attest.mjs" "$NET" "$PROXY" "$PROBE" "$OUT" "$SHA" example.com "$MUTANT"
