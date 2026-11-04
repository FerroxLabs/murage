#!/bin/bash
# Copyright 2026 Ferrox Labs
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Linux leg of the ten-jobs gate, for the Linux gate box (a user with Xvfb, dbus, node 20+ and playwright-core 1.57).
# Run DETACHED:  setsid nohup bash linux.sh <app exe> <40-hex build commit> <mouse|keyboard> [jobs] > /dev/null 2>&1 &
# Each run gets a fresh root under $TJ/runs/<label>. Log $TJ/runs/<label>/run.out, marker run.done. No deletes, no pattern kills.
# Env: TJ (default ~/gate/tj), TJ_NODE (default ~/gate/node24/bin/node), TJ_PW (default ~/gate/pw), TJ_DISPLAY (default :94),
#      TEN_JOBS_FLUX_KEY_FILE (default ~/.config/flux/fuigo.key: the throwaway gate key, never the Flux TEST key).
set -u -o pipefail
EXE=${1:?app exe}; TREE=${2:?build commit}; MODE=${3:?mouse or keyboard}; JOBS=${4:-}
TJ=${TJ:-$HOME/gate/tj}; NODE=${TJ_NODE:-$HOME/gate/node24/bin/node}; PW=${TJ_PW:-$HOME/gate/pw}; DSP=${TJ_DISPLAY:-:94}
SRC=$(cd "$(dirname "$0")/.." && pwd)
LABEL=${TREE:0:12}-$MODE-$(date -u +%Y%m%dT%H%M%SZ); R=$TJ/runs/$LABEL
mkdir -p "$R" || exit 2
L() { echo "=== $(date -u +%FT%TZ) $*" >> "$R/run.out"; }
[ -x "$EXE" ] || { L "STOP no exe $EXE"; touch "$R/run.done"; exit 2; }
L "exe $(sha256sum "$EXE" | cut -c1-16) tree $TREE mode $MODE jobs ${JOBS:-all}; free $(df -h / | tail -1 | awk '{print $4}')"
XP=""
if ! [ -e "/tmp/.X11-unix/X${DSP#:}" ]; then Xvfb "$DSP" -screen 0 1280x800x24 > "$R/xvfb.log" 2>&1 & XP=$!; sleep 2; fi
export DISPLAY=$DSP
eval "$(dbus-launch --sh-syntax)"
# An owner's Linux desktop has an unlocked keyring; Murage refuses to keep a key without one. Give this run its own
# fresh keyring (under the run root, random throwaway password on stdin, never printed) so the Flux key the owner
# pastes in job 0 is kept the way it is on a real desktop.
export XDG_DATA_HOME=$R/xdg XDG_RUNTIME_DIR=$R/xrun; mkdir -p "$XDG_DATA_HOME"; mkdir -m 700 -p "$XDG_RUNTIME_DIR"
KRPW=$(head -c 24 /dev/urandom | base64)
eval "$(printf '%s' "$KRPW" | gnome-keyring-daemon --unlock --components=secrets 2>/dev/null)"; unset KRPW
eval "$(gnome-keyring-daemon --start --components=secrets 2>/dev/null)"
export GNOME_KEYRING_CONTROL SSH_AUTH_SOCK 2>/dev/null
L "keyring: $(command -v gnome-keyring-daemon >/dev/null && echo started || echo MISSING)"
# Local stand-ins, no real accounts and no secrets (jobs 7 and 9; the plan asks for stubs):
# - Tailscale: a stand-in CLI first on PATH (the box has no tailscale; Murage looks for bare `tailscale` last).
# - Telegram: an HTTP proxy that answers api.telegram.org itself, over TLS with a leaf from a CA made for this
#   run only and trusted only by this run's app (NODE_EXTRA_CA_CERTS); every other host is a plain tunnel.
#   The CA key is emptied once the leaf is signed. Keys stay in the 700 run dir; nothing is printed.
SI=$R/standin; mkdir -m 700 -p "$SI" "$R/bin"
for t in /usr/bin/tailscale /usr/local/bin/tailscale /opt/homebrew/bin/tailscale /run/current-system/sw/bin/tailscale; do
  [ -e "$t" ] && { L "STOP a real Tailscale CLI is installed at $t; the stand-in would not be used"; touch "$R/run.done"; exit 2; }
done
cp "$SRC/rig/stand-ins/tailscale" "$R/bin/tailscale" && chmod 755 "$R/bin/tailscale"
( umask 077
  openssl req -x509 -newkey rsa:2048 -nodes -keyout "$SI/ca.key" -out "$SI/ca.pem" -days 2 -subj "/CN=ten-jobs gate stand-in CA, one run" \
    -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign" > /dev/null 2>&1 &&
  openssl req -newkey rsa:2048 -nodes -keyout "$SI/leaf.key" -out "$SI/leaf.csr" -subj "/CN=api.telegram.org" > /dev/null 2>&1 &&
  printf 'subjectAltName=DNS:api.telegram.org\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n' > "$SI/leaf.ext" &&
  openssl x509 -req -in "$SI/leaf.csr" -CA "$SI/ca.pem" -CAkey "$SI/ca.key" -CAcreateserial -out "$SI/leaf.pem" -days 2 -extfile "$SI/leaf.ext" > /dev/null 2>&1
  RCX=$?; : > "$SI/ca.key"; exit $RCX ) || { L "STOP could not make the stand-in certificate"; touch "$R/run.done"; exit 2; }
"$NODE" "$SRC/rig/stand-ins/proxy.mjs" "$SI" > "$SI/proxy.err" 2>&1 & PXP=$!
for _ in $(seq 1 50); do [ -s "$SI/proxy.port" ] && break; sleep 0.2; done
[ -s "$SI/proxy.port" ] || { L "STOP the Telegram stand-in did not start"; kill "$PXP" 2>/dev/null; touch "$R/run.done"; exit 2; }
PX=http://127.0.0.1:$(cat "$SI/proxy.port")
L "stand-ins: tailscale on PATH, telegram via $PX"
PATH=$R/bin:$PATH HTTPS_PROXY=$PX https_proxy=$PX HTTP_PROXY=$PX http_proxy=$PX NO_PROXY=127.0.0.1,localhost,::1 no_proxy=127.0.0.1,localhost,::1 \
NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=$SI/ca.pem TEN_JOBS_STAND_INS=telegram,tailscale \
"$NODE" "$SRC/run.mjs" --exe "$EXE" --root "$R/root" --pw "$PW" --tree "$TREE" --mode "$MODE" ${JOBS:+--jobs "$JOBS"} --out "$R/verdict.json" >> "$R/run.out" 2>&1
RC=$?
L "run.mjs exit $RC: $(grep -E '^(JOB|VERDICT) ' "$R/run.out" | tr '\n' ' ' | cut -c1-1500)"
L "telegram stand-in answered: $(grep -c ' telegram ' "$SI/telegram.log" 2>/dev/null || echo 0) calls ($(grep -o 'telegram [A-Za-z]*' "$SI/telegram.log" 2>/dev/null | sort | uniq -c | tr '\n' ' '))"
kill "$PXP" 2>/dev/null
[ -n "$XP" ] && kill "$XP" 2>/dev/null
kill "$DBUS_SESSION_BUS_PID" 2>/dev/null   # the run's keyring daemon leaves with its session bus
echo "$RC" > "$R/run.done"
