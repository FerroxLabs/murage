# Back up now: say what is happening, and say how it went (1.0.7)

Status: design r1, 2026-10-26. Branch fix/107-backup-stray-file, base dev/int/107 893e0768f.

## What Sean saw (server.log, read-only)
10-25 23:23Z and 23:26Z: Back up now quit the server, the capture stopped with
`BACKUP_UNCLASSIFIED_COMPONENT path=config.json.bak-20260918-openaicompat`, and Murage
reopened. Same failure 10-23 13:30Z and 13:41Z. updater.log shows the app running then was
**1.0.5** (installed 10-24 14:03Z); 1.0.6 was downloaded 23:22:41Z and installed 23:27:26Z.

## Bug 1 (one stray file stops every backup): already fixed in 1.0.6
fix/106-backup-stray-files (fe4a32c81, in 1.0.6 source 099d47a0f and in int/107) set the rule in
`server/data-dir-inventory.ts` `classifyDataDirEntryForBackup`: a top-level name that is not an
exact inventory row is **never stored**, the backup goes on, the name is listed to the owner
("not recognised by Murage, so the backup leaves it out; it stays where it is") and the file is
left untouched. The installed 1.0.6 bundle carries that string. `server/backup-stray-scheduled-roundtrip.test.ts`
drives Back up now (`runNow` -> `resumeOffline`) on that exact file: verified, listed once, restores, the
key in the stray never reaches the archive.

Options weighed again, decision unchanged:
- Junk patterns (`*.bak*`, `.DS_Store`, `*~`, `*.swp`) as a skip class: adds nothing; they are already skipped and listed.
- Copy unknown files as opaque blobs: rejected. `config.json.bak-*` is a copy of a key-bearing file; an
  unknown name has no rule that knows what its bytes hold (fail-closed intent of the inventory).
- Skip and list: **in place since 1.0.6**. No change to classification in this lane.

## Bug 2 (the owner cannot tell what happened): two real gaps remain
The quiesce-restart is the intended design (the whole workspace is copied while nothing writes;
`electron/main.mjs` handoff-armed branch). A failed capture is already announced on the next start
(W-D7: Inbox row + one notification "The last backup didn't finish"). Gaps:

**G1. The progress window always says "Setting up your first backup"**, even for the hundredth
Back up now or a pre-update backup. Fix: `openBackupProgressWindow({kind})`, kind from the job's
occurrence (`<rev>:manual:` / `:daily:` / `:upgrade:`) plus `firstRun`. Headings:
first "Setting up your first backup"; manual and daily "Backing up your workspace"; upgrade
"Backing up before the update". Body and the four real steps unchanged.

**G2. A backup that worked says nothing after Murage reopens.** Only Settings > Backups shows it.
Fix: a pure `backupResultNotice(status, announcedKey)` in `electron/backup-failure-notice.mjs`.
It answers only for a **manual** job in phase `returned` whose `lastVerified.jobId` is that job,
once per job id (key kept in userData `backup-result-announced.json`, job id only, mode 0600).
On the normal start, after the failure announcement, one notification:
- title "Backup saved and checked"
- body "Your workspace is backed up to <folder>." and, when items were left out,
  "<n> item(s) were left out. Settings → Backups lists them." Click focuses the window.
Daily runs stay quiet (no daily pop-up); the Backups page already lists their skipped items.

## Privacy
The notification carries the folder label and a count only, never a file name or a path inside the
data folder. No change to what a backup stores or a restore installs. Notification failure never
changes backup state.

## Tests
- `backupResultNotice` unit cases (manual returned with and without skipped, daily, failed, repeat key).
- Progress kind cases (first, manual, daily, upgrade, unknown -> manual wording).
- Extend `backup-stray-scheduled-roundtrip.test.ts`: after Back up now with the stray, the end status
  yields the notice with count 2 and no stray name.
- Real-data proof: a copy of rh3-data/pristine plus the stray, backed up and restored with this branch.
