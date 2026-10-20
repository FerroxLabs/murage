// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.3's boot recovery of delegated replies an earlier build froze as withheld (frozen-replies.ts) writes its cursor,
// frozen-replies-recovery.json, at the data folder's root on every start. A backup refuses any top-level name the inventory does not
// classify (BACKUP_UNCLASSIFIED_COMPONENT), so on the 1.0.3 candidate every backup of a folder that had started once stopped: the
// Settings > Backups schedule and Back up now (schedule host -> capture -> backup-encrypted -> stageInstallationStateWhileOwned) and
// the offline backup alike. The cursor is a derived start-up note, so a backup leaves it out and lists why.
//
// Everything here is real: the recovery slice writes the cursor, the real BackupCoordinator and schedule host run the real capture
// command with the pinned age binary, and the archive is inspected.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createBackupScheduleHost } from "../electron/backup-schedule-host.mjs";
import { backupAgePinForTarget } from "../shared/backup-age-pin.ts";
import { BackupCoordinator } from "./backup-coordinator.ts";
import { classifyDataDirEntry } from "./data-dir-inventory.ts";
import { FROZEN_REPLIES_CURSOR, recoverFrozenRepliesSlice, type FrozenReplyPorts } from "./frozen-replies.ts";
import { inspectEncryptedInstallationBackup } from "./installation-encrypted-backup.ts";
import { installationRecoveryCommand } from "./installation-recovery-command.ts";
import { stageInstallationState } from "./installation-state-snapshot.ts";
import { backupFixture, testAgeKeys } from "./testing/backup-fixture.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const noPinnedAge = !backupAgePinForTarget(process.platform, process.arch) || !process.env.MURAGE_BACKUP_TEST_AGE_DIR;
type CaptureRequest = { output: string; recipient: string; readIdentity: () => Promise<string>; maxBytes: number; maxDurationMs: number };

/** A fixture data folder after one 1.0.3 start: the real recovery slice has written its cursor at the root. */
function bootedFixture() {
  const fixture = backupFixture();
  // a folder with no `dres-` rows: the slice reads the window, judges nothing and only saves how far it read
  const ports = { db: () => fixture.db } as unknown as FrozenReplyPorts;
  const step = recoverFrozenRepliesSlice(ports, { cursorFile: path.join(fixture.data, FROZEN_REPLIES_CURSOR) });
  expect(step).toMatchObject({ more: false, scanned: 0 });
  expect(existsSync(path.join(fixture.data, FROZEN_REPLIES_CURSOR))).toBe(true);
  fixture.db.close();
  return fixture;
}

describe("the frozen-replies recovery cursor never stops a backup", () => {
  it("is classified: left out of every backup, with a reason", () => {
    expect(FROZEN_REPLIES_CURSOR).toBe("frozen-replies-recovery.json");
    expect(classifyDataDirEntry(FROZEN_REPLIES_CURSOR)).toMatchObject({ backup: "excluded" });
    // its atomic write's leftover too (writeFileAtomic: `<name>.<pid>.<uuid>.tmp`)
    expect(classifyDataDirEntry(`${FROZEN_REPLIES_CURSOR}.4242.0f8e2b1a-3c4d-4e5f-8a9b-0c1d2e3f4a5b.tmp`)).toMatchObject({ backup: "excluded" });
  });

  it("the offline backup stage succeeds on a folder that has started once, and lists the cursor as left out", async () => {
    const fixture = bootedFixture();
    try {
      const { manifest } = await stageInstallationState(fixture.data, fixture.parent);
      expect(manifest.omitted.map(item => item.path)).toContain(FROZEN_REPLIES_CURSOR);
      expect(manifest.files.map(item => item.path)).not.toContain(FROZEN_REPLIES_CURSOR);
    } finally { removeTempDirSync(fixture.parent); }
  });

  it.skipIf(noPinnedAge)("the in-app backup (Settings > Backups, Back up now) completes and verifies with the cursor present", { timeout: 120_000 }, async () => {
    const fixture = bootedFixture(), keys = testAgeKeys();
    const destination = path.join(fixture.parent, "backups"), keyFile = path.join(fixture.parent, "recovery-key.txt");
    mkdirSync(destination);
    writeFileSync(keyFile, keys.identity, { mode: 0o600 });
    const state = path.join(fixture.parent, "control");
    let binding: string | undefined;
    const capture = (request: CaptureRequest) => installationRecoveryCommand(["backup-encrypted", "--data-dir", fixture.data, "--output", request.output,
      "--age-tool", keys.ageExecutable, "--recipient", request.recipient, "--credential-policy", "preserve-in-encrypted-fidelity",
      "--max-bytes", String(request.maxBytes), "--max-duration-ms", String(request.maxDurationMs)], { readIdentity: request.readIdentity });
    const host = createBackupScheduleHost({
      coordinator: new BackupCoordinator({ stateDirectory: state, now: () => Date.parse("2026-10-20T08:00:00Z") }),
      installation: () => fixture.data, now: () => Date.parse("2026-10-20T08:00:00Z"), supported: () => true,
      readProtected: async () => binding, writeProtected: async (_key: string, value: string) => { binding = value; },
      chooseDestination: async () => destination, chooseKey: async () => keyFile,
      createRecoveryKey: async () => ({ file: keyFile, label: path.basename(keyFile), publicKey: keys.recipient }),
      confirmReferences: async () => true, prepare: async () => async () => {}, cleanupIdle: async () => {}, relaunch: async () => {},
      capture,
    });
    try {
      const selected = await host.setUpBackups();
      await host.configure(0, {
        enabled: true, preUpgrade: false, time: "02:00", timezone: "UTC", catchupMs: 12 * 3600_000, maxBytes: 200 * 1024 ** 2, maxDurationMs: 300_000,
        selection: { scope: "application-data", credentialPolicy: "preserve-in-encrypted-fidelity" },
        installationRef: selected.refs.installationRef, destinationRef: selected.refs.destinationRef, recoveryRef: selected.refs.recoveryRef, allowIdleRestart: true,
      });
      host.stopPolling();
      for (let attempt = 0; attempt < 100 && host.isPreparing(); attempt++) await new Promise(resolve => setImmediate(resolve));
      await host.runNow((await host.status()).revision);
      await host.resumeOffline();
      host.completeReturn();
      const ended = await host.status();
      expect(ended.captureFailure).toBeUndefined();
      expect(ended.phase).not.toBe("needs-review");
      expect(ended.lastVerified?.jobId).toBeTruthy();
      // the archive leaves the cursor out
      const archive = path.join(destination, ended.lastVerified.jobId + ".age");
      const inspection = await inspectEncryptedInstallationBackup(archive, fixture.parent, { ageExecutable: keys.ageExecutable, identity: keys.identity });
      expect(existsSync(path.join(inspection.stateDirectory, "recovery", FROZEN_REPLIES_CURSOR))).toBe(false);
      expect(existsSync(path.join(inspection.stateDirectory, "recovery", "bots.json"))).toBe(true);
    } finally { removeTempDirSync(fixture.parent); }
  });
});
