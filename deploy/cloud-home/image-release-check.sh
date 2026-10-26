#!/bin/bash
# shellcheck disable=SC2034  # the pins are read through indirect expansion
# Release gate for a CUSTOMER home image. Usage: image-release-check.sh ROOT IMAGE_ID ENV
# ROOT is the image's root filesystem (a mounted snapshot disk; default /). IMAGE_ID is the published snapshot id and
# ENV is staging or prod; both are printed in the evidence line, so the line names the exact image and environment.
# Fails (exit 1) when the image has an ssh daemon in any form, carries the staging marker /etc/murage-image-kind, or
# bakes in a control-plane key, release key or release channel that is not the pinned one for ENV.
# Fail closed: a probe that errors counts as a failure, symlinks are never followed out of ROOT, and the ok line is
# printed only when every probe ran. Reads files only; changes nothing.
set -euo pipefail

# Pins per environment. The control-plane key (/etc/murage-home/control-plane-public-key.json) and the release key
# (/usr/lib/murage-home/trust/release-public-key.pem) are pinned by sha256 (lowercase hex) of the file. The release channel
# file (/usr/lib/murage-home/trust/release.json) holds the build's revision and sequence, so it differs per build: it is
# pinned by the channel URL it names and must have exactly the shape build-image.sh writes. An empty pin refuses every image
# of that environment, so the pins must be filled in (and this file re-reviewed) before the first signature.
# staging control key: the SIGNING_PINS staging JWK of cloudflare/control-plane/src/env-policy.mjs, re-serialized by hz-live.py
# (sorted keys, public fields only). staging release key: ~/.config/murage-staging/release-signing-ed25519.pub.pem (Ed25519,
# never the production key). staging channel: no staging channel is deployed; the .test name cannot resolve, so a staging home
# can never fetch an update from anywhere.
CONTROL_KEY_SHA256_staging="5eb46a3c09fa9c8dc88f33c65c2fbd4825a5392f90c6fe76bb0d2d31d3d82c4c"
CONTROL_KEY_SHA256_prod=""
RELEASE_KEY_SHA256_staging="fa2c1c732921ffa2c9da9a40e10a890956e3237d28c5ef2a75e29a532e29b072"
RELEASE_KEY_SHA256_prod=""
RELEASE_CHANNEL_URL_staging="https://releases.murage.test/cloud-home"
RELEASE_CHANNEL_URL_prod=""

root=${1:-/}
image_id=${2:-unspecified}
env_name=${3:-}
fail=0
probes=0
EXPECTED_PROBES=8
bad() { echo "image-release-check: FAIL $*"; fail=1; }
probe() { probes=$((probes + 1)); }

if [[ $env_name != staging && $env_name != prod ]]; then
    echo "image-release-check: FAIL ENV must be staging or prod"
    exit 1
fi
[[ -d $root ]] || { echo "image-release-check: FAIL root $root is not a directory"; exit 1; }
root=$(cd -P -- "$root" && pwd -P) || { echo "image-release-check: FAIL cannot resolve root"; exit 1; }
root=${root%/}

# Resolve a path inside ROOT without following a link out of it. A symlink whose target is absolute or climbs out of
# ROOT resolves (with realpath, which uses the running system's root) to a place outside ROOT, and that is a failure.
inside() {
    local rp
    rp=$(realpath -m -- "$root/$1" 2>/dev/null) || return 1
    [[ $rp == "$root" || $rp == "$root"/* ]]
}
# dirlinks DIR: print the directory symlinks under DIR, judged inside the image: a link whose text is absolute means $root$target,
# a relative one is relative to its own directory, and a target that resolves outside the image counts as a directory link.
# (find -xtype would stat the rescue host, where an absolute target usually does not exist.) /dev/null masks are not directories.
dirlinks() {
    local link t cand rp
    while IFS= read -r -d '' link; do
        t=$(readlink -- "$link") || { echo "$link"; continue; }
        [[ $t == /dev/null ]] && continue
        if [[ $t == /* ]]; then cand=$root$t; else cand=$(dirname -- "$link")/$t; fi
        rp=$(realpath -m -- "$cand" 2>/dev/null) || { echo "$link"; continue; }
        if [[ $rp != "$root" && $rp != "$root"/* ]]; then echo "$link"; continue; fi
        [[ -d $rp ]] && echo "$link"
    done < <(find -P "$1" -xdev -type l -print0)
}
checked_exists() {
    # Echo nothing; status 0 = present (file or link), 1 = absent, 2 = path escapes ROOT.
    local p=$root/$1
    if [[ -e $p || -L $p ]]; then
        inside "$1" || return 2
        return 0
    fi
    return 1
}

# Probe 1: dpkg database readable.
probe
status=$root/var/lib/dpkg/status
if [[ -L $status ]] && ! inside var/lib/dpkg/status; then
    bad "dpkg status escapes the image root"
elif [[ ! -f $status || ! -r $status ]]; then
    echo "image-release-check: FAIL no dpkg status at $status"
    exit 1
else
    # Probe 2: openssh-server absent. awk exits 10 when an installed or configured stanza is found, 0 when none is,
    # and anything else is an error and a failure.
    probe
    rc=0
    awk 'BEGIN{RS="";FS="\n"} /^Package: openssh-server(\n|$)/ { if ($0 ~ /\nStatus: [a-z]+ ok (installed|half-installed|unpacked|half-configured|triggers-awaited|triggers-pending|config-files)(\n|$)/) found=1 } END{exit found?10:0}' "$status" || rc=$?
    case $rc in
        0) ;;
        10) bad "openssh-server package is present" ;;
        *) bad "dpkg status probe errored (awk exit $rc)" ;;
    esac
fi

# Probe 3: no sshd binary, config or root ssh dir.
probe
for f in usr/sbin/sshd usr/lib/openssh/sshd-session usr/lib/openssh/sshd-auth etc/ssh/sshd_config etc/ssh/sshd_config.d root/.ssh; do
    rc=0
    checked_exists "$f" || rc=$?
    case $rc in
        0) bad "$f exists" ;;
        1) ;;
        *) bad "$f escapes the image root" ;;
    esac
done

# Probe 4: no ssh host keys, anywhere under /etc/ssh. A symlinked /etc/ssh is refused: [[ -d ]] follows it, find -P does not, so
# a link would hide the keys from the search while the running system still reads them.
probe
if [[ -L $root/etc/ssh ]]; then
    bad "/etc/ssh is a symlink"
elif [[ -d $root/etc/ssh ]]; then
    if ! inside etc/ssh; then bad "/etc/ssh escapes the image root"; else
        errf=$(mktemp)
        rc=0
        hits=$(find -P "$root/etc/ssh" -xdev -name 'ssh_host_*' -print0 2>"$errf" | tr '\0' '\n') || rc=$?
        if (( rc != 0 )) || [[ -s $errf ]]; then bad "host key probe errored"; fi
        rm -f "$errf"
        [[ -n $hits ]] && bad "ssh host key exists under /etc/ssh"
        errf=$(mktemp)
        rc=0
        dl=$(dirlinks "$root/etc/ssh" 2>"$errf") || rc=$?
        if (( rc != 0 )) || [[ -s $errf ]]; then bad "directory link probe under /etc/ssh errored"; fi
        rm -f "$errf"
        [[ -z $dl ]] || bad "a directory symlink under /etc/ssh hides host keys from the search"
    fi
elif [[ -e $root/etc/ssh ]]; then
    bad "/etc/ssh is not a directory"
fi

# Probe 5: no listener unit: no unit file, enable link or socket for an ssh daemon anywhere systemd looks. A symlinked systemd
# directory (or system/ subdirectory) is refused for the same reason as /etc/ssh: find -P would not follow it, systemd does.
probe
for d in usr/lib/systemd usr/local/lib/systemd lib/systemd etc/systemd run/systemd; do
    for sub in "" /system; do
        if [[ -L $root/$d$sub ]]; then bad "/$d$sub is a symlink"; fi
    done
    [[ -d $root/$d && ! -L $root/$d ]] || continue
    if ! inside "$d"; then bad "/$d escapes the image root"; continue; fi
    # systemd opens a directory symlink anywhere in its tree (a *.wants link, say), and find -P does not enter one.
    errf=$(mktemp)
    rc=0
    dl=$(dirlinks "$root/$d" 2>"$errf") || rc=$?
    if (( rc != 0 )) || [[ -s $errf ]]; then bad "directory link probe under /$d errored"; fi
    rm -f "$errf"
    [[ -z $dl ]] || bad "a directory symlink under /$d hides units from the search"
    errf=$(mktemp)
    rc=0
    hits=$(find -P "$root/$d" -xdev \( -name 'ssh.service' -o -name 'ssh.socket' -o -name 'sshd.service' -o -name 'sshd@.service' -o -name 'sshd.socket' -o -name 'sshd-keygen.service' -o -name 'ssh@.service' \) -print0 2>"$errf" | tr '\0' '\n') || rc=$?
    if (( rc != 0 )) || [[ -s $errf ]]; then bad "unit probe under /$d errored"; fi
    rm -f "$errf"
    [[ -n $hits ]] && bad "ssh daemon unit present under /$d"
done

# Probe 6: no staging marker.
probe
rc=0
checked_exists etc/murage-image-kind || rc=$?
case $rc in
    0) bad "marker /etc/murage-image-kind is present" ;;
    1) ;;
    *) bad "/etc/murage-image-kind escapes the image root" ;;
esac

# Probe 7: the baked-in keys and channel are the pinned ones for ENV.
probe
pin_check() {
    local rel=$1 pin=$2 label=$3 p=$root/$1 got
    if [[ -z $pin || ! $pin =~ ^[0-9a-f]{64}$ ]]; then bad "no pin for $label in $env_name"; return; fi
    if [[ -L $p || ! -f $p ]]; then bad "$label is missing or not a regular file"; return; fi
    inside "$rel" || { bad "$label escapes the image root"; return; }
    got=$(sha256sum -- "$p" | awk '{print $1}') || { bad "$label hash probe errored"; return; }
    [[ $got == "$pin" ]] || bad "$label does not match the $env_name pin"
}
# release.json is what build-image.sh writes with json.dump: channelUrl, minimumSequence, imageRevision, launcherAbi, in that order.
channel_check() {
    local rel=$1 pin=$2 label=$3 p=$root/$1 body size
    local re='^\{"channelUrl": "([^"]+)", "minimumSequence": [1-9][0-9]{0,8}, "imageRevision": "[0-9a-f]{40}", "launcherAbi": "[A-Za-z0-9][A-Za-z0-9._-]{0,63}"\}$'
    if [[ -z $pin || ! $pin =~ ^https://[A-Za-z0-9.-]+(/[A-Za-z0-9._/-]*)?$ ]]; then bad "no pin for $label in $env_name"; return; fi
    if [[ -L $p || ! -f $p ]]; then bad "$label is missing or not a regular file"; return; fi
    inside "$rel" || { bad "$label escapes the image root"; return; }
    size=$(wc -c < "$p") || { bad "$label size probe errored"; return; }
    size=${size//[[:space:]]/}
    # murage-commands read_trust refuses a file over 4096 bytes; command substitution drops NULs and trailing newlines, so the
    # body must account for every byte of the file.
    if [[ ! $size =~ ^[0-9]+$ ]] || (( size > 4096 )); then bad "$label is larger than the home's reader accepts"; return; fi
    body=$(head -c 4096 -- "$p") || { bad "$label read probe errored"; return; }
    (( ${#body} == size )) || { bad "$label is not the file build-image.sh writes"; return; }
    if [[ ! $body =~ $re ]]; then bad "$label is not the file build-image.sh writes"; return; fi
    [[ ${BASH_REMATCH[1]} == "$pin" ]] || bad "$label does not name the $env_name channel"
}
pv=CONTROL_KEY_SHA256_$env_name; ck=${!pv}
pv=RELEASE_KEY_SHA256_$env_name; rk=${!pv}
pv=RELEASE_CHANNEL_URL_$env_name; ru=${!pv}
pin_check etc/murage-home/control-plane-public-key.json "$ck" "control-plane-public-key.json"
pin_check usr/lib/murage-home/trust/release-public-key.pem "$rk" "release-public-key.pem"
channel_check usr/lib/murage-home/trust/release.json "$ru" "release channel file"
# The trust root moved from /etc/murage-home to /usr/lib/murage-home/trust. Nothing reads the old pair, so its presence means
# an image from the old layout or a planted decoy: refuse either way.
for stale in etc/murage-home/release-public-key.pem etc/murage-home/release.json; do
    if [[ -e $root/$stale || -L $root/$stale ]]; then bad "$stale is present (old trust layout)"; fi
done

# Probe 8: nothing above was skipped.
probe
if (( probes != EXPECTED_PROBES )); then bad "probe count $probes, expected $EXPECTED_PROBES"; fi

if (( fail )); then exit 1; fi
echo "image-release-check: ok image=$image_id env=$env_name (no sshd package, binary, config, host keys or unit; no staging marker; pinned keys and channel)"
