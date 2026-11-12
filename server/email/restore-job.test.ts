// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The restore JOB in the product, part 1 (J): arm, capture, abort, and the open window. Reference behaviour is the r3.4d J1 reducer
// (server/email/exec-spec/restore/restore-reducer.ts at d94e6adb8): W25 arm, restore_finishing, archive_not_local, W23 then W26, W29.
import { removeTempDirSync } from "../testing/cleanup.ts";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RESTORE_FAILED_LINE, RESTORE_FINISHING_LINE, RestoreJobStore, type RestoreJobOptions } from "./restore-job.ts";
import { writeFileAtomic } from "../atomic.ts";
import { EmailRuntime } from "./runtime.ts";
import { emailOwnerRoute, type OwnerRouteDeps } from "./owner-routes.ts";
import { FakeFlux } from "../testing/fake-flux-email.ts";
import { BackupCoordinator } from "../backup-coordinator.ts";
import type { BotRecord } from "../store.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "restore-job-")); });
afterEach(() => removeTempDirSync(dir));

let n = 0;
const make = (extra: Partial<RestoreJobOptions> = {}) => new RestoreJobStore({
  dir, now: () => 1_800_000_000_000, uid: p => `${p}-${++n}`, isLocalArchive: id => id === "arc-local",
  captureCarry: () => ({ bindings: [{ botId: "b1", inboxId: "ibx_1" }] }), ...extra,
});
const journal = () => JSON.parse(readFileSync(join(dir, "restore-job.json"), "utf8"));
const carry = () => JSON.parse(readFileSync(join(dir, "restore-carry.json"), "utf8"));
const writeJob = (phase: string) => writeFileSync(join(dir, "restore-job.json"), JSON.stringify({ version: 1, id: "job-x", archiveId: "arc-local", source: "local", phase, at: 1 }));
const ARM = { archiveId: "arc-local", source: "local" } as const;

describe("arm (W25)", () => {
  it("owner restore of a local archive arms a durable job", () => {
    const s = make();
    const r = s.arm(ARM);
    expect(r).toMatchObject({ ok: true });
    expect(journal()).toMatchObject({ phase: "armed", archiveId: "arc-local", source: "local" });
    expect(s.windowOpen()).toBe(true);
  });
  it("a second restore while the window is open is refused restore_finishing and changes nothing", () => {
    const s = make(); s.arm(ARM); const before = readFileSync(join(dir, "restore-job.json"), "utf8");
    expect(s.arm(ARM)).toEqual({ ok: false, code: "restore_finishing", line: RESTORE_FINISHING_LINE });
    expect(readFileSync(join(dir, "restore-job.json"), "utf8")).toBe(before);
    s.capture();
    expect(s.arm(ARM)).toMatchObject({ ok: false, code: "restore_finishing" });
  });
  for (const [phase, code] of [["prepared", "restore_finishing"], ["aborted", "restore_aborted"]] as const) {
    it(`a finished job not yet cleared (${phase}) also refuses arm with ${code} (S20; O2 gives the aborted one its own code)`, () => {
      writeJob(phase);
      expect(make().arm(ARM)).toMatchObject({ ok: false, code });
    });
  }
  it("a non-local archive is refused archive_not_local and arms nothing", () => {
    const s = make();
    expect(s.arm({ archiveId: "arc-remote", source: "remote" })).toMatchObject({ ok: false, code: "archive_not_local" });
    expect(s.read()).toBeNull();
    expect(s.windowOpen()).toBe(false);
  });
  it("crash right after arm: a fresh store at boot sees the armed job and the window", () => {
    make().arm(ARM);
    const boot = make();
    expect(boot.read()).toMatchObject({ phase: "armed", archiveId: "arc-local" });
    expect(boot.windowOpen()).toBe(true);
  });
  it("an unreadable journal fails closed: the window stays open", () => {
    writeFileSync(join(dir, "restore-job.json"), "{not json");
    expect(make().windowOpen()).toBe(true);
  });
});

describe("capture (W23 then W26) as its own step", () => {
  it("arm alone never writes a carry; capture writes the carry then moves the job to captured", () => {
    const s = make(); s.arm(ARM);
    expect(() => readFileSync(join(dir, "restore-carry.json"))).toThrow();
    expect(s.capture()).toMatchObject({ ok: true });
    expect(carry()).toMatchObject({ jobId: journal().id });
    expect(journal().phase).toBe("captured");
  });
  it("the carry is durable BEFORE the phase moves: a fault on the second write leaves armed with a carry, never captured without one", () => {
    const writes: string[] = [];
    let fail = false;
    const write: typeof writeFileAtomic = (p, d, o) => { writes.push(p.split("/").pop()!); if (fail && writes.length >= 3) throw new Error("crash"); writeFileAtomic(p, d, o); };
    const s = make({ write }); s.arm(ARM); fail = true;
    expect(() => s.capture()).toThrow("crash"); // the 3rd write overall (the phase) faults
    // writes: [job(arm), carry, job(capture)]; the third throws
    expect(writes).toEqual(["restore-job.json", "restore-carry.json", "restore-job.json"]);
    expect(journal().phase).toBe("armed");
    expect(carry().jobId).toBe(journal().id);
    const boot = make();
    expect(boot.windowOpen()).toBe(true);
    expect(boot.capture()).toMatchObject({ ok: true }); // re-capture after the crash finishes the step
    expect(journal().phase).toBe("captured");
  });
  it("capture only from armed: nothing armed, captured, aborted change nothing", () => {
    const s = make();
    expect(s.capture()).toMatchObject({ ok: false, code: "no_armed_job" });
    s.arm(ARM); s.capture();
    const before = readFileSync(join(dir, "restore-job.json"), "utf8");
    expect(s.capture()).toMatchObject({ ok: false });
    expect(readFileSync(join(dir, "restore-job.json"), "utf8")).toBe(before);
  });
});

describe("abort (W29) only from armed or captured", () => {
  for (const from of ["armed", "captured"]) {
    it(`abort from ${from} writes phase aborted and shows the failed line`, () => {
      const s = make(); s.arm(ARM); if (from === "captured") s.capture();
      expect(s.abort()).toMatchObject({ ok: true, line: RESTORE_FAILED_LINE });
      expect(journal().phase).toBe("aborted");
      expect(s.windowOpen()).toBe(false);
      expect(s.homeLine()).toBe(RESTORE_FAILED_LINE);
    });
  }
  for (const from of ["swapped", "prepared", "aborted"]) {
    it(`abort from ${from} is refused and changes nothing`, () => {
      writeJob(from);
      const before = readFileSync(join(dir, "restore-job.json"), "utf8");
      expect(make().abort()).toMatchObject({ ok: false });
      expect(readFileSync(join(dir, "restore-job.json"), "utf8")).toBe(before);
    });
  }
  it("abort with no job is refused", () => { expect(make().abort()).toMatchObject({ ok: false }); });
});

describe("the open window", () => {
  it("is open for armed, captured, swapped and closed for none, prepared, aborted", () => {
    expect(make().windowOpen()).toBe(false);
    for (const [phase, open] of [["armed", true], ["captured", true], ["swapped", true], ["prepared", false], ["aborted", false]] as const) {
      writeJob(phase); expect(make().windowOpen(), phase).toBe(open);
    }
  });
  it("shows the finishing line while open", () => { writeJob("captured"); expect(make().homeLine()).toBe(RESTORE_FINISHING_LINE); });

  it("refuses every owner email decision with restore_finishing, and still answers reads", async () => {
    const fake = new FakeFlux(); const db = new DatabaseSync(":memory:");
    fake.always("GET", /^\/v1\/email\/capabilities$/, { status: 200, body: { object: "email.capabilities", enabled: true, available: true, account_state: "active", terms_version: "v1", limits: {} } });
    const bot = { id: "b1", name: "Juniper", threadId: "t-b1" };
    const runtime = new EmailRuntime({ accountKey: () => "sk-x", database: () => db, transaction: fn => fn(), fetch: fake.fetch, apiBase: "https://api.flux.test", appBase: "https://app.flux.test", now: () => 1, workspaceRoot: () => undefined, bot: id => (id === "b1" ? bot as unknown as BotRecord : undefined) });
    runtime.secrets.setOwner({ token: "o", keyId: "k" });
    await runtime.probe.refresh();
    const s = make(); s.arm(ARM);
    const deps = (open: boolean): OwnerRouteDeps => ({ runtime, bot: id => (id === "b1" ? bot : undefined), fluxKeyPresent: () => true, freshProof: async () => null, ...(open ? { restoreWindow: () => s.windowOpen() } : {}) });
    const post = (d: OwnerRouteDeps, path: string) => emailOwnerRoute(d, { method: "POST", path, query: new URL(`http://x${path}`).searchParams, body: {}, surface: "desktop", botCredential: false });
    for (const path of ["/api/email/bots/b1/pause", "/api/email/bots/b1/remove", "/api/email/account"]) {
      const a = await post(deps(true), path);
      expect(a, path).toMatchObject({ status: 409, body: { code: "restore_finishing", error: RESTORE_FINISHING_LINE } });
    }
    const read = await emailOwnerRoute(deps(true), { method: "GET", path: "/api/email/status", query: new URLSearchParams(), body: undefined, surface: "desktop", botCredential: false });
    expect(read?.status).toBe(200);
    // window closed (aborted): the same decision is no longer refused for the window
    s.abort();
    const open = await post(deps(true), "/api/email/bots/b1/pause");
    expect((open?.body as Record<string, unknown>).code).not.toBe("restore_finishing");
    db.close();
  });

  it("refuses a manual backup with restore_finishing while open, and allows it after abort", () => {
    const s = make(); s.arm(ARM);
    const sd = join(dir, "bk"); mkdirSync(sd);
    const c = new BackupCoordinator({ stateDirectory: sd, now: () => Date.parse("2026-09-13T01:00:00Z"), restoreWindow: () => s.windowOpen() });
    expect(() => c.requestManual(0, "req-1")).toThrow("restore_finishing");
    s.abort();
    expect(() => c.requestManual(0, "req-1")).not.toThrow(/restore_finishing/);
  });
});

describe("the window goes through the RemovalGate", () => {
  it("authorize and deleteInbox are refused restore_finishing while open, and work again after abort", async () => {
    const fake = new FakeFlux(); const db = new DatabaseSync(":memory:"); const s = make(); s.arm(ARM);
    fake.always("GET", /^\/v1\/email\/capabilities$/, { status: 200, body: { object: "email.capabilities", enabled: true, available: true, account_state: "active", terms_version: "v1", limits: {} } });
    const runtime = new EmailRuntime({ accountKey: () => "sk-x", database: () => db, transaction: fn => fn(), fetch: fake.fetch, apiBase: "https://api.flux.test", appBase: "https://app.flux.test", now: () => 1, workspaceRoot: () => undefined, bot: id => ({ id, name: "J", threadId: "t" } as unknown as BotRecord), restoreWindow: () => s.windowOpen() });
    runtime.secrets.setOwner({ token: "o", keyId: "k" });
    await runtime.probe.refresh(); await runtime.start(); runtime.stop();
    const gate = runtime.services()!.bindings.gate;
    expect(gate.authorize({ kind: "owner", botId: "b1" })).toEqual({ kind: "gate_refused", code: "restore_finishing" });
    expect(await gate.deleteInbox({ kind: "foreign", inboxId: "ibx_9" }, null)).toEqual({ kind: "gate_refused", code: "restore_finishing" });
    s.abort();
    expect(gate.authorize({ kind: "owner", botId: "b1" })).toEqual({ kind: "gate_refused", code: "authority_gone" });
    db.close();
  });
});
