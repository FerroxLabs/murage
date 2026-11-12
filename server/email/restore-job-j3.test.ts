// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Restore park J3: O1 the owner restore route (arm -> capture -> close -> swap -> prepare -> clear) and O2 the aborted job (a refusal code, an owner status line
// with an OK action, an ops alert on abort).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { copyFileSync, existsSync, symlinkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RESTORE_ABORTED_LINE, RESTORE_FAILED_LINE, RESTORE_FINISHING_LINE, RESTORE_STUCK_LINE, RestoreJobStore, runRestoreBootRecovery, type RestoreJob, type RestoreJobEffects, type RestoreJobOptions } from "./restore-job.ts";
import { archiveIsLocal, captureEmailCarry, sqliteRestoreEffects } from "./restore-job-effects.ts";
import { RESTORE_OWNER_ONLY_LINE, restoreOwnerRoute, type RestoreOwnerDeps, type RestoreOwnerRequest } from "./restore-owner-routes.ts";
import { spoolHomeEvent } from "../home-events.ts";
import { ROUTE_POLICY, routePolicy } from "../route-policy.ts";

let dir: string, live: string, archives: string;
let n = 0;
beforeEach(() => { n = 0; dir = mkdtempSync(join(tmpdir(), "restore-j3-")); live = join(dir, "messages.db"); archives = join(dir, "archives"); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const BIND = "CREATE TABLE email_bindings (bot_id TEXT PRIMARY KEY, inbox_id TEXT, address TEXT, email_key_ref TEXT, op_id TEXT, state TEXT, step TEXT, revision INTEGER DEFAULT 0)";
const mkdb = (path: string, rows: Array<[string, string, string]>) => {
  mkdirSync(join(path, ".."), { recursive: true }); rmSync(path, { force: true });
  const db = new DatabaseSync(path); db.exec(BIND);
  for (const [bot, inbox, state] of rows) db.prepare("INSERT INTO email_bindings (bot_id, inbox_id, address, email_key_ref, op_id, state) VALUES (?,?,?,?,?,?)").run(bot, inbox, `${bot}@x.test`, `key_${bot}`, `op_${bot}`, state);
  db.close();
};
const mkArchive = (id: string) => mkdb(join(archives, id, "messages.db"), [["b1", "ibx_1", "removing"], ["b2", "ibx_2", "active"]]);
const bindings = () => { const db = new DatabaseSync(live, { readOnly: true }); try { return db.prepare("SELECT bot_id AS b, state FROM email_bindings ORDER BY bot_id").all() as Array<{ b: string; state: string }>; } finally { db.close(); } };
const liveMarks = () => { const db = new DatabaseSync(live, { readOnly: true }); try { return db.prepare("SELECT kind, job_id AS j FROM restore_job_marks ORDER BY kind").all(); } finally { db.close(); } };
const journalFile = () => join(dir, "restore-job.json");
const journal = () => JSON.parse(readFileSync(journalFile(), "utf8"));
const ARM = { archiveId: "arc1", source: "owner" } as const;
const aborts: RestoreJob[] = [];
const make = (extra: Partial<RestoreJobOptions> = {}, wrap?: (fx: RestoreJobEffects) => RestoreJobEffects) => {
  const fx = sqliteRestoreEffects({ liveDb: live, archivesDir: archives, now: () => 1_800_000_000_000 });
  return new RestoreJobStore({ dir, now: () => 1_800_000_000_000, uid: p => `${p}-${++n}`, isLocalArchive: id => archiveIsLocal(archives, id), captureCarry: () => captureEmailCarry(live), effects: wrap ? wrap(fx) : fx, onAbort: j => { aborts.push(j); }, ...extra });
};
beforeEach(() => { aborts.length = 0; });

describe("O2 the store: aborted job", () => {
  it("arm while aborted answers restore_aborted with the OK line at once, and changes nothing", () => {
    mkdb(live, [["b3", "ibx_3", "active"]]); mkArchive("arc1");
    const s = make(); s.arm(ARM); s.abort();
    const before = readFileSync(journalFile(), "utf8");
    expect(s.arm(ARM)).toEqual({ ok: false, code: "restore_aborted", line: RESTORE_ABORTED_LINE });
    expect(readFileSync(journalFile(), "utf8")).toBe(before);
  });
  it("arm while armed, captured or prepared is still restore_finishing", () => {
    mkdb(live, [["b3", "ibx_3", "active"]]); mkArchive("arc1");
    const s = make(); s.arm(ARM);
    expect(s.arm(ARM)).toMatchObject({ ok: false, code: "restore_finishing" });
    s.capture();
    expect(s.arm(ARM)).toMatchObject({ ok: false, code: "restore_finishing" });
  });
  it("the abort hook is told once per abort, with the aborted job; a refused abort tells nobody", () => {
    mkdb(live, [["b3", "ibx_3", "active"]]); mkArchive("arc1");
    const s = make(); expect(s.abort()).toMatchObject({ ok: false }); expect(aborts).toHaveLength(0);
    s.arm(ARM); s.abort();
    expect(aborts).toHaveLength(1); expect(aborts[0]).toMatchObject({ id: "job-1", phase: "aborted", archiveId: "arc1" });
    s.abort(); expect(aborts).toHaveLength(1);
  });
  it("a hook that throws never breaks the abort", () => {
    mkdb(live, [["b3", "ibx_3", "active"]]); mkArchive("arc1");
    const s = make({ onAbort: () => { throw new Error("alert down"); } }); s.arm(ARM);
    expect(s.abort()).toMatchObject({ ok: true }); expect(journal().phase).toBe("aborted");
  });
  it("boot recovery of a captured job alerts once; recovering an already aborted job does not alert again", () => {
    mkdb(live, [["b3", "ibx_3", "active"]]); mkArchive("arc1");
    const s = make(); s.arm(ARM); s.capture();
    expect(s.recover()).toEqual({ action: "aborted" }); expect(aborts).toHaveLength(1);
    expect(s.recover()).toEqual({ action: "none" }); expect(aborts).toHaveLength(1);
  });
  it("state(): none, running (armed, captured, swapped), aborted, unreadable", () => {
    mkdb(live, [["b3", "ibx_3", "active"]]); mkArchive("arc1");
    const s = make(); expect(s.state()).toBe("none");
    s.arm(ARM); expect(s.state()).toBe("running");
    s.capture(); expect(s.state()).toBe("running");
    s.swap(ARM); expect(s.state()).toBe("running");
    s.prepare(); expect(s.state()).toBe("running");
    const t = make(); rmSync(journalFile(), { force: true }); rmSync(join(dir, "restore-carry.json"), { force: true });
    writeFileSync(live, ""); mkdb(live, [["b3", "ibx_3", "active"]]);
    t.arm(ARM); t.abort(); expect(t.state()).toBe("aborted");
    writeFileSync(journalFile(), "not json"); expect(t.state()).toBe("unreadable");
  });
  it("dismiss clears only an aborted job (carry and journal) and then arm works", () => {
    mkdb(live, [["b3", "ibx_3", "active"]]); mkArchive("arc1");
    const s = make(); s.arm(ARM); s.capture(); s.abort();
    expect(existsSync(join(dir, "restore-carry.json"))).toBe(true);
    expect(s.dismiss()).toMatchObject({ ok: true });
    expect(existsSync(journalFile())).toBe(false); expect(existsSync(join(dir, "restore-carry.json"))).toBe(false);
    expect(s.arm(ARM)).toMatchObject({ ok: true });
  });
  it("dismiss refuses none, armed, captured and swapped and leaves the journal alone", () => {
    mkdb(live, [["b3", "ibx_3", "active"]]); mkArchive("arc1");
    const s = make(); expect(s.dismiss()).toEqual({ ok: false, code: "not_dismissable" });
    s.arm(ARM); expect(s.dismiss()).toEqual({ ok: false, code: "not_dismissable" }); expect(journal().phase).toBe("armed");
    s.capture(); expect(s.dismiss()).toEqual({ ok: false, code: "not_dismissable" }); expect(journal().phase).toBe("captured");
    s.swap(ARM); expect(s.dismiss()).toEqual({ ok: false, code: "not_dismissable" }); expect(existsSync(journalFile())).toBe(true);
  });
});

describe("O1 the owner restore route", () => {
  interface Spy { events: string[]; closeResult: boolean | "throw"; restarts: number }
  const build = (extra: Partial<RestoreOwnerDeps> = {}, wrap?: (fx: RestoreJobEffects) => RestoreJobEffects) => {
    const spy: Spy = { events: [], closeResult: true, restarts: 0 };
    const jobs = make({}, wrap);
    const deps: RestoreOwnerDeps = {
      jobs,
      closeForSwap: async () => { spy.events.push(`close:${jobs.read()?.phase}:${jobs.windowOpen()}`); if (spy.closeResult === "throw") throw new Error("busy"); return spy.closeResult; },
      restart: () => { spy.restarts++; spy.events.push("restart"); },
      ...extra,
    };
    return { spy, jobs, deps };
  };
  const req = (method: string, path: string, body: unknown = {}, o: Partial<RestoreOwnerRequest> = {}): RestoreOwnerRequest => ({ method, path, body, surface: "desktop", botCredential: false, ...o });
  const START = "/api/restore-job/start", DISMISS = "/api/restore-job/dismiss", STATUS = "/api/restore-job/status";
  const live1 = () => { mkdb(live, [["b3", "ibx_3", "active"]]); mkArchive("arc1"); };

  it("answers null for a path that is not a restore job route", async () => {
    const { deps } = build(); expect(await restoreOwnerRoute(deps, req("POST", "/api/email/status"))).toBeNull();
  });
  it("a bot or engine credential gets 403 on every restore route and arms nothing", async () => {
    live1(); const { deps, spy } = build();
    for (const [m, p] of [["POST", START], ["POST", DISMISS], ["GET", STATUS]] as const) {
      expect(await restoreOwnerRoute(deps, req(m, p, { archiveId: "arc1" }, { botCredential: true }))).toMatchObject({ status: 403 });
    }
    expect(existsSync(journalFile())).toBe(false); expect(spy.events).toEqual([]);
  });
  it("no owner surface (a script, a browser tab) gets 403", async () => {
    live1(); const { deps } = build();
    expect(await restoreOwnerRoute(deps, req("POST", START, { archiveId: "arc1" }, { surface: null }))).toMatchObject({ status: 403 });
    expect(await restoreOwnerRoute(deps, req("GET", STATUS, {}, { surface: null }))).toMatchObject({ status: 403 });
    expect(existsSync(journalFile())).toBe(false);
  });
  it("the paired phone may read the status but never start or dismiss a restore", async () => {
    live1(); const { deps, jobs } = build();
    expect(await restoreOwnerRoute(deps, req("GET", STATUS, {}, { surface: "phone" }))).toMatchObject({ status: 200 });
    expect(await restoreOwnerRoute(deps, req("POST", START, { archiveId: "arc1" }, { surface: "phone" }))).toMatchObject({ status: 403 });
    expect(existsSync(journalFile())).toBe(false);
    jobs.arm(ARM); jobs.abort();
    expect(await restoreOwnerRoute(deps, req("POST", DISMISS, {}, { surface: "phone" }))).toMatchObject({ status: 403 });
    expect(existsSync(journalFile())).toBe(true);
  });
  it("every refusal carries a stable code next to the English line (owner_only, not_found, bad_archive, restore_failed)", async () => {
    live1(); const { deps } = build();
    expect(await restoreOwnerRoute(deps, req("POST", START, { archiveId: "arc1" }, { surface: null }))).toMatchObject({ status: 403, body: { code: "owner_only", error: RESTORE_OWNER_ONLY_LINE } });
    expect(await restoreOwnerRoute(deps, req("GET", STATUS, {}, { botCredential: true }))).toMatchObject({ status: 403, body: { code: "owner_only" } });
    expect(await restoreOwnerRoute(deps, req("POST", START, { archiveId: "arc1" }, { surface: "phone" }))).toMatchObject({ status: 403, body: { code: "owner_only" } });
    expect(await restoreOwnerRoute(deps, req("POST", "/api/restore-job/nope"))).toMatchObject({ status: 404, body: { code: "not_found" } });
    expect(await restoreOwnerRoute(deps, req("POST", START, {}))).toMatchObject({ status: 400, body: { code: "bad_archive" } });
  });
  it("the English lines are the approved forms: no Nothing changed on the failed line, no Press OK anywhere on the server", () => {
    for (const line of [RESTORE_FINISHING_LINE, RESTORE_FAILED_LINE, RESTORE_ABORTED_LINE, RESTORE_OWNER_ONLY_LINE]) {
      expect(line).not.toMatch(/Press OK|you can restore|Try again in a minute/);
    }
    expect(RESTORE_FINISHING_LINE).toBe("A restore may still be in progress. Try again later.");
    expect(RESTORE_FAILED_LINE).not.toContain("Nothing changed");
    expect(RESTORE_OWNER_ONLY_LINE).toBe("Only the owner can restore a backup, using Murage on their computer or, for a Cloud home, on their phone.");
  });
  it("an unknown route under the prefix is 404 and a wrong method is 404", async () => {
    const { deps } = build();
    expect(await restoreOwnerRoute(deps, req("POST", "/api/restore-job/nope"))).toMatchObject({ status: 404 });
    expect(await restoreOwnerRoute(deps, req("GET", START))).toMatchObject({ status: 404 });
  });

  it("start drives arm, capture, close, swap, prepare, clear and asks for a restart", async () => {
    live1(); const { deps, spy } = build();
    const a = await restoreOwnerRoute(deps, req("POST", START, { archiveId: "arc1" }));
    expect(a).toEqual({ status: 200, body: { ok: true, restarting: true } });
    // the store was closed while the job was captured and the window open, and the restart came last
    expect(spy.events).toEqual(["close:captured:true", "restart"]);
    expect(bindings()).toEqual([{ b: "b1", state: "removal_parked" }, { b: "b2", state: "restored_unverified" }]);
    expect(liveMarks()).toEqual([{ kind: "prepared", j: "job-1" }, { kind: "swapped", j: "job-1" }]);
    expect(existsSync(journalFile())).toBe(false); expect(existsSync(join(dir, "restore-carry.json"))).toBe(false);
    expect(aborts).toHaveLength(0);
  });
  it("start refuses a missing, odd or traversing archive id with 400 and arms nothing", async () => {
    live1(); const { deps, spy } = build();
    for (const body of [{}, { archiveId: 5 }, { archiveId: "" }, { archiveId: "../x" }, { archiveId: "a/b" }, null, "arc1"]) {
      expect(await restoreOwnerRoute(deps, req("POST", START, body)), JSON.stringify(body)).toMatchObject({ status: 400 });
    }
    expect(existsSync(journalFile())).toBe(false); expect(spy.events).toEqual([]);
  });
  it("start with an archive that is not on this computer is 404 archive_not_local and closes nothing", async () => {
    live1(); const { deps, spy } = build();
    const a = await restoreOwnerRoute(deps, req("POST", START, { archiveId: "ghost" }));
    expect(a).toMatchObject({ status: 404, body: { code: "archive_not_local" } });
    expect(existsSync(journalFile())).toBe(false); expect(spy.events).toEqual([]); expect(bindings()).toEqual([{ b: "b3", state: "active" }]);
  });
  it("start while a restore is running is 409 restore_finishing and closes nothing", async () => {
    live1(); const { deps, spy, jobs } = build(); jobs.arm(ARM); jobs.capture();
    expect(await restoreOwnerRoute(deps, req("POST", START, { archiveId: "arc1" }))).toMatchObject({ status: 409, body: { code: "restore_finishing", error: RESTORE_FINISHING_LINE } });
    expect(spy.events).toEqual([]); expect(journal().phase).toBe("captured");
  });
  it("start while aborted is 409 restore_aborted with the OK action, never a hang, and closes nothing", async () => {
    live1(); const { deps, spy, jobs } = build(); jobs.arm(ARM); jobs.abort();
    const a = await restoreOwnerRoute(deps, req("POST", START, { archiveId: "arc1" }));
    expect(a).toEqual({ status: 409, body: { error: RESTORE_ABORTED_LINE, code: "restore_aborted", action: { label: "OK", method: "POST", path: DISMISS, code: "dismiss" } } });
    expect(spy.events).toEqual([]);
  });
  it("a store that will not close aborts the job (the failed line, one alert), leaves the live home alone and still restarts", async () => {
    live1(); const { deps, spy, jobs } = build(); spy.closeResult = false;
    const a = await restoreOwnerRoute(deps, req("POST", START, { archiveId: "arc1" }));
    expect(a).toEqual({ status: 500, body: { error: RESTORE_FAILED_LINE, code: "restore_failed", restarting: true } });
    expect(jobs.state()).toBe("aborted"); expect(aborts).toHaveLength(1); expect(spy.restarts).toBe(1);
    expect(bindings()).toEqual([{ b: "b3", state: "active" }]);
  });
  it("a close that throws is the same as one that refuses", async () => {
    live1(); const { deps, spy, jobs } = build(); spy.closeResult = "throw";
    expect(await restoreOwnerRoute(deps, req("POST", START, { archiveId: "arc1" }))).toMatchObject({ status: 500, body: { code: "restore_failed" } });
    expect(jobs.state()).toBe("aborted"); expect(aborts).toHaveLength(1); expect(spy.restarts).toBe(1);
  });
  it("a swap that throws before the home changed aborts the job, alerts once and restarts", async () => {
    live1(); const { deps, spy, jobs } = build({}, fx => ({ ...fx, install: () => { throw new Error("disk"); } }));
    const a = await restoreOwnerRoute(deps, req("POST", START, { archiveId: "arc1" }));
    expect(a).toMatchObject({ status: 500, body: { code: "restore_failed", restarting: true } });
    expect(jobs.state()).toBe("aborted"); expect(aborts).toHaveLength(1); expect(spy.restarts).toBe(1);
    expect(bindings()).toEqual([{ b: "b3", state: "active" }]);
  });
  it("a prepare that throws leaves the job swapped (no abort, no alert), restarts, and boot recovery finishes it", async () => {
    live1(); let boom = true;
    const { deps, spy, jobs } = build({}, fx => ({ ...fx, prepare: j => { if (boom) throw new Error("locked"); fx.prepare(j); } }));
    const a = await restoreOwnerRoute(deps, req("POST", START, { archiveId: "arc1" }));
    expect(a).toMatchObject({ status: 500, body: { code: "restore_failed", restarting: true } });
    expect(spy.restarts).toBe(1); expect(aborts).toHaveLength(0); expect(jobs.windowOpen()).toBe(true);
    boom = false;
    expect(jobs.recover()).toEqual({ action: "prepared" }); expect(jobs.state()).toBe("none");
    expect(bindings().map(r => r.b)).toEqual(["b1", "b2"]);
  });
  it("status: none has no line and no action; running has the finishing line; aborted has the OK line and the action", async () => {
    live1(); const { deps, jobs } = build();
    expect(await restoreOwnerRoute(deps, req("GET", STATUS))).toEqual({ status: 200, body: { state: "none", code: null, line: null, action: null } });
    jobs.arm(ARM);
    expect(await restoreOwnerRoute(deps, req("GET", STATUS))).toEqual({ status: 200, body: { state: "running", code: "finishing", line: RESTORE_FINISHING_LINE, action: null } });
    jobs.abort();
    expect(await restoreOwnerRoute(deps, req("GET", STATUS))).toEqual({ status: 200, body: { state: "aborted", code: "aborted", line: RESTORE_ABORTED_LINE, action: { label: "OK", method: "POST", path: DISMISS, code: "dismiss" } } });
  });
  it("status of an unreadable journal fails closed: its own line and code (not the finishing line), no action", async () => {
    live1(); const { deps } = build(); writeFileSync(journalFile(), "garbage");
    expect(await restoreOwnerRoute(deps, req("GET", STATUS))).toEqual({ status: 200, body: { state: "unreadable", code: "stuck_or_unreadable", line: RESTORE_STUCK_LINE, action: null } });
    expect(await restoreOwnerRoute(deps, req("POST", DISMISS))).toMatchObject({ status: 409, body: { code: "not_dismissable" } });
    expect(existsSync(journalFile())).toBe(true);
  });
  it("dismiss clears the aborted job, answers the empty status, and a new start then works end to end", async () => {
    live1(); const { deps, spy, jobs } = build(); jobs.arm(ARM); jobs.capture(); jobs.abort();
    expect(await restoreOwnerRoute(deps, req("POST", START, { archiveId: "arc1" }))).toMatchObject({ status: 409, body: { code: "restore_aborted" } });
    expect(await restoreOwnerRoute(deps, req("POST", DISMISS))).toEqual({ status: 200, body: { state: "none", code: null, line: null, action: null } });
    expect(await restoreOwnerRoute(deps, req("POST", START, { archiveId: "arc1" }))).toEqual({ status: 200, body: { ok: true, restarting: true } });
    expect(spy.restarts).toBe(1);
  });
  it("dismiss with nothing to dismiss, or while running, is 409 not_dismissable and keeps the job", async () => {
    live1(); const { deps, jobs } = build();
    expect(await restoreOwnerRoute(deps, req("POST", DISMISS))).toMatchObject({ status: 409, body: { code: "not_dismissable" } });
    jobs.arm(ARM); jobs.capture();
    expect(await restoreOwnerRoute(deps, req("POST", DISMISS))).toMatchObject({ status: 409, body: { code: "not_dismissable" } });
    expect(journal().phase).toBe("captured");
  });
});

describe("O2 the ops alert path", () => {
  it("spoolHomeEvent drops one small file {type, at} through a dot-prefixed temp name and leaves no temp behind", () => {
    const events = join(dir, "events");
    const name = spoolHomeEvent(events, "restore.aborted", 1_800_000_000_000);
    expect(name).toBe("restore.aborted-1800000000000.json");
    expect(readdirSync(events)).toEqual([name]);
    expect(JSON.parse(readFileSync(join(events, name!), "utf8"))).toEqual({ type: "restore.aborted", at: 1_800_000_000_000 });
  });
  it("spoolHomeEvent does nothing without a directory (a desktop install) and never throws", () => {
    expect(spoolHomeEvent(undefined, "restore.aborted", 1)).toBeNull();
    writeFileSync(join(dir, "afile"), "x");
    expect(spoolHomeEvent(join(dir, "afile", "sub"), "restore.aborted", 1)).toBeNull();
  });
  it("the control plane and the home daemon both carry the restore.aborted event, and the heartbeat schema accepts it", () => {
    const monitor = readFileSync(new URL("../../cloudflare/control-plane/src/ops-monitor.ts", import.meta.url), "utf8");
    expect(monitor).toMatch(/HOME_EVENT_TYPES = \["abuse\.mining_suspected", "restore\.aborted", "restore\.stuck", "home\.event_spool_failed"\] as const/);
    const control = readFileSync(new URL("../../deploy/cloud-home/murage-control", import.meta.url), "utf8");
    expect(control).toMatch(/BASE_EVENT_TYPES = \("abuse\.mining_suspected",\)/);
    expect(control).toMatch(/EXTENDED_EVENT_TYPES = \("restore\.aborted", "restore\.stuck", "home\.event_spool_failed", "restore\.finished"\)/);
  });
  it("the product wires the alert: index.ts builds the store with the abort hook and the route is in the policy", () => {
    const index = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    expect(index).toMatch(/onAbort:\s*job\s*=>\s*\{?\s*noteRestoreAborted\(/);
    expect(index).toMatch(/restoreOwnerRoute\(/);
    expect(routePolicy("POST", "/api/restore-job/start")).toMatchObject({ class: "desktop" });
    expect(routePolicy("POST", "/api/restore-job/dismiss")).toMatchObject({ class: "desktop" });
    expect(routePolicy("GET", "/api/restore-job/status")).toBeDefined();
    expect(ROUTE_POLICY.length).toBeGreaterThan(0);
  });
});

describe("review round: H1 H3 M4 M5 L7", () => {
  const live1 = () => { mkdb(live, [["b3", "ibx_3", "active"]]); mkArchive("arc1"); };
  it("M4: '.' and '..' are not archive ids, and a symlinked archive folder or a file resolving outside the root is not local", () => {
    live1();
    mkdirSync(archives, { recursive: true });
    for (const id of [".", "..", "...x/y"]) expect(archiveIsLocal(archives, id), id).toBe(false);
    writeFileSync(join(archives, "messages.db"), "x"); // what '..' would have reached
    expect(archiveIsLocal(archives, "..")).toBe(false);
    const outside = join(dir, "outside"); mkdirSync(outside); mkdb(join(outside, "messages.db"), [["x", "i", "active"]]);
    symlinkSync(outside, join(archives, "linked"));
    expect(archiveIsLocal(archives, "linked")).toBe(false);
    expect(archiveIsLocal(archives, "arc1")).toBe(true);
  });
  it("M5: an uncaptured swap that claims blind on a readable home installs nothing and leaves the job armed", () => {
    live1(); const s = make(); s.arm(ARM);
    expect(s.swap({ ...ARM, blind: true })).toMatchObject({ ok: false, code: "not_swappable" });
    expect(bindings()).toEqual([{ b: "b3", state: "active" }]); expect(journal().phase).toBe("armed");
  });
  it("L7: confirm_inventory does not answer 200 when the check was not consumed", async () => {
    const src = readFileSync(new URL("./owner-routes.ts", import.meta.url), "utf8");
    expect(src).toMatch(/if \(!deps\.confirmRestoreCheck\?\.\(\)\) return refuse\(409/);
  });
  it("H3: arm refuses backup_running while a backup is running, and arms once it ends", () => {
    live1(); let busy = true; const s = make({ backupBusy: () => busy });
    expect(s.arm(ARM)).toMatchObject({ ok: false, code: "backup_running" }); expect(existsSync(journalFile())).toBe(false);
    busy = false; expect(s.arm(ARM)).toMatchObject({ ok: true });
  });
  it("H3: a real BackupCoordinator reports busy while its tick runs (the interleaving the arm gate reads)", async () => {
    const src = readFileSync(new URL("../backup-coordinator.ts", import.meta.url), "utf8");
    expect(src).toMatch(/busy\(\):boolean\{\s*if\(this\.running!==undefined\)return true;/); // J4: the in-memory flag is still the first answer; the committed state answers for other processes (restore-backup-gate-j4.test.ts)
  });

  const child = (mode: string, killAt?: string) => spawnSync(process.execPath, [fileURLToPath(new URL("./restore-job-j3-child.ts", import.meta.url)), mode, dir, ...(killAt ? [killAt] : [])], { encoding: "utf8" });
  it("H1 (real process death): killed right after the install, with the marks unreadable at recovery, recovery neither aborts nor skips the prepare; once readable it prepares", () => {
    live1();
    const died = child("swap-and-die", "after-install");
    expect(died.signal).toBe("SIGKILL");
    expect(journal().phase).toBe("captured"); // the journal never saw the swap
    copyFileSync(live, join(dir, "good.db"));
    writeFileSync(live, "this is not a database file at all, not even close"); // the real open/query error path
    const first = JSON.parse(child("recover").stdout);
    expect(first.action).toBe("unreadable"); expect(first.aborts).toEqual([]); expect(first.windowOpen).toBe(true);
    expect(journal().phase).toBe("captured");
    copyFileSync(join(dir, "good.db"), live);
    const second = JSON.parse(child("recover").stdout);
    expect(second).toMatchObject({ action: "prepared", state: "none", aborts: [] });
    expect(bindings()).toEqual([{ b: "b1", state: "removal_parked" }, { b: "b2", state: "restored_unverified" }]);
  });
  it("H1 (real process death): killed before the install, recovery aborts (the home never changed) and alerts once", () => {
    live1();
    expect(child("swap-and-die", "before-install").signal).toBe("SIGKILL");
    const r = JSON.parse(child("recover").stdout);
    expect(r).toMatchObject({ action: "aborted", state: "aborted" }); expect(r.aborts).toHaveLength(1);
    expect(bindings()).toEqual([{ b: "b3", state: "active" }]);
  });
  it("H1 (real process death): killed before the prepare, a fresh process finishes the prepare exactly once", () => {
    live1();
    expect(child("swap-and-die", "before-prepare").signal).toBe("SIGKILL");
    expect(JSON.parse(child("recover").stdout)).toMatchObject({ action: "prepared", state: "none" });
    expect(liveMarks().map((m: any) => m.kind)).toEqual(["prepared", "swapped"]);
  });
  it("H1: a marks table that cannot be queried (the home opens, the query fails) is unreadable, not empty marks", () => {
    live1(); const s = make(); s.arm(ARM); s.capture();
    const db = new DatabaseSync(live); db.exec("CREATE TABLE restore_job_marks (x)"); db.close();
    expect(s.state()).toBe("unreadable"); expect(s.recover()).toEqual({ action: "unreadable" }); expect(aborts).toHaveLength(0);
  });
  it("H1: unreadable live marks with a blind carry (the outgoing home was already unreadable) still let a pre-install job abort", () => {
    writeFileSync(live, "garbage home"); mkArchive("arc1");
    const s = make(); s.arm(ARM); s.capture();
    expect(s.recover()).toEqual({ action: "aborted" });
  });
  it("H2: boot recovery that is stuck (unreadable journal, or a prepare that throws) is reported stuck, never thrown", () => {
    live1(); const s = make(); writeFileSync(journalFile(), "garbage");
    expect(s.recover()).toEqual({ action: "unreadable" });
    rmSync(journalFile()); const t = make({}, fx => ({ ...fx, prepare: () => { throw new Error("locked"); } })); t.arm(ARM); t.capture(); t.swap(ARM);
    expect(t.recover()).toEqual({ action: "stuck" });
    const index = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    // J4d3: the decision moved into runRestoreBootRecovery (restore-job.ts); index.ts calls it and spools restore.stuck. Pinned by text and by running it.
    expect(readFileSync(new URL("./restore-job.ts", import.meta.url), "utf8")).toMatch(/r\.action === "unreadable" \|\| r\.action === "stuck"/);
    expect(index).toMatch(/runRestoreBootRecovery\(restoreJobs, \(\) => noteRestoreStuck\(HOME_EVENTS_DIR, stuckFile, true\)/);
    expect(readFileSync(new URL("../home-events.ts", import.meta.url), "utf8")).toMatch(/reportHomeEvent\("restore\.stuck"/);
    const spooled: string[] = [];
    expect(runRestoreBootRecovery({ recover: () => ({ action: "unreadable" }) }, () => spooled.push("u"))).toEqual({ stuck: true });
    expect(runRestoreBootRecovery({ recover: () => ({ action: "stuck" }) }, () => spooled.push("s"))).toEqual({ stuck: true });
    expect(runRestoreBootRecovery({ recover: () => { throw new Error("x"); } }, () => spooled.push("t"), () => {})).toEqual({ stuck: true });
    expect(runRestoreBootRecovery({ recover: () => ({ action: "prepared" }) }, () => spooled.push("p"))).toEqual({ stuck: false });
    expect(spooled).toEqual(["u", "s", "t"]);
  });
});
