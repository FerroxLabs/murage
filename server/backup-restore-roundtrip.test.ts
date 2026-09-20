// M57. Until this file, nothing exercised a scheduled backup all the way back:
// the library round trips (installation-encrypted-backup.test.ts) start at
// writeEncryptedInstallationBackup, and the one test that drives the real
// schedule host (electron/backup-schedule-host.node-test.mjs) captures and
// stops. Nobody had ever taken the archive a *daily backup* produces, destroyed
// the installation, restored, and compared the result with what went in.
//
// On 2026-09-20 the owner lost two weeks of live business work because no
// backup existed. The only thing that makes a backup worth setting up is that
// the restore works, so this test proves it byte for byte and states, in
// assertions rather than prose, exactly how much comes back.
//
// Everything here is real: the pinned age binary, a real ZIP, a real SQLite
// database with an unpublished WAL, the real BackupCoordinator handoff and the
// real restore. The only injected part is the process boundary — production
// forks server/installation-recovery-worker.js, which immediately calls
// installationRecoveryCommand; this test calls that same command in-process so
// it needs no built dist-server.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error -- plain JavaScript desktop module, as every other test imports it
import { createBackupScheduleHost } from "../electron/backup-schedule-host.mjs";
import { backupAgePinForTarget } from "../shared/backup-age-pin.ts";
import { BackupCoordinator } from "./backup-coordinator.ts";
import { inspectEncryptedInstallationBackup } from "./installation-encrypted-backup.ts";
import { installationRecoveryCommand } from "./installation-recovery-command.ts";
import { restoreEncryptedInstallationNew } from "./installation-encrypted-backup.ts";
import { backupFixture, testAgeKeys } from "./testing/backup-fixture.ts";
import { safeWipeSync } from "./testing/safe-wipe.mjs";

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Every regular file under `root`, as relative POSIX path -> sha256. */
function digestTree(root: string, relative = "", into = new Map<string, string>()) {
  for (const name of readdirSync(path.join(root, relative)).sort()) {
    const next = relative ? `${relative}/${name}` : name;
    const stat = lstatSync(path.join(root, next));
    if (stat.isDirectory()) digestTree(root, next, into);
    else if (stat.isFile()) into.set(next, sha256(readFileSync(path.join(root, next))));
  }
  return into;
}

/** SQLite sidecars are not files a restore is expected to reproduce: the
 * snapshot checkpoints the WAL into the database it captures. */
const SIDECAR = /\.db-(wal|shm)$/;

const noPinnedAge = !backupAgePinForTarget(process.platform, process.arch) || !process.env.MURAGE_BACKUP_TEST_AGE_DIR;

describe("a scheduled backup can actually be restored", () => {
  it.skipIf(noPinnedAge)("survives the installation being destroyed, and every backed-up byte comes back", { timeout: 120_000 }, async () => {
    const fixture = backupFixture(), keys = testAgeKeys();
    // Content nobody could reproduce by accident, so "byte for byte" means it.
    const liveWork = Buffer.concat([Buffer.from("# Deal desk — do not lose this\n"), Buffer.from(randomUUID().repeat(2048))]);
    writeFileSync(path.join(fixture.data, "workspaces", "live-deal.md"), liveWork);
    fixture.db.close();

    const destination = path.join(fixture.parent, "backups");
    const keyFile = path.join(fixture.parent, "recovery-key.txt");
    mkdirSync(destination);
    // Exactly the file shape createRecoveryKeyFile writes and readBackupIdentity accepts.
    writeFileSync(keyFile, keys.identity, { mode: 0o600 });

    const before = digestTree(fixture.data);
    expect(before.get("workspaces/live-deal.md")).toBe(sha256(liveWork));

    // ---- 1. A real scheduled backup, through the real host and coordinator.
    let binding: string | undefined, captureFailure: unknown = null, captureError: unknown = null;
    const coordinator = () => new BackupCoordinator({ stateDirectory: path.join(fixture.parent, "control"), now: () => Date.parse("2026-09-20T08:00:00Z") });
    const shared = coordinator();
    const host = createBackupScheduleHost({
      coordinator: shared,
      installation: () => fixture.data,
      now: () => Date.parse("2026-09-20T08:00:00Z"),
      supported: () => true,
      readProtected: async () => binding,
      writeProtected: async (_key: string, value: string) => { binding = value; },
      chooseDestination: async () => destination,
      chooseKey: async () => keyFile,
      // The one act of setup writes the key itself; here it is the fixture's,
      // so the restore below can be driven with the same identity.
      createRecoveryKey: async () => ({ file: keyFile, label: path.basename(keyFile), publicKey: keys.recipient }),
      confirmReferences: async () => true,
      prepare: async () => async () => {},
      cleanupIdle: async () => {},
      relaunch: async () => {},
      // A capture refusal is otherwise reported only as BACKUP_SCHEDULE_REVIEW_REQUIRED.
      reportCaptureFailure: (failure: unknown) => { captureFailure = failure; },
      capture: async (request: { output: string; recipient: string; readIdentity: () => Promise<string>; maxBytes: number; maxDurationMs: number }) => {
        const args = ["backup-encrypted", "--data-dir", fixture.data, "--output", request.output, "--age-tool", keys.ageExecutable,
          "--recipient", request.recipient, "--credential-policy", "preserve-in-encrypted-fidelity",
          "--max-bytes", String(request.maxBytes), "--max-duration-ms", String(request.maxDurationMs)];
        // The identity reaches the capture over the host's readIdentity hook, never argv.
        expect(JSON.stringify(args)).not.toContain("AGE-SECRET");
        try { return await installationRecoveryCommand(args, { readIdentity: request.readIdentity }); }
        catch (cause) { captureError = cause; throw cause; }
      },
    });

    // The whole setup act the Backups page now performs, on the real host.
    const selected = await host.setUpBackups();
    expect(selected.refs.recoveryLabel).toBe("recovery-key.txt");
    expect(selected.created.label).toBe("recovery-key.txt");
    expect(JSON.stringify(selected)).not.toContain("AGE-SECRET");
    await host.configure(0, {
      enabled: true, preUpgrade: false, time: "02:00", timezone: "UTC",
      catchupMs: 12 * 3600_000, maxBytes: 200 * 1024 ** 2, maxDurationMs: 300_000,
      selection: { scope: "application-data", credentialPolicy: "preserve-in-encrypted-fidelity" },
      installationRef: selected.refs.installationRef, destinationRef: selected.refs.destinationRef, recoveryRef: selected.refs.recoveryRef,
      allowIdleRestart: true,
    });
    host.stopPolling();
    for (let attempt = 0; attempt < 100 && host.isPreparing(); attempt++) await new Promise(resolve => setImmediate(resolve));

    const armed = await host.runNow((await host.status()).revision);
    expect(armed.phase).toBe("handoff-armed");
    await host.resumeOffline().catch((cause: unknown) => {
      throw new Error(`capture refused: ${JSON.stringify(captureFailure)} / ${String(captureError ?? cause)}`);
    });
    host.completeReturn();

    // THE GATE, on the real host. src/components/backups-section-ui.ts prints
    // "No verified backup on this computer yet" for exactly one status shape —
    // no lastVerified — and adds "Daily backups are on, but no backup has been
    // taken yet" when the schedule is on without one. The status this act ends
    // on must not be that shape. (The page's own helper is exercised against
    // this same shape in src/components/BackupsSection.test.ts; it cannot be
    // imported here because the server program has no DOM ambient types.)
    const ended = await host.status();
    expect(ended.enabled).toBe(true);
    expect(ended.pending).toBe(false);
    expect(ended.schedule.time).toBe("02:00");
    expect(ended.lastVerified, "setup finished without a verified backup").toBeTruthy();
    expect(ended.lastVerified.bytes).toBeGreaterThan(0);
    expect(ended.lastVerified.verifiedAt).toBeGreaterThan(0);
    expect(ended.error).toBeFalsy();

    const receipt = shared.status().lastVerified!;
    const archive = path.join(destination, receipt.jobId + ".age");
    expect(sha256(readFileSync(archive))).toBe(receipt.sha256);
    // A backup nobody can read is not a backup: no plaintext escaped either.
    expect(readFileSync(archive).includes("FAKE-CREDENTIAL-CANARY")).toBe(false);
    expect(readFileSync(archive).includes(liveWork.subarray(0, 64))).toBe(false);

    // ---- 2. Everything the archive claims to hold is byte-identical to source.
    const inspection = await inspectEncryptedInstallationBackup(archive, fixture.parent, { ageExecutable: keys.ageExecutable, identity: keys.identity });
    const raw = digestTree(path.join(inspection.stateDirectory, "raw"));
    const recoveryProjection = digestTree(path.join(inspection.stateDirectory, "recovery"));
    for (const [file, digest] of raw) {
      if (SIDECAR.test(file) || file.endsWith(".db")) continue; // databases are checkpointed snapshots, compared by contents below
      expect(before.get(file), `raw/${file} is not the file that went in`).toBe(digest);
    }
    // Nothing the installation held was silently dropped from the fidelity copy.
    const missing = [...before.keys()].filter(file => !raw.has(file) && !SIDECAR.test(file));
    expect(missing, "files present before the backup but absent from its fidelity payload").toEqual([]);
    expect(raw.has("workspaces/live-deal.md")).toBe(true);

    // ---- 3. Destroy the installation, exactly as a lost machine would.
    const doomed = path.resolve(fixture.data);
    expect(doomed.startsWith(path.resolve(fixture.parent) + path.sep), `refusing to wipe ${doomed}`).toBe(true);
    expect(readdirSync(doomed).length).toBeGreaterThan(0);
    safeWipeSync(doomed);
    expect(existsSync(doomed)).toBe(false);

    // ---- 4. Restore from the archive alone, with only the recovery key.
    const restored = path.join(fixture.parent, "restored");
    const result = await restoreEncryptedInstallationNew(restored, archive, receipt.sha256, { ageExecutable: keys.ageExecutable, identity: keys.identity });
    expect(result.status).toBe("restored-review-required");
    expect(result.encryptedSha256).toBe(receipt.sha256);

    // ---- 5. Byte for byte: the owner's own files come back unchanged.
    // Settings documents and the database are deliberately NOT byte-identical:
    // restore rewrites them into an explicit, paused, safe-defaulted form, and
    // the assertions below pin that instead. Everything else — the work — must
    // be the same bytes that were destroyed.
    const after = digestTree(restored);
    const opaque = [...before.keys()].filter(file => !/\.(json|db)$/.test(file) && !SIDECAR.test(file));
    expect(opaque, "the fixture must contain opaque user content to prove byte fidelity with").toEqual(["workspaces/live-deal.md", "workspaces/report.md"]);
    for (const file of opaque) expect(after.get(file), `${file} did not come back byte for byte`).toBe(before.get(file));
    expect(readFileSync(path.join(restored, "workspaces", "live-deal.md")).equals(liveWork)).toBe(true);
    // And the archive's recovery projection is exactly what was restored from,
    // so nothing was invented between the two.
    expect(recoveryProjection.get("workspaces/live-deal.md")).toBe(before.get("workspaces/live-deal.md"));

    // Settings come back as the owner's own values with every capability off.
    const bots = JSON.parse(readFileSync(path.join(restored, "bots.json"), "utf8")) as Record<string, unknown>[];
    expect(bots).toHaveLength(1);
    expect(bots[0]).toMatchObject({ id: "bot", threadId: "thread", name: "Fixture", autoApprove: false, browser: false, computer: "off", resumeCursors: {} });
    const config = JSON.parse(readFileSync(path.join(restored, "config.json"), "utf8")) as { profile: { name: string }; instances: Record<string, { enabled: boolean }> };
    expect(config.profile.name).toBe("Fixture");
    expect(JSON.stringify(config)).not.toContain("FAKE-CREDENTIAL-CANARY");
    expect(Object.values(config.instances).every(instance => instance.enabled === false)).toBe(true);

    // The transcript the owner would come back for is really there.
    const db = new DatabaseSync(path.join(restored, "messages.db"), { readOnly: true });
    try {
      const rows = db.prepare("SELECT id,text FROM messages ORDER BY at").all() as { id: string; text: string }[];
      expect(rows.map(row => row.text)).toEqual(["WAL-visible transcript"]);
    } finally { db.close(); }

    safeWipeSync(fixture.parent);
  });

  // What restore does NOT give back. This is pinned deliberately: the setup
  // page must never imply more than this, and if a future change starts
  // activating raw fidelity, this test is where that decision surfaces.
  it.skipIf(noPinnedAge)("restores the paused recovery copy, not the raw fidelity payload, and says so", { timeout: 120_000 }, async () => {
    const fixture = backupFixture(), keys = testAgeKeys();
    mkdirSync(path.join(fixture.data, "channels", "slack"), { recursive: true });
    writeFileSync(path.join(fixture.data, "channels", "slack", "binding.json"), '{"team":"fixture"}\n');
    writeFileSync(path.join(fixture.data, "startup-background.json"), '{"enabled":true}\n');
    fixture.db.close();
    const destination = path.join(fixture.parent, "backups");
    mkdirSync(destination);
    const archive = path.join(destination, "one.age");
    await installationRecoveryCommand(["backup-encrypted", "--data-dir", fixture.data, "--output", archive,
      "--age-tool", keys.ageExecutable, "--recipient", keys.recipient, "--credential-policy", "preserve-in-encrypted-fidelity"],
      { readIdentity: async () => keys.identity });

    const inspection = await inspectEncryptedInstallationBackup(archive, fixture.parent, { ageExecutable: keys.ageExecutable, identity: keys.identity });
    const raw = digestTree(path.join(inspection.stateDirectory, "raw"));
    // The archive holds the real bindings and the real credentials…
    expect(raw.has("channels/slack/binding.json")).toBe(true);
    expect(raw.has("startup-background.json")).toBe(true);
    expect(readFileSync(path.join(inspection.stateDirectory, "raw", "config.json"), "utf8")).toContain("FAKE-CREDENTIAL-CANARY");

    const restored = path.join(fixture.parent, "restored");
    const result = await restoreEncryptedInstallationNew(restored, archive, inspection.sha256, { ageExecutable: keys.ageExecutable, identity: keys.identity });
    // …and the restore deliberately activates none of it.
    expect(result.rawFidelityActivated).toBe(false);
    expect(result.activationAvailable).toBe(false);
    expect(existsSync(path.join(restored, "channels"))).toBe(false);
    expect(existsSync(path.join(restored, "startup-background.json"))).toBe(false);
    expect(readFileSync(path.join(restored, "config.json"), "utf8")).not.toContain("FAKE-CREDENTIAL-CANARY");
    expect(existsSync(path.join(restored, "restore-review.json"))).toBe(true);
    // The workspace files the owner actually works in do come back.
    expect(readFileSync(path.join(restored, "workspaces", "report.md"), "utf8")).toBe("# Saved output\n");

    safeWipeSync(fixture.parent);
  });
});
