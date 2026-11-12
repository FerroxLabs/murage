// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Restore park, batch A (server core), r3.1 test plan: T1 T2 T3 T4a-c T5 T6 T8 T9 T10a-c T15 T17 T21 T22 T24 T28 T29. Every one of these fails on fad83e823 (no park table, no gate,
// binding-state Keep). Names carry the plan ids.
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EmailRuntime } from "./runtime.ts";
import { prepareRestoredEmail } from "./restore.ts";
import { isGateRefusal } from "./removal-gate.ts";
import { FakeFlux, fluxError } from "../testing/fake-flux-email.ts";
import type { BotRecord } from "../store.ts";

const CAPS = { object: "email.capabilities", enabled: true, available: true, account_state: "active", terms_version: "v1", limits: {} };
let fake: FakeFlux;
let db: DatabaseSync;
let runtime: EmailRuntime;
let clock: number;

const make = () => new EmailRuntime({
  accountKey: () => "sk-flux-account-fixture", database: () => db, transaction: fn => fn(), fetch: fake.fetch, apiBase: "https://api.flux.test", appBase: "https://app.flux.test",
  now: () => clock, workspaceRoot: () => undefined, bot: id => ({ id, name: "Juniper", threadId: `t-${id}` } as unknown as BotRecord), deletionProof: () => true,
});
const boot = async () => {
  runtime = make();
  runtime.secrets.setOwner({ token: "owner-fixture", keyId: "key_owner" });
  runtime.secrets.setBotKey("b1", { token: "bot-key", keyId: "key_old" });
  await runtime.probe.refresh();
  await runtime.start();
  runtime.stop();
};
const svc = () => runtime.services()!;
const deletes = () => fake.calls("DELETE", /\/v1\/email\/inboxes\//);
const binding = { botId: "b1", inboxId: "ibx_1", address: "juniper@murage.email", username: "juniper", displayName: "Juniper", emailKeyRef: "key_old", fluxAccountId: null, step: null, opId: "op1", opStartedAt: null, policy: "auto", failure: null, updatedAt: 0 };
const intent = (committed: boolean) => svc().store.upsertTombstone({ botId: "b1", inboxId: "ibx_1", addressHash: null, state: "removing", committed, reason: "bot_deleted", keyId: null, createdAt: clock, removedAt: null, nextTryAt: null });
/** The backup: a binding in `state`, and optionally a bot-deletion intent; then the restore preparation, before any runtime start. */
const restored = async (state: string, withIntent: "none" | "committed" | "uncommitted" = "none") => {
  runtime = make();
  runtime.secrets.setOwner({ token: "owner-fixture", keyId: "key_owner" });
  await runtime.probe.refresh();
  runtime.stop();
  svc().store.insertBinding({ ...binding, state } as never);
  if (withIntent !== "none") intent(withIntent === "committed");
  prepareRestoredEmail(db);
};
const gateOpen = () => { let open!: () => void; const gate = new Promise<void>(resolve => { open = resolve; }); return { gate, open }; };

beforeEach(() => { clock = 1_800_000_000_000; fake = new FakeFlux(); db = new DatabaseSync(":memory:"); fake.always("GET", /^\/v1\/email\/capabilities$/, { status: 200, body: CAPS }); });
afterEach(() => runtime?.stop());

describe("restore park A: preparation and boot (T1 T2 T17 T21)", () => {
  it("T1: a committed intent on an active binding is parked by the restore; boot, reap and three ticks make 0 DELETEs and 0 revokes", async () => {
    await restored("active", "committed");
    await boot();
    for (let i = 0; i < 3; i += 1) { await svc().bindings.reap(); await svc().bindings.resumeRemovals(); }
    expect(deletes()).toHaveLength(0);
    expect(fake.calls("DELETE", /bot-keys/)).toHaveLength(0);
    expect(svc().store.getBinding("b1")?.state).toBe("removal_parked");
    expect(svc().store.getPark("b1")).toMatchObject({ state: "parked", inboxId: "ibx_1", keyId: "key_old", parkRev: 0 });
  });

  it("T2: an uncommitted intent with the bot absent and proof stays untouched for a parked bot: park parked, 0 DELETEs", async () => {
    await restored("active", "uncommitted");
    await boot();
    svc().bindings.settleDeletionIntents(() => false, () => true);
    await svc().bindings.reap();
    expect(svc().store.getTombstone("b1", "ibx_1")).toMatchObject({ committed: false, state: "removing" });
    expect(svc().store.getPark("b1")?.state).toBe("parked");
    expect(deletes()).toHaveLength(0);
    svc().bindings.settleDeletionIntents(() => true, () => false); // the bot is present: still kept (Decision 5 NO)
    expect(svc().store.getTombstone("b1", "ibx_1")).not.toBeNull();
  });

  it("T17: parks in each of the four states restore as parked with a new park_id, park_rev 0, keep and authorization cleared, remote_deleted_at kept", async () => {
    await restored("removal_parked");
    const store = svc().store;
    for (const state of ["parked", "keep_pending", "remove_authorized", "key_release"] as const) {
      const before = store.getPark("b1")!;
      db.exec("DROP TRIGGER IF EXISTS temp.email_parks_no_insert");
      store.casPark("b1", before.parkRev, { state, keepOp: "k", keepCovers: [{ inboxId: "ibx_1", revision: 1 }], keepFailure: "x", authorizedBy: "orphan", authorizedAt: 5, remoteDeletedAt: 77 });
      prepareRestoredEmail(db);
      const after = store.getPark("b1")!;
      expect(after).toMatchObject({ state: "parked", parkRev: 0, keepOp: null, keepCovers: null, keepFailure: null, authorizedBy: null, authorizedAt: null, remoteDeletedAt: 77 });
      expect(after.parkId).not.toBe(before.parkId);
    }
  });

  it("T21: a fad83e823 data dir (removal_parked binding, no park row) adopts a park at store start; reaper and events make 0 DELETEs", async () => {
    runtime = make();
    runtime.secrets.setOwner({ token: "owner-fixture", keyId: "key_owner" });
    await runtime.probe.refresh();
    runtime.stop();
    svc().store.insertBinding({ ...binding, state: "removal_parked", step: "restored" } as never);
    db.exec("DELETE FROM email_parks");
    await boot();
    expect(svc().store.getPark("b1")).toMatchObject({ state: "parked", inboxId: "ibx_1" });
    await svc().bindings.reap();
    await svc().bindings.applyLifecycle({ type: "email.inbox.closing", inbox_id: "ibx_1", data: {} });
    expect(deletes()).toHaveLength(0);
  });
});

describe("restore park A: the gate (T3 T28)", () => {
  it("T3: a stale intent snapshot is refused by authorize, and a parked bot is refused for every authority but its own", async () => {
    await restored("active", "committed");
    await boot();
    const gate = svc().bindings.gate;
    const tomb = svc().store.getTombstone("b1", "ibx_1")!;
    expect(gate.authorize({ kind: "intent", botId: "b1", inboxId: "ibx_1", intentRev: tomb.revision })).toMatchObject({ kind: "gate_refused", code: "removal_parked" });
    expect(gate.authorize({ kind: "intent", botId: "b1", inboxId: "ibx_1", intentRev: tomb.revision + 9 })).toMatchObject({ kind: "gate_refused" });
    expect(gate.authorize({ kind: "owner", botId: "b1" })).toMatchObject({ kind: "gate_refused", code: "removal_parked" });
    expect(await gate.deleteInbox({ kind: "foreign", inboxId: "ibx_1" }, null)).toMatchObject({ kind: "gate_refused" });
    expect(await gate.revokeKey({ kind: "owner", botId: "b1", gen: { inboxId: "ibx_1", opId: "op1", keyRef: "key_old" } }, "key_old")).toMatchObject({ kind: "gate_refused" });
    expect(deletes()).toHaveLength(0);
    expect(fake.calls("DELETE", /bot-keys/)).toHaveLength(0);
  });

  it("T28: any park INSERT through the runtime connection after start aborts with park_insert_at_runtime", async () => {
    await boot();
    expect(() => db.prepare("INSERT INTO email_parks (bot_id, park_id, park_rev, state, parked_at) VALUES ('x','p',0,'parked',1)").run()).toThrow(/park_insert_at_runtime/);
  });
});

describe("restore park A: durable Keep, closing-window Keep, remote deleted (T5 T8 T9 T10 T15 T24)", () => {
  const closing = () => fake.on("GET", /\/inboxes\/ibx_1$/, { status: 200, body: { id: "ibx_1", state: "closing" } }).on("POST", /\/inboxes\/ibx_1\/restore$/, { status: 200, body: { id: "ibx_1", state: "active" } });

  it("T5: a Keep claimed and never answered survives a restart: boot re-sends GET and restore and ends restored_unverified", async () => {
    await restored("removing");
    await boot();
    const park = svc().store.getPark("b1")!;
    svc().store.casPark("b1", park.parkRev, { state: "keep_pending", keepOp: "op-k", keepCovers: [] }); // crashed after the claim, before any answer
    closing();
    await boot();
    expect(svc().store.getPark("b1")).toBeNull();
    expect(svc().store.getBinding("b1")).toMatchObject({ state: "restored_unverified", step: "restored" });
    expect(fake.calls("POST", /\/restore$/)).toHaveLength(1);
    expect(deletes()).toHaveLength(0);
  });

  it("T8: a deleted event on a parked inbox only records evidence; Keep answers inbox_gone with 0 Flux calls", async () => {
    await restored("removing");
    await boot();
    await svc().bindings.applyLifecycle({ type: "email.inbox.deleted", inbox_id: "ibx_1" });
    expect(svc().store.getPark("b1")).toMatchObject({ state: "parked_evidence", remoteDeletedAt: clock });
    expect(await svc().bindings.keep("b1")).toMatchObject({ ok: false, code: "inbox_gone", status: 409 });
    expect(fake.calls("GET", /\/inboxes\/ibx_1$/)).toHaveLength(0);
    expect(deletes()).toHaveLength(0);
    expect(fake.calls("DELETE", /bot-keys/)).toHaveLength(0);
  });

  it("T9: GET answers deleted: Keep is inbox_gone, no restore is sent, the evidence is written", async () => {
    await restored("removing");
    await boot();
    fake.on("GET", /\/inboxes\/ibx_1$/, { status: 200, body: { id: "ibx_1", state: "deleted" } });
    expect(await svc().bindings.keep("b1")).toMatchObject({ ok: false, code: "inbox_gone" });
    expect(fake.calls("POST", /\/restore$/)).toHaveLength(0);
    expect(svc().store.getPark("b1")).toMatchObject({ state: "parked_evidence", remoteDeletedAt: clock, keepOp: null });
  });

  it("T10a: an owner Remove that completed (404): Keep is inbox_gone with 0 restores", async () => {
    await restored("removing");
    await boot();
    fake.on("DELETE", /\/inboxes\/ibx_1$/, fluxError(404, "inbox_not_found")).on("DELETE", /bot-keys\/key_old$/, { status: 204 });
    await svc().bindings.remove("b1");
    expect(svc().store.getPark("b1")).toBeNull();
    expect(await svc().bindings.keep("b1")).toMatchObject({ ok: false, code: "inbox_gone", status: 409 });
    expect(fake.calls("POST", /\/restore$/)).toHaveLength(0);
  });

  it("T10b: Remove on a parked binding answers 202 (closing): Keep claims from remove_authorized, sends 1 restore, ends restored_unverified with step restored", async () => {
    await restored("removing");
    await boot();
    fake.on("DELETE", /\/inboxes\/ibx_1$/, { status: 202, body: { state: "closing", closing_until: "2026-12-01T00:00:00Z" } });
    await svc().bindings.remove("b1");
    expect(svc().store.getPark("b1")).toMatchObject({ state: "remove_authorized", authorizedBy: "bot_section" });
    closing();
    expect(await svc().bindings.keep("b1")).toMatchObject({ ok: true, row: { state: "restored_unverified", step: "restored" } });
    expect(fake.calls("POST", /\/restore$/)).toHaveLength(1);
    expect(svc().store.getPark("b1")).toBeNull();
  });

  it("T10c: Remove on a parked binding with the DELETE held: Keep answers removal_sending; after the release Keep works", async () => {
    await restored("removing");
    await boot();
    const { gate, open } = gateOpen();
    fake.on("DELETE", /\/inboxes\/ibx_1$/, async () => { await gate; return { status: 202, body: { state: "closing" } }; });
    const removing = svc().bindings.remove("b1");
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(await svc().bindings.keep("b1")).toMatchObject({ ok: false, code: "removal_sending", status: 409 });
    open();
    await removing;
    closing();
    expect(await svc().bindings.keep("b1")).toMatchObject({ ok: true, row: { state: "restored_unverified" } });
  });

  it("T15: while Keep is pending, Remove leaves 0 DELETEs and answers keep_pending; the authorize refuses it too", async () => {
    await restored("removing");
    await boot();
    const { gate, open } = gateOpen();
    fake.on("GET", /\/inboxes\/ibx_1$/, async () => { await gate; return { status: 200, body: { id: "ibx_1", state: "active" } }; });
    const kept = svc().bindings.keep("b1");
    await new Promise(resolve => setTimeout(resolve, 20));
    await expect(svc().bindings.remove("b1")).rejects.toMatchObject({ code: "keep_pending" });
    expect(isGateRefusal(svc().bindings.gate.authorize({ kind: "park", botId: "b1", by: "orphan" }))).toBe(true);
    open();
    expect(await kept).toMatchObject({ ok: true });
    expect(deletes()).toHaveLength(0);
  });

  it("T24: a second Keep while keep_pending answers keep_pending; overlapping resumes apply one done transaction", async () => {
    await restored("removing");
    await boot();
    const { gate, open } = gateOpen();
    fake.on("GET", /\/inboxes\/ibx_1$/, async () => { await gate; return { status: 200, body: { id: "ibx_1", state: "active" } }; });
    const first = svc().bindings.keep("b1");
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(await svc().bindings.keep("b1")).toMatchObject({ ok: false, code: "keep_pending", status: 409 });
    const resumes = Promise.all([svc().bindings.resumeRemovals(), svc().bindings.resumeRemovals()]);
    open();
    await resumes;
    expect(await first).toMatchObject({ ok: true });
    expect(svc().store.getPark("b1")).toBeNull();
    expect(svc().store.getBinding("b1")?.state).toBe("restored_unverified");
  });
});

describe("restore park A: Keep races and rollback (T4a T4b T4c T6 T22 T29)", () => {
  const held = () => {
    const barrier = gateOpen();
    fake.on("GET", /\/inboxes\/ibx_1$/, { status: 200, body: { id: "ibx_1", state: "closing" } })
      .on("POST", /\/inboxes\/ibx_1\/restore$/, async () => { await barrier.gate; return { status: 200, body: { id: "ibx_1", state: "active" } }; });
    return barrier;
  };
  const settle = () => new Promise(resolve => setTimeout(resolve, 20));
  const quiet = async () => {
    await svc().bindings.reap();
    for (let i = 0; i < 3; i += 1) await svc().bindings.resumeRemovals();
    expect(deletes()).toHaveLength(0);
    expect(fake.calls("DELETE", /bot-keys/)).toHaveLength(0);
  };

  it("T4a: a bot deleted while Keep's restore is in flight (new intent, no token): Keep ends ok, the park stays parked, the binding removal_parked, 0 DELETEs", async () => {
    await restored("removing");
    await boot();
    const barrier = held();
    const kept = svc().bindings.keep("b1");
    await settle();
    svc().bindings.recordDeletionIntent("b1"); svc().bindings.commitDeletionIntent("b1");
    barrier.open();
    expect(await kept).toMatchObject({ ok: true });
    expect(svc().store.getPark("b1")).toMatchObject({ state: "parked", keepOp: null });
    expect(svc().store.getBinding("b1")?.state).toBe("removal_parked");
    await quiet();
  });

  it("T4b: the bot's existing uncommitted intent, covered by the claim, is updated during Keep (same created_at, new revision): the park stays, the intent is kept, 0 DELETEs", async () => {
    await restored("removing", "uncommitted");
    await boot();
    const before = svc().store.getTombstone("b1", "ibx_1")!;
    const barrier = held();
    const kept = svc().bindings.keep("b1");
    await settle();
    clock += 5_000;
    svc().bindings.recordDeletionIntent("b1");
    const moved = svc().store.getTombstone("b1", "ibx_1")!;
    expect(moved.createdAt).toBe(before.createdAt);
    expect(moved.revision).toBeGreaterThan(before.revision);
    barrier.open();
    expect(await kept).toMatchObject({ ok: true });
    expect(svc().store.getPark("b1")).toMatchObject({ state: "parked" });
    expect(svc().store.getTombstone("b1", "ibx_1")).not.toBeNull();
    await quiet();
  });

  it("T4c: the same with the clock frozen (claim and the new intent share one millisecond): the park still stays", async () => {
    await restored("removing", "uncommitted");
    await boot();
    const before = svc().store.getTombstone("b1", "ibx_1")!;
    const barrier = held();
    const kept = svc().bindings.keep("b1");
    await settle();
    svc().bindings.recordDeletionIntent("b1");
    expect(svc().store.getTombstone("b1", "ibx_1")!.revision).toBeGreaterThan(before.revision);
    barrier.open();
    expect(await kept).toMatchObject({ ok: true });
    expect(svc().store.getPark("b1")).toMatchObject({ state: "parked" });
    expect(svc().store.getTombstone("b1", "ibx_1")).not.toBeNull();
    await quiet();
  });

  it("T6: a binding revision bump during Keep (account noted) does not block the rollback: 403 restore_window_passed leaves the park parked with keep_failure, Keep can run again, Remove works", async () => {
    await restored("removing");
    await boot();
    const barrier = gateOpen();
    fake.on("GET", /\/inboxes\/ibx_1$/, async () => { await barrier.gate; return fluxError(403, "restore_window_passed"); });
    const kept = svc().bindings.keep("b1");
    await settle();
    const revision = svc().store.getBinding("b1")!.revision;
    svc().bindings.noteAccount("acct_other");
    expect(svc().store.getBinding("b1")!.revision).toBeGreaterThan(revision);
    barrier.open();
    expect(await kept).toMatchObject({ ok: false, code: "restore_window_passed" });
    expect(svc().store.getPark("b1")).toMatchObject({ state: "parked", keepOp: null, keepFailure: "restore_window_passed" });
    fake.on("GET", /\/inboxes\/ibx_1$/, fluxError(403, "restore_window_passed"));
    expect(await svc().bindings.keep("b1")).toMatchObject({ ok: false, code: "restore_window_passed" });
    fake.on("DELETE", /\/inboxes\/ibx_1$/, { status: 202, body: { state: "closing" } });
    await svc().bindings.remove("b1");
    expect(svc().store.getPark("b1")).toMatchObject({ state: "remove_authorized" });
    expect(deletes()).toHaveLength(1);
  });

  it("T22: a deleted event arriving during Keep, before the done transaction: the park is parked, Keep answers inbox_gone, the evidence stays", async () => {
    await restored("removing");
    await boot();
    const barrier = held();
    const kept = svc().bindings.keep("b1");
    await settle();
    await svc().bindings.applyLifecycle({ type: "email.inbox.deleted", inbox_id: "ibx_1" });
    expect(svc().store.getPark("b1")).toMatchObject({ state: "keep_pending", remoteDeletedAt: clock });
    barrier.open();
    expect(await kept).toMatchObject({ ok: false, code: "inbox_gone", status: 409 });
    expect(svc().store.getPark("b1")).toMatchObject({ state: "parked_evidence", keepOp: null, remoteDeletedAt: clock });
    expect(svc().store.getBinding("b1")?.state).toBe("removal_parked");
    await quiet();
  });

  it("T29: a restored binding that is removed and then kept returns to restored_unverified, never active (1.0.18 provenance), on the park path and the plain path", async () => {
    await restored("removing");
    await boot();
    fake.on("DELETE", /\/inboxes\/ibx_1$/, { status: 202, body: { state: "closing", closing_until: "2026-12-01T00:00:00Z" } });
    await svc().bindings.remove("b1");
    fake.on("GET", /\/inboxes\/ibx_1$/, { status: 200, body: { id: "ibx_1", state: "closing" } }).on("POST", /\/inboxes\/ibx_1\/restore$/, { status: 200, body: { id: "ibx_1", state: "active" } });
    expect(await svc().bindings.keep("b1")).toMatchObject({ ok: true, row: { state: "restored_unverified", step: "restored" } });
    // plain path (no park): a restored binding in its closing window
    svc().store.deleteBindingGeneration(svc().store.getBinding("b1")!);
    svc().store.insertBinding({ ...binding, state: "remove_requested", step: "restored" } as never);
    fake.on("POST", /\/inboxes\/ibx_1\/restore$/, { status: 200, body: { id: "ibx_1", state: "active" } });
    expect(await svc().bindings.keep("b1")).toMatchObject({ ok: true, row: { state: "restored_unverified" } });
    expect(svc().store.getBinding("b1")?.state).not.toBe("active");
  });
});
