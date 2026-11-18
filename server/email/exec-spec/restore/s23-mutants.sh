#!/bin/bash
# Run inside the integration adapter; all mutations use a private temporary copy.
set -eu
exec python3 "$(dirname "$0")/s23-mutants.py" "$@"
