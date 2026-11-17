#!/bin/bash
# Inputs are a public source tree, a dependency directory, and a Node binary;
# none may contain user profiles/config. SOURCE must match PROVENANCE.json.
set -euo pipefail
: "${S0_SOURCE:?set the extracted pinned Hermes source directory}"
: "${S0_DEPS:?set the prepared Python 3.14 dependency directory}"
: "${S0_NODE:?set a Node 22 executable}"
: "${S0_OUT:?set an empty evidence directory}"
: "${S0_IMAGE:?set the pinned Python Docker image ID}"
S0_FIXTURES="$(cd -- "$(dirname -- "$0")" && pwd)"
mkdir -p "$S0_OUT"
test -z "$(ls -A "$S0_OUT")"
docker run --rm --network none --name "bld-toolid-s0-${S0_RUN:-capture}" --cpus 2 --memory 2g \
  -v "$S0_SOURCE:/hermes:ro" -v "$S0_DEPS:/deps:ro" -v "$S0_NODE:/node:ro" \
  -v "$S0_FIXTURES:/capture:ro" -v "$S0_OUT:/evidence" \
  "$S0_IMAGE" python /capture/capture.py
