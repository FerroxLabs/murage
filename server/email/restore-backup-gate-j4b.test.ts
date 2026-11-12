// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// r3.4d J4b: a Cloud home has no Electron BackupCoordinator, but it does run backup/snapshot writers (the nightly restic murage-backup, and murage-commands' pre-reset
// snapshot, reset, undo and export). All of them hold /run/murage-data-ops.lock; the restore arm gate reads that lock on a Cloud home and fails closed when it cannot.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as setupBackup from "../setup-backup.ts";
import { RestoreJobStore } from "./restore-job.ts";

let root: string, lock: string;
const children: ChildProcess[] = [];
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "murage-gate-j4b-")); lock = join(root, "murage-data-ops.lock"); });
afterEach(() => { for (const c of children.splice(0)) { try { c.kill("SIGKILL"); } catch { /* gone */ } } rmSync(root, { recursive: true, force: true }); });

const cloud = (busy = () => setupBackup.cloudDataOpsBusy(lock)) => ({ home: true, busy });
const gate = () => setupBackup.backupBusyForRestore(undefined, cloud());

/** A real writer: a process that takes the lock exclusive on a descriptor, exactly as murage-backup's ops_lock does, and sits there. */
async function holder(): Promise<ChildProcess> {
  const child = spawn("/bin/sh", ["-c", `exec 9>>"${lock}"; /usr/bin/flock -x 9; echo held; exec sleep 120`], { stdio: ["ignore", "pipe", "ignore"] });
  children.push(child);
  await new Promise<void>((resolve, reject) => { child.stdout!.once("data", () => resolve()); child.once("exit", () => reject(new Error("holder exited"))); });
  return child;
}
const exited = (c: ChildProcess) => new Promise<void>((resolve) => { if (c.exitCode !== null || c.signalCode !== null) resolve(); else c.once("exit", () => resolve()); });

describe("Cloud restore arm gate reads the shared data-ops lock", () => {
  it("is free when nothing holds the lock, and the probe leaves no lock behind", () => {
    expect(gate()).toBe(false);
    expect(gate()).toBe(false);
  });
  it("is busy while a backup writer holds the lock, and the arm refuses backup_running; after the SIGKILL the same store arms", async () => {
    const h = await holder();
    const t0 = Date.now();
    expect(gate()).toBe(true);
    expect(Date.now() - t0).toBeLessThan(3000); // a probe that waited for the lock would sit out its 5 s timeout: never block the arm
    const store = new RestoreJobStore({ dir: root, isLocalArchive: () => true, captureCarry: () => ({}), backupBusy: gate });
    expect(store.arm({ archiveId: "arc1", source: "owner" })).toMatchObject({ ok: false, code: "backup_running" });
    h.kill("SIGKILL"); await exited(h);
    expect(store.arm({ archiveId: "arc1", source: "owner" })).toMatchObject({ ok: true });
  });
  it("a real SIGKILL of the writer mid-backup frees the lock (the kernel drops it), so the gate heals without a relaunch", async () => {
    const h = await holder();
    expect(gate()).toBe(true);
    h.kill("SIGKILL"); await exited(h);
    expect(gate()).toBe(false);
  });
  it("fails closed when the lock cannot be tested: flock missing, lock path unusable, probe throws", () => {
    expect(setupBackup.cloudDataOpsBusy(lock, join(root, "no-such-flock"))).toBe(true);
    expect(setupBackup.cloudDataOpsBusy(join(root, "no-dir", "x.lock"))).toBe(true);
    expect(setupBackup.backupBusyForRestore(undefined, cloud(() => { throw new Error("boom"); }))).toBe(true);
  });
  it("is off when this is not a Cloud home and there is no backup host, and the desktop control-folder path still applies", () => {
    expect(setupBackup.backupBusyForRestore(undefined, { home: false, busy: () => true })).toBe(false);
    expect(setupBackup.backupBusyForRestore(join(root, "no-control-dir"), { home: false, busy: () => false })).toBe(false);
  });
  it("uses the Cloud role from the environment and the production lock path by default", () => {
    expect(setupBackup.CLOUD_DATA_OPS_LOCK).toBe("/run/murage-data-ops.lock");
    const before = process.env.MURAGE_CLOUD_ROLE;
    try {
      process.env.MURAGE_CLOUD_ROLE = "home";
      // On a build box /run/murage-data-ops.lock is absent or unwritable for a non-root test user: either way it must not throw.
      expect(typeof setupBackup.backupBusyForRestore(undefined)).toBe("boolean");
    } finally { if (before === undefined) delete process.env.MURAGE_CLOUD_ROLE; else process.env.MURAGE_CLOUD_ROLE = before; }
  });
});

// Pin: no backup/snapshot writer may join a Cloud home unless it holds the lock the arm gate reads. Adding one later fails here until it is wired in.
describe("no unwired backup or snapshot writer on a Cloud home", () => {
  const dir = fileURLToPath(new URL("../../deploy/cloud-home/", import.meta.url));
  const files = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && !/\.(md|txt)$/.test(e.name)).map((e) => e.name);
  const text = (f: string) => readFileSync(join(dir, f), "utf8");
  const WRITER_MARK = /restic["', ]+(backup|forget|tag|init|copy)|["']restic["'] *, *["'](backup|forget|tag)|online_backup|sqlite3\.connect|\.backup\(|tar\b.*\.zst/;
  // Every unit timer reviewed: name -> what it runs and why it is not a backup writer (or that it is one that holds the lock).
  const TIMERS: Record<string, string> = {
    "murage-backup.timer": "murage-backup.service: the nightly restic writer (holds the lock)",
    "murage-home-recover.timer": "restarts stopped home/proxy units",
    "murage-sentinel.timer": "sentinel check, no backup",
  };

  it("every timer is a reviewed one", () => {
    const timers = files.filter((f) => f.endsWith(".timer")).sort();
    expect(timers).toEqual(Object.keys(TIMERS).sort());
  });
  it("every file that writes backups or snapshots is a known writer that takes the shared data-ops lock", () => {
    const writers = files.filter((f) => !f.endsWith(".sh") && WRITER_MARK.test(text(f))).sort();
    expect(writers).toEqual(["murage-backup", "murage-commands"]);
    for (const w of writers) expect(text(w), w).toContain("murage-data-ops.lock");
  });
  it("the lock path the writers use is the one the arm gate probes", () => {
    expect(text("murage-backup")).toContain(`OPS_LOCK = "${setupBackup.CLOUD_DATA_OPS_LOCK}"`);
    expect(text("murage-commands")).toMatch(/path\(ctx, "run", "murage-data-ops\.lock"\)/);
    expect(text("murage-backup")).toMatch(/fcntl\.flock\(handle\.fileno\(\), fcntl\.LOCK_EX\)/);
  });
  it("every service that runs a writer is either the backup/commands service, and no other service ExecStart runs a writer", () => {
    for (const f of files.filter((x) => x.endsWith(".service"))) {
      const t = text(f);
      const runsWriter = /^ExecStart=.*\/(murage-backup|murage-commands)\s*$/m.test(t);
      expect(runsWriter, f).toBe(["murage-backup.service", "murage-commands.service"].includes(f));
    }
  });
  it("the server tree holds no restic or snapshot writer of its own on the Cloud home path", () => {
    const sdir = fileURLToPath(new URL("../cloud-home/", import.meta.url));
    for (const f of readdirSync(sdir).filter((x) => x.endsWith(".ts") && !x.endsWith(".test.ts"))) {
      expect(readFileSync(join(sdir, f), "utf8"), f).not.toMatch(/restic|VACUUM INTO|\.backup\(/);
    }
    expect(existsSync(dir)).toBe(true);
  });
});
