#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Boot ordering qualification for the home image, run as root INSIDE a throwaway Ubuntu 24.04 container (never on a
# workstation or a live home). It installs systemd and cloud-init from the archive, installs and enables the image's
# units exactly as build-image.sh does (the `systemctl enable` lines are taken from build-image.sh itself), emulates the
# cloud-init generator, and then fails on any ordering cycle reported by either:
#   1. `systemd-analyze verify`, which enqueues a start job for each unit and logs "Found ordering cycle" when the
#      transaction is cyclic (systemd would delete a job at boot);
#   2. unit-order-check.py, an independent graph check over the same files that also writes the dot graph.
# Usage (from a host with docker, repository at $PWD):
#   docker run --rm -v "$PWD":/src:ro ubuntu:24.04 bash /src/deploy/cloud-home/qualify/unit-order-test.sh
set -euo pipefail
src=${1:-/src}
here=$src/deploy/cloud-home
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null
apt-get install -y -qq --no-install-recommends systemd cloud-init python3 >/dev/null
echo "systemd $(systemd-analyze --version | head -n1), cloud-init $(dpkg-query -W -f='${Version}' cloud-init)"
for f in "$here"/*.service "$here"/*.timer "$here"/*.path "$here"/*.mount "$here"/*.slice; do
  install -m 0644 "$f" /etc/systemd/system/
done
# Placeholders for the image's own programs, so verify reports ordering, not "command not found".
for exe in $(sed -n 's/^Exec[A-Za-z]*=[-@:+!]*\([^ ]*\).*/\1/p' "$here"/*.service | sort -u); do
  case $exe in /*) [ -e "$exe" ] || { mkdir -p "$(dirname "$exe")"; printf '#!/bin/sh\nexit 0\n' > "$exe"; chmod 0755 "$exe"; } ;; esac
done
# Same enables as the image (systemctl works offline here: it only creates the .wants links).
sed -n 's/^systemctl enable \(.*\)$/\1/p' "$here/build-image.sh" > /tmp/enables
[ -s /tmp/enables ] || { echo "no systemctl enable lines found in build-image.sh"; exit 1; }
while read -r line; do
  # shellcheck disable=SC2086
  systemctl enable $line 2>&1 | grep -v '^Created symlink' || true
done < /tmp/enables
# cloud-init's generator does this at boot when a datasource is found (build host, Vultr).
ln -sf /usr/lib/systemd/system/cloud-init.target /etc/systemd/system/multi-user.target.wants/cloud-init.target
systemctl set-default multi-user.target >/dev/null 2>&1

units=(multi-user.target cloud-final.service cloud-config.service)
for f in "$here"/*.service "$here"/*.timer "$here"/*.path "$here"/*.mount; do units+=("$(basename "$f")"); done
set +e
systemd-analyze verify --man=no "${units[@]}" > /tmp/verify.log 2>&1
verify=$?
set -e
echo "systemd-analyze verify exit $verify, $(wc -l < /tmp/verify.log) lines"
if grep -Ei 'ordering cycle|order is cyclic|break ordering' /tmp/verify.log; then
  echo "FAIL: systemd-analyze verify found an ordering cycle"
  exit 1
fi
# Any complaint about the image's own unit files is a failure too.
if grep -E '^/etc/systemd/system/(murage-|data\.mount)' /tmp/verify.log; then
  echo "FAIL: systemd-analyze verify rejected an image unit"
  exit 1
fi
python3 -I "$here/qualify/unit-order-check.py" --root / --dot /tmp/boot-order.dot
echo "dot graph: $(wc -l < /tmp/boot-order.dot) lines in /tmp/boot-order.dot"
echo "PASS: no ordering cycle"
