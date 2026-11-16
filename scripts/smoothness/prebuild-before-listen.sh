#!/bin/bash
# Migrate and prebuild the rig's isolated data copy before starting its server.
# Usage: SMOOTH_NODE=/absolute/node bash prebuild-before-listen.sh PRODUCT DB COMMAND [ARG...]
set -euo pipefail
product=${1:?product checkout}; database=${2:?run database}; shift 2
[ "$#" -gt 0 ] || { echo 'PREBUILD FAILED: missing server command' >&2; exit 4; }
node_path=${SMOOTH_NODE:-}
[[ "$node_path" = /* && -x "$node_path" ]] || { echo 'PREBUILD FAILED: SMOOTH_NODE must name the rig executable' >&2; exit 4; }
export SMOOTH_NODE="$node_path"
here=$(cd -- "$(dirname -- "$0")" && pwd)
# Both calls load the product registry. No fixed count and no PREBUILD=0 fallback.
prebuild_log=${SMOOTH_PREBUILD_LOG:-$(dirname -- "$database")/prebuild.log}
: > "$prebuild_log"
"$node_path" "$here/prebuild-index.mjs" --build "$product" "$database" 2>&1 | tee -a "$prebuild_log"
"$node_path" "$here/prebuild-index.mjs" --verify "$product" "$database" 2>&1 | tee -a "$prebuild_log"
echo PREBUILD=1
# The launched rig and its keep-logs.sh inherit this exact Node, including when
# the host has no /usr/local/bin/node. A failed build/verify never reaches exec.
exec "$@"
