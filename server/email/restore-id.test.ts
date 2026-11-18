// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// MAIN RULING: /fixture/jobs/_small/RULING-RESTORE-S1.md.
// MAIN RULING 1115-R5BUGS-OPEN1: fixture restores pass their captured owner fence in argument four; all idempotency and restart assertions stay intact.
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { FluxEmailClient, type StoredRestoreOutcome } from "./flux-email-client.ts";
import { EmailRuntime } from "./runtime.ts";
import { prepareRestoredEmail } from "./restore.ts";
import { FakeFlux, fluxError } from "../testing/fake-flux-email.ts";

const outcomes = () => {
  const saved = new Map<string, StoredRestoreOutcome>();
  return { read: (id: string) => structuredClone(saved.get(id) ?? null), write: (id: string, value: StoredRestoreOutcome) => { saved.set(id, structuredClone(value)); } };
};
function client(fake: FakeFlux, restoreOutcomes = outcomes()) {
  return new FluxEmailClient({ fetch: fake.fetch, apiBase: "https://api.flux.test", appBase: "https://app.flux.test",
    // MAIN RULING 1115-R5BUGS-OPEN1: this positive fixture exposes the same captured owner reference as its owner credential.
    credentials: { account: () => null, owner: () => ({ token: "test-owner", keyId: "owner-1" }), ownerRef: () => "owner-1", bot: () => null }, restoreOutcomes });
}

describe("restore ids on the production client", () => {
  it("joins in-flight duplicates, then serves a late duplicate after GET from the stored outcome with the same ids", async () => {
    const fake = new FakeFlux();
    let finish!: () => void;
    const held = new Promise<void>(resolve => { finish = resolve; });
    fake.on("POST", /\/restore$/, async () => { await held; return { status: 200, body: { id: "i1", bot_id: "b1", state: "active", address: "same@fixture.test" } }; });
    fake.on("GET", /\/inboxes\/i1$/, { status: 200, body: { id: "i1", state: "active" } });
    const saved = outcomes(), c = client(fake, saved);
    const first = c.restoreInbox("i1", "b1", "restore-1", "owner-1");
    const duplicate = c.restoreInbox("i1", "b1", "restore-1", "owner-1");
    // Both calls are outstanding when the physical response is released.
    await Promise.resolve();
    finish();
    const result = await first;
    expect(await duplicate).toEqual(result);
    expect(await c.getInbox({ kind: "owner", expectOwnerRef: c.currentOwnerRef() ?? "" }, "i1")).toMatchObject({ kind: "ok", body: { id: "i1", state: "active" } });
    expect(await c.restoreInbox("i1", "b1", "restore-1", "owner-1")).toEqual(result);
    expect(await client(fake, saved).restoreInbox("i1", "b1", "restore-1", "owner-1")).toEqual(result);
    expect(fake.calls("POST", /\/restore$/)).toHaveLength(1);
    expect(fake.requests[0].headers["idempotency-key"]).toBe("restore-1");
    expect(fake.unexpected).toEqual([]);
    if (result.kind !== "ok") throw new Error("restore did not commit");
    result.body.id = "caller-mutated";
    expect(await c.restoreInbox("i1", "b1", "restore-1", "owner-1")).toMatchObject({ kind: "ok", body: { id: "i1" } });
  });

  it("retries durable persistence of a committed outcome after storage recovers without redispatch", async () => {
    const fake = new FakeFlux().on("POST", /\/restore$/, { status: 200, body: { id: "i1", bot_id: "b1", state: "active" } });
    const saved = outcomes();
    let failing = true, writes = 0;
    const durable = { read: saved.read, write: (id: string, value: StoredRestoreOutcome) => {
      writes++;
      if (failing) throw new Error("fixture storage unavailable");
      saved.write(id, value);
    } };
    const c = client(fake, durable);
    const first = c.restoreInbox("i1", "b1", "persist-retry", "owner-1");
    const joined = c.restoreInbox("i1", "b1", "persist-retry", "owner-1");
    expect((await Promise.allSettled([first, joined])).map(r => r.status)).toEqual(["rejected", "rejected"]);
    expect(writes).toBe(1);
    // A second failed persistence attempt must also retain the committed answer.
    await expect(c.restoreInbox("i1", "b1", "persist-retry", "owner-1")).rejects.toThrow("fixture storage unavailable");
    expect(writes).toBe(2);
    failing = false;
    const result = await c.restoreInbox("i1", "b1", "persist-retry", "owner-1");
    expect(result).toMatchObject({ kind: "ok", body: { id: "i1", bot_id: "b1", state: "active" } });
    expect(writes).toBe(3);
    expect(await client(fake, durable).restoreInbox("i1", "b1", "persist-retry", "owner-1")).toEqual(result);
    expect(fake.calls("POST", /\/restore$/)).toHaveLength(1);
    expect(fake.unexpected).toEqual([]);
  });

  it("replays a committed refusal; a distinct restore id may execute later", async () => {
    const fake = new FakeFlux().on("POST", /\/restore$/, fluxError(409, "not_closing"))
      .on("POST", /\/restore$/, { status: 200, body: { id: "i1", state: "active" } });
    const c = client(fake), refused = await c.restoreInbox("i1", "b1", "refused-id", "owner-1");
    expect(refused).toMatchObject({ kind: "refused", code: "not_closing" });
    expect(await c.restoreInbox("i1", "b1", "refused-id", "owner-1")).toEqual(refused);
    expect(await c.restoreInbox("i1", "b1", "new-id", "owner-1")).toMatchObject({ kind: "ok", body: { id: "i1" } });
    expect(fake.calls("POST", /\/restore$/)).toHaveLength(2);
  });

  it("cannot reuse an accepted id for another inbox or bot, either in flight or after restart", async () => {
    const fake = new FakeFlux().on("POST", /\/restore$/, { status: 200, body: { id: "i1", state: "active" } });
    const saved = outcomes(), c = client(fake, saved);
    const first = c.restoreInbox("i1", "b1", "same-id", "owner-1");
    expect(await c.restoreInbox("i2", "b1", "same-id", "owner-1")).toMatchObject({ kind: "uncertain", reason: "idempotency_mismatch" });
    expect(await c.restoreInbox("i1", "b1", "", "owner-1")).toMatchObject({ kind: "uncertain", reason: "idempotency_mismatch" });
    await first;
    expect(await client(fake, saved).restoreInbox("i1", "b2", "same-id", "owner-1")).toMatchObject({ kind: "uncertain", reason: "idempotency_mismatch" });
    expect(fake.calls("POST", /\/restore$/)).toHaveLength(1);
  });
});

describe("durable restore identity through the production runtime", () => {
  const runtimes: EmailRuntime[] = [], databases: DatabaseSync[] = [];
  afterEach(() => { for (const runtime of runtimes.splice(0)) runtime.stop(); for (const db of databases.splice(0)) db.close(); });
  const make = async (db: DatabaseSync, fake: FakeFlux) => {
    const runtime = new EmailRuntime({ accountKey: () => "fixture-account", database: () => db, transaction: fn => fn(), fetch: fake.fetch,
      apiBase: "https://api.flux.test", appBase: "https://app.flux.test", bot: () => undefined, workspaceRoot: () => undefined });
    runtimes.push(runtime);
    runtime.secrets.setOwner({ token: "test-owner", keyId: "owner-1" });
    await runtime.probe.refresh();
    expect(runtime.services()).not.toBeNull();
    runtime.stop();
    return runtime;
  };
  const fixture = () => {
    const db = new DatabaseSync(":memory:"); databases.push(db);
    // MAIN RULING 1115-R5BUGS-OPEN1: positive Keep fixtures prove the inbox owner through the real read before restore.
    const fake = new FakeFlux().always("GET", /\/capabilities$/, { status: 200, body: { enabled: true, available: true, account_state: "active", terms_version: "v1" } })
      .always("GET", /^\/v1\/email\/inboxes\/i1$/, { status: 200, body: { id: "i1", bot_id: "b1", state: "closing" } });
    return { db, fake };
  };
  const closingBinding = (runtime: EmailRuntime) => runtime.services()!.store.insertBinding({
    botId: "b1", inboxId: "i1", address: "same@fixture.test", username: "same", displayName: "Same", emailKeyRef: null,
    fluxAccountId: null, state: "closing", step: null, opId: "setup-1", opStartedAt: null, policy: "auto", failure: null, updatedAt: 0,
  });

  it("stores committed results before returning; preparation and a new runtime keep the same result without another POST", async () => {
    const { db, fake } = fixture();
    fake.on("POST", /\/restore$/, { status: 200, body: { id: "i1", bot_id: "b1", state: "active" } });
    const runtime = await make(db, fake);
    const first = await runtime.client.restoreInbox("i1", "b1", "durable-id", "owner-1");
    expect(first).toMatchObject({ kind: "ok", body: { id: "i1", bot_id: "b1" } });
    expect(db.prepare("SELECT cursor FROM email_event_cursor WHERE scope LIKE 'restore-result:%'").all()).toHaveLength(1);
    prepareRestoredEmail(db);
    const rebooted = await make(db, fake);
    expect(await rebooted.client.restoreInbox("i1", "b1", "durable-id", "owner-1")).toEqual(first);
    expect(fake.calls("POST", /\/restore$/)).toHaveLength(1);
    expect(fake.unexpected).toEqual([]);
  });

  it("an uncertain guard retry across restart carries the same id; the remote stored outcome prevents a second physical restore", async () => {
    const { db, fake } = fixture();
    const runtime = await make(db, fake), store = runtime.services()!.store;
    store.putKeepClaim({ inboxId: "i1", botId: "b1", keepOp: "claim-1", authorityId: "keep:b1", claimedAt: 1 }, 1);
    let physicalRestores = 0;
    const remote = new Map<string, { status: number; body: { id: string; state: string } }>();
    fake.always("POST", /\/restore$/, request => {
      const id = request.headers["idempotency-key"];
      expect(id).toBeTruthy();
      if (remote.has(id)) return remote.get(id)!;
      physicalRestores++;
      remote.set(id, { status: 200, body: { id: "i1", state: "active" } });
      return "reset"; // Flux committed, but its answer was lost.
    });
    await runtime.services()!.bindings.pollKeepGuards();
    expect(store.getKeepClaim("i1")).not.toBeNull();
    const rebooted = await make(db, fake);
    await rebooted.services()!.bindings.pollKeepGuards();
    expect(store.getKeepClaim("i1")).toBeNull();
    expect(fake.calls("POST", /\/restore$/)).toHaveLength(2);
    expect(new Set(fake.calls("POST", /\/restore$/).map(r => r.headers["idempotency-key"])).size).toBe(1);
    expect(physicalRestores).toBe(1);
    expect(fake.unexpected).toEqual([]);
  });

  it("a live Keep retry keeps its id across restart and an unrelated binding revision change", async () => {
    const { db, fake } = fixture(), runtime = await make(db, fake);
    closingBinding(runtime);
    fake.on("POST", /\/restore$/, "reset").on("POST", /\/restore$/, { status: 200, body: { id: "i1", state: "active" } });
    expect((await runtime.services()!.bindings.keep("b1")).ok).toBe(false);
    const store = runtime.services()!.store;
    store.casBinding("b1", store.getBinding("b1")!.revision, { displayName: "Updated" }, 1);
    const rebooted = await make(db, fake);
    expect((await rebooted.services()!.bindings.keep("b1")).ok).toBe(true);
    const posts = fake.calls("POST", /\/restore$/);
    expect(posts).toHaveLength(2);
    expect(posts[0].headers["idempotency-key"]).toBeTruthy();
    expect(posts[1].headers["idempotency-key"]).toBe(posts[0].headers["idempotency-key"]);
    expect(fake.unexpected).toEqual([]);
  });

  it("a new owner Keep mints a fresh id even when an archive repeats a binding's earlier revision", async () => {
    const { db, fake } = fixture(), runtime = await make(db, fake);
    closingBinding(runtime);
    fake.always("POST", /\/restore$/, { status: 200, body: { id: "i1", state: "active" } });
    expect((await runtime.services()!.bindings.keep("b1")).ok).toBe(true);
    prepareRestoredEmail(db);
    // The restored/mirrored binding can revisit an old revision; a revision is not an operation id.
    db.prepare("UPDATE email_bindings SET state='closing', step=NULL, revision=1 WHERE bot_id='b1'").run();
    const rebooted = await make(db, fake);
    expect((await rebooted.services()!.bindings.keep("b1")).ok).toBe(true);
    const posts = fake.calls("POST", /\/restore$/);
    expect(posts).toHaveLength(2);
    expect(new Set(posts.map(r => r.headers["idempotency-key"])).size).toBe(2);
    expect(posts.every(r => Boolean(r.headers["idempotency-key"]))).toBe(true);
    expect(fake.unexpected).toEqual([]);
  });
});
