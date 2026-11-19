#!/bin/bash
# Run this command through it-remote.sh in its --network none container.
set -euo pipefail
cd /work
export PYTHONHOME=/work/.s0b-runtime/python
export LD_LIBRARY_PATH="$PYTHONHOME/lib"
export PYTHONDONTWRITEBYTECODE=1
PYTHON="$PYTHONHOME/bin/python3.14"
FIXTURE=/work/server/testing/fixtures/hermes-0.22.2-tool-identity-s0b
"$PYTHON" -m pip install --no-index --no-cache-dir --no-compile --no-deps --find-links /work/.s0b-runtime/wheels --target /work/.s0b-runtime/deps -r "$FIXTURE/requirements.txt"
"$PYTHON" "$FIXTURE/capture.py"
