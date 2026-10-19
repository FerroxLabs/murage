#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Runs ON a disposable Ubuntu host as root, from a checkout containing deploy/cloud-home.
# Proves the real murage-backup (restic over SFTP) -> restore round trip into a fresh directory:
#   1. files come back byte-identical, 2. no engine credential or browser cookie is in the backup,
#   3. the repo holds no plaintext, 4. retention keeps 7 daily + 4 weekly, 5. restic check passes.
# Usage: bash backup-restore-test.sh [path-to-deploy/cloud-home]
set -euo pipefail
# >>> disposable-host guard
# Everything below deletes /data, /srv/bk-repo and /restore. A real home keeps its
# data in /data/home, so run only where backup-restore-test-hcloud.sh made the host
# for this test (it writes the marker on the fresh VM), never on an enrolled home and
# never on a host built from the home image (build-image.sh writes identity.json).
for refusal in "/etc/mcq-disposable-test-host:missing" "/etc/murage-home/enrolled:present" "/data/home:present" \
               "/etc/murage-home/identity.json:present"; do
  path=${refusal%:*}; want=${refusal##*:}
  if { [ "$want" = missing ] && [ ! -e "$path" ]; } || { [ "$want" = present ] && [ -e "$path" ]; }; then
    echo "backup-restore-test: refusing to run: $path is $want; this test deletes /data and runs only on a fresh host made by backup-restore-test-hcloud.sh" >&2
    exit 3
  fi
done
# <<< disposable-host guard
SRC=${1:-$(cd "$(dirname "$0")/.." && pwd)}
export DEBIAN_FRONTEND=noninteractive
command -v restic >/dev/null || { apt-get update -qq && apt-get install -y -qq restic openssh-server python3 >/dev/null; }
systemctl start ssh 2>/dev/null || service ssh start
W=/root/bk-test; rm -rf "$W" /data /srv/bk-repo /restore; mkdir -p "$W" /srv/bk-repo /etc/murage-home /var/lib/murage-home /usr/local/libexec
SECRET="FAKE-ENGINE-SECRET-$(head -c8 /dev/urandom | od -An -tx1 | tr -d ' \n')"
# --- a /data tree shaped like a home, with credential decoys everywhere the launcher pins them ---
mkdir -p /data/home/work /data/home/memory /data/engines/claudeAgent/.claude /data/engines/codex/.codex /data/engines/grokAgent/.grok \
  /data/engines/kimiAgent/.kimi-code /data/engines/opencodeGo/.config/opencode /data/engines/opencodeGo/.local/share/opencode "/data/browser/bot1/Default/Local Storage" /data/home/work/Network
echo "quarterly plan" > /data/home/work/report.md; echo "customer folder named like a browser dir" > /data/home/work/Network/plan.md
head -c 20000000 /dev/urandom > /data/home/memory/db.bin
for f in engines/claudeAgent/.claude/.credentials.json engines/claudeAgent/.claude.json engines/codex/.codex/auth.json engines/grokAgent/.grok/auth.json \
         engines/kimiAgent/.kimi-code/credentials engines/opencodeGo/.config/opencode/auth.json engines/opencodeGo/.local/share/opencode/auth.json \
         browser/bot1/Default/Cookies "browser/bot1/Default/Local Storage/000003.log" engines/claudeAgent/.claude/settings.json; do
  echo "$SECRET" > "/data/$f"; done
# --- sftp to ourselves with a dedicated key, like a Storage Box sub-account ---
ssh-keygen -q -t ed25519 -N '' -f /etc/murage-home/backup.key
cat /etc/murage-home/backup.key.pub >> /root/.ssh/authorized_keys 2>/dev/null || { mkdir -p /root/.ssh; cat /etc/murage-home/backup.key.pub >> /root/.ssh/authorized_keys; }
ssh-keyscan -t ed25519 localhost > /etc/murage-home/backup.known_hosts 2>/dev/null
head -c 32 /dev/urandom | base64 > /etc/murage-home/backup.pass; chmod 600 /etc/murage-home/backup.pass /etc/murage-home/backup.key
cat > /etc/murage-home/backup.json <<JSON
{"repository":"sftp:root@localhost:/srv/bk-repo","passwordFile":"/etc/murage-home/backup.pass","sshKey":"/etc/murage-home/backup.key","knownHosts":"/etc/murage-home/backup.known_hosts"}
JSON
install -m 0644 "$SRC/backup-excludes.txt" /etc/murage-home/backup-excludes.txt
install -m 0755 "$SRC/murage-backup" /usr/local/libexec/murage-backup
mkdir -p /var/cache/restic
T0=$(date +%s)
/usr/bin/python3 -I /usr/local/libexec/murage-backup
echo "backup 1 ok in $(( $(date +%s) - T0 )) s; heartbeat stamp: $(cat /var/lib/murage-home/backup-last)"
echo "changed" >> /data/home/work/report.md
/usr/bin/python3 -I /usr/local/libexec/murage-backup
# --- restore into a fresh empty directory (stands in for the fresh home's /data) ---
export RESTIC_REPOSITORY=sftp:root@localhost:/srv/bk-repo RESTIC_PASSWORD_FILE=/etc/murage-home/backup.pass
SFTPARG=(-o "sftp.args=-o BatchMode=yes -o UserKnownHostsFile=/etc/murage-home/backup.known_hosts -i /etc/murage-home/backup.key")
restic "${SFTPARG[@]}" check >/dev/null && echo "restic check ok"
restic "${SFTPARG[@]}" restore latest --target /restore >/dev/null
fail=0
for f in home/work/report.md home/work/Network/plan.md home/memory/db.bin; do
  cmp -s "/data/$f" "/restore/data/$f" || { echo "MISMATCH $f"; fail=1; }; done
if find /restore \( -name .claude -o -name .claude.json -o -name .codex -o -name .grok -o -name .kimi-code -o -name opencode -o -name Cookies -o -name 'Local Storage' -o -name auth.json -o -name credentials \) | grep .; then
  echo "CREDENTIAL PATH RESTORED"; fail=1; fi
if grep -rIl "$SECRET" /restore /srv/bk-repo 2>/dev/null | grep .; then echo "SECRET FOUND"; fail=1; fi
grep -raql "quarterly plan" /srv/bk-repo && { echo "REPO HOLDS PLAINTEXT"; fail=1; }
echo "restore ok: $(find /restore -type f | wc -l) files, repo $(du -sh /srv/bk-repo | cut -f1) for $(du -sh /data | cut -f1) of data"
# --- retention: 40 nightly snapshots, expect 7 daily + up to 4 weekly (a weekly that falls inside the daily window is the same snapshot) ---
rm -rf /srv/bk-repo/*; restic "${SFTPARG[@]}" init >/dev/null
echo x > /root/bk-test/one
for d in $(seq 40 -1 0); do
  restic "${SFTPARG[@]}" backup /root/bk-test/one --time "$(date -u -d "-$d days" '+%Y-%m-%d 02:00:00')" --host h >/dev/null; done
restic "${SFTPARG[@]}" forget --keep-daily 7 --keep-weekly 4 --prune >/dev/null
kept=$(restic "${SFTPARG[@]}" snapshots --json | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))')
echo "retention kept $kept of 41 snapshots"
[ "$kept" -ge 7 ] && [ "$kept" -le 11 ] || { echo "RETENTION OFF"; fail=1; }
[ "$fail" = 0 ] && echo "BACKUP_RESTORE_TEST PASS" || { echo "BACKUP_RESTORE_TEST FAIL"; exit 1; }
