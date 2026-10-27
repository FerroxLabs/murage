// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Sean's own install, 2026-10-23 13:30Z and 13:41Z (1.0.3): both of his backups stopped with
//   backup capture failed {"stage":"capture","code":"BACKUP_UNCLASSIFIED_COMPONENT","path":"config.json.bak-20260918-openaicompat"}
// so he had no backup at all. This drives the same scheduled path he ran (real host, real
// coordinator, real encrypting worker) on a data folder holding that exact file and another
// old config copy. The backup must complete and be verified, leave the strays out and name them
// once in the log, leave them untouched in the data folder, and the archive must restore.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { backupResultNotice } from "../electron/backup-failure-notice.mjs";
import { createBackupScheduleHost } from "../electron/backup-schedule-host.mjs";
import { backupAgePinForTarget } from "../shared/backup-age-pin.ts";
import { BackupCoordinator } from "./backup-coordinator.ts";
import { installationRecoveryCommand } from "./installation-recovery-command.ts";
import { restoreEncryptedInstallationNew } from "./installation-encrypted-backup.ts";
import { backupFixture, testAgeKeys } from "./testing/backup-fixture.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
// Built at run time so no key-shaped literal sits in the source.
const STRAY_KEY = ["sk", "stray", "fixture0123456789abcdef"].join("-");
const STRAYS = ["config.json.bak-20260918-openaicompat", "config.json.bak-xxx"];
const STAMP = Date.parse("2026-10-23T13:30:00Z");

// A pinned host without MURAGE_BACKUP_TEST_AGE_DIR fails loudly in testAgeKeys, never skips.
it.skipIf(!backupAgePinForTarget(process.platform, process.arch))("a data folder with old config.json.bak copies backs up on schedule, is verified, names them once in the log, and restores", { timeout: 120_000 }, async () => {
  const fixture = backupFixture(), keys = testAgeKeys();
  try {
    const strayBody = JSON.stringify({ instances: { openaiCompat: { driver: "openaiCompat", config: { apiKey: STRAY_KEY } } } }) + "\n";
    for (const name of STRAYS) writeFileSync(path.join(fixture.data, name), strayBody);
    fixture.db.close();
    const destination = path.join(fixture.parent, "backups"), keyFile = path.join(fixture.parent, "recovery-key.txt");
    mkdirSync(destination);
    writeFileSync(keyFile, keys.identity, { mode: 0o600 });

    let binding: string | undefined, captureFailure: unknown = null;
    const lines: string[] = [];
    const shared = new BackupCoordinator({ stateDirectory: path.join(fixture.parent, "control"), now: () => STAMP });
    const host = createBackupScheduleHost({
      coordinator: shared,
      installation: () => fixture.data,
      now: () => STAMP,
      supported: () => true,
      readProtected: async () => binding,
      writeProtected: async (_key: string, value: string) => { binding = value; },
      chooseDestination: async () => destination,
      chooseKey: async () => keyFile,
      createRecoveryKey: async () => ({ file: keyFile, label: path.basename(keyFile), publicKey: keys.recipient }),
      confirmReferences: async () => true,
      prepare: async () => async () => {},
      cleanupIdle: async () => {},
      relaunch: async () => {},
      reportOutcome: (line: string) => { lines.push(line); },
      reportCaptureFailure: (failure: unknown) => { captureFailure = failure; },
      capture: async (request: { output: string; recipient: string; readIdentity: () => Promise<string>; maxBytes: number; maxDurationMs: number }) =>
        installationRecoveryCommand(["backup-encrypted", "--data-dir", fixture.data, "--output", request.output, "--age-tool", keys.ageExecutable,
          "--recipient", request.recipient, "--credential-policy", "preserve-in-encrypted-fidelity",
          "--max-bytes", String(request.maxBytes), "--max-duration-ms", String(request.maxDurationMs)], { readIdentity: request.readIdentity }),
    });
    const selected = await host.setUpBackups();
    await host.configure(0, {
      enabled: true, preUpgrade: false, time: "02:00", timezone: "UTC", catchupMs: 12 * 3600_000, maxBytes: 200 * 1024 ** 2, maxDurationMs: 300_000,
      selection: { scope: "application-data", credentialPolicy: "preserve-in-encrypted-fidelity" },
      installationRef: selected.refs.installationRef, destinationRef: selected.refs.destinationRef, recoveryRef: selected.refs.recoveryRef,
      allowIdleRestart: true,
    });
    host.stopPolling();
    for (let attempt = 0; attempt < 100 && host.isPreparing(); attempt++) await new Promise(resolve => setImmediate(resolve));
    expect((await host.runNow((await host.status()).revision)).phase).toBe("handoff-armed");
    await host.resumeOffline().catch((cause: unknown) => { throw new Error(`backup did not complete: ${JSON.stringify(captureFailure)} / ${String(cause)}`); });
    host.completeReturn();

    // Completed and verified: no failure recorded, a verified receipt whose file re-reads to its sha256.
    expect(captureFailure).toBeNull();
    const ended = await host.status();
    expect(ended.error).toBeFalsy();
    expect(ended.lastVerified, "no verified backup").toBeTruthy();
    const receipt = shared.status().lastVerified!;
    const archive = path.join(destination, receipt.jobId + ".age");
    expect(sha256(readFileSync(archive))).toBe(receipt.sha256);
    expect(lines.some(line => line.startsWith("backup local verified "))).toBe(true);
    expect(lines.some(line => line.startsWith("backup local failed "))).toBe(false);

    // Named once in the log, by name and reason, and nothing else about them.
    const skippedLines = lines.filter(line => line.startsWith("backup skipped "));
    expect(skippedLines).toHaveLength(1);
    const logged = JSON.parse(skippedLines[0]!.slice("backup skipped ".length)) as { count: number; reasons: Record<string, number>; names: string[] };
    expect(logged.count).toBe(STRAYS.length);
    expect(logged.reasons).toEqual({ unrecognised: STRAYS.length });
    expect([...logged.names].sort()).toEqual([...STRAYS].sort());
    expect(skippedLines[0]).not.toContain(STRAY_KEY);

    // 1.0.7: once Murage reopens, the person is told it worked and how many items were left
    // out, by count; the Backups page names them. No stray name and no key in the words.
    const reopened = shared.status();
    expect(reopened.job?.phase).toBe("returned");
    const notice = backupResultNotice(reopened, null, "backups");
    expect(notice?.title).toBe("Backup saved and checked");
    expect(notice?.body).toBe(`Your workspace is backed up to backups. ${STRAYS.length} items were left out. Settings → Backups lists them.`);
    for (const name of STRAYS) expect(notice!.body).not.toContain(name);
    expect(notice!.body).not.toContain(STRAY_KEY);
    expect(backupResultNotice(reopened, notice!.key, "backups"), "announced once").toBeNull();

    // Left out of the archive's plaintext path too, and still in the data folder, unchanged.
    expect(readFileSync(archive).includes(STRAY_KEY)).toBe(false);
    for (const name of STRAYS) expect(readFileSync(path.join(fixture.data, name), "utf8"), name).toBe(strayBody);

    // The archive restores (its sha256 is checked by the restore), Murage's own records and the
    // owner's work come back, and a stray is never written back.
    const restored = path.join(fixture.parent, "restored");
    const result = await restoreEncryptedInstallationNew(restored, archive, receipt.sha256, { ageExecutable: keys.ageExecutable, identity: keys.identity });
    expect(result.status).toBe("restored-review-required");
    expect(result.encryptedSha256).toBe(receipt.sha256);
    expect(readFileSync(path.join(restored, "workspaces", "report.md"), "utf8")).toBe("# Saved output\n");
    expect(JSON.parse(readFileSync(path.join(restored, "bots.json"), "utf8"))).toMatchObject([{ id: "bot", threadId: "thread", name: "Fixture" }]);
    expect(JSON.parse(readFileSync(path.join(restored, "config.json"), "utf8")).profile.name).toBe("Fixture");
    const db = new DatabaseSync(path.join(restored, "messages.db"), { readOnly: true });
    try { expect((db.prepare("SELECT text FROM messages").all() as { text: string }[]).map(row => row.text)).toEqual(["WAL-visible transcript"]); } finally { db.close(); }
    for (const name of STRAYS) expect(existsSync(path.join(restored, name)), name).toBe(false);
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
    for (const file of walk(restored)) expect(readFileSync(file).includes(STRAY_KEY), file).toBe(false);
  } finally { removeTempDirSync(fixture.parent); }
});
