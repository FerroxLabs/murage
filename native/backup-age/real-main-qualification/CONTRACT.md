# B20/B26 real-main Windows qualification fixture

Current disposition03:33UTC: BLOCKED after native2/2rounds and totalfixture
corrections2/2. See existing B20-WINDOWS-TRANSPORT-CONTRACT.md current addendum and
native-receipts/journey.json. Real signed main exited after repeated GPUchild
crashes before the Backup-mode UI appeared. ZIP code tree lacks the restricted
application-package RX grant supplied by existing NSIS customInstall; this is a
concrete prerequisite difference, not proven crash causality. No third run or ACL
change. Jobactive0/pinnedhandlesclosed; task removed; all candidate/data retained.

Source preparation only, 2026-09-14. Historical eight invocations remain consumed;
the user's new Go admits focused completion. Root freezes and admits the new native
round allocation (maximum two) and fresh 60-minute host window. This directory is
task-only and excluded from the public candidate. Do not run it during source work.

Outcome: untouched signed Murage.exe and app.asar, real Backup-mode buttons and
native dialogs, actual utility worker/private identity, synthetic capture/inspect,
separate paused restore and relaunch, final DACL, original preservation and observed
child closure. No full programme qualification, installer install, account changes,
provider requests, normal profile, scheduler activation, UAC/VSS or release action.

## Executable fixture interface and admission

Offline seed command: existing Node 24 executable with `--experimental-strip-types`
against `seed.ts <fresh-task-parent>\real-main-qualification`. Its relative import
closure is the candidate's message-tables.ts, image-operations-schema.ts and
memory/schema.ts plus their imports; bundle using the existing esbuild tool if
shipping a standalone seed. This Node process only creates synthetic files and
closes SQLite. It does not invoke a backup operation or impersonate Murage.exe.

`dialogs.ps1` exposes `Invoke-OwnedButton(pid,name)` and
`Set-OwnedFileDialog(pid,title,file,button)`, using Windows built-in UIAutomation.
Native filename control AutomationId 1148 (Edit or ComboBox with one child Edit)
and English Open/Save buttons are explicit
preconditions, not previously observed host facts. All matches are unique and
PID-scoped; missing/ambiguous accessibility is a fixture failure. No fallback to
global keystrokes, clipboard, forced IPC, monkeypatches or replacement dialogs.
Launch `--force-renderer-accessibility` to expose Chromium's real controls. This
switch changes accessibility exposure, not application trust or backup admission.

Before any native launch root must bind a manifest containing candidate SHA, new
workflow run/artifact IDs, archive digest, extracted Murage.exe and app.asar digests,
the task fixture closure digest, exact task scratch/executable/Node paths, desktop
SID and session ID, start/deadline and remaining round count. Artifact 10329096257
belongs to old source and cannot satisfy the changed-main candidate. Verify Valid
Ferrox Labs, LLC signatures on app/helper and exact shared/windows-backup-tools.mjs
raw age/keygen/LICENSE hashes; no signing-policy or PATH changes.

Use the already available SeanDesktop\\seand Interactive/Limited session. A new
task name, if needed, uses the existing scheduled-task mechanism only after root
admits it. No new account/password/global install. Pin the existing executable
tools by absolute paths. Refuse any other process already executing the extracted
Murage.exe path. Record identity plus creation time, not PID alone.

Child ProcessStartInfo must clear inherited environment and set only SystemRoot,
WINDIR, SystemDrive, COMSPEC, task-local HOME/USERPROFILE/APPDATA/LOCALAPPDATA/TEMP/
TMP/TMPDIR, MURAGE_DATA_DIR=data and MURAGE_USER_DATA=user-data; keep a minimal
explicit system-tool PATH in this child only. All directories must already exist,
be local NTFS and have no reparse ancestry. Add roaming/local subdirectories to
home. Do not inherit ELECTRON_RUN_AS_NODE, NODE_OPTIONS, API keys or provider env.
Launch exact extracted Murage.exe with `--murage-backup-mode
--force-renderer-accessibility`, no positional JS, no app.asar modification.

Driver command, only after admission: existing Windows PowerShell
`-NoProfile -NonInteractive -File run.ps1 -Manifest <task-manifest.json>`.
`run.ps1` validates the manifest, creates the owning job before starting any child,
and calls `OwnedJob.cs` CreateProcess(CREATE_SUSPENDED|CREATE_UNICODE_ENVIRONMENT),
AssignProcessToJobObject, ResumeThread. No job breakaway flags or UI restrictions.
Kill-on-job-close is task containment; native backup helper's existing nested job
must remain compatible. Job admission failure is a fixture/environment failure,
never permission to run uncontained. New main must be found inside this same job
and pinned by a real process handle. An unowned replacement is never adopted.

Generate an independent synthetic original age-keygen file using the verified
packaged keygen `-o <keys>\recovery.txt`; this file is outside data/user-data and
exports. Never print or record its content. Record only successful invocation and
public recipient if needed. Generate a second independent wrong key for the
agreed failure case. Hash every original seeded file and record file identities
before launch; distinguish expected lease files from application data.

## Frozen UI sequence

1. Observe owned window "Murage Backup mode", Backup mode heading, exact original
   data location, and visible/enabled Create encrypted backup. No normal workspace
   or server/provider startup is admissible. Capture screenshot and process tree.
2. Click Create encrypted backup; wait for native "Save an encrypted application-data
   backup". Cancel its owned Cancel button. Require idle original Backup window,
   no archive, no selection receipt and unchanged seeded data. This is dialog
   cancellation only, not in-flight worker cancellation.
3. Repeat Create encrypted backup. Native Save dialog chooses exports\\backup.age;
   native "Choose an independent age recovery key file" chooses keys\\recovery.txt;
   native confirmation chooses Create encrypted backup. Require the visible
   "Encrypted application-data backup saved and verified:" result and a nonempty
   age ciphertext. Publication already requires worker result ACK and actual exit
   in installation-recovery-runner.mjs; retain OS process evidence separately.
4. Click Inspect encrypted backup. Native "Choose an encrypted application-data
   backup" chooses backup.age, key dialog chooses the independent wrong key. Require
   visible "The encrypted operation could not be verified." (renderer also appends
   the safe AGE_PROCESS_FAILED code), owner-visible retained path if supplied, no preview,
   unchanged original/archive and no selector. Preserve any retained private scratch.
5. Inspect again with recovery.txt. Require "Backup inspected. No installation data
   has been changed.", visible snapshot UUID/hash, coverage, and new-installation
   path under task user-data\\recovered-installations\\<UUID>\\data. Record these
   displayed values. They must match ciphertext hash and later receipts.
6. Click Restore encrypted backup separately for review. Native confirmation chooses
   "Restore separately and restart for review". Do not click activation or Retry.
   This intentionally terminates initial main and relaunches the same executable
   WITHOUT --murage-backup-mode. Track the new main by exact image, session, unique
   creation time and observed relaunch ancestry; it may outlive its original parent.
7. Require original main exit, unique replacement recovery window, location equal
   to selected new data directory, and exact paused-review reason. No normal server
   process. Save final screenshot. Closing the recovered window/application is
   task-owned; never kill by image name or session-wide policy.

## Receipt checks and evidence limits

Read user-data installation-selection-*.json only within the task root; exactly
one selector must name requestedRoot/originalRoot=original synthetic data and a
container whose selection-record.json bytes match it. Check snapshot/hash/transaction
IDs against the displayed inspect values and container .data.restore-<id>.receipt.json
with phase=candidate-installed and hadOriginal=false. New data restore-review.json
must have status=review-required, not reviewed; restored-connections.json must name
a fresh profile. Check all config instances disabled, engineDiscovery=explicit,
bot autoApprove=false and empty resumeCursors, saved report content, transcript
receipt and tombstone row with existing SQLite read-only tooling. No activation.

For each original seeded file require unchanged SHA and file identity; record any
new files separately, allowing only established lease bookkeeping. Hash exe/asar
again after the journey. Do not hash/log secret recovery-key contents.

Read effective ACL/SDDL for final restored data and every descendant, including
messages.db, config.json and saved report. Require private effective ACLs,
current SID+SYSTEM full access and no other allowed SID. Record protection and
inheritance rather than assuming the moved data root has a protected bit: it was
created beneath the protected private stage and may retain inherited private ACEs.
Reject broad or unexpected allow entries. Same-volume journal moves must actually
preserve private DACLs. ACL inspection is permission evidence; it is not a separate
unauthorized-account access trial (no account changes authorized).

Owning job is established before child execution and includes inherited descendants
and relaunch. Record total/active/terminated accounting at each step; final job
ActiveProcesses=0 and every pinned initial/keygen/verifier/replacement handle
signaled are mandatory. Preserve the original main's observed exit before selecting
replacement. This gives bounded whole-job closure, not individual short-lived
child receipts. Real worker completion plus selector publication exercises the
runner's ACK+actual-exit path; do not claim inspecting secret IPC payloads. On failure,
terminate only the owned job, record closure or uncertainty, retain all task data.
No image-name kills. Save screenshots using PrintWindow on the pinned window HWND,
not a desktop rectangle; blank/unreadable images fail root's visual review.

## Current status / concrete remaining fixture work

Source preparation is complete: seed.ts, dialogs.ps1, OwnedJob.cs, run.ps1 and
verify.mjs. No checks, compilation, build or native execution. Root must perform
the admitted source preflight and freeze exact candidate/artifact/fixture hashes
before native admission. Runtime preconditions still needing observation are UIA
dialog controls/disclosure ExpandCollapsePattern, PrintWindow content, existing
Limited-session nested-job support and relaunch staying in the job. Failure is
classified at the observed requirement; no substitute entry or bypass is offered.

Manifest required fields: root, executable, candidateSha (40 hex), artifactId
(new artifact), workflowRunId, artifactArchive, artifactSha256, exeSha256,
asarSha256, nodeExecutable, nodeSha256, sid, sessionId, deadlineUtc and fixtureFiles
(object mapping each of the five code filenames to SHA256). Seed executes on the
target before this driver, and source-files.json carries each seeded SHA/dev/ino.
Native driver refuses an existing invoked.json and never replays failed scratch.
Root visually reviews all five PNGs and the final JSON/SDDL before acceptance;
driver status=passed is automated evidence, not visual acceptance on its own.

Before first native cycle, source integrity was tightened to require actual pinned
handle exit code0 for both keygens, the offline verifier, initial application's
relaunch exit and restored application's normal close. File existence never
substitutes for successful child completion. Failure cleanup terminates only the
owned job and permits at most15seconds of closure observation after the execution
deadline; it cannot start another operation. The outer task watchdog must terminate
the driver if necessary, closing its kill-on-close job. No test/remote invocation
was consumed by these source changes.

Source basis: electron/main.mjs isolated userData setup and desktopStartup;
installation-recovery-window/controller/runner.mjs; installation-selection.mjs;
restore-review.mjs; restored-connections.mjs; recovery/index.html and renderer.js;
server/installation-windows-backup-operations.test.ts existing seed; message/image/
memory schema initializers. The product capability join is owned by another agent.
