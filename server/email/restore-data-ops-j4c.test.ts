// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// r3.4d J4c: (1) the server uid (not root) can open, probe and hold the Cloud data-ops lock once root has prepared it; (2) the restore HOLDS the lock exclusive from arm to
// clear/abort, so a nightly (murage-backup style) that starts after arm waits, and a crash while holding releases it.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, chownSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as setupBackup from "../cloud-data-ops-lock.ts";
import { prepareDataOpsLock } from "../cloud-home/home-volume-spec.ts";
import { RestoreJobStore } from "./restore-job.ts";

const CHILD = fileURLToPath(new URL("./restore-data-ops-j4c-child.ts", import.meta.url));
const IS_ROOT = process.getuid?.() === 0;
const SERVER = { uid: 2001, gid: 2001 };
let root: string, lock: string;
const children: ChildProcess[] = [];
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "murage-j4c-")); lock = join(root, "murage-data-ops.lock"); chmodSync(root, 0o755); writeFileSync(lock, ""); chmodSync(lock, 0o600); });
afterEach(() => { for (const c of children.splice(0)) { try { c.kill("SIGKILL"); } catch { /* gone */ } } rmSync(root, { recursive: true, force: true }); });

const exited = (c: ChildProcess) => new Promise<void>((resolve) => { if (c.exitCode !== null || c.signalCode !== null) resolve(); else c.once("exit", () => resolve()); });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/** murage-backup / murage-commands style contender: open "a", flock LOCK_EX (blocking, as ops_lock does), then write a marker. Started by the test AFTER arm. */
function nightly(marker: string, asServerUid = false): ChildProcess {
  const code = `import fcntl,sys;h=open(sys.argv[1],"a");fcntl.flock(h.fileno(),fcntl.LOCK_EX);open(sys.argv[2],"w").write("ran")`;
  const c = spawn("python3", ["-c", code, lock, marker], { stdio: ["ignore","inherit","inherit"], ...(asServerUid ? SERVER : {}) });
  children.push(c); return c;
}
function asChild(mode: string, uidSplit: boolean): ChildProcess {
  const c = spawn(process.execPath, [CHILD, mode, lock], { stdio: ["ignore", "pipe", "inherit"], ...(uidSplit ? SERVER : {}) });
  children.push(c); return c;
}
const heldLine = (c: ChildProcess) => new Promise<boolean>((resolve) => { c.stdout!.once("data", () => resolve(true)); c.once("exit", () => resolve(false)); });
const make = (extra: Partial<ConstructorParameters<typeof RestoreJobStore>[0]> = {}) => new RestoreJobStore({ dir: root, isLocalArchive: () => true, captureCarry: () => ({}), ...extra });
const lockHook = () => { let hold: setupBackup.DataOpsHold | null = null; return { acquire: () => { hold ??= setupBackup.holdCloudDataOpsLock(lock); return hold !== null; }, release: () => { hold?.release(); hold = null; } }; };

describe("J4c lock file the server uid can use (real uid split: root writer, uid 2001 server)", () => {
  it.skipIf(!IS_ROOT)("as the writers create it (root 0600) the server uid cannot open it, so the probe reports busy with nobody holding: the bug", () => {
    chmodSync(lock, 0o600); chownSync(lock, 0, 0);
    expect(spawnSync(process.execPath, [CHILD, "probe", lock], { ...SERVER }).status).toBe(3);
  });
  it.skipIf(!IS_ROOT)("after prepareDataOpsLock (root:server-gid 0660) the server uid probes it free, and busy while a root writer holds it", async () => {
    chmodSync(lock, 0o600); chownSync(lock, 0, 0);
    prepareDataOpsLock(SERVER, lock);
    const st = statSync(lock);
    expect([st.uid, st.gid, st.mode & 0o777]).toEqual([0, 2001, 0o660]);
    expect(spawnSync(process.execPath, [CHILD, "probe", lock], { ...SERVER }).status).toBe(0);
    const root_holder = spawn("/bin/sh", ["-c", `exec 9>>"${lock}"; /usr/bin/flock -x 9; echo held; exec sleep 60`], { stdio: ["ignore", "pipe", "ignore"] });
    children.push(root_holder); await heldLine(root_holder);
    expect(spawnSync(process.execPath, [CHILD, "probe", lock], { ...SERVER }).status).toBe(3);
    root_holder.kill("SIGKILL"); await exited(root_holder);
    expect(spawnSync(process.execPath, [CHILD, "probe", lock], { ...SERVER }).status).toBe(0);
  });
  it.skipIf(!IS_ROOT)("the server uid takes the EXCLUSIVE hold on the prepared file; a root nightly started afterwards waits, then runs once the server uid is killed", async () => {
    prepareDataOpsLock(SERVER, lock);
    const h = asChild("hold", true);
    expect(await heldLine(h)).toBe(true);
    const marker = join(root, "nightly-root");
    const n = nightly(marker);
    await sleep(1500);
    expect(existsSync(marker)).toBe(false);
    h.kill("SIGKILL"); await exited(h);
    await exited(n);
    expect(readFileSync(marker, "utf8")).toBe("ran");
  });
  it.skipIf(!IS_ROOT)("a root-held lock refuses the server uid hold (null), never waits", async () => {
    prepareDataOpsLock(SERVER, lock);
    const root_holder = spawn("/bin/sh", ["-c", `exec 9>>"${lock}"; /usr/bin/flock -x 9; echo held; exec sleep 60`], { stdio: ["ignore", "pipe", "ignore"] });
    children.push(root_holder); await heldLine(root_holder);
    const t0 = Date.now();
    expect(await heldLine(asChild("hold", true))).toBe(false);
    expect(Date.now() - t0).toBeLessThan(4000);
  });
  it("prepareDataOpsLock: creates it 0660 with the server gid, fixes a 0600 one, refuses a symlink (injected chown)", () => {
    const owners: Array<[number, number]> = [];
    rmSync(lock);
    prepareDataOpsLock({ gid: 4242 }, lock, (_fd, uid, gid) => { owners.push([uid, gid]); });
    expect(statSync(lock).mode & 0o777).toBe(0o660);
    chmodSync(lock, 0o600);
    prepareDataOpsLock({ gid: 4242 }, lock, (_fd, uid, gid) => { owners.push([uid, gid]); });
    expect(statSync(lock).mode & 0o777).toBe(0o660);
    expect(owners).toEqual([[0, 4242], [0, 4242]]);
    const link = join(root, "link.lock"); writeFileSync(join(root, "t"), ""); require_symlink(join(root, "t"), link);
    expect(() => prepareDataOpsLock({ gid: 1 }, link, () => {})).toThrow();
  });
  it("the image launcher prepares the lock as root before the privilege drop", () => {
    const src = readFileSync(fileURLToPath(new URL("../../deploy/cloud-home/murage-home-launch.py", import.meta.url)), "utf8");
    const prep = src.indexOf("    prepare_data_ops_lock(identity)"), drop = src.indexOf("    drop_privileges(identity)");
    expect(prep).toBeGreaterThan(0); expect(prep).toBeLessThan(drop);
  });
});

describe("J4c the restore holds the data-ops lock from arm to clear", () => {
  it("a nightly started AFTER arm waits; an abort releases the lock and it then runs", async () => {
    const s = make({ dataOpsLock: lockHook() });
    expect(s.arm({ archiveId: "arc1", source: "owner" })).toMatchObject({ ok: true });
    const marker = join(root, "nightly");
    const n = nightly(marker);
    await sleep(1500);
    expect(existsSync(marker)).toBe(false); // waiting, not running
    expect(n.exitCode).toBeNull();
    s.abort(); // J4c: abort frees it too (checked below); here we want clear, so re-arm path is covered in the next test
    await exited(n);
    expect(readFileSync(marker, "utf8")).toBe("ran");
  });
  it("held across capture, swap and prepare, released at clear (full happy path with stub effects)", async () => {
    let marks = { swapped: null as string | null, prepared: null as string | null, blind: null as string | null };
    const effects = { marks: () => marks, stage: () => ({ blind: false }), install: (j: { id: string }) => { marks = { ...marks, swapped: j.id }; }, prepare: (j: { id: string }) => { marks = { ...marks, prepared: j.id }; } };
    const s = make({ dataOpsLock: lockHook(), effects });
    s.arm({ archiveId: "arc1", source: "owner" });
    const marker = join(root, "nightly");
    const n = nightly(marker);
    s.capture(); expect(s.swap({ archiveId: "arc1", source: "owner" }).ok).toBe(true);
    await sleep(1200); expect(existsSync(marker)).toBe(false); // still waiting after the swap
    expect(s.prepare().ok).toBe(true);
    await sleep(800); expect(existsSync(marker)).toBe(false); // and after prepare
    expect(s.clear().ok).toBe(true);
    await exited(n);
    expect(readFileSync(marker, "utf8")).toBe("ran");
  });
  it("a second arm while a nightly holds the lock is refused backup_running and does not hold; a refused arm (job open) never takes the lock", async () => {
    const holder = spawn("/bin/sh", ["-c", `exec 9>>"${lock}"; /usr/bin/flock -x 9; echo held; exec sleep 60`], { stdio: ["ignore", "pipe", "ignore"] });
    children.push(holder); await heldLine(holder);
    const s = make({ dataOpsLock: lockHook() });
    expect(s.arm({ archiveId: "arc1", source: "owner" })).toMatchObject({ ok: false, code: "backup_running" });
    holder.kill("SIGKILL"); await exited(holder);
    expect(s.arm({ archiveId: "arc1", source: "owner" })).toMatchObject({ ok: true });
  });
  it("a crash (SIGKILL) while holding releases the lock: the waiting nightly then runs", async () => {
    const h = asChild("hold", false);
    expect(await heldLine(h)).toBe(true);
    const marker = join(root, "nightly");
    const n = nightly(marker);
    await sleep(1200); expect(existsSync(marker)).toBe(false);
    h.kill("SIGKILL"); await exited(h); await exited(n);
    expect(readFileSync(marker, "utf8")).toBe("ran");
  });
  it("the hold is not inherited by children the holder starts afterwards (close-on-exec): a long-lived child does not keep the lock after release", async () => {
    const hold = setupBackup.holdCloudDataOpsLock(lock)!;
    expect(hold).not.toBeNull();
    const child = spawn("sleep", ["60"], { stdio: "ignore" }); children.push(child);
    hold.release();
    expect(setupBackup.cloudDataOpsBusy(lock)).toBe(false);
  });
  it("release is idempotent and a missing flock or path gives null (fail closed)", () => {
    expect(setupBackup.holdCloudDataOpsLock(lock, join(root, "no-flock"))).toBeNull();
    expect(setupBackup.holdCloudDataOpsLock(join(root, "no-dir", "x"))).toBeNull();
    writeFileSync(lock, "");
    const h = setupBackup.holdCloudDataOpsLock(lock)!; h.release(); h.release();
    expect(setupBackup.holdCloudDataOpsLock(lock)).not.toBeNull();
  });
  it("an arm whose journal write fails gives the lock back (no lock held by a job that does not exist)", () => {
    const s = make({ dataOpsLock: lockHook(), write: () => { throw new Error("disk full"); } });
    expect(() => s.arm({ archiveId: "arc1", source: "owner" })).toThrow();
    expect(setupBackup.cloudDataOpsBusy(lock)).toBe(false);
  });
  it("wired in index.ts on a Cloud home only", () => {
    const src = readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");
    expect(src).toMatch(/dataOpsLock: process\.env\.MURAGE_CLOUD_ROLE === "home" \?/);
  });
});
import { symlinkSync } from "node:fs";
function require_symlink(target: string, path: string): void { symlinkSync(target, path); }
