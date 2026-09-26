// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// An owner whose backups the 0.1.60 final draft already paused must get them
// back by updating, with no hand repair. On that draft, saving Settings >
// About me wrote about-me.md at the data folder's root, no backup list knew
// the name, and the next backup stopped with BACKUP_UNCLASSIFIED_COMPONENT
// and left the schedule in "needs review" (Mac customer re-test 2,
// 2026-09-26). The review note survives restarts, so the updated app starts
// in exactly that state.
//
// Everything here is real except the failed draft capture, which is replayed
// as the error it raised: the pinned age binary, the real BackupCoordinator
// state files, the real schedule host, the real capture command and the real
// restore. The updated app is a NEW host and coordinator over the same state
// folder, as after an update and relaunch.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createBackupScheduleHost } from "../electron/backup-schedule-host.mjs";
import { backupAgePinForTarget } from "../shared/backup-age-pin.ts";
import { saveAboutMe } from "./about-me.ts";
import { BackupCoordinator } from "./backup-coordinator.ts";
import { appendDecision, flushDecisionLog } from "./decision-log.ts";
import { InstallationSnapshotError } from "./installation-database-snapshot.ts";
import { inspectEncryptedInstallationBackup, restoreEncryptedInstallationNew } from "./installation-encrypted-backup.ts";
import { installationRecoveryCommand } from "./installation-recovery-command.ts";
import { backupFixture, testAgeKeys } from "./testing/backup-fixture.ts";
import { safeWipeSync } from "./testing/safe-wipe.mjs";

const noPinnedAge = !backupAgePinForTarget(process.platform, process.arch) || !process.env.MURAGE_BACKUP_TEST_AGE_DIR;
const ABOUT = "I run a small candle shop and like short answers.";
type CaptureRequest = { output: string; recipient: string; readIdentity: () => Promise<string>; maxBytes: number; maxDurationMs: number };

describe("backups paused by the About me defect recover after the update", () => {
  it.skipIf(noPinnedAge)("clearing the review and backing up again just works, and About me comes back on restore", { timeout: 120_000 }, async () => {
    const fixture = backupFixture(), keys = testAgeKeys();
    fixture.db.close();
    const destination = path.join(fixture.parent, "backups"), keyFile = path.join(fixture.parent, "recovery-key.txt");
    mkdirSync(destination);
    writeFileSync(keyFile, keys.identity, { mode: 0o600 });
    const state = path.join(fixture.parent, "control");
    let binding: string | undefined;
    const makeHost = (capture: (request: CaptureRequest) => Promise<unknown>) => createBackupScheduleHost({
      coordinator: new BackupCoordinator({ stateDirectory: state, now: () => Date.parse("2026-09-26T08:00:00Z") }),
      installation: () => fixture.data, now: () => Date.parse("2026-09-26T08:00:00Z"), supported: () => true,
      readProtected: async () => binding, writeProtected: async (_key: string, value: string) => { binding = value; },
      chooseDestination: async () => destination, chooseKey: async () => keyFile,
      createRecoveryKey: async () => ({ file: keyFile, label: path.basename(keyFile), publicKey: keys.recipient }),
      confirmReferences: async () => true, prepare: async () => async () => {}, cleanupIdle: async () => {}, relaunch: async () => {},
      capture,
    });
    const realCapture = (request: CaptureRequest) => installationRecoveryCommand(["backup-encrypted", "--data-dir", fixture.data, "--output", request.output,
      "--age-tool", keys.ageExecutable, "--recipient", request.recipient, "--credential-policy", "preserve-in-encrypted-fidelity",
      "--max-bytes", String(request.maxBytes), "--max-duration-ms", String(request.maxDurationMs)], { readIdentity: request.readIdentity });

    // ---- The draft: backups on and verified, as the customer had them.
    const draft = makeHost(realCapture);
    const selected = await draft.setUpBackups();
    await draft.configure(0, {
      enabled: true, preUpgrade: false, time: "02:00", timezone: "UTC", catchupMs: 12 * 3600_000, maxBytes: 200 * 1024 ** 2, maxDurationMs: 300_000,
      selection: { scope: "application-data", credentialPolicy: "preserve-in-encrypted-fidelity" },
      installationRef: selected.refs.installationRef, destinationRef: selected.refs.destinationRef, recoveryRef: selected.refs.recoveryRef, allowIdleRestart: true,
    });
    draft.stopPolling();
    for (let attempt = 0; attempt < 100 && draft.isPreparing(); attempt++) await new Promise(resolve => setImmediate(resolve));
    await draft.runNow((await draft.status()).revision);
    await draft.resumeOffline();
    draft.completeReturn();
    const first = (await draft.status()).lastVerified;
    expect(first).toBeTruthy();

    // ---- The owner saves About me (and approvals are logged), then the
    // draft's next backup refuses the unknown name and pauses.
    saveAboutMe(ABOUT, fixture.data);
    appendDecision(fixture.data, { threadId: "thread", decision: "user-approved", source: "user", tool: "Bash", summary: "ls" });
    await flushDecisionLog(fixture.data);
    expect(existsSync(path.join(fixture.data, "about-me.md"))).toBe(true);
    expect(existsSync(path.join(fixture.data, "decisions.ndjson"))).toBe(true);
    const failing = makeHost(async () => { throw new InstallationSnapshotError("BACKUP_UNCLASSIFIED_COMPONENT"); });
    await failing.runNow((await failing.status()).revision);
    await expect(failing.resumeOffline()).rejects.toThrow("BACKUP_SCHEDULE_REVIEW_REQUIRED");
    failing.completeReturn?.();

    // ---- The update: a new app over the same state starts paused, saying why.
    const updated = makeHost(realCapture);
    const paused = await updated.status();
    expect(paused.phase).toBe("needs-review");
    expect(paused.captureFailure).toEqual({ stage: "capture", code: "BACKUP_UNCLASSIFIED_COMPONENT" });
    expect(paused.lastVerified?.jobId).toBe(first.jobId);

    // The owner clears it on the Backups page and presses Back up now.
    const cleared = await updated.clearReview(paused.revision);
    expect(cleared.phase).not.toBe("needs-review");
    expect(cleared.captureFailure).toBeUndefined();
    await updated.runNow(cleared.revision);
    await updated.resumeOffline();
    updated.completeReturn();
    const ended = await updated.status();
    expect(ended.phase).not.toBe("needs-review");
    expect(ended.captureFailure).toBeUndefined();
    expect(ended.error).toBeFalsy();
    expect(ended.lastVerified.jobId).not.toBe(first.jobId);

    // ---- And the new backup really holds About me and the decision log.
    const archive = path.join(destination, ended.lastVerified.jobId + ".age");
    const inspection = await inspectEncryptedInstallationBackup(archive, fixture.parent, { ageExecutable: keys.ageExecutable, identity: keys.identity });
    expect(readFileSync(path.join(inspection.stateDirectory, "recovery", "about-me.md"), "utf8")).toBe(readFileSync(path.join(fixture.data, "about-me.md"), "utf8"));
    expect(existsSync(path.join(inspection.stateDirectory, "recovery", "decisions.ndjson"))).toBe(true);
    const restored = path.join(fixture.parent, "restored");
    await restoreEncryptedInstallationNew(restored, archive, ended.lastVerified.sha256, { ageExecutable: keys.ageExecutable, identity: keys.identity });
    expect(readFileSync(path.join(restored, "about-me.md"), "utf8")).toBe(readFileSync(path.join(fixture.data, "about-me.md"), "utf8"));

    safeWipeSync(fixture.parent);
  });
});
