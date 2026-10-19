#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Operator/CI wrapper: creates ONE throwaway CX23 (mcq-b5bk), runs backup-restore-test.sh on it, deletes it.
# Usage: HCLOUD_TOKEN_FILE=~/.config/murage-test/hetzner-token SSH_KEY_ID=<id> bash backup-restore-test-hcloud.sh
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
TOKEN=$(cat "${HCLOUD_TOKEN_FILE:?}"); KEY=${SSH_KEY_ID:?}
api() { curl -4 -s -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' "$@"; }
[ "$(api https://api.hetzner.cloud/v1/servers?name=mcq-b5bk | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["servers"]))')" = 0 ] || { echo "mcq-b5bk already exists"; exit 2; }
RESP=$(api -X POST https://api.hetzner.cloud/v1/servers -d "{\"name\":\"mcq-b5bk\",\"server_type\":\"cx23\",\"image\":\"ubuntu-24.04\",\"ssh_keys\":[$KEY],\"location\":\"fsn1\"}")
ID=$(echo "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["server"]["id"])')
IP=$(echo "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["server"]["public_net"]["ipv4"]["ip"])')
trap 'api -X DELETE https://api.hetzner.cloud/v1/servers/'"$ID"' >/dev/null; echo "mcq-b5bk deleted"' EXIT
SSH=(ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 "root@$IP")
for i in $(seq 1 30); do "${SSH[@]}" true 2>/dev/null && break; sleep 10; done
# backup-restore-test.sh deletes /data and refuses to start without this marker:
# only this wrapper, on the VM it just created, says the host is disposable.
"${SSH[@]}" 'touch /etc/mcq-disposable-test-host'
tar -C "$HERE/.." -cf - backup-excludes.txt murage-backup | "${SSH[@]}" 'mkdir -p /root/hc && tar -C /root/hc -xf -'
cat "$HERE/backup-restore-test.sh" | "${SSH[@]}" 'cat > /root/hc/t.sh'
"${SSH[@]}" 'bash /root/hc/t.sh /root/hc'
