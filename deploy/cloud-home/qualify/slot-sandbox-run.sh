#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Builds the Lane G two-slot layout in a throwaway Debian/Ubuntu container (root, bwrap + python3 installed, user namespaces
# allowed: e.g. `docker run --privileged`, or on a stock Ubuntu 24.04 VM after installing deploy/cloud-home/bwrap.apparmor and browser-bwrap.apparmor as build-image.sh does, since its default AppArmor denies bwrap its uid map) and runs slot-sandbox-check.py as the turn user against the launcher under test.
# Usage: slot-sandbox-run.sh <launcher.py> <slot-sandbox-check.py>      Exit 0 only when every step passed.
set -eu
LAUNCHER=$1; CHECK=$2
id murage-turn >/dev/null 2>&1 || useradd -u 1000 -M -s /usr/sbin/nologin murage-turn
# The launcher's --child path demands the real murage-turn uid, so run as whatever uid the account has (it may already exist, e.g. from another proof).
TU=$(id -u murage-turn); TG=$(id -g murage-turn)
rm -rf /opt/murage /opt/murage-releases
for slot in A B; do mkdir -p /opt/murage-releases/$slot/bin /opt/murage-releases/$slot/resources/browser-engine/chrome/chrome-headless-shell-linux64 \
  /opt/murage-releases/$slot/resources/browser-engine/chrome/chrome-headless-shell-linux-arm64; done
# Slot A: real native binaries (echo prints its args, true prints nothing). Slot B: the other way round, same manifest.
sha() { sha256sum "$1" | cut -d' ' -f1; }
cp /bin/echo /opt/murage-releases/A/bin/claude
cp /bin/echo /opt/murage-releases/A/resources/browser-engine/agent-browser
cp /bin/echo /opt/murage-releases/A/resources/browser-engine/chrome/chrome-headless-shell-linux64/chrome-headless-shell
cp /bin/echo /opt/murage-releases/A/resources/browser-engine/chrome/chrome-headless-shell-linux-arm64/chrome-headless-shell
cp /bin/true /opt/murage-releases/B/bin/claude
cp /bin/true /opt/murage-releases/B/resources/browser-engine/agent-browser
cp /bin/true /opt/murage-releases/B/resources/browser-engine/chrome/chrome-headless-shell-linux64/chrome-headless-shell
cp /bin/true /opt/murage-releases/B/resources/browser-engine/chrome/chrome-headless-shell-linux-arm64/chrome-headless-shell
D=$(sha /bin/echo)
cat > /opt/murage-releases/A/engine-manifest.json <<JSON
{"claudeAgent":[{"path":"/opt/murage/bin/claude","sha256":"$D"}],
 "browser":[{"path":"/opt/murage/resources/browser-engine/agent-browser","sha256":"$D"},
  {"path":"/opt/murage/resources/browser-engine/chrome/chrome-headless-shell-linux64/chrome-headless-shell","sha256":"$D"},
  {"path":"/opt/murage/resources/browser-engine/chrome/chrome-headless-shell-linux-arm64/chrome-headless-shell","sha256":"$D"}]}
JSON
cp /opt/murage-releases/A/engine-manifest.json /opt/murage-releases/B/engine-manifest.json
chown -R root:root /opt/murage-releases; chmod -R go-w /opt/murage-releases; chmod 755 /opt /opt/murage-releases
ln -s A /opt/murage-releases/current
ln -s murage-releases/current /opt/murage
install -d -m 755 -o root -g root /usr/local/libexec
install -m 755 -o root -g root "$LAUNCHER" /usr/local/libexec/murage-turn-launch
mkdir -p /data/browser /etc/claude-code; echo "{}" > /etc/claude-code/managed-settings.json; chmod 644 /etc/claude-code/managed-settings.json; rm -f /tmp/slot-flip-request /tmp/slot-flipped
# The root side of the slot flip: when the check asks, point `current` at B (atomically, as the updater does).
( i=0; while [ $i -lt 600 ]; do
    if [ -e /tmp/slot-flip-request ]; then ln -sfn B /opt/murage-releases/current.new && mv -T /opt/murage-releases/current.new /opt/murage-releases/current; touch /tmp/slot-flipped; exit 0; fi
    i=$((i+1)); sleep 0.1; done ) &
FLIPPER=$!
set +e
SLOT_FLIP=1 setpriv --reuid="$TU" --regid="$TG" --clear-groups env HOME=/tmp SLOT_FLIP=1 python3 -I "$CHECK" /usr/local/libexec/murage-turn-launch
RC=$?
kill $FLIPPER 2>/dev/null
exit $RC
