#!/bin/bash
# the LAST thing run on a CUSTOMER image builder, in the LAST ssh session, before shutdown and snapshot.
# Usage: finalize-customer-image.sh IMAGE_ID ENV   (run as root on the builder, from a copy outside /build)
# ENV is staging or prod: the environment the image is built for (hz-live --env, the murage/env label). The release check
# compares the baked-in control-plane key, release key and release channel (read from /etc/murage-home and
# /usr/lib/murage-home/trust) with the pins for that ENV.
# It removes the ssh daemon (package, config, host keys, /root/.ssh), then runs image-release-check.sh on this same disk,
# the disk that becomes the snapshot. Nothing may need ssh after this: the caller shuts the server down through the
# provider API and never connects again. A STAGING_OPS_SSH=1 image never runs this script.
# The release check is read from the same directory as this script (hz-live copies both to /run first).
set -euo pipefail
image_id=${1:-builder-disk}
env_name=${2:-}
[[ $env_name == staging || $env_name == prod ]] || { echo "finalize-customer-image: ENV (second argument) must be staging or prod"; exit 1; }
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
apt-get purge -y --auto-remove openssh-server
rm -rf /etc/ssh/sshd_config /etc/ssh/sshd_config.d /root/.ssh /etc/ssh/ssh_host_*
rm -f /etc/murage-image-kind
if dpkg-query -W -f='${Status}' openssh-server 2>/dev/null | grep 'install ok installed' >/dev/null; then echo 'openssh-server is still installed'; exit 1; fi
apt-get clean
bash "$here/image-release-check.sh" / "$image_id" "$env_name" || { echo 'customer image failed the release check'; exit 1; }
sync
