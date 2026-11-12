// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Restore park, batch A3: the product side of the r3.4d spec reducer (server/email/exec-spec/restore/restore-reducer.ts on r34d-fix-view): parked_evidence, keep guards,
// kept keys never parked again, park_rev authority, `removing` only with an authorize record. Each test names the reducer function and line it mirrors.
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EmailRuntime } from "./runtime.ts";
import { adoptLegacyParks, prepareRestoredEmail } from "./restore.ts";
import { isGateRefusal, type RemovalGate } from "./removal-gate.ts";
import { RemovalRefused } from "./binding-service.ts";
import { FakeFlux } from "../testing/fake-flux-email.ts";
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
const gateOf = () => (svc().bindings as unknown as { gate: RemovalGate }).gate;
const deletes = () => fake.calls("DELETE", /\/v1\/email\/inboxes\//);
const restores = () => fake.calls("POST", /\/v1\/email\/inboxes\/ibx_1\/restore$/);
const binding = { botId: "b1", inboxId: "ibx_1", address: "juniper@murage.email", username: "juniper", displayName: "Juniper", emailKeyRef: "key_old", fluxAccountId: null, step: null, opId: "op1", opStartedAt: null, policy: "auto", failure: null, updatedAt: 0 };
const restored = async (state: string) => {
  runtime = make();
  runtime.secrets.setOwner({ token: "owner-fixture", keyId: "key_owner" });
  await runtime.probe.refresh();
  runtime.stop();
  svc().store.insertBinding({ ...binding, state } as never);
  prepareRestoredEmail(db);
};
/** A Keep that succeeds (Flux says the inbox is active), after the restore parked a removing binding. */
const keepOk = async () => {
  fake.on("GET", /\/inboxes\/ibx_1$/, () => ({ status: 200, body: { id: "ibx_1", state: "active" } }));
  expect(await svc().bindings.keep("b1")).toMatchObject({ ok: true });
};

beforeEach(() => { clock = 1_800_000_000_000; fake = new FakeFlux(); db = new DatabaseSync(":memory:"); fake.always("GET", /^\/v1\/email\/capabilities$/, { status: 200, body: CAPS }); });
afterEach(() => runtime?.stop());

describe("restore park A3: parked_evidence (reducer parkBinding line 112, onAnswer kget rollback line 303)", () => {
  it("A3-1: email.inbox.deleted on a parked row makes it parked_evidence with remote_deleted_at and a park_rev bump; Keep answers inbox_gone", async () => {
    await restored("removing");
    await boot();
    expect(svc().store.getPark("b1")).toMatchObject({ state: "parked", remoteDeletedAt: null, parkRev: 0 });
    await svc().bindings.inboxDeleted("ibx_1");
    expect(svc().store.getPark("b1")).toMatchObject({ state: "parked_evidence", remoteDeletedAt: clock, parkRev: 1 });
    expect(await svc().bindings.keep("b1")).toMatchObject({ ok: false, code: "inbox_gone", status: 409 });
    expect(deletes()).toHaveLength(0);
  });
  it("A3-2: a Keep whose GET says 404 rolls back to parked_evidence, not parked", async () => {
    await restored("removing");
    await boot();
    fake.on("GET", /\/inboxes\/ibx_1$/, () => ({ status: 404, body: { error: { code: "inbox_not_found" } } }));
    expect(await svc().bindings.keep("b1")).toMatchObject({ ok: false, code: "inbox_gone" });
    expect(svc().store.getPark("b1")?.state).toBe("parked_evidence");
  });
});

describe("restore park A3: keep guards (reducer startGuardRestore line 156, applyEvent closing line 445, guardPoll line 439, ownerRemove line 238)", () => {
  it("A3-3: after Keep, a Flux re-close for the owner re-sends RESTORE and the Keep stays Kept", async () => {
    await restored("removing");
    await boot();
    await keepOk();
    expect(restores()).toHaveLength(0);
    fake.always("POST", /\/inboxes\/ibx_1\/restore$/, { status: 200, body: { id: "ibx_1", state: "active" } });
    await svc().bindings.applyLifecycle({ type: "email.inbox.closing", inbox_id: "ibx_1", data: { reason: "owner" } });
    expect(restores()).toHaveLength(1);
    expect(svc().store.getBinding("b1")?.state).toBe("restored_unverified");
    expect(svc().store.getPark("b1")).toBeNull();
  });
  it("A3-4: a closing for a Flux reason (billing) is not guarded; the guard polls closing inboxes once per minute inside its window, then expires", async () => {
    await restored("removing");
    await boot();
    await keepOk();
    await svc().bindings.applyLifecycle({ type: "email.inbox.closing", inbox_id: "ibx_1", data: { reason: "billing" } });
    expect(restores()).toHaveLength(0);
    fake.always("POST", /\/inboxes\/ibx_1\/restore$/, { status: 200, body: { id: "ibx_1", state: "active" } });
    fake.always("GET", /\/inboxes\/ibx_1$/, { status: 200, body: { id: "ibx_1", state: "closing" } });
    await svc().bindings.pollKeepGuards();
    expect(restores()).toHaveLength(1);
    await svc().bindings.pollKeepGuards(); // same minute: no second GET
    expect(restores()).toHaveLength(1);
    clock += 61_000;
    await svc().bindings.pollKeepGuards();
    expect(restores()).toHaveLength(2);
    clock += 25 * 3600_000;
    await svc().bindings.pollKeepGuards();
    expect(svc().store.getKeepGuard("ibx_1")).toBeNull();
  });
  it("A3-5: the owner's fresh Remove ends the guard in the same step as the authority", async () => {
    await restored("removing");
    await boot();
    await keepOk();
    expect(svc().store.getKeepGuard("ibx_1")).not.toBeNull();
    fake.on("DELETE", /\/inboxes\/ibx_1$/, () => ({ status: 202, body: { id: "ibx_1", state: "closing" } }));
    await svc().bindings.remove("b1");
    expect(svc().store.getKeepGuard("ibx_1")).toBeNull();
  });
});

describe("restore park A3: kept keys are never parked again (reducer parkBinding line 108, parkUnauthorized line 118)", () => {
  it("A3-6: a kept key's unrecorded removing binding is refused parking on the tick (0 parks, 0 DELETEs, visible refusal)", async () => {
    await restored("removing");
    await boot();
    await keepOk();
    const row = svc().store.getBinding("b1")!;
    svc().store.casBinding("b1", row.revision, { state: "removing" }, clock);
    expect(svc().store.isKeptKey("key_old")).toBe(true);
    await svc().bindings.resumeRemovals();
    expect(svc().store.getPark("b1")).toBeNull();
    expect(svc().store.getBinding("b1")?.state).toBe("removing");
    expect(deletes()).toHaveLength(0);
  });
  it("A3-7: adoptLegacyParks skips a kept key; the same row with an unkept key is adopted", async () => {
    await restored("removal_parked");
    svc().store.deletePark("b1", svc().store.getPark("b1")!.parkId, 0);
    svc().store.markKeptKey("key_old", "keep:b1", clock);
    adoptLegacyParks(db);
    expect(svc().store.getPark("b1")).toBeNull();
    db.prepare("DELETE FROM email_event_cursor WHERE scope LIKE 'keptkey:%'").run();
    adoptLegacyParks(db);
    expect(svc().store.getPark("b1")).toMatchObject({ state: "parked", keyId: "key_old" });
  });
});

describe("restore park A3: park_rev authority (reducer tokenInfo line 66; ownerRemove line 251)", () => {
  it("A3-8: Remove with a stale park_rev is refused confirm_expired and nothing is sent", async () => {
    await restored("removing");
    await boot();
    await expect(svc().bindings.remove("b1", 7)).rejects.toMatchObject({ code: "confirm_expired" });
    await expect(svc().bindings.remove("b1", 7)).rejects.toBeInstanceOf(RemovalRefused);
    expect(svc().store.getPark("b1")?.state).toBe("parked");
    expect(deletes()).toHaveLength(0);
    fake.on("DELETE", /\/inboxes\/ibx_1$/, () => ({ status: 202, body: { id: "ibx_1", state: "closing" } }));
    await svc().bindings.remove("b1", 0);
    expect(svc().store.getPark("b1")?.state).toBe("remove_authorized");
    expect(deletes()).toHaveLength(1);
  });
  it("A3-9: an authority whose park_rev moved on (same park_id, still remove_authorized) cannot DELETE", async () => {
    await restored("removing");
    await boot();
    const auth = gateOf().authorize({ kind: "park", botId: "b1", by: "bot_section", parkRev: 0 });
    if (isGateRefusal(auth)) throw new Error("authorize refused");
    const p = svc().store.getPark("b1")!;
    svc().store.casPark("b1", p.parkRev, { keepFailure: "bump" });
    expect(await gateOf().deleteInbox(auth.authority, auth.start)).toMatchObject({ kind: "gate_refused", code: "authority_gone" });
    expect(deletes()).toHaveLength(0);
  });
});

describe("restore park A3: removing needs an authorize record (reducer ownerRemove line 250, parkUnauthorized line 118)", () => {
  it("A3-10: an unrecorded removing binding is refused by the gate and parked on the tick, 0 DELETEs", async () => {
    await restored("active");
    await boot();
    svc().store.casBinding("b1", svc().store.getBinding("b1")!.revision, { state: "removing" }, clock);
    expect(svc().store.removingAuthority("b1")).toBeNull();
    expect(gateOf().authorize({ kind: "owner", botId: "b1" })).toMatchObject({ kind: "gate_refused", code: "removing_unrecorded" });
    await svc().bindings.resumeRemovals();
    expect(deletes()).toHaveLength(0);
    expect(svc().store.getBinding("b1")?.state).toBe("removal_parked");
    expect(svc().store.getPark("b1")).toMatchObject({ state: "parked", inboxId: "ibx_1", keyId: "key_old" });
  });
  it("A3-11: an owner authorize writes the record, and the DELETE goes", async () => {
    await restored("active");
    await boot();
    svc().store.casBinding("b1", svc().store.getBinding("b1")!.revision, { state: "active" }, clock);
    fake.on("DELETE", /\/inboxes\/ibx_1$/, () => ({ status: 202, body: { id: "ibx_1", state: "closing" } }));
    await svc().bindings.remove("b1");
    expect(svc().store.removingAuthority("b1")).toBe("owner");
    expect(deletes()).toHaveLength(1);
  });
  it("A3-12: the DELETE re-checks the record from fresh rows: an authority whose record is gone cannot send", async () => {
    await restored("active");
    await boot();
    const auth = gateOf().authorize({ kind: "owner", botId: "b1" });
    if (isGateRefusal(auth)) throw new Error("owner authorize refused");
    svc().store.clearRemovingAuthority("b1");
    expect(await gateOf().deleteInbox(auth.authority, auth.start)).toMatchObject({ kind: "gate_refused", code: "removing_unrecorded" });
    expect(deletes()).toHaveLength(0);
  });
});
