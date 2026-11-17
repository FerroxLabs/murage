#!/usr/bin/env bash
set -euo pipefail
# Arguments are reviewed executable SHA-256 values: linux-x64, win32-x64,
# darwin-arm64. Registry access happens only when this command is invoked.
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
exec node "$script_dir/fill-fuigo-pin.mjs" "$@"
