#!/bin/bash
set -Eeuo pipefail
trap 'rc=$?; echo "g8-container: line $LINENO failed ($rc): $BASH_COMMAND" >&2; exit "$rc"' ERR
mkdir -p /tmp/home
export HOME=/tmp/home PATH=/tools/bin:$PATH SMOOTH_NODE
SMOOTH_NODE=$(command -v node)
export SMOOTH_PREBUILD_LOG=/out/prebuild.log
rc=0
if [[ ${PREBUILD:?} == 1 ]]; then
  bash /work/scripts/smoothness/prebuild-before-listen.sh /work /smooth-data/murage/messages.db \
    true
fi
touch /out/prebuild.done
deadline=$((SECONDS + 30))
until [[ -f /out/load.ready ]]; do
  (( SECONDS < deadline )) || { echo 'g8-container: host did not release leg after prebuild' >&2; exit 124; }
  sleep 1
done
bash /work/scripts/smoothness/run-container.sh || rc=$?
if compgen -G '/out/server-*.log' > /out/keeper-inputs.txt; then
  bash /work/scripts/smoothness/keep-logs.sh /out /evidence "${SMOOTH_RUN_ID:?}" "$SMOOTH_NODE" || rc=4
fi
echo "g8-container: exit=$rc"
exit "$rc"
