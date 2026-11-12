#!/usr/bin/env bash
# Run on build-host. All product execution is from the requested Git object.
set -euo pipefail
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
exec node "$here/gate-1019.mjs" "$@"
