// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// r3.4d J4 H3: the restore arm gate reads the backup host's committed state, so it refuses while ANY backup runs (scheduled and manual), in another process, and
// across a process death. The coordinator's in-memory flag alone is blind to all three.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BackupCoordinator } from "../backup-coordinator.ts";
import { backupBusyForRestore } from "../setup-backup.ts";
import { RestoreJobStore } from "./restore-job.ts";

let root: string, control: string, data: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "murage-gate-j4-")); control = join(root, "control"); data = join(root, "data"); mkdirSync(data); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const store = (busy: () => boolean) => new RestoreJobStore({ dir: data, isLocalArchive: () => true, captureCarry: () => ({}), backupBusy: busy });
const childFile = fileURLToPath(new URL("./restore-backup-gate-j4-child.ts", import.meta.url));
async function killedMidBackup(mode: "scheduled" | "manual"): Promise<void> {
  const ready = join(root, "ready");
  const p = spawn(process.execPath, [childFile, mode, control, ready], { stdio: "ignore" });
  const exited = new Promise<string | null>(resolve => p.on("exit", (_c, signal) => resolve(signal)));
  const t0 = Date.now();
  while (!existsSync(ready)) { if (Date.now() - t0 > 20000) { p.kill("SIGKILL"); throw new Error("child never reached the capture"); } await new Promise(r => setTimeout(r, 25)); }
  p.kill("SIGKILL");
  expect(await exited).toBe("SIGKILL");
}

describe("H3 wiring", () => {
  it("index.ts hands the restore store the backup host's busy state", () => {
    const index = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    expect(index).toMatch(/new RestoreJobStore\(\{[^]*?backupBusy: \(\) => backupBusyForRestore\(\)/);
  });
  it("no desktop backup host (no control directory, as on Cloud) is not busy", () => {
    expect(backupBusyForRestore(undefined)).toBe(false);
  });
  it("a control directory whose state cannot be read counts as busy (fails closed)", () => {
    mkdirSync(control, { recursive: true }); writeFileSync(join(control, "backup-coordinator.json"), "garbage");
    expect(backupBusyForRestore(control)).toBe(true);
  });
});

describe("H3 a backup in another coordinator", () => {
  it("a coordinator that is not the one running sees the backup, and stops seeing it when it ends", async () => {
    let finish!: (v: any) => void; let req: any; let started!: () => void; const up = new Promise<void>(r => { started = r; });
    const choices = { enabled: true, installationRef: "installation-one", destinationRef: "destination-one", recoveryRef: "recovery-one", timezone: "Asia/Bangkok", time: "09:00", catchupMs: 3 * 86400000, maxBytes: 100000, maxDurationMs: 600000, selection: { scope: "application-data" as const, credentialPolicy: "preserve-in-encrypted-fidelity" as const }, preUpgrade: false };
    let clock = Date.parse("2026-09-13T01:00:00Z"); const now = () => clock;
    const host = new BackupCoordinator({ stateDirectory: control, now, claimIdle: async () => ({ state: "claimed" as const, release: async () => {} }), captureOffline: r => { req = r; started(); return new Promise(res => { finish = res; }); } });
    host.configure(0, choices); clock = Date.parse("2026-09-13T03:00:00Z");
    const running = host.tick(); await up;
    expect(backupBusyForRestore(control)).toBe(true);
    finish({ jobId: req.jobId, installationRef: req.installationRef, destinationRef: req.destinationRef, selectionHash: req.selectionHash, snapshotId: "00000000-0000-4000-8000-000000000000", artifactRef: "verified-artifact", sha256: "a".repeat(64), bytes: 200, verifiedAt: now() });
    await running;
    expect(backupBusyForRestore(control)).toBe(false);
  });
});

describe("H3 a manual or scheduled backup waiting to take the installation offline", () => {
  it("a prepared and an armed handoff are busy (the restart transfer is about to run), a plain due or waiting job is not", async () => {
    let clock = Date.parse("2026-09-13T01:00:00Z");
    const c = new BackupCoordinator({ stateDirectory: control, now: () => clock });
    c.configure(0, { enabled: true, installationRef: "installation-one", destinationRef: "destination-one", recoveryRef: "recovery-one", timezone: "Asia/Bangkok", time: "09:00", catchupMs: 3 * 86400000, maxBytes: 100000, maxDurationMs: 600000, selection: { scope: "application-data" as const, credentialPolicy: "preserve-in-encrypted-fidelity" as const }, preUpgrade: false });
    clock = Date.parse("2026-09-13T03:00:00Z");
    const due = await c.tick(); expect(due.phase).toBe("waiting-backup-mode"); expect(backupBusyForRestore(control)).toBe(false);
    const intent = { version: 1 as const, id: "11111111-1111-4111-8111-111111111111", bindingRevision: "b".repeat(64), installationIdentity: "c".repeat(64), expiresAt: clock + 60000 };
    c.prepareHandoff(due.job!.id, intent); expect(c.status().phase).toBe("handoff-prepared"); expect(backupBusyForRestore(control)).toBe(true);
    c.armHandoff(intent.id); expect(c.status().phase).toBe("handoff-armed"); expect(backupBusyForRestore(control)).toBe(true);
    c.claimHandoff(intent.id, intent.bindingRevision, intent.installationIdentity); expect(c.status().phase).toBe("offline-claimed"); expect(backupBusyForRestore(control)).toBe(true);
  });
});

describe("H3 real process death mid-backup", () => {
  for (const mode of ["scheduled", "manual"] as const) {
    it(`SIGKILL during a ${mode} backup: a fresh process still refuses arm (backup_running) until the host reconciles, then arms`, async () => {
      await killedMidBackup(mode);
      expect(new BackupCoordinator({ stateDirectory: control }).status().phase).toBe("capturing"); // the host died with the capture on the books
      const s = store(() => backupBusyForRestore(control));
      expect(s.arm({ archiveId: "arc1", source: "owner" })).toMatchObject({ ok: false, code: "backup_running" });
      expect(existsSync(join(data, "restore-job.json"))).toBe(false);
      new BackupCoordinator({ stateDirectory: control }).reconcileStartup(); // the host relaunches: the interrupted capture needs review
      expect(new BackupCoordinator({ stateDirectory: control }).status().phase).toBe("needs-review");
      expect(s.arm({ archiveId: "arc1", source: "owner" })).toMatchObject({ ok: true });
    });
  }
});
