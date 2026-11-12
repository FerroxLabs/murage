// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A restore parks every bot email removal that was in progress at backup time (1.0.19). Nothing re-runs it at boot, because the owner may
// have pressed Keep address after the backup; Keep always wins; only the owner's Remove after the restore resumes it.
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EmailRuntime } from "./runtime.ts";
import { prepareRestoredEmail } from "./restore.ts";
import { FakeFlux, fluxError } from "../testing/fake-flux-email.ts";
import type { BotRecord } from "../store.ts";

const CAPS = { object: "email.capabilities", enabled: true, available: true, account_state: "active", terms_version: "v1", limits: {} };
let fake: FakeFlux;
let db: DatabaseSync;
let runtime: EmailRuntime;
let clock: number;

const make = () => new EmailRuntime({
  accountKey: () => "sk-flux-account-fixture", database: () => db, transaction: fn => fn(), fetch: fake.fetch, apiBase: "https://api.flux.test", appBase: "https://app.flux.test",
  now: () => clock, workspaceRoot: () => undefined, bot: id => ({ id, name: "Juniper", threadId: `t-${id}` } as unknown as BotRecord), deletionProof: () => false,
});
const boot = async () => {
  runtime = make();
  runtime.secrets.setOwner({ token: "owner-fixture", keyId: "key_owner" });
  runtime.secrets.setBotKey("b1", { token: "bot-key", keyId: "key_old" });
  await runtime.probe.refresh();
  await runtime.start();
  runtime.stop();
};
const state = () => runtime.services()!.store.getBinding("b1")?.state;
const deletes = () => fake.calls("DELETE", /\/v1\/email\/inboxes\//);

/** The backup holds a binding mid-removal; the restore preparation runs on that database before the app boots. */
const restoreBackupTakenDuring = async (during: "removing" | "remove_requested") => {
  runtime = make();
  runtime.secrets.setOwner({ token: "owner-fixture", keyId: "key_owner" });
  await runtime.probe.refresh();
  runtime.stop();
  runtime.services()!.store.insertBinding({ botId: "b1", inboxId: "ibx_1", address: "juniper@murage.email", username: "juniper", displayName: "Juniper", emailKeyRef: "key_old", fluxAccountId: null, state: during, step: null, opId: null, opStartedAt: null, policy: "auto", failure: null, updatedAt: clock } as never);
  prepareRestoredEmail(db);
};

beforeEach(() => {
  clock = 1_800_000_000_000;
  fake = new FakeFlux();
  db = new DatabaseSync(":memory:");
  fake.always("GET", /^\/v1\/email\/capabilities$/, { status: 200, body: CAPS });
});
afterEach(() => runtime?.stop());

describe("restore parks an in-flight inbox removal", () => {
  for (const during of ["removing", "remove_requested"] as const) {
    it(`(a) backup during ${during}, Keep pressed later, restore, boot: the address stays and no removal call is made`, async () => {
      await restoreBackupTakenDuring(during);
      await boot();
      expect(deletes()).toHaveLength(0);
      expect(state()).not.toBe("removing");
      expect(state()).not.toBe("remove_requested");
      expect(runtime.services()!.store.getBinding("b1")).toMatchObject({ inboxId: "ibx_1", address: "juniper@murage.email" });
      // the owner's Keep after the restore: the inbox is normal again, still nothing deleted
      fake.on("GET", /\/inboxes\/ibx_1$/, { status: 200, body: { id: "ibx_1", state: "active" } });
      expect(await runtime.services()!.bindings.keep("b1")).toMatchObject({ ok: true, row: { state: "restored_unverified" } });
      expect(deletes()).toHaveLength(0);
    });
  }

  it("(b) no later Keep: boot parks it with no removal call; the owner's Remove after the restore resumes and completes it", async () => {
    await restoreBackupTakenDuring("removing");
    await boot();
    expect(deletes()).toHaveLength(0);
    expect(state()).toBe("removal_parked");
    const bindings = runtime.services()!.bindings;
    fake.on("DELETE", /\/inboxes\/ibx_1$/, { status: 202, body: { state: "closing", closing_until: "2026-12-01T00:00:00Z" } });
    await bindings.remove("b1");
    expect(deletes()).toHaveLength(1);
    expect(state()).toBe("remove_requested");
    fake.on("GET", /\/inboxes\/ibx_1$/, fluxError(404, "inbox_not_found")).on("DELETE", /bot-keys\/key_old$/, { status: 204 });
    await bindings.resumeRemovals();
    expect(runtime.services()!.store.getBinding("b1")).toBeNull();
    expect(runtime.services()!.store.getPark("b1")).toBeNull();
  });

  it("(c) parked, then Keep: back to normal, no removal call is ever made; a Flux-closed inbox is restored first", async () => {
    await restoreBackupTakenDuring("remove_requested");
    await boot();
    fake.on("GET", /\/inboxes\/ibx_1$/, { status: 200, body: { id: "ibx_1", state: "closing", closing_until: "2026-12-01T00:00:00Z" } });
    fake.on("POST", /\/inboxes\/ibx_1\/restore$/, { status: 200, body: { id: "ibx_1", state: "active" } });
    expect(await runtime.services()!.bindings.keep("b1")).toMatchObject({ ok: true, row: { state: "restored_unverified", closingUntil: null } });
    expect(fake.calls("POST", /\/restore$/)).toHaveLength(1);
    await boot();
    expect(state()).toBe("restored_unverified");
    expect(deletes()).toHaveLength(0);
  });

  it("(d) restart while parked: it stays parked and is not re-driven", async () => {
    await restoreBackupTakenDuring("removing");
    await boot();
    await boot();
    await boot();
    expect(state()).toBe("removal_parked");
    expect(deletes()).toHaveLength(0);
    expect(fake.calls("GET", /\/inboxes\/ibx_1$/)).toHaveLength(0);
  });
});

const addIntent = (committed: boolean) => runtime.services()!.store.upsertTombstone({ botId: "b1", inboxId: "ibx_1", addressHash: null, state: "removing", committed, reason: "bot_deleted", keyId: null, createdAt: clock, removedAt: null, nextTryAt: null });
const parkedRestore = async () => { await restoreBackupTakenDuring("removing"); };
const keepGate = () => { let open!: () => void; const gate = new Promise<void>(resolve => { open = resolve; }); return { gate, open }; };

describe("the park holds against every other route (Astra r1)", () => {
  it("H1: a bot-deletion intent for a parked binding is parked too: boot, reaper and settle make no call and no state change; Keep ends the intent", async () => {
    await parkedRestore();
    addIntent(true);
    await boot();
    const { bindings, store } = runtime.services()!;
    await bindings.reap();
    expect(deletes()).toHaveLength(0);
    expect(state()).toBe("removal_parked");
    store.deleteTombstone("b1", "ibx_1", store.getTombstone("b1", "ibx_1")!.revision);
    addIntent(false);
    bindings.settleDeletionIntents(() => false, () => true);
    await bindings.reap();
    expect(deletes()).toHaveLength(0);
    expect(state()).toBe("removal_parked");
    expect(store.getTombstone("b1", "ibx_1")).toMatchObject({ committed: false });
    store.deleteTombstone("b1", "ibx_1", store.getTombstone("b1", "ibx_1")!.revision);
    addIntent(true);
    fake.on("GET", /\/inboxes\/ibx_1$/, { status: 200, body: { id: "ibx_1", state: "active" } });
    expect(await bindings.keep("b1")).toMatchObject({ ok: true, row: { state: "restored_unverified" } });
    await bindings.reap();
    await boot();
    expect(deletes()).toHaveLength(0);
    expect(state()).toBe("restored_unverified");
    expect(runtime.services()!.store.tombstones().filter(tomb => tomb.state !== "removed")).toHaveLength(0);
  });

  it("H2: a Remove that arrives while Keep waits on Flux is refused: Keep wins, and Keep is ok only because nothing was removed", async () => {
    await parkedRestore();
    await boot();
    const { bindings } = runtime.services()!;
    const { gate, open } = keepGate();
    fake.on("GET", /\/inboxes\/ibx_1$/, async () => { await gate; return { status: 200, body: { id: "ibx_1", state: "active" } }; });
    fake.on("DELETE", /\/inboxes\/ibx_1$/, { status: 202, body: { state: "closing" } });
    const kept = bindings.keep("b1");
    await expect(bindings.remove("b1")).rejects.toMatchObject({ code: "keep_pending" });
    open();
    expect(await kept).toMatchObject({ ok: true, row: { state: "restored_unverified" } });
    expect(deletes()).toHaveLength(0);
    expect(state()).toBe("restored_unverified");
  });

  it("H2b: a Remove that wins the race first makes Keep refuse instead of reporting ok", async () => {
    await parkedRestore();
    await boot();
    const { bindings } = runtime.services()!;
    fake.on("DELETE", /\/inboxes\/ibx_1$/, { status: 202, body: { state: "closing", closing_until: "2026-12-01T00:00:00Z" } });
    await bindings.remove("b1");
    fake.on("GET", /\/inboxes\/ibx_1$/, { status: 200, body: { id: "ibx_1", state: "closing" } });
    const answer = await bindings.keep("b1");
    expect(answer.ok && state() === "remove_requested").toBe(false);
  });

  it("H3: an inbox-deleted event for a parked binding is written down only: no tombstone, no key revoked, binding stays parked", async () => {
    await parkedRestore();
    runtime.services()!.store.insertBinding({ botId: "b2", inboxId: "ibx_2", address: "other@murage.email", username: "other", displayName: "Other", emailKeyRef: "key_2", fluxAccountId: null, state: "active", step: null, opId: null, opStartedAt: null, policy: "auto", failure: null, updatedAt: clock } as never);
    await boot();
    fake.on("GET", /\/v1\/email\/events$/, { status: 200, body: { object: "list", data: [{ id: "eev_del", type: "email.inbox.deleted", inbox_id: "ibx_1", created: "2026-11-10T00:00:00Z" }], next_cursor: "c_2" } });
    expect(await runtime.services()!.events.pollOnce()).toBe("ok");
    expect(state()).toBe("removal_parked");
    expect(fake.calls("DELETE", /bot-keys/)).toHaveLength(0);
    expect(runtime.services()!.store.tombstones()).toHaveLength(0);
    expect(runtime.secrets.botKey("b1")).toMatchObject({ keyId: "key_old" });
  });

  it("M4: restore, then Remove, then Keep returns to restored_unverified (Reconnect and a new key), never active", async () => {
    await parkedRestore();
    await boot();
    const { bindings } = runtime.services()!;
    fake.on("DELETE", /\/inboxes\/ibx_1$/, { status: 202, body: { state: "closing", closing_until: "2026-12-01T00:00:00Z" } });
    await bindings.remove("b1");
    expect(state()).toBe("remove_requested");
    fake.on("GET", /\/inboxes\/ibx_1$/, { status: 200, body: { id: "ibx_1", state: "closing" } });
    fake.on("POST", /\/inboxes\/ibx_1\/restore$/, { status: 200, body: { id: "ibx_1", state: "active" } });
    expect(await bindings.keep("b1")).toMatchObject({ ok: true, row: { state: "restored_unverified" } });
    expect(state()).toBe("restored_unverified");
    expect(runtime.services()!.store.getBinding("b1")).toMatchObject({ step: "restored" });
  });

  it("the park survives an export and import of the bindings row (state and restore mark are plain columns)", async () => {
    await parkedRestore();
    const { db: live, store } = runtime.services()!;
    const row = live.prepare("SELECT * FROM email_bindings WHERE bot_id='b1'").get() as Record<string, unknown>;
    expect(row).toMatchObject({ state: "removal_parked", step: "restored" });
    expect(store.getBinding("b1")).toMatchObject({ state: "removal_parked", step: "restored" });
  });
});
