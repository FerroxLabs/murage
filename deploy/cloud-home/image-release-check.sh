#!/bin/bash
# Release gate for a CUSTOMER home image. Usage: image-release-check.sh [ROOT] [IMAGE_ID]
# ROOT is the image's root filesystem (default /; a mounted snapshot disk also works). IMAGE_ID (the published snapshot
# id or digest) is only printed, so the evidence line names the exact image the check ran on.
# Fails (exit 1) when the image has an ssh daemon in any form or carries the staging marker /etc/murage-image-kind.
# Reads files only; changes nothing.
set -uo pipefail
root=${1:-/}
image_id=${2:-unspecified}
root=${root%/}
fail=0
bad() { echo "image-release-check: FAIL $*"; fail=1; }
status=$root/var/lib/dpkg/status
[[ -r $status ]] || { echo "image-release-check: FAIL no dpkg status at $status"; exit 1; }
# Package absent: no openssh-server stanza with an installed status (a removed-but-configured "deinstall ok config-files" is also refused).
if awk 'BEGIN{RS="";FS="\n"} /^Package: openssh-server\n/ { if ($0 ~ /\nStatus: [a-z]+ ok (installed|half-installed|unpacked|half-configured|triggers-awaited|triggers-pending|config-files)\n/) found=1 } END{exit found?0:1}' "$status"; then
    bad "openssh-server package is present"
fi
for f in usr/sbin/sshd usr/lib/openssh/sshd-session usr/lib/openssh/sshd-auth etc/ssh/sshd_config etc/ssh/sshd_config.d root/.ssh; do
    [[ -e $root/$f || -L $root/$f ]] && bad "$f exists"
done
for h in "$root"/etc/ssh/ssh_host_*; do [[ -e $h ]] && bad "ssh host key $(basename "$h") exists"; done
# No listener unit: no unit file, enable link or socket for an ssh daemon anywhere systemd looks.
for d in usr/lib/systemd lib/systemd etc/systemd run/systemd; do
    [[ -d $root/$d ]] || continue
    hits=$(find "$root/$d" \( -name 'ssh.service' -o -name 'ssh.socket' -o -name 'sshd.service' -o -name 'sshd@.service' -o -name 'sshd.socket' -o -name 'sshd-keygen.service' -o -name 'ssh@.service' \) 2>/dev/null | head -3)
    [[ -n $hits ]] && bad "ssh daemon unit present under /$d"
done
# No marker: a staging image carries /etc/murage-image-kind = staging-ops-ssh; a customer image carries neither it nor any other kind.
if [[ -e $root/etc/murage-image-kind || -L $root/etc/murage-image-kind ]]; then bad "marker /etc/murage-image-kind is present"; fi
if (( fail )); then exit 1; fi
echo "image-release-check: ok image=$image_id (no sshd package, binary, config, host keys or unit; no staging marker)"
