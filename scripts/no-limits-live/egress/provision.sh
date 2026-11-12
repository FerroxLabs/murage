#!/bin/bash
set -euo pipefail
OUT=${1:?report path}; SHA=${2:?candidate sha}; MUTANT=${3:-none}
IMAGE=node:24-bookworm@sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4
if ! command -v docker > /dev/null || ! docker info > /dev/null 2>&1; then
  echo "Docker is required for the No limits egress self-test." >&2
  exit 1
fi
while [ "$(cut -d. -f1 /proc/loadavg)" -gt 60 ]; do sleep 30; done
ROOT=$(cd -- "$(dirname -- "$0")" && pwd)
NET=nolim-j2-${SHA:0:8}-$$; PROXY=$NET-proxy; PROBE=$NET-probe
cleanup(){ docker rm -f "$PROBE" "$PROXY" > /dev/null 2>&1 || true; docker network rm "$NET" > /dev/null 2>&1 || true; }
trap cleanup EXIT
# CI provisions this exact digest in the immediately preceding blocking step.
docker image inspect "$IMAGE" > /dev/null
# Shared hosts may have exhausted Docker's automatic pools. Docker itself rejects overlap.
CREATED=0
for OCTET in 241 242 243 244 245; do
  if docker network create --internal --subnet "198.18.$OCTET.0/29" "$NET" > /dev/null; then CREATED=1; break; fi
done
[ "$CREATED" = 1 ]
docker run --pull never -d --name "$PROXY" --label owner=bld-nolim-s3r3 --network bridge -e NOLIM_PROXY_MUTANT="$MUTANT" -v "$ROOT:/egress:ro" "$IMAGE" node /egress/proxy.mjs > /dev/null
docker network connect --alias "$PROXY" "$NET" "$PROXY"
NETWORK=$NET; [ "$MUTANT" != bridge ] || NETWORK=bridge
DNS=(--dns 127.0.0.1); [ "$MUTANT" != dns ] || DNS=()
docker run --pull never -d --name "$PROBE" --label owner=bld-nolim-s3r3 --network "$NETWORK" "${DNS[@]}" -e HTTPS_PROXY="http://$PROXY:3128" -v "$ROOT:/egress:ro" "$IMAGE" node -e 'setInterval(()=>{},100000)' > /dev/null
# A bridge mutant still reaches the proxy by its actual bridge address.
if [ "$MUTANT" = bridge ]; then
  IP=$(docker inspect -f '{{.NetworkSettings.Networks.bridge.IPAddress}}' "$PROXY")
  docker exec "$PROBE" sh -c 'printf "%s %s\n" "$1" "$2" >> /etc/hosts' sh "$IP" "$PROXY"
fi
node "$ROOT/attest.mjs" "$NET" "$PROXY" "$PROBE" "$OUT" "$SHA" example.com "$MUTANT"
