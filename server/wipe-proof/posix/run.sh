#!/bin/sh
# Owner: wg-proof. Fresh isolated fixtures only; no live app connection.
set -eu
proof_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec node "$proof_dir/posix/driver.mjs" "$@"
