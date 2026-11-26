#!/bin/sh
# Real-size rig: background CPU + IO pressure shaped like a busy owner machine (load 4-12 on ~10 cores,
# hundreds of MB/min of fsync'd writes), from portable sh/dd burners that run on Linux and macOS alike. Usage: load.sh <scratch-dir> <cpu-workers> <io-workers>
#
# Ownership of the burners (no pid file, no pid is ever read back): the starter (rig.mts) runs this script as the leader
# of a NEW process group with stdin on a pipe it holds. The script stops when that pipe closes: the rig closes it at the
# end of the run, and the kernel closes it when the rig dies for any reason (SIGKILL included). It then signals only its
# own process group (kill 0), which holds exactly the processes this invocation started. A recycled pid, a stale file from
# an earlier run or an unrelated process can never be signalled. Started any other way it refuses to run.
set -eu
DIR=${1:?scratch dir}; CPU=${2:-8}; IO=${3:-2}
PGID=$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ' || true)
[ -n "$PGID" ] || PGID=$(cut -d' ' -f5 "/proc/$$/stat" 2>/dev/null || true)
if [ "$PGID" != "$$" ]; then echo "load.sh: not the leader of its own process group (pgid=${PGID:-?} pid=$$); refusing to start burners" >&2; exit 2; fi
mkdir -p "$DIR"
# Portable sh/dd burners only: the same load on every box, and every burner provably stays in this process group.
i=0
while [ "$i" -lt "$CPU" ]; do sh -c 'while :; do :; done' </dev/null & i=$((i + 1)); done
i=0
while [ "$i" -lt "$IO" ]; do
  # 64 MB written and synced, read back, removed: sustained write + fsync pressure on the profile's disk.
  sh -c 'f="$1/io.$2"; while :; do dd if=/dev/zero of="$f" bs=1048576 count=64 2>/dev/null; sync; cat "$f" > /dev/null; rm -f "$f"; done' io "$DIR" "$i" </dev/null &
  i=$((i + 1))
done
echo "load: portable cpu=$CPU io=$IO group=$$"
cat > /dev/null || true   # blocks until the starter closes the pipe or dies
trap '' TERM              # this script outlives its own group signal long enough to exit 0
kill -TERM 0
exit 0
