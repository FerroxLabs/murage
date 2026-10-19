# Backups v1

## Decision: restic over SFTP to a build host Storage Box, one sub-account per home

- build host server backups skip volumes, and a build host volume has no snapshot feature, so neither can protect `/data`
  (the LUKS volume). That leaves file-level backup from inside the home.
- restic is already Murage's backup engine. Its repository is encrypted client-side (AES-256 + Poly1305) before it leaves the
  home; the storage box only ever sees ciphertext.
- Restorability of the key: the repository password is NOT stored anywhere new. It is `HKDF-SHA256(dataKey, salt=homeId,
  info="murage-backup-v1")`, computed by the control plane from the home's KMS-wrapped data key
  (`POST /v1/machines/<homeId>/backup-password`, admin token). Anyone with admin rights plus KMS access can always recompute it,
  including for a dead home.
- Isolation: a Storage Box sub-account per home, restricted to its own directory, so a compromised home can reach only its
  own repository. A compromised home could delete its own repo; enable Storage Box snapshots (daily) as the second layer.
- Schedule: `murage-backup.timer`, 02:00 UTC plus up to 1 h random delay. Retention in the script: `--keep-daily 7 --keep-weekly 4`
  with prune. The heartbeat reports `lastBackupAt`; the control plane alerts `home.backup_stale` after 26 h.
- The unit is inert until `/etc/murage-home/backup.json` exists. Provisioning (B5 build host adapter or operator) must write
  `backup.json`, `backup.pass` (from the backup-password route), `backup.key` and `backup.known_hosts` (all root 0600).

## Never backed up (hard requirement, Anthropic hosting terms)

We may never collect or store Claude.ai credentials or session tokens. `backup-excludes.txt` excludes, at any depth:
`.claude`, `.claude.json`, `.claude.json.backup`, `.codex`, `.grok`, `.kimi-code`, `.config/opencode`, `.local/share/opencode`,
`.gemini`, `.qwen`, `.cursor`, `.factory`, `.droid`, `.antigravity`, and files named `auth.json`, `.credentials.json`,
`credentials`, `credentials.json`; plus browser cookie jars and storage under `/data/browser` (`Cookies`, `Login Data`,
`Local Storage`, `Session Storage`, `IndexedDB`, `Network`, ...). Source of the list: `RECOVERY_CREDENTIALS` and the pinned
engine homes in `deploy/cloud-home/murage-turn-launch.py`. Guards: `murage-backup` refuses to run if the exclusion file lacks
the core entries; `server/cloud-home/backup-excludes.test.ts` fails if any launcher credential path would reach the backup set;
`qualify/backup-restore-test.sh` proves on a real host that a restore contains none of them and that the secret string is
absent from both the restore and the repository.

**After a restore the customer signs in again** (Claude, Codex and the other engines, and any website logins in the home
browser). Tell them this in the restore notice.

## Cost per home (estimate; confirm list prices at order time)

Assumptions: Storage Box BX11, 1 TB, about EUR 3.20/month (fixed, shared by the fleet; sub-accounts are free); typical home data
10 GB; restic dedup plus 7 daily + 4 weekly keeps roughly 1.5 to 2x the live data = 15 to 20 GB.

| Item | Per home per month |
|---|---|
| Storage 15-20 GB at EUR 3.20/TB | about EUR 0.05 to 0.07 |
| Fixed box share at 50 homes | EUR 0.06 (EUR 3.20 / 50) |
| Transfer (SFTP to a Storage Box, build host-internal) | EUR 0 |
| **Total** | **about EUR 0.10 to 0.15 (about $0.12 to $0.16)** |

A 1 TB box holds about 50 to 60 homes at these sizes; a heavy home at 100 GB data costs about EUR 0.50/month. For comparison,
build host server backups (20% of server price, about EUR 0.80 for a CX23) would cost more and would not include the volume.

## Measured on a throwaway CX23 (mcq-b5bk, deleted afterwards)
20 MB data: first backup 5 s; repo 21 MB; `restic check` ok; restore byte-identical; credentials and cookies absent;
retention over 41 nightly snapshots kept 9 (7 daily + 4 weekly with overlap); PASS.

## Restore runbook

When: home destroyed, volume lost or corrupt, or customer asks to roll back.
1. **Get the old home id** (`HOME_ID`) from the control plane / portal. Do not delete its row or key rows yet: the repository password derives from its data key.
2. **Provision a fresh home** the normal way (new server and volume, enroll). It gets a NEW home id `NEW_ID` and new keys.
3. **Derive the repository password**: `curl -s -X POST https://<cp>/v1/machines/$HOME_ID/backup-password -H "authorization: Bearer $CLOUD_ADMIN_TOKEN"` and store the answer in `/etc/murage-home/backup.pass` on the fresh home (root 0600). Never print it in chat or logs.
4. **Give the fresh home read access** to the old repository: a temporary read credential for the old home's Storage Box sub-account, in `/root/restore.json` style env (`RESTIC_REPOSITORY=sftp:...`, `RESTIC_PASSWORD_FILE`). Remove it after.
5. **Stop the home** (`systemctl stop murage-home murage-proxy murage-egress-proxy`), keep `/data` mounted.
6. **Pick the snapshot**: `restic snapshots` (latest is last night; weekly ones go back 4 weeks).
7. **Restore**: `restic restore <snapshot> --target /restore-tmp`, check, then `rsync -a /restore-tmp/data/ /data/` and `chown` per the image's ownership (engine homes `root:engine 2770` are re-created by the launcher on first start).
8. **Start the home** and let the customer in. **Tell the customer they must sign in again** to Claude, Codex and any other engine (credentials are never backed up), and to any websites in the home browser.
9. **Repoint backups**: write the fresh home's own `backup.json` and password (derived for `NEW_ID`), run `systemctl start murage-backup` once, confirm `lastBackupAt` appears in the heartbeat.
10. Keep the old repository 30 days, then delete it.

Restore test (run before launch, then quarterly): `HCLOUD_TOKEN_FILE=... SSH_KEY_ID=... bash deploy/cloud-home/qualify/backup-restore-test-hcloud.sh`
creates ONE throwaway CX23 `mcq-b5bk`, runs the full back-up / restore / credential-absence / retention check, and deletes the server.
Limit of the automated test: it restores into a fresh directory on a fresh host over SFTP; the full "new enrolled home" restore
(steps 2 to 8) is the manual runbook and should be rehearsed once on a real B5 home before the first customer.
