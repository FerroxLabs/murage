// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// r3.4d J4d: (1) the restore's hold of the Cloud data-ops lock is BOUNDED (a job armed and idle, or stuck, frees the lock at the deadline and raises restore.stuck);
// (2) boot recovery takes the same exclusive lock before it prepares a swapped job, and releases it after. Real flock contenders (python, as murage-backup does).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as lockLib from "../cloud-data-ops-lock.ts";
import { RestoreJobStore, RESTORE_BOOT_WAIT_LINE, RESTORE_FAILED_LINE, RESTORE_FINISHING_LINE, RESTORE_STUCK_LINE, RESTORE_HOLD_DEADLINE_MS, RESTORE_RECOVER_LOCK_WAIT_MS, restoreBootWaitLine, runRestoreBootRecovery, writeRecordAtomic } from "./restore-job.ts";
import { restoreOwnerRoute } from "./restore-owner-routes.ts";
import { rowFromRequest, rowBackedEffects } from "../test-support/restore-boot-wait.ts";
import { rename as renameAsync } from "node:fs/promises";

let root: string, lock: string;
const children: ChildProcess[] = [];
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "murage-j4d-")); lock = join(root, "murage-data-ops.lock"); chmodSync(root, 0o755); writeFileSync(lock, ""); chmodSync(lock, 0o600); });
afterEach(() => { for (const c of children.splice(0)) { try { c.kill("SIGKILL"); } catch { /* gone */ } } rmSync(root, { recursive: true, force: true }); });
const exited = (c: ChildProcess) => new Promise<void>((resolve) => { if (c.exitCode !== null || c.signalCode !== null) resolve(); else c.once("exit", () => resolve()); });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
function nightly(marker: string): ChildProcess {
  const code = `import fcntl,sys;h=open(sys.argv[1],"a");fcntl.flock(h.fileno(),fcntl.LOCK_EX);open(sys.argv[2],"w").write("ran")`;
  const c = spawn("python3", ["-c", code, lock, marker], { stdio: ["ignore", "inherit", "inherit"] });
  children.push(c); return c;
}
/** exit 0 = a contender got the exclusive lock at once; 1 = it would have had to wait. */
const contenderGets = () => spawnSync("python3", ["-c", `import fcntl,sys;h=open(sys.argv[1],"a")\ntry:\n  fcntl.flock(h.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept OSError:\n  sys.exit(1)`, lock]).status === 0;
const lockHook = () => { let hold: lockLib.DataOpsHold | null = null; return { acquire: () => { hold ??= lockLib.holdCloudDataOpsLock(lock); return hold !== null; }, release: () => { hold?.release(); hold = null; } }; };
const fx = () => {
  let marks = { swapped: null as string | null, prepared: null as string | null, blind: null as string | null };
  const calls: string[] = [];
  let onPrepare: () => void = () => {};
  return {
    calls, setOnPrepare(f: () => void) { onPrepare = f; },
    effects: { marks: () => marks, stage: () => ({ blind: false }), install: (j: { id: string }) => { calls.push("install"); marks = { ...marks, swapped: j.id }; },
      prepare: (j: { id: string }) => { calls.push("prepare"); onPrepare(); marks = { ...marks, prepared: j.id }; } },
  };
};
// J4d3: the boot wait is measured on the monotonic clock (mono). A test that gives only a fake `now` and a sleepSync that advances it means that clock for both; the jump tests give both.
const make = (extra: Partial<ConstructorParameters<typeof RestoreJobStore>[0]> = {}) => new RestoreJobStore({ dir: root, isLocalArchive: () => true, captureCarry: () => ({}), ...(extra.now && !extra.mono ? { mono: extra.now } : {}), ...extra });

describe("J4d the hold is bounded", () => {
  it("defaults: 30 min hold, 120 s boot wait", () => { expect(RESTORE_HOLD_DEADLINE_MS).toBe(1_800_000); expect(RESTORE_RECOVER_LOCK_WAIT_MS).toBe(120_000); });
  it("armed and idle past the deadline: the job is aborted, the lock is freed, a waiting nightly runs, restore.stuck is raised", async () => {
    const stuck: Array<string | null> = [], aborted: string[] = [];
    const s = make({ dataOpsLock: lockHook(), holdDeadlineMs: 600, onHoldExpired: j => stuck.push(j?.phase ?? null), onAbort: j => aborted.push(j.id) });
    expect(s.arm({ archiveId: "arc1", source: "owner" })).toMatchObject({ ok: true });
    const marker = join(root, "nightly");
    const n = nightly(marker);
    await sleep(300);
    expect(existsSync(marker)).toBe(false);
    await exited(n); // the contender proceeds once the deadline fires, with nobody calling abort
    expect(readFileSync(marker, "utf8")).toBe("ran");
    expect(s.state()).toBe("aborted");
    expect(aborted.length).toBe(1);
    expect(stuck.length).toBe(1);
  });
  it("captured and idle past the deadline: same", async () => {
    const stuck: number[] = [];
    const s = make({ dataOpsLock: lockHook(), holdDeadlineMs: 500, onHoldExpired: () => stuck.push(1) });
    s.arm({ archiveId: "arc1", source: "owner" }); s.capture();
    expect(contenderGets()).toBe(false);
    await sleep(900);
    expect(contenderGets()).toBe(true);
    expect(s.state()).toBe("aborted"); expect(stuck).toEqual([1]);
  });
  it("swapped and stuck past the deadline: the lock is freed, the job is NOT aborted (the home changed), restore.stuck is raised", async () => {
    const f = fx(), stuck: Array<string | null> = [];
    const s = make({ dataOpsLock: lockHook(), effects: f.effects, holdDeadlineMs: 500, onHoldExpired: j => stuck.push(j?.phase ?? null) });
    s.arm({ archiveId: "arc1", source: "owner" }); s.capture();
    expect(s.swap({ archiveId: "arc1", source: "owner" }).ok).toBe(true);
    await sleep(900);
    expect(contenderGets()).toBe(true);
    expect(stuck.length).toBe(1);
    expect(s.state()).toBe("running"); // still owed a prepare; windowOpen stays true
    expect(s.windowOpen()).toBe(true);
  });
  it("a job cleared or aborted in time cancels the timer: no alert, no second release", async () => {
    const stuck: number[] = [];
    const s = make({ dataOpsLock: lockHook(), holdDeadlineMs: 400, onHoldExpired: () => stuck.push(1) });
    s.arm({ archiveId: "arc1", source: "owner" }); s.abort();
    await sleep(800);
    expect(stuck).toEqual([]);
    expect(s.clear().ok).toBe(true);
    s.arm({ archiveId: "arc1", source: "owner" }); s.capture(); s.abort(); s.clear();
    await sleep(800);
    expect(stuck).toEqual([]);
  });
  it("no data-ops lock (desktop): no timer, no alert", async () => {
    const stuck: number[] = [];
    const s = make({ holdDeadlineMs: 100, onHoldExpired: () => stuck.push(1) });
    s.arm({ archiveId: "arc1", source: "owner" }); await sleep(400);
    expect(stuck).toEqual([]); expect(s.state()).toBe("running");
  });
  it("source pin: index.ts raises restore.stuck from onHoldExpired", () => {
    const src = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    expect(src).toMatch(/onHoldExpired: \(\) => noteRestoreStuck\(HOME_EVENTS_DIR, join\(DATA_DIR, "restore-stuck-at"\), true\)/);
  });
});

describe("J4d boot recovery holds the lock", () => {
  const swappedJob = () => {
    const f = fx();
    const a = make({ effects: f.effects });
    a.arm({ archiveId: "arc1", source: "owner" }); a.capture(); a.swap({ archiveId: "arc1", source: "owner" });
    return f;
  };
  it("during the prepare a backup contender waits; before and after it does not", () => {
    const f = swappedJob();
    expect(contenderGets()).toBe(true); // nothing holds it before recovery
    const seen: boolean[] = [];
    f.setOnPrepare(() => { seen.push(contenderGets()); });
    const s = make({ dataOpsLock: lockHook(), effects: f.effects });
    expect(s.recover()).toEqual({ action: "prepared" });
    expect(seen).toEqual([false]); // a real flock contender could not take it mid-prepare
    expect(contenderGets()).toBe(true); // released when done
    expect(s.state()).toBe("none");
  });
  it("a blocking nightly started while recovery prepares runs only after recovery is done", async () => {
    const f = swappedJob();
    const marker = join(root, "nightly"); let n: ChildProcess | undefined;
    f.setOnPrepare(() => { n = nightly(marker); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 700); });
    const s = make({ dataOpsLock: lockHook(), effects: f.effects });
    s.recover();
    expect(existsSync(marker)).toBe(false); // it was waiting through the whole prepare
    await exited(n!);
    expect(readFileSync(marker, "utf8")).toBe("ran");
  });
  it("a prepare that throws still releases the lock and reports stuck", () => {
    const f = swappedJob(); f.setOnPrepare(() => { throw new Error("disk"); });
    const s = make({ dataOpsLock: lockHook(), effects: f.effects });
    expect(s.recover()).toEqual({ action: "stuck" });
    expect(contenderGets()).toBe(true);
  });
  it("lock held by a backup at boot: recovery retries, then prepares once the backup lets go; no prepare ran while it was held", async () => {
    const f = swappedJob();
    const holder = spawn("/bin/sh", ["-c", `exec 9>>"${lock}"; /usr/bin/flock -x 9; echo held; exec sleep 60`], { stdio: ["ignore", "pipe", "ignore"] });
    children.push(holder); await new Promise<void>(r => holder.stdout!.once("data", () => r()));
    let tries = 0;
    const s = make({ dataOpsLock: lockHook(), effects: f.effects, recoverLockWaitMs: 20_000, sleepSync: () => { if (++tries === 3) { holder.kill("SIGKILL"); spawnSync("sleep", ["0.3"]); } } });
    expect(s.recover()).toEqual({ action: "prepared" });
    expect(tries).toBeGreaterThanOrEqual(3);
    expect(f.calls.filter(c => c === "prepare").length).toBe(1);
  });
  it("lock held for the whole wait: stuck, nothing prepared, the job stays swapped", async () => {
    const f = swappedJob();
    const holder = spawn("/bin/sh", ["-c", `exec 9>>"${lock}"; /usr/bin/flock -x 9; echo held; exec sleep 60`], { stdio: ["ignore", "pipe", "ignore"] });
    children.push(holder); await new Promise<void>(r => holder.stdout!.once("data", () => r()));
    const s = make({ dataOpsLock: lockHook(), effects: f.effects, recoverLockWaitMs: 400, sleepSync: ms => { spawnSync("sleep", [String(ms / 1000)]); } });
    expect(s.recover()).toEqual({ action: "stuck" });
    expect(f.calls).not.toContain("prepare");
    expect(s.windowOpen()).toBe(true);
  });
  it("armed or captured at boot is aborted without taking the lock (nothing to prepare); desktop (no lock) recovers as before", () => {
    const a = make({ dataOpsLock: lockHook() }); a.arm({ archiveId: "arc1", source: "owner" });
    const s = make({ dataOpsLock: lockHook() });
    expect(s.recover()).toEqual({ action: "aborted" });
  });
  it("desktop (no lock) recovers a swapped job as before", () => {
    const f = swappedJob();
    expect(make({ effects: f.effects }).recover()).toEqual({ action: "prepared" });
  });
});

describe("J4d2 boot wait: ceiling and log", () => {
  const stubLock = () => ({ acquire: () => false, release: () => {} });
  const swappedJob = () => { const f = fx(); const a = make({ effects: f.effects }); a.arm({ archiveId: "arc1", source: "owner" }); a.capture(); a.swap({ archiveId: "arc1", source: "owner" }); return f; };
  it("the default boot wait is exactly 120 s: retries every 250 ms, sleeps 120000 ms in all, then stuck, with start and give-up lines naming the cause and elapsed time", () => {
    const f = swappedJob(); let clock = 1_000; let slept = 0; const lines: string[] = [];
    const s = make({ dataOpsLock: stubLock(), effects: f.effects, now: () => clock, sleepSync: ms => { slept += ms; clock += ms; }, log: l => lines.push(l) });
    expect(s.recover()).toEqual({ action: "stuck" });
    expect(slept).toBe(120_000);
    expect(f.calls).not.toContain("prepare");
    expect(lines[0]).toMatch(/finishing a backup before starting; waiting up to 120000 ms, a backup or other data operation holds the data-ops lock/);
    expect(lines.some(l => /still waiting, 10000 ms of 120000 ms/.test(l))).toBe(true);
    expect(lines[lines.length - 1]).toMatch(/gave up after 120000 ms.*restore\.stuck follows/);
  });
  it("a lock freed after 3 retries logs the finish with the elapsed time and goes on", () => {
    const f = swappedJob(); let clock = 0, n = 0; const lines: string[] = [];
    const s = make({ dataOpsLock: { acquire: () => ++n > 3, release: () => {} }, effects: f.effects, now: () => clock, sleepSync: ms => { clock += ms; }, log: l => lines.push(l) });
    expect(s.recover()).toEqual({ action: "prepared" });
    expect(lines.at(-1)).toMatch(/lock available after 750 ms, going on/);
  });
  it("a lock free at once logs nothing", () => {
    const f = swappedJob(); const lines: string[] = [];
    make({ dataOpsLock: { acquire: () => true, release: () => {} }, effects: f.effects, log: l => lines.push(l) }).recover();
    expect(lines).toEqual([]);
  });
});

describe("J4d3 the boot wait record and the owner line", () => {
  let notice: ReturnType<typeof rowFromRequest> | null = null;
  beforeEach(() => { notice = null; });
  const noticeEffects = () => { const base = fx().effects; if (notice) base.prepare({id:notice.job_id}); return rowBackedEffects(base, notice); };

  const swappedJob = () => { const f = fx(); const a = make({ effects: f.effects }); a.arm({ archiveId: "arc1", source: "owner" }); a.capture(); a.swap({ archiveId: "arc1", source: "owner" }); return f; };
  const waitFile = () => join(root, "restore-boot-wait.json");
  /** A boot whose lock frees after `tries` failed tries, on a fake clock. Returns the store that ran it. */
  const bootThatWaited = (tries: number, clockBox = { t: 1_000 }) => {
    const f = swappedJob(); let n = 0;
    const s = make({ dataOpsLock: { acquire: () => ++n > tries, release: () => {} }, effects: f.effects, now: () => clockBox.t, sleepSync: ms => { clockBox.t += ms; }, log: () => {}, bootId: () => "boot-A", bootTime: () => 1000,
      publish: req => { notice = rowFromRequest(req, {dev:"1",ino:"2"}); const result=Promise.resolve("saved"); return {result,terminate:()=>{},exited:result.then(()=>{})}; } });
    const r = s.recover();
    return s.publishSettled().then(() => ({ s, r, clockBox })); // the record is written asynchronously (M4)
  };
  const statusOf = (s: RestoreJobStore) => restoreOwnerRoute({ jobs: s, closeForSwap: async () => true, restart: () => {} }, { method: "GET", path: "/api/restore-job/status", body: null, surface: "desktop", botCredential: false });
  const reboot = (clockBox: { t: number }) => make({ now: () => clockBox.t, bootId: () => "boot-A", bootTime: () => 1000, effects: noticeEffects() });

  it("the copy is one exported constant, plain and calm: no dashes, none of the banned words", async () => {
    expect(RESTORE_BOOT_WAIT_LINE).toBe("Murage waited {N} seconds for a backup to finish before starting, so your data stays consistent.");
    const lines = [RESTORE_BOOT_WAIT_LINE, restoreBootWaitLine({ elapsedMs: 1 }), restoreBootWaitLine({ elapsedMs: 3_400 }), restoreBootWaitLine({ elapsedMs: 120_000 })];
    for (const l of lines) { expect(l).not.toMatch(/[–—]/); expect(l).not.toMatch(/\b(safe|unsafe|safety|free|forge)\b|will fail/i); if (l !== RESTORE_BOOT_WAIT_LINE) expect(l).not.toMatch(/[{}]/); }
    expect(restoreBootWaitLine({ elapsedMs: 3_400 })).toBe("Murage waited 3 seconds for a backup to finish before starting, so your data stays consistent.");
    expect(restoreBootWaitLine({ elapsedMs: 3_600 })).toMatch(/waited 4 seconds/);
    expect(restoreBootWaitLine({ elapsedMs: 400 })).toMatch(/waited 1 second for/);
  });
  it("R1-212 a completed boot wait records v2 and publishes the full row", async () => {
    const { r, clockBox } = await bootThatWaited(12);
    expect(r).toEqual({ action: "prepared" });
    expect(statSync(waitFile()).mode & 0o777).toBe(0o600);
    expect(readdirSync(root).filter(n => n.includes("tmp") || n.endsWith(".tmp"))).toEqual([]);
    const after = reboot(clockBox); // a new process: nothing in memory
    const w = JSON.parse(readFileSync(waitFile(), "utf8"));
    expect(w).toMatchObject({ version: 2, outcome: "freed", elapsedMs: 3_000, at: clockBox.t, bootId:"boot-A", upMs:1000 });
    expect(w.jobId).toMatch(/\S/); expect(w.cause).toMatch(/backup/);
    expect(notice).toEqual({id:1,job_id:w.jobId,cause:w.cause,elapsed_ms:3000,outcome:"freed",at:clockBox.t,boot_id:"boot-A",up_ms:1000,db_dev:"1",db_ino:"2"});
    expect(after.bootWaitLine()).toBe("Murage waited 3 seconds for a backup to finish before starting, so your data stays consistent.");
  });
  it("a wait that gave up still writes the record (gave_up) and still returns stuck, which index.ts raises as restore.stuck", async () => {
    const f = swappedJob(); const box = { t: 0 };
    const s = make({ dataOpsLock: { acquire: () => false, release: () => {} }, effects: f.effects, now: () => box.t, sleepSync: ms => { box.t += ms; }, log: () => {} });
    expect(s.recover()).toEqual({ action: "stuck" });
    await s.opsSettled();
    expect(JSON.parse(readFileSync(waitFile(),"utf8"))).toMatchObject({ version:2, outcome: "gave_up", elapsedMs: 120_000 });
    expect(reboot(box).bootWaitLine()).toBeNull();
    // the stuck branch by EXECUTION: the same function index.ts runs at boot spools restore.stuck for this very store (a second gave_up boot), and only index.ts's one call is pinned by text
    const f2 = swappedJob(); const box2 = { t: 0 }; const spooled: string[] = [];
    const s2 = make({ dataOpsLock: { acquire: () => false, release: () => {} }, effects: f2.effects, now: () => box2.t, sleepSync: ms => { box2.t += ms; }, log: () => {} });
    expect(runRestoreBootRecovery(s2, () => spooled.push("restore.stuck"))).toEqual({ stuck: true });
    expect(spooled).toEqual(["restore.stuck"]);
    expect(readFileSync(new URL("../index.ts", import.meta.url), "utf8")).toMatch(/runRestoreBootRecovery\(restoreJobs, \(\) => noteRestoreStuck\(HOME_EVENTS_DIR, stuckFile, true\)\);/);
  });
  it("no wait, no record: a lock free at once writes nothing, and a store with no record has no line", async () => {
    const f = swappedJob();
    make({ dataOpsLock: { acquire: () => true, release: () => {} }, effects: f.effects }).recover();
    expect(existsSync(waitFile())).toBe(false);
    const s = make();
    expect(s.bootWaitLine()).toBeNull(); expect(s.homeLine()).toBeNull();
    expect(await statusOf(s)).toEqual({ status: 200, body: { state: "none", code: null, line: null, action: null } });
  });
  it("the owner status shows the line, and keeps showing it (the status is polled, so there is no seen signal) until a restore finishes or 24 h pass", async () => {
    const { clockBox } = await bootThatWaited(12);
    const s = reboot(clockBox);
    for (let i = 0; i < 3; i++) expect(await statusOf(s)).toEqual({ status: 200, body: { state: "none", code: null, line: "Murage waited 3 seconds for a backup to finish before starting, so your data stays consistent.", action: null } });
    expect(s.homeLine()).toBe(s.bootWaitLine());
  });
  it("an open restore or a failed one keeps its own line; the wait line comes back after it is cleared", async () => {
    const { clockBox } = await bootThatWaited(12);
    const s = make({ now: () => clockBox.t, bootId: () => "boot-A", bootTime: () => 1000, effects: noticeEffects() });
    s.arm({ archiveId: "arc1", source: "owner" });
    expect((await statusOf(s))!.body.line).toBe("A restore may still be in progress. Try again later.");
    s.abort();
    expect((await statusOf(s))!.body.line).toMatch(/did not finish/);
    s.dismiss();
    expect((await statusOf(s))!.body.line).toMatch(/Murage waited 3 seconds/);
  });
  it("the same boot's own restore does not erase it, but the NEXT successful restore does", async () => {
    const { clockBox } = await bootThatWaited(12);
    expect(existsSync(waitFile())).toBe(true); // recover() prepared and cleared job 1, the record stayed
    const s = make({ now: () => clockBox.t, bootId: () => "boot-A", bootTime: () => 1000, effects: noticeEffects() });
    expect(s.arm({ archiveId: "arc2", source: "owner" }).ok).toBe(true);
    expect(s.bootWaitLine()).not.toBeNull(); // armed is not finished
    s.capture(); s.swap({ archiveId: "arc2", source: "owner" }); expect(s.prepare().ok).toBe(true);
    expect(s.bootWaitLine()).toBeNull(); // the prepared mark now names B
    expect(s.clear().ok).toBe(true);
    expect(existsSync(waitFile())).toBe(true);
    expect(await statusOf(s)).toEqual({ status: 200, body: { state: "none", code: null, line: null, action: null } });
  });
  it("an aborted restore does not clear it (only a successful one does)", async () => {
    const { clockBox } = await bootThatWaited(12);
    const s = make({ now: () => clockBox.t, bootId: () => "boot-A", bootTime: () => 1000, effects: noticeEffects() });
    s.arm({ archiveId: "arc2", source: "owner" }); s.abort(); s.dismiss();
    expect(existsSync(waitFile())).toBe(true);
  });

  it("a record that cannot be written never stops the boot", async () => {
    const f = swappedJob(); let n = 0; const lines: string[] = [];
    const s = make({ dataOpsLock: { acquire: () => ++n > 2, release: () => {} }, effects: f.effects, sleepSync: () => {}, log: l => lines.push(l),
      writeRecord: () => Promise.reject(new Error("disk full")) });
    expect(s.recover()).toEqual({ action: "prepared" });
    await s.opsSettled();
    expect(lines.some(l => /boot wait record not written: disk full/.test(l))).toBe(true);
  });

  // ===================== J4d3 fix round (Astra: M1 to M4, L5, test gaps) =====================
  const journalId = () => (JSON.parse(readFileSync(join(root, "restore-job.json"), "utf8")) as { id: string }).id;
  const rawRecord = (over: Record<string, string>) => {
    const values: Record<string, unknown> = {};
    for (const [key, text] of Object.entries(over)) values[key === "elapsedMs" ? "elapsed_ms" : key] = JSON.parse(text);
    notice = {id:1,job_id:"j1",cause:"backup",elapsed_ms:3000,outcome:"freed",at:1000,boot_id:"boot-A",up_ms:1000,db_dev:"1",db_ino:"2",...values};
  };
  it("R1-M4 hanging or throwing record writes leave recovery responsive", async () => {
    for (const throwing of [false, true]) {
      rmSync(root, {recursive:true,force:true}); mkdirSync(root,{recursive:true});
      const f=swappedJob();let tries=0;const logs:string[]=[];
      const s=make({effects:f.effects,dataOpsLock:{acquire:()=>++tries>1,release:()=>{}},sleepSync:()=>{},log:l=>logs.push(l),writeRecord:()=>{if(throwing)throw Error("sync boom");return new Promise<void>(()=>{});}});
      expect(s.recover()).toEqual({action:"prepared"});await new Promise<void>(r=>setImmediate(r));
      if(throwing){await s.opsSettled();expect(logs.some(l=>l.includes("boot wait record not written: sync boom"))).toBe(true);}
    }
  });

  const childRead = (withRow = false) => {
    const url = new URL("./restore-job.ts", import.meta.url).href;
    const code = `import { RestoreJobStore } from ${JSON.stringify(url)}; const s = new RestoreJobStore({ dir: ${JSON.stringify(root)}, isLocalArchive: () => true, captureCarry: () => ({}), now: () => 1500, bootId: () => "boot-A", bootTime: () => 1000, effects: { marks: () => ({swapped:null, prepared:"j1", blind:null}), bootWait: () => ({row: ${JSON.stringify(withRow ? {id:1,job_id:"j1",cause:"backup",elapsed_ms:3000,outcome:"freed",at:1000,boot_id:"boot-A",up_ms:1000,db_dev:"1",db_ino:"2"}:null)}, prepared:"j1", dev:"1", ino:"2"}) } }); process.stdout.write(String(s.bootWaitLine()));`;
    return spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 8_000 });
  };
  it("M3: a hostile record (symlink, FIFO, oversized file, directory) gives no notice and no hang", async () => {
    const { clockBox } = await bootThatWaited(12);
    const good = readFileSync(waitFile(), "utf8");
    const check = (label: string) => {
      const r = childRead(); // a child with a timeout: a read that blocks must show as a failure, not as a hung test run
      expect(r.signal, `${label}: hang (${r.stderr})`).toBeNull();
      expect({ label, status: r.status, out: r.stdout }).toEqual({ label, status: 0, out: "null" });
      const s = make({now:()=>clockBox.t}); const t=performance.now(); expect(s.bootWait()).toBeNull(); expect(s.homeLine()).toBeNull(); expect(performance.now()-t).toBeLessThan(50);
    };
    rmSync(waitFile()); writeFileSync(join(root, "real.json"), good); symlinkSync(join(root, "real.json"), waitFile()); check("symlink");
    rmSync(waitFile()); expect(spawnSync("mkfifo", [waitFile()]).status).toBe(0); check("fifo");
    rmSync(waitFile()); writeFileSync(waitFile(), good.trimEnd() + " ".repeat(64 * 1024) + "\n"); check("oversized");
    rmSync(waitFile()); mkdirSync(waitFile()); check("directory");
    rmSync(waitFile(), { recursive: true }); writeFileSync(waitFile(), good);
    expect(childRead().stdout).toBe("null");
    writeFileSync(waitFile(),JSON.stringify({version:1,jobId:"j1",cause:"backup",elapsedMs:3000,outcome:"freed",at:1000}));
    expect(childRead().stdout).toBe("null");
    rmSync(waitFile()); expect(childRead(true).stdout).toMatch(/Murage waited/);
  });

  it("M2: a wall clock that jumps BACK during the boot wait does not stretch it: 120 s on the monotonic clock, then stuck", async () => {
    const f = swappedJob(); const mono = { t: 5_000 }, wall = { t: 1_000_000_000 }; let sleeps = 0;
    const s = make({ dataOpsLock: { acquire: () => false, release: () => {} }, effects: f.effects, now: () => wall.t, mono: () => mono.t, log: () => {},
      sleepSync: ms => { if (++sleeps > 2000) throw new Error("runaway wait"); mono.t += ms; if (sleeps === 1) wall.t -= 86_400_000; } });
    expect(s.recover()).toEqual({ action: "stuck" });
    expect(sleeps).toBe(480);
    await s.opsSettled();
    expect(JSON.parse(readFileSync(waitFile(), "utf8"))).toMatchObject({ outcome: "gave_up", elapsedMs: 120_000 });
  });
  it("M2: a wall clock that jumps FORWARD during the boot wait does not cut it short", async () => {
    const f = swappedJob(); const mono = { t: 5_000 }, wall = { t: 1_000_000_000 }; let sleeps = 0;
    const s = make({ dataOpsLock: { acquire: () => false, release: () => {} }, effects: f.effects, now: () => wall.t, mono: () => mono.t, log: () => {},
      sleepSync: ms => { if (++sleeps > 2000) throw new Error("runaway wait"); mono.t += ms; if (sleeps === 1) wall.t += 86_400_000; } });
    expect(s.recover()).toEqual({ action: "stuck" });
    expect(sleeps).toBe(480);
  });


  it("L5: non-finite, negative or implausible numbers give no notice (1e309 parses to Infinity)", async () => {
    const cases: Array<[string, Record<string, string>]> = [
      ["at 1e309", { at: "1e309" }], ["at -1e309", { at: "-1e309" }], ["at negative", { at: "-5" }], ["at string", { at: '"1000"' }], ["at null", { at: "null" }],
      ["elapsedMs 1e309", { elapsedMs: "1e309" }], ["elapsedMs negative", { elapsedMs: "-1" }], ["elapsedMs 30 days", { elapsedMs: String(30 * 86_400_000) }], ["elapsedMs string", { elapsedMs: '"3000"' }],
    ];
    for (const [label, over] of cases) {
      rawRecord(over);
      const s = make({ now: () => 2_000, bootId:()=>"boot-A",bootTime:()=>1000,effects:noticeEffects() });
      expect({ label, line: s.bootWaitLine() }).toEqual({ label, line: null });
    }
    rawRecord({}); expect(make({ now: () => 2_000, bootId:()=>"boot-A",bootTime:()=>1000,effects:noticeEffects() }).bootWaitLine()).toMatch(/waited 3 seconds/); // control
    rawRecord({ elapsedMs: "1e309" }); expect(make({ now: () => 2_000, bootId:()=>"boot-A",bootTime:()=>1000,effects:noticeEffects() }).homeLine()).toBeNull();
  });

  it("gap: a gave_up record carries the job's own id (not another), so the next restore can tell it is not its own", async () => {
    const f = swappedJob(); const id = journalId(); const box = { t: 0 };
    const s = make({ dataOpsLock: { acquire: () => false, release: () => {} }, effects: f.effects, now: () => box.t, sleepSync: ms => { box.t += ms; }, log: () => {} });
    expect(s.recover()).toEqual({ action: "stuck" });
    await s.opsSettled();
    expect(JSON.parse(readFileSync(waitFile(), "utf8")).jobId).toBe(id);
    expect(reboot(box).bootWaitLine()).toBeNull();
  });
  it("R1-TR the record is written temp then rename, owner-only, and a failed rename leaves the old record whole and no temp behind", async () => {
    const seen: Array<{ from: string; to: string; tmpText: string; tmpMode: number; targetThere: boolean }> = [];
    const spyRename = async (from: string, to: string) => { seen.push({ from, to, tmpText: readFileSync(from, "utf8"), tmpMode: statSync(from).mode & 0o777, targetThere: existsSync(to) }); await renameAsync(from, to); };
    const f = swappedJob(); let n = 0;
    const s = make({ dataOpsLock: { acquire: () => ++n > 2, release: () => {} }, effects: f.effects, sleepSync: () => {}, log: () => {}, recordOps: { rename: spyRename } });
    expect(s.recover()).toEqual({ action: "prepared" });
    await s.opsSettled();
    expect(seen.length).toBe(1);
    expect(seen[0].to).toBe(waitFile()); expect(seen[0].from).not.toBe(waitFile()); expect(seen[0].from.startsWith(waitFile())).toBe(true); expect(seen[0].from.endsWith(".tmp")).toBe(true);
    expect(JSON.parse(seen[0].tmpText)).toMatchObject({ version: 2, outcome: "freed" }); expect(seen[0].tmpMode).toBe(0o600); expect(seen[0].targetThere).toBe(false);
    // crash cut: the rename never happens
    writeFileSync(waitFile(), "OLD");
    await expect(writeRecordAtomic(waitFile(), "NEW", { rename: async () => { throw new Error("cut"); } })).rejects.toThrow("cut");
    expect(readFileSync(waitFile(), "utf8")).toBe("OLD");
    expect(readdirSync(root).filter(x => x.endsWith(".tmp"))).toEqual([]);
  });
  it("gap: homeLine() precedence, directly: an unreadable, open or failed restore keeps its own line; the wait line shows only with no job or after the failed one is dismissed", async () => {
    const { clockBox } = await bootThatWaited(12);
    const wl = restoreBootWaitLine({ elapsedMs: 3_000 });
    const s = make({ now: () => clockBox.t, bootId: () => "boot-A", bootTime: () => 1000, effects: noticeEffects() });
    expect(s.homeLine()).toBe(wl);
    s.arm({ archiveId: "arc2", source: "owner" }); expect(s.homeLine()).toBe(RESTORE_FINISHING_LINE);
    s.capture(); expect(s.homeLine()).toBe(RESTORE_FINISHING_LINE);
    s.abort(); expect(s.homeLine()).toBe(RESTORE_FAILED_LINE);
    s.dismiss(); expect(s.homeLine()).toBe(wl);
    writeFileSync(join(root, "restore-job.json"), "not json"); expect(s.homeLine()).toBe(RESTORE_STUCK_LINE);
  });
});
