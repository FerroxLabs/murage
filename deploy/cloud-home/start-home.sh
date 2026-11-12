#!/bin/bash
set -euo pipefail
# Safe mode (murage-commands): one start with bots, schedules and add-ons paused. The flag is consumed here,
# so the next start (a restart, a crash restart or a reboot) is normal again.
safe_mode=
if [[ -f /run/murage-safe-mode && ! -L /run/murage-safe-mode ]]; then safe_mode=1; fi
rm -f /run/murage-safe-mode
# Root-only enrollment. Secret bytes remain in unexported memory and pipes.
/usr/local/libexec/murage-enroll
set -a
. /etc/murage-home/home.env
set +a
# Retain and wait for the producer: process substitution alone loses exit 78.
exec 3< <(/usr/local/libexec/murage-enroll --envelope)
unwrap_pid=$!
envelope=''
IFS= read -r -d '' envelope <&3 || true
exec 3<&-
if wait "$unwrap_pid"; then
    :
else
    status=$?
    unset envelope
    if [[ "$status" == 78 ]]; then
        echo 'Cloud home stopped: stale generation; operator recovery required' >&2
    else
        echo 'Cloud home unwrap failed' >&2
    fi
    exit "$status"
fi
# Validate before exec, with stdin carrying the value and no echo on failure.
if ! printf '%s' "$envelope" | /usr/bin/python3 -I -c '
import base64,json,os,sys
try:
    value=json.load(sys.stdin)
    assert isinstance(value,dict) and set(value)=={"version","machineId","dataKey","bootstrapSecret"}
    assert type(value["version"]) is int and value["version"]==2
    assert value["machineId"]==os.environ["MURAGE_CLOUD_MACHINE_ID"]
    for name in ("dataKey","bootstrapSecret"):
        raw=base64.b64decode(value[name],validate=True)
        assert len(raw)==32 and base64.b64encode(raw).decode()==value[name]
except Exception:
    sys.exit(1)
'; then
    unset envelope
    echo 'Cloud home unwrap returned no valid envelope' >&2
    exit 1
fi
exec 3< <(printf '%s' "$envelope")
unset envelope
export MURAGE_CLOUD_SECRETS_FD=3
if [[ -n $safe_mode ]]; then export MURAGE_SAFE_MODE=1; else unset MURAGE_SAFE_MODE; fi
# The image-owned root launcher (LANE-G r3 sec. 1): binds the volume, verifies the live release slot and the update journal, asks the
# updater's gate while an update is in flight, drops to the service user and only then execs the slot's supervisor through the verified
# directory descriptor, with an environment it builds itself from home.env (nothing of this shell's environment reaches node).
exec /usr/bin/python3 -I /usr/local/libexec/murage-home-launch
