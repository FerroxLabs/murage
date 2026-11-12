// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The restore JOB in the product, part 2 (J2): swap (W27 then W3), prepare (W28), clear (W24 then W30), boot recovery, the scheduled-backup gate, and the real
// isLocalArchive / captureCarry. Reference: exec-spec/restore/restore-reducer.ts (restoreSwap, prepare, restoreJobClear, bootPrep.prep) at r34d-fix-job.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RESTORE_FAILED_LINE, RESTORE_FINISHING_LINE, RestoreJobStore, type RestoreJobEffects, type RestoreJobOptions } from "./restore-job.ts";
import { archiveIsLocal, captureEmailCarry, sqliteRestoreEffects } from "./restore-job-effects.ts";
import { BackupCoordinator } from "../backup-coordinator.ts";
import { EmailRuntime } from "./runtime.ts";
import { emailOwnerRoute, type OwnerRouteDeps } from "./owner-routes.ts";
import { FakeFlux } from "../testing/fake-flux-email.ts";
import type { BotRecord } from "../store.ts";

let dir: string, live: string, archives: string;
let n = 0;
beforeEach(() => { n = 0; dir = mkdtempSync(join(tmpdir(), "restore-j2-")); live = join(dir, "messages.db"); archives = join(dir, "archives"); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const BIND = "CREATE TABLE email_bindings (bot_id TEXT PRIMARY KEY, inbox_id TEXT, address TEXT, email_key_ref TEXT, op_id TEXT, state TEXT, step TEXT, revision INTEGER DEFAULT 0)";
const mkdb = (path: string, rows: Array<[string, string, string]>) => {
  mkdirSync(join(path, ".."), { recursive: true }); rmSync(path, { force: true });
  const db = new DatabaseSync(path); db.exec(BIND);
  for (const [bot, inbox, state] of rows) db.prepare("INSERT INTO email_bindings (bot_id, inbox_id, address, email_key_ref, op_id, state) VALUES (?,?,?,?,?,?)").run(bot, inbox, `${bot}@x.test`, `key_${bot}`, `op_${bot}`, state);
  db.close();
};
const mkArchive = (id: string) => mkdb(join(archives, id, "messages.db"), [["b1", "ibx_1", "removing"], ["b2", "ibx_2", "active"]]);
const rows = (path = live) => { const db = new DatabaseSync(path, { readOnly: true }); try { return db.prepare("SELECT bot_id AS b, state FROM email_bindings ORDER BY bot_id").all() as Array<{ b: string; state: string }>; } finally { db.close(); } };
const parks = () => { const db = new DatabaseSync(live, { readOnly: true }); try { return db.prepare("SELECT bot_id AS b, park_id AS p FROM email_parks ORDER BY bot_id").all() as Array<{ b: string; p: string }>; } finally { db.close(); } };
const marks = () => { const db = new DatabaseSync(live, { readOnly: true }); try { return db.prepare("SELECT kind, job_id AS j FROM restore_job_marks ORDER BY kind").all(); } finally { db.close(); } };
const journal = () => JSON.parse(readFileSync(join(dir, "restore-job.json"), "utf8"));
const ARM = { archiveId: "arc1", source: "local" } as const;
const make = (extra: Partial<RestoreJobOptions> = {}, wrap?: (fx: RestoreJobEffects) => RestoreJobEffects) => {
  const fx = sqliteRestoreEffects({ liveDb: live, archivesDir: archives, now: () => 1_800_000_000_000 });
  return new RestoreJobStore({ dir, now: () => 1_800_000_000_000, uid: p => `${p}-${++n}`, isLocalArchive: id => archiveIsLocal(archives, id), captureCarry: () => captureEmailCarry(live), effects: wrap ? wrap(fx) : fx, ...extra });
};
/** An armed + captured job on a live install holding b3. */
const captured = (wrap?: (fx: RestoreJobEffects) => RestoreJobEffects) => { mkdb(live, [["b3", "ibx_3", "active"]]); mkArchive("arc1"); const s = make({}, wrap); s.arm(ARM); s.capture(); return s; };
const CRASH = new Error("CRASH");

describe("swap (W27 then W3)", () => {
  it("stages the archive database with the swapped mark, then puts it in place; the carry of the outgoing install stays", () => {
    const s = captured();
    expect(s.swap(ARM)).toMatchObject({ ok: true, job: { phase: "swapped" } });
    expect(rows()).toEqual([{ b: "b1", state: "removing" }, { b: "b2", state: "active" }]);
    expect(marks()).toEqual([{ kind: "swapped", j: "job-1" }]);
    expect(s.windowOpen()).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "restore-carry.json"), "utf8"))).toMatchObject({ jobId: "job-1", bindings: [{ botId: "b3" }] });
  });
  it("a crash after staging and before the install leaves the live home unchanged, the job captured and the window open; swapping again finishes it", () => {
    let boom = true;
    const s = captured(fx => ({ ...fx, install: j => { if (boom) throw CRASH; fx.install(j); } }));
    expect(() => s.swap(ARM)).toThrow("CRASH");
    expect(rows()).toEqual([{ b: "b3", state: "active" }]);
    expect(existsSync(`${live}.restore-job-1`)).toBe(true);
    expect(journal().phase).toBe("captured");
    expect(s.windowOpen()).toBe(true);
    boom = false;
    expect(s.swap(ARM)).toMatchObject({ ok: true });
    expect(rows().map(r => r.b)).toEqual(["b1", "b2"]);
  });
  it("a crash after the install but before swap returns reads as swapped from the mark alone, and the window stays open", () => {
    const s = captured();
    s.swap(ARM);
    const again = make();
    expect(again.windowOpen()).toBe(true);
    expect(again.homeLine()).toBe(RESTORE_FINISHING_LINE);
    expect(again.abort()).toMatchObject({ ok: false, code: "not_abortable" });
  });
  it("is refused from armed (not blind), for another archive, and when the archive is not local", () => {
    mkdb(live, [["b3", "ibx_3", "active"]]); mkArchive("arc1");
    const s = make(); s.arm(ARM);
    expect(s.swap(ARM)).toMatchObject({ ok: false, code: "not_swappable" });
    s.capture();
    expect(s.swap({ archiveId: "arc2", source: "local" })).toMatchObject({ ok: false, code: "not_swappable" });
    rmSync(join(archives, "arc1"), { recursive: true });
    expect(s.swap(ARM)).toMatchObject({ ok: false, code: "archive_not_local" });
    expect(rows()).toEqual([{ b: "b3", state: "active" }]);
  });
  it("a blind swap (the outgoing database is unreadable) is allowed from armed and marks the job blind", () => {
    writeFileSync(live, "not a database"); mkArchive("arc1");
    const s = make(); s.arm(ARM);
    expect(s.swap({ ...ARM, blind: true })).toMatchObject({ ok: true });
    expect(marks()).toEqual([{ kind: "blind", j: "job-1" }, { kind: "swapped", j: "job-1" }]);
  });
});

describe("prepare (W28)", () => {
  it("parks the removal in flight, moves the rest to restored_unverified and writes the prepared mark in the same transaction; the window closes, the job stays until cleared", () => {
    const s = captured(); s.swap(ARM);
    expect(s.prepare()).toMatchObject({ ok: true, job: { phase: "prepared" } });
    expect(rows()).toEqual([{ b: "b1", state: "removal_parked" }, { b: "b2", state: "restored_unverified" }]);
    expect(parks().map(p => p.b)).toEqual(["b1"]);
    expect(marks()).toContainEqual({ kind: "prepared", j: "job-1" });
    expect(s.windowOpen()).toBe(false);
    expect(s.arm(ARM)).toMatchObject({ ok: false, code: "restore_finishing" }); // S20
  });
  it("the preparation and the mark are ONE transaction: a failure writing the mark rolls the preparation back", () => {
    const s = captured(); s.swap(ARM);
    const db = new DatabaseSync(live);
    db.exec("CREATE TRIGGER no_prepared BEFORE INSERT ON restore_job_marks WHEN NEW.kind='prepared' BEGIN SELECT RAISE(ABORT,'cut'); END");
    db.close();
    expect(() => s.prepare()).toThrow();
    expect(rows()).toEqual([{ b: "b1", state: "removing" }, { b: "b2", state: "active" }]);
    expect(s.windowOpen()).toBe(true);
  });
  it("a crash after the commit is finished by preparing again without re-parking (the park id does not change)", () => {
    let boom = true;
    const s = captured(fx => ({ ...fx, prepare: j => { fx.prepare(j); if (boom) throw CRASH; } }));
    s.swap(ARM);
    expect(() => s.prepare()).toThrow("CRASH");
    const before = parks();
    boom = false;
    const again = make();
    expect(again.windowOpen()).toBe(false);
    expect(again.prepare()).toMatchObject({ ok: false, code: "not_preparable" });
    expect(parks()).toEqual(before);
  });
  it("a crash before the preparation leaves swapped and preparing again finishes it", () => {
    let boom = true;
    const s = captured(fx => ({ ...fx, prepare: j => { if (boom) throw CRASH; fx.prepare(j); } }));
    s.swap(ARM);
    expect(() => s.prepare()).toThrow("CRASH");
    expect(s.windowOpen()).toBe(true);
    boom = false;
    expect(s.prepare()).toMatchObject({ ok: true });
  });
  it("is refused unless the job is swapped", () => {
    const s = captured();
    expect(s.prepare()).toMatchObject({ ok: false, code: "not_preparable" });
    expect(make({ dir: join(dir, "none") }).prepare()).toMatchObject({ ok: false, code: "not_preparable" });
  });
  it("a blind restore makes the inventory check durable before the prepared mark; confirming removes it and it never comes back", () => {
    writeFileSync(live, "not a database"); mkArchive("arc1");
    const s = make(); s.arm(ARM); s.swap({ ...ARM, blind: true });
    expect(s.checkPending()).toBe(false);
    s.prepare();
    expect(existsSync(join(dir, "restore-check.json"))).toBe(true);
    expect(s.checkPending()).toBe(true);
    expect(make().confirmCheck()).toBe(true);
    expect(s.checkPending()).toBe(false);
    expect(s.confirmCheck()).toBe(false);
  });
  it("a restore that was not blind has no inventory check", () => {
    const s = captured(); s.swap(ARM); s.prepare();
    expect(s.checkPending()).toBe(false);
  });
});

describe("effects edge cases", () => {
  const job = { version: 1 as const, id: "job-1", archiveId: "arc1", source: "local", phase: "captured" as const, at: 1 };
  it("a crash after the prepare committed still leaves the blind inventory check durable (it is written first)", () => {
    writeFileSync(live, "not a database"); mkArchive("arc1");
    let boom = true;
    const s = make({}, fx => ({ ...fx, prepare: j => { fx.prepare(j); if (boom) throw CRASH; } }));
    s.arm(ARM); s.swap({ ...ARM, blind: true });
    expect(() => s.prepare()).toThrow("CRASH");
    boom = false;
    expect(make().checkPending()).toBe(true);
  });
  it("the inventory check is not pending while the window is still open", () => {
    writeFileSync(live, "not a database"); mkArchive("arc1");
    const s = make({}, fx => ({ ...fx, prepare: () => { throw CRASH; } }));
    s.arm(ARM); s.swap({ ...ARM, blind: true });
    expect(() => s.prepare()).toThrow("CRASH");
    expect(existsSync(join(dir, "restore-check.json"))).toBe(true);
    expect(s.windowOpen()).toBe(true);
    expect(s.checkPending()).toBe(false);
  });
  it("preparing an already prepared database does not re-key its parks", () => {
    const s = captured(); s.swap(ARM); s.prepare();
    const before = parks();
    sqliteRestoreEffects({ liveDb: live, archivesDir: archives }).prepare(job);
    expect(parks()).toEqual(before);
  });
  it("a stale WAL of the outgoing database does not follow the swap", () => {
    const s = captured();
    writeFileSync(`${live}-wal`, "stale"); writeFileSync(`${live}-shm`, "stale");
    s.swap(ARM);
    expect(existsSync(`${live}-wal`)).toBe(false);
    expect(existsSync(`${live}-shm`)).toBe(false);
  });
  it("install with neither a staged database nor a mark in place fails instead of pretending", () => {
    mkdb(live, []);
    expect(() => sqliteRestoreEffects({ liveDb: live, archivesDir: archives }).install(job)).toThrow("RESTORE_STAGED_MISSING");
  });
  it("an id that climbs out of the archives directory is not a local archive even when a database is there", () => {
    mkdb(join(dir, "evil", "messages.db"), []);
    expect(archiveIsLocal(archives, "../evil")).toBe(false);
  });
});

describe("clear (W24 then W30)", () => {
  it("removes the carry first, then the journal; the next restore can arm", () => {
    const s = captured(); s.swap(ARM); s.prepare();
    expect(s.clear()).toMatchObject({ ok: true });
    expect(existsSync(join(dir, "restore-carry.json"))).toBe(false);
    expect(existsSync(join(dir, "restore-job.json"))).toBe(false);
    expect(make().arm(ARM)).toMatchObject({ ok: true });
  });
  it("a crash between the two removals leaves the finished job; clearing again ends it", () => {
    let calls = 0;
    const s = captured(); s.swap(ARM); s.prepare();
    const cut = make({ remove: p => { if (++calls === 2) throw CRASH; rmSync(p, { force: true }); } });
    expect(() => cut.clear()).toThrow("CRASH");
    expect(existsSync(join(dir, "restore-carry.json"))).toBe(false);
    expect(existsSync(join(dir, "restore-job.json"))).toBe(true);
    expect(make().clear()).toMatchObject({ ok: true });
    expect(existsSync(join(dir, "restore-job.json"))).toBe(false);
  });
  it("clears an aborted job and removes its failed line; refuses armed, captured and swapped", () => {
    const s = captured();
    expect(s.clear()).toMatchObject({ ok: false, code: "not_clearable" });
    s.abort();
    expect(s.homeLine()).toBe(RESTORE_FAILED_LINE);
    expect(s.clear()).toMatchObject({ ok: true });
    expect(s.homeLine()).toBeNull();
    const t = captured(); t.swap(ARM);
    expect(t.clear()).toMatchObject({ ok: false, code: "not_clearable" });
  });
});

describe("boot recovery", () => {
  it("captured: the swap never happened, so the job is aborted with the failed line and the live home is untouched", () => {
    captured();
    const r = make().recover();
    expect(r).toEqual({ action: "aborted" });
    expect(journal().phase).toBe("aborted");
    expect(rows()).toEqual([{ b: "b3", state: "active" }]);
  });
  it("swapped: the owed preparation runs, the window closes and the finished job is cleared", () => {
    const s = captured(); s.swap(ARM);
    expect(make().recover()).toEqual({ action: "prepared" });
    expect(rows()).toEqual([{ b: "b1", state: "removal_parked" }, { b: "b2", state: "restored_unverified" }]);
    expect(existsSync(join(dir, "restore-job.json"))).toBe(false);
  });
  it("prepared and not cleared (a crash before W30): cleared", () => {
    const s = captured(); s.swap(ARM); s.prepare();
    expect(make().recover()).toEqual({ action: "cleared" });
    expect(existsSync(join(dir, "restore-job.json"))).toBe(false);
  });
  it("a crash inside recovery is finished by recovering again (idempotent)", () => {
    const s = captured(); s.swap(ARM);
    let boom = true;
    // H2: a prepare that throws inside recovery is reported stuck (the index raises the ops alert), never thrown out of boot
    expect(make({}, fx => ({ ...fx, prepare: j => { fx.prepare(j); if (boom) throw CRASH; } })).recover()).toEqual({ action: "stuck" });
    boom = false;
    const before = parks();
    expect(make().recover()).toMatchObject({ action: expect.stringMatching(/cleared|prepared/) });
    expect(parks()).toEqual(before);
    expect(existsSync(join(dir, "restore-job.json"))).toBe(false);
  });
  it("no job: nothing; aborted: stays for the owner; an unreadable journal stays closed", () => {
    expect(make().recover()).toEqual({ action: "none" });
    const s = captured(); s.abort();
    expect(make().recover()).toEqual({ action: "none" });
    expect(existsSync(join(dir, "restore-job.json"))).toBe(true);
    writeFileSync(join(dir, "restore-job.json"), "{broken");
    expect(make().recover()).toEqual({ action: "unreadable" });
    expect(make().windowOpen()).toBe(true);
  });
  it("marks that cannot be read fail closed (window open)", () => {
    const s = captured();
    const bad = make({}, fx => ({ ...fx, marks: () => { throw new Error("db"); } }));
    expect(bad.windowOpen()).toBe(true);
    expect(s.windowOpen()).toBe(true);
  });
});

describe("real isLocalArchive and captureCarry", () => {
  it("only a regular archive file on this computer is local; links and odd ids are not", () => {
    mkArchive("arc1");
    expect(archiveIsLocal(archives, "arc1")).toBe(true);
    expect(archiveIsLocal(archives, "nope")).toBe(false);
    expect(archiveIsLocal(archives, "../arc1")).toBe(false);
    expect(archiveIsLocal(archives, "")).toBe(false);
    mkdirSync(join(archives, "lnk"), { recursive: true });
    symlinkSync(join(archives, "arc1", "messages.db"), join(archives, "lnk", "messages.db"));
    expect(archiveIsLocal(archives, "lnk")).toBe(false);
  });
  it("captures the outgoing email rows, and an unreadable database as blind", () => {
    mkdb(live, [["b3", "ibx_3", "removing"], ["b4", "ibx_4", "active"]]);
    expect(captureEmailCarry(live)).toMatchObject({ blind: false, removals: ["b3"], bindings: [{ botId: "b3", inboxId: "ibx_3" }, { botId: "b4" }] });
    writeFileSync(live, "junk");
    expect(captureEmailCarry(live)).toEqual({ blind: true });
    rmSync(live);
    expect(captureEmailCarry(live)).toEqual({ blind: true });
  });
  it("arm refuses an archive that is not on this computer with the real check", () => {
    mkdb(live, []);
    expect(make().arm({ archiveId: "gone", source: "local" })).toMatchObject({ ok: false, code: "archive_not_local" });
  });
});

describe("scheduled backups are gated during the restore window", () => {
  const choices = { enabled: true, installationRef: "installation-one", destinationRef: "destination-one", recoveryRef: "recovery-one", timezone: "Asia/Bangkok", time: "09:00", catchupMs: 3 * 86400000, maxBytes: 100000, maxDurationMs: 1000, selection: { scope: "application-data" as const, credentialPolicy: "preserve-in-encrypted-fidelity" as const }, preUpgrade: false };
  it("a due daily tick creates no job and starts no capture while the window is open, and runs once it closes", async () => {
    let open = true;
    const sd = join(dir, "backup-state"); mkdirSync(sd, { recursive: true });
    let nowMs = Date.parse("2026-09-13T01:00:00Z");
    const c = new BackupCoordinator({ stateDirectory: sd, now: () => nowMs, restoreWindow: () => open });
    c.configure(0, choices);
    nowMs = Date.parse("2026-09-13T03:00:00Z");
    expect((await c.tick()).job).toBeUndefined();
    open = false;
    expect((await c.tick()).job).toBeDefined();
  });
});

describe("confirm_inventory is ready after a real blind restore (park-int step 5)", () => {
  const build = () => {
    const fake = new FakeFlux(); const db = new DatabaseSync(":memory:");
    fake.always("GET", /^\/v1\/email\/capabilities$/, { status: 200, body: { object: "email.capabilities", enabled: true, available: true, account_state: "active", terms_version: "v1", limits: {} } });
    return new EmailRuntime({ accountKey: () => "sk-x", database: () => db, transaction: fn => fn(), fetch: fake.fetch, apiBase: "https://api.flux.test", appBase: "https://app.flux.test", now: () => 1, workspaceRoot: () => undefined, bot: () => undefined as unknown as BotRecord });
  };
  const call = (d: OwnerRouteDeps, method: string, path: string) => emailOwnerRoute(d, { method, path, query: new URL(`http://x${path}`).searchParams, body: {}, surface: "desktop", botCredential: false });
  it("refuses restore_not_ready with nothing pending, answers 200 with the check pending, and removes the check", async () => {
    const runtime = build(); runtime.secrets.setOwner({ token: "o", keyId: "k" }); await runtime.probe.refresh();
    writeFileSync(live, "not a database"); mkArchive("arc1");
    const s = make(); s.arm(ARM); s.swap({ ...ARM, blind: true });
    const deps: OwnerRouteDeps = { runtime, bot: () => undefined, fluxKeyPresent: () => true, freshProof: async () => null, restoreWindow: () => s.windowOpen(), restoreCheck: () => s.checkPending(), confirmRestoreCheck: () => s.confirmCheck() };
    const path = "/api/email/restore/confirm-inventory";
    expect(await call(deps, "POST", path)).toMatchObject({ status: 409, body: { code: "restore_finishing" } }); // swapped: still in the window
    s.prepare();
    const rows = async () => ((await call(deps, "GET", "/api/email/status"))!.body as { rows: Array<{ section: string }> }).rows;
    expect((await rows()).some(r => r.section === "restore_check")).toBe(true);
    expect(await call(deps, "POST", path)).toMatchObject({ status: 200 });
    expect((await rows()).some(r => r.section === "restore_check")).toBe(false);
    expect(await call(deps, "POST", path)).toMatchObject({ status: 409, body: { code: "restore_not_ready" } });
  });
});
