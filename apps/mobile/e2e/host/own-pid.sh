# shellcheck shell=bash
# Sourced by door.sh and stop-host.sh. A PID file can outlive its process and
# the PID can be reused, even by the live Murage, so a kill needs proof the
# PID is ours: the listener on its isolated port, or node running the named
# entry from this checkout (server) or with this host's preload (door).
#   own_pid PID PORT ENTRY [MARK]
own_pid() {
  local pid=$1 port=$2 entry=$3 mark=${4:-} app command cwd
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  if lsof -t -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | grep -qx "$pid"; then return 0; fi
  command=$(ps -o command= -p "$pid" 2>/dev/null) || return 1
  [[ "$command" == *"$entry"* ]] || return 1
  if [[ -n "$mark" ]]; then [[ "$command" == *"$mark"* ]]; return; fi
  app=$(cd "$HERE/../../../.." && pwd -P)
  cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')
  [[ "$cwd" == "$app" ]]
}

# Kill PID only when own_pid agrees; otherwise say so and leave it alone.
kill_own() {
  local pid=$1
  if own_pid "$@"; then
    kill "$pid" 2>/dev/null || true
  else
    echo "refusing to kill $pid: it is not the isolated $3 on port $2" >&2
    return 1
  fi
}
