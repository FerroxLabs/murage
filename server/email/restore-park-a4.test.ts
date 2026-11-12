// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Restore park, batch A4: the reducer-parity leftovers of A3 (r3.4d spec reducer, server/email/exec-spec/restore/restore-reducer.ts): guard repair under a keep op claim (startGuardRestore line 156),
// the ops alert line of a guard restore (invariant opsLinesNameNoAddress), guards carried across a restore (restore carry line 373, keep_wins line 389, intents line 397).
// Claims are read and written as raw kv rows (`keepop:<inbox>`, `keepguard:<inbox>`) so the same file runs red on the A3 head.
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EmailRuntime } from "./runtime.ts";
import { prepareRestoredEmail } from "./restore.ts";
import { RemovalRefused } from "./binding-service.ts";
import { FakeFlux } from "../testing/fake-flux-email.ts";
import type { BotRecord } from "../store.ts";

const CAPS = { object: "email.capabilities", enabled: true, available: true, account_state: "active", terms_version: "v1", limits: {} };
let fake: FakeFlux;
let db: DatabaseSync;
let runtime: EmailRuntime;
let clock: number;
let logs: string[];

const make = () => new EmailRuntime({
  accountKey: () => "sk-flux-account-fixture", database: () => db, transaction: fn => fn(), fetch: fake.fetch, apiBase: "https://api.flux.test", appBase: "https://app.flux.test",
  now: () => clock, workspaceRoot: () => undefined, bot: id => ({ id, name: "Juniper", threadId: `t-${id}` } as unknown as BotRecord), deletionProof: () => true,
  log: (line: string) => { logs.push(line); },
});
const svc = () => runtime.services()!;
const restores = () => fake.calls("POST", /\/v1\/email\/inboxes\/ibx_1\/restore$/);
const deletes = () => fake.calls("DELETE", /\/v1\/email\/inboxes\//);
const binding = { botId: "b1", inboxId: "ibx_1", address: "juniper@murage.email", username: "juniper", displayName: "Juniper", emailKeyRef: "key_old", fluxAccountId: null, step: null, opId: "op1", opStartedAt: null, policy: "auto", failure: null, updatedAt: 1, revision: 1, closingUntil: null, createdAt: 1 };
const up = async (state = "active") => {
  runtime = make();
  runtime.secrets.setOwner({ token: "owner-fixture", keyId: "key_owner" });
  runtime.secrets.setBotKey("b1", { token: "bot-key", keyId: "key_old" });
  await runtime.probe.refresh();
  runtime.stop();
  svc().store.insertBinding({ ...binding, state } as never);
};
const kv = (scope: string, value: unknown) => db.prepare("INSERT OR REPLACE INTO email_event_cursor (scope, cursor, updated_at) VALUES (?,?,?)").run(scope, typeof value === "string" ? value : JSON.stringify(value), clock);
const kvHas = (scope: string) => Boolean(db.prepare("SELECT 1 FROM email_event_cursor WHERE scope=?").get(scope));
const guard = (pollUntil = clock + 3600_000) => kv("keepguard:ibx_1", { inboxId: "ibx_1", botId: "b1", keepOp: "keep:b1", keptAt: clock, pollUntil, lastCheckedAt: null });
const claim = () => kv("keepop:ibx_1", { keepOp: "kg-1", botId: "b1", inboxId: "ibx_1", authorityId: "keep:b1", claimedAt: clock });
const closing = (reason = "owner") => svc().bindings.applyLifecycle({ type: "email.inbox.closing", inbox_id: "ibx_1", data: { reason } });
const RESTORE_OK = { status: 200, body: { id: "ibx_1", state: "active" } };

beforeEach(() => { clock = 1_800_000_000_000; logs = []; fake = new FakeFlux(); db = new DatabaseSync(":memory:"); fake.always("GET", /^\/v1\/email\/capabilities$/, { status: 200, body: CAPS }); });
afterEach(() => runtime?.stop());

describe("restore park A4: guard repair runs through keepOps (reducer startGuardRestore line 156)", () => {
  it("A4-1: a guard repair is skipped while a keep op already holds the inbox", async () => {
    await up(); guard(); claim();
    fake.always("POST", /\/inboxes\/ibx_1\/restore$/, RESTORE_OK);
    await closing();
    expect(restores()).toHaveLength(0);
  });
  it("A4-2: a guard repair is skipped while a park or a removal holds the inbox (reducer line 158)", async () => {
    await up("removing"); guard();
    fake.always("POST", /\/inboxes\/ibx_1\/restore$/, RESTORE_OK);
    await closing();
    expect(restores()).toHaveLength(0);
  });
  it("A4-3: an unanswered RESTORE keeps its claim, the tick sends it again and then releases the claim", async () => {
    await up(); guard();
    fake.on("POST", /\/inboxes\/ibx_1\/restore$/, "reset");
    await closing();
    expect(restores()).toHaveLength(1);
    expect(kvHas("keepop:ibx_1")).toBe(true);
    await closing(); // the claim holds the inbox: no second RESTORE from the event
    expect(restores()).toHaveLength(1);
    fake.always("POST", /\/inboxes\/ibx_1\/restore$/, RESTORE_OK);
    await svc().bindings.pollKeepGuards();
    expect(restores()).toHaveLength(2);
    expect(kvHas("keepop:ibx_1")).toBe(false);
  });
  it("A4-4: an answered RESTORE releases the claim", async () => {
    await up(); guard();
    fake.always("POST", /\/inboxes\/ibx_1\/restore$/, RESTORE_OK);
    await closing();
    expect(restores()).toHaveLength(1);
    expect(kvHas("keepop:ibx_1")).toBe(false);
  });
  it("A4-5: the tick does not park a removing binding while a keep op holds its target (reducer line 125)", async () => {
    await up("removing"); claim();
    fake.always("POST", /\/inboxes\/ibx_1\/restore$/, "reset"); // Flux does not answer: the Keep op stays in flight through this tick
    await svc().bindings.resumeRemovals();
    expect(svc().store.getPark("b1")).toBeNull();
    expect(svc().store.getBinding("b1")?.state).toBe("removing");
    expect(deletes()).toHaveLength(0);
  });
  it("A4-6: the owner's Remove is refused keep_pending while a keep op holds the target (reducer line 225), 0 DELETEs", async () => {
    await up(); claim();
    await expect(svc().bindings.remove("b1")).rejects.toBeInstanceOf(RemovalRefused);
    await expect(svc().bindings.remove("b1")).rejects.toMatchObject({ code: "keep_pending" });
    expect(deletes()).toHaveLength(0);
  });
});

describe("restore park A4: the ops alert line of a guard restore (invariant opsLinesNameNoAddress, guard restore needs an ops alert)", () => {
  const BAD = /[–—]|\b(safe|unsafe|safety|free|forge)\b|will fail/i;
  const ops = () => logs.filter(l => l.startsWith("[email-ops]"));
  it("A4-7: one guard_restore line is written before the RESTORE is sent: binding id and inbox generation, no address, the window, wording rules", async () => {
    await up(); guard();
    let before = -1;
    fake.on("POST", /\/inboxes\/ibx_1\/restore$/, () => { before = ops().length; return RESTORE_OK; });
    await closing();
    expect(before).toBe(1);
    expect(ops()).toHaveLength(1);
    const line = ops()[0];
    expect(line).toContain("guard_restore");
    expect(line).toContain("bot=b1");
    expect(line).toContain("inbox=ibx_1");
    expect(line).toContain(`since=${clock}`);
    expect(line.toLowerCase()).not.toContain("juniper@murage.email");
    expect(line).not.toMatch(BAD);
  });
  it("A4-8: a refused guard restore writes a guard_refused line (wording rules) and releases the claim", async () => {
    await up(); guard();
    fake.on("POST", /\/inboxes\/ibx_1\/restore$/, { status: 409, body: { error: "inbox_not_closing", message: "x" } });
    await closing();
    expect(ops().map(l => l.split(" ")[1])).toEqual(["guard_restore", "guard_refused"]);
    expect(ops().join("\n")).not.toMatch(BAD);
    expect(kvHas("keepop:ibx_1")).toBe(false);
  });
  it("A4-9: a closing that is not guarded writes no ops line", async () => {
    await up(); guard();
    await closing("billing");
    expect(ops()).toHaveLength(0);
  });
});

describe("restore park A4: guards across a restore (restore carry line 373, keep_wins line 389, intents line 397)", () => {
  const prep = () => prepareRestoredEmail(db, clock);
  it("A4-10: the guard row survives the restore preparation, and the poll still works after it", async () => {
    await up(); guard();
    prep();
    expect(kvHas("keepguard:ibx_1")).toBe(true);
    expect(svc().store.getKeepGuard("ibx_1")).toMatchObject({ botId: "b1", pollUntil: clock + 3600_000 });
  });
  it("A4-11: a removing binding whose inbox holds a guard is not parked: the Keep wins", async () => {
    await up("removing"); guard();
    prep();
    expect(svc().store.getPark("b1")).toBeNull();
    expect(svc().store.getBinding("b1")?.state).toBe("restored_unverified");
  });
  it("A4-12: the same removing binding without a guard is parked, and a guarded removal_parked binding stays parked", async () => {
    await up("removing");
    prep();
    expect(svc().store.getPark("b1")).toMatchObject({ state: "parked" });
    db.prepare("DELETE FROM email_parks").run();
    db.prepare("UPDATE email_bindings SET state='removal_parked'").run();
    guard();
    prep();
    expect(svc().store.getPark("b1")).toMatchObject({ state: "parked" });
    expect(svc().store.getBinding("b1")?.state).toBe("removal_parked");
  });
  it("A4-13: a keep op claim does not survive the restore preparation (reducer line 400)", async () => {
    await up(); guard(); claim();
    prep();
    expect(kvHas("keepop:ibx_1")).toBe(false);
  });
});
