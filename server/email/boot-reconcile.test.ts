import { createMemoryEmailRuntime } from "../testing/email-store-fixture.ts";
import { legacyEmailDecisionFixture } from "./testing/legacy-decision-fixture.ts";
import type { ServiceAuthority } from "../narrow-denials.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Phase 5 boot and deletion (BOT-EMAIL-MURAGE-109 2.3, 2.5, 2.6, 8, 9.1, 9.2): setup crash steps (F21), key rotation (F20), bot deletion
// intents through the store hooks and the boot settle (F22, L2), a pending approval with no local row (F4), account Off (F29), an account
// change, and the monthly budget resting line (F30).
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMAIL_EVENT_KEEP_MS, EMAIL_PRUNE_BATCH, EmailRuntime, PRUNE_TICKS } from "./runtime.ts";
import { EmailStore, PRUNE_PAYLOADS_SCOPE, type SendRow, type SendState } from "./email-store.ts";
import { KEY_IDEMPOTENCY_WINDOW_MS } from "./binding-service.ts";
import { prepareRestoredEmail } from "./restore.ts";
import { EMAIL_LINES, codeLine } from "./tools.ts";
import { FakeFlux, fluxError } from "../testing/fake-flux-email.ts";
import type { BotRecord } from "../store.ts";

import { provenInsert } from "../testing/email-proven.ts";
const CAPS = { object: "email.capabilities", enabled: true, available: true, account_state: "active", terms_version: "v1", limits: {} };
let fake: FakeFlux;
let db: DatabaseSync;
let runtime: EmailRuntime;
let clock: number;
let bots: Set<string>;
let proofs: Set<string>;
let authority: ServiceAuthority;

const make = (extra: Partial<ConstructorParameters<typeof EmailRuntime>[0]> = {}) => createMemoryEmailRuntime({
  authorityFor: () => authority,
  accountKey: () => "sk-flux-account-fixture", database: () => db, transaction: fn => fn(), fetch: fake.fetch, apiBase: "https://api.flux.test", appBase: "https://app.flux.test",
  now: () => clock, workspaceRoot: () => undefined, bot: id => (bots.has(id) ? { id, name: "Juniper", threadId: `t-${id}` } as unknown as BotRecord : undefined),
  deletionProof: id => proofs.has(id),
  ...extra,
});
const binding = (botId = "b1", patch: Record<string, unknown> = {}) => provenInsert(runtime.services()!.store, { botId, inboxId: "ibx_1", address: "juniper@murage.email", username: "juniper", displayName: "Juniper", emailKeyRef: "key_old", fluxAccountId: null, state: "active", step: null, opId: null, opStartedAt: null, policy: "auto", failure: null, updatedAt: clock, ...patch } as never);
// r5: a setup row records the owner ref its run started on (setup-account); a row with no record is cancelled before any paid call
const OWNER_REF = "key_owner";
const setupRecord = (botId = "b1") => runtime.services()!.store.setCursor(`setup-account:${botId}`, JSON.stringify({ ownerRef: OWNER_REF }), clock);
const heldByOwner = () => runtime.services()!.send.submit({ botId: "b1", generation: 1, threadId: "t-b1", draft: { kind: "send", to: ["stranger@acme.test"], cc: [], subject: "Hi", text: "Hi", attachments: [], replyTo: null } });

beforeEach(async () => {
  authority = await legacyEmailDecisionFixture({ botId: "b1", threadId: "t-b1" });
  clock = 1_800_000_000_000;
  fake = new FakeFlux();
  db = new DatabaseSync(":memory:");
  bots = new Set(["b1"]); proofs = new Set();
  runtime = make();
  runtime.secrets.setOwner({ token: "owner-fixture", keyId: "key_owner" });
  fake.always("GET", /^\/v1\/email\/capabilities$/, { status: 200, body: CAPS });
  await runtime.probe.refresh();
});

afterEach(() => runtime.stop());

describe("F21 setup crash steps (2.5)", () => {
  it("the runtime tick finishes a setup that got no answer, with no restart", async () => {
    runtime.stop(); // the beforeEach read started a real tick
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      await runtime.start();
      fake.on("POST", /^\/api\/desktop\/bot-keys$/, "reset");
      expect(await runtime.services()!.bindings.enable("b1", { username: "juniper" })).toMatchObject({ state: "provisioning" });
      fake.on("POST", /^\/api\/desktop\/bot-keys$/, { status: 201, body: { key: "bot-email-key", key_id: "key_new" } });
      fake.on("POST", /^\/v1\/email\/inboxes$/, { status: 201, body: { id: "ibx_7", bot_id: "b1", address: "juniper@murage.email", state: "active", send_policy: "ask" } });
      clock += 30_000;
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(() => expect(runtime.services()!.store.getBinding("b1")).toMatchObject({ state: "active", inboxId: "ibx_7" }));
    } finally { vi.useRealTimers(); }
  });

  it("a key already stored at step key is not trusted (nothing names it): the mint replays, and 409 inbox_exists is adopted (r4 test 9)", async () => {
    binding("b1", { inboxId: null, address: null, state: "provisioning", step: "key", opId: "op-1", opStartedAt: clock - 1000 });
    setupRecord();
    runtime.secrets.setBotKey("b1", { token: "bot-new", keyId: "key_new" });
    fake.on("POST", /^\/api\/desktop\/bot-keys$/, { status: 200, body: { key: "bot-new", key_id: "key_new" } });
    fake.on("POST", /^\/v1\/email\/inboxes$/, fluxError(409, "inbox_exists", { inbox_id: "ibx_7" }));
    fake.on("GET", /^\/v1\/email\/inboxes\/ibx_7$/, { status: 200, body: { id: "ibx_7", address: "juniper@murage.email", state: "active" } });
    await runtime.start(); runtime.stop();
    expect(fake.calls("POST", /^\/api\/desktop\/bot-keys$/)).toHaveLength(1);
    expect(runtime.services()!.store.getBinding("b1")).toMatchObject({ state: "active", inboxId: "ibx_7", emailKeyRef: "key_new" });
  });
  it("inside 24 h the same op id is replayed; past 24 h the step reruns with a new op id", async () => {
    binding("b1", { inboxId: null, address: null, state: "provisioning", step: "key", opId: "op-1", opStartedAt: clock - 1000 });
    setupRecord();
    fake.on("POST", /^\/api\/desktop\/bot-keys$/, "reset");
    await runtime.services()!.bindings.advance("b1");
    clock += KEY_IDEMPOTENCY_WINDOW_MS;
    fake.on("POST", /^\/api\/desktop\/bot-keys$/, "reset");
    await runtime.services()!.bindings.advance("b1");
    const keys = fake.calls("POST", /^\/api\/desktop\/bot-keys$/).map(call => call.headers["idempotency-key"]);
    expect(keys[0]).toContain("op-1");
    expect(keys[1]).not.toContain("op-1");
  });
});

describe("F20 key rotation (2.3)", () => {
  beforeEach(() => { binding(); runtime.secrets.setBotKey("b1", { token: "bot-old", keyId: "key_old" }); });
  it("mint, check #5 with the new key, save, then revoke the old one", async () => {
    fake.on("POST", /^\/api\/desktop\/bot-keys$/, { status: 201, body: { key: "bot-new", key_id: "key_new" } });
    fake.on("GET", /^\/v1\/email\/inboxes\/ibx_1$/, { status: 200, body: { id: "ibx_1", state: "active" } });
    fake.on("DELETE", /^\/api\/desktop\/bot-keys\/key_old$/, { status: 200, body: {} });
    const services = runtime.services()!;
    expect(await services.bindings.rotateKey("b1", id => services.send.canRotate(id))).toEqual({ ok: true });
    expect(fake.calls("GET", /^\/v1\/email\/inboxes\/ibx_1$/)[0]!.headers.authorization).toBe("Bearer bot-new");
    expect(runtime.secrets.botKey("b1")?.keyId).toBe("key_new");
    expect(services.store.getBinding("b1")!.emailKeyRef).toBe("key_new");
    expect(services.store.getCursor("rotate:b1")).toBeNull();
  });
  it("waits while a row is dispatching or unknown", async () => {
    const services = runtime.services()!;
    expect(await services.bindings.rotateKey("b1", () => false)).toEqual({ ok: false, code: "sends_in_flight" });
    expect(fake.calls("POST", /^\/api\/desktop\/bot-keys$/)).toHaveLength(0);
  });
  it("a crash after the new key was saved: boot revokes the old key, the one not in the secret store", async () => {
    const services = runtime.services()!;
    services.store.setCursor("rotate:b1", JSON.stringify({ oldKeyId: "key_old", opId: "op-r", at: clock, ownerRef: OWNER_REF }), clock);
    runtime.secrets.setBotKey("b1", { token: "bot-new", keyId: "key_new" });
    fake.on("GET", /^\/v1\/email\/inboxes\/ibx_1$/, { status: 200, body: { id: "ibx_1", state: "active" } });
    fake.on("DELETE", /^\/api\/desktop\/bot-keys\/key_old$/, { status: 200, body: {} });
    await runtime.start(); runtime.stop();
    expect(fake.calls("DELETE", /^\/api\/desktop\/bot-keys\/key_old$/)).toHaveLength(1);
    expect(fake.calls("POST", /^\/api\/desktop\/bot-keys$/)).toHaveLength(0);
    expect(services.store.getCursor("rotate:b1")).toBeNull();
  });
});

describe("H3 no revoke by absence (CLOUD-EMAIL-KEYSTORE-1019 r2 section 6 rules 1, 4, 5; r3 section 1: no store id on intents)", () => {
  const A = "a".repeat(32);
  const cloud = (r: EmailRuntime, storeId: string) => r.secrets.attachCloud({ storeId, gen: 0, ownerRev: 0, owner: { token: "owner-fixture", keyId: "key_owner" }, doc: { bots: {} } });
  const revokes = () => fake.calls("DELETE", /^\/api\/desktop\/bot-keys\//);
  const mints = () => fake.calls("POST", /^\/api\/desktop\/bot-keys$/);
  const homeFrom = (fresh: EmailRuntime) => { runtime.stop(); runtime = fresh; };
  /** One boot of the same database under a new process: nothing in memory survives, the sealed keys are put back as the supervisor would. */
  const boot = async (storeId: string, keys: () => void = () => {}) => {
    homeFrom(make()); cloud(runtime, storeId); keys(); await runtime.probe.refresh();
    await runtime.start(); runtime.stop();
  };
  const restoreInPlace = () => expect(prepareRestoredEmail(db)).toBeGreaterThanOrEqual(0);
  it("R1. prepareRestoredEmail on a provisioning binding with rotate and setup-retry cursors: restored_unverified, both cursors gone, install-id kept", () => {
    binding("b1", { state: "provisioning", step: "key", opId: "op-s", opStartedAt: clock });
    const store = runtime.services()!.store;
    store.setCursor("install-id", "install-src", clock);
    store.setCursor("rotate:b1", JSON.stringify({ oldKeyId: "key_old", opId: "op-r", at: clock }), clock);
    store.setCursor("setup-retry:b1", "1", clock);
    expect(prepareRestoredEmail(db)).toBe(1);
    expect(store.getBinding("b1")!.state).toBe("restored_unverified");
    expect(store.getCursor("rotate:b1")).toBeNull();
    expect(store.getCursor("setup-retry:b1")).toBeNull();
    expect(store.getCursor("install-id")).toBe("install-src");
  });
  it("R2. boot on that restored database: zero mint and zero revoke calls", async () => {
    binding("b1", { state: "provisioning", step: "key", opId: "op-s", opStartedAt: clock });
    runtime.services()!.store.setCursor("rotate:b1", JSON.stringify({ oldKeyId: "key_old", opId: "op-r", at: clock }), clock);
    restoreInPlace();
    await boot(A);
    expect(mints()).toHaveLength(0); expect(revokes()).toHaveLength(0);
  });
  it("R3. Reconnect mints with an idempotency key that differs from every opId in the restored database", async () => {
    binding("b1", { state: "provisioning", step: "key", opId: "op-source", opStartedAt: clock });
    runtime.services()!.store.setCursor("rotate:b1", JSON.stringify({ oldKeyId: "key_old", opId: "op-rot", at: clock }), clock);
    restoreInPlace();
    cloud(runtime, A);
    fake.always("GET", /^\/v1\/email\/inboxes$/, { status: 200, body: { data: [{ id: "ibx_1", bot_id: "b1", state: "active", address: "juniper@murage.email" }] } });
    fake.on("POST", /^\/api\/desktop\/bot-keys$/, { status: 201, body: { key: "bot-tgt", key_id: "key_tgt" } });
    expect(await runtime.services()!.bindings.reconnect("b1")).toMatchObject({ ok: true });
    const keyHeader = String(mints()[0]!.headers["idempotency-key"] ?? "");
    expect(keyHeader).not.toBe("");
    for (const op of ["op-source", "op-rot"]) expect(keyHeader).not.toContain(op);
  });
  it("a rotation intent carries no store id, also on a Cloud home with a sealed record", async () => {
    binding("b1", { emailKeyRef: "key_old" });
    cloud(runtime, A);
    runtime.secrets.setBotKey("b1", { token: "bot-old", keyId: "key_old" });
    fake.always("GET", /^\/v1\/email\/inboxes$/, { status: 200, body: { data: [] } });
    fake.on("POST", /^\/api\/desktop\/bot-keys$/, { status: 201, body: { key: "bot-new", key_id: "key_new" } });
    fake.on("DELETE", /^\/api\/desktop\/bot-keys\/key_old$/, { status: 200, body: {} });
    await runtime.services()!.bindings.rotateKey("b1", () => true);
    expect(runtime.services()!.store.getCursor("keystore-store-id")).toBeNull();
    const raw = runtime.services()!.store.getCursor("rotate:b1");
    if (raw) expect(JSON.parse(raw)).not.toHaveProperty("storeId");
  });
  it("11. two homes, one restored from the other (the restore preparation runs), Reconnect and two boots each: the revoke spy never sees a key id", async () => {
    binding("b1", { emailKeyRef: "key_src" });
    cloud(runtime, A);
    runtime.secrets.setBotKey("b1", { token: "bot-src", keyId: "key_src" });
    runtime.services()!.store.setCursor("rotate:b1", JSON.stringify({ oldKeyId: "key_older", opId: "op-r", at: clock }), clock);
    // the restored home: the same database rows through prepareRestoredEmail, a new sealed store (credentials.enc is never backed up)
    restoreInPlace();
    expect(runtime.services()!.store.getCursor("rotate:b1")).toBeNull();
    fake.always("GET", /^\/v1\/email\/inboxes$/, { status: 200, body: { data: [{ id: "ibx_1", bot_id: "b1", state: "active", address: "juniper@murage.email" }] } });
    fake.on("POST", /^\/api\/desktop\/bot-keys$/, { status: 201, body: { key: "bot-tgt", key_id: "key_tgt" } });
    for (let n = 0; n < 2; n++) await boot("b".repeat(32));
    expect(runtime.services()!.store.getBinding("b1")!.state).toBe("restored_unverified");
    expect(revokes()).toHaveLength(0);
    expect(await runtime.services()!.bindings.reconnect("b1")).toMatchObject({ ok: true });
    expect(runtime.secrets.botKey("b1")?.keyId).toBe("key_tgt");
    for (let n = 0; n < 2; n++) await boot("b".repeat(32), () => runtime.secrets.setBotKey("b1", { token: "bot-tgt", keyId: "key_tgt" }));
    expect(revokes()).toHaveLength(0);
  });
  it("12. boot never revokes a key id absent from this home's sealed doc and from the oldKeyId of intents in this home's database (no storeId on intents); Reconnect revokes only a key this home minted, past 24 h (reconnect-r32h.test.ts), never a foreign one", async () => {
    binding("b1", { emailKeyRef: "key_new" });
    cloud(runtime, A);
    runtime.secrets.setBotKey("b1", { token: "bot-new", keyId: "key_new" });
    // an own intent finishes (its old key is revoked once); a key id that is in neither the doc nor an intent is never touched
    runtime.services()!.store.setCursor("rotate:b1", JSON.stringify({ ownerRef: runtime.secrets.owner()!.keyId, oldKeyId: "key_old", opId: "op-r", at: clock }), clock);
    fake.on("DELETE", /^\/api\/desktop\/bot-keys\/key_old$/, { status: 200, body: {} });
    fake.on("DELETE", /^\/api\/desktop\/bot-keys\/key_stray$/, { status: 200, body: {} });
    await runtime.start(); runtime.stop();
    expect(revokes().map(c => c.path)).toEqual(["/api/desktop/bot-keys/key_old"]);
    expect(revokes().some(c => c.path.endsWith("key_stray") || c.path.endsWith("key_new"))).toBe(false);
    // a restored binding: boot revokes nothing, Reconnect never calls revokeBotKey
    binding("b2", { state: "restored_unverified", emailKeyRef: "key_src" });
    fake.always("GET", /^\/v1\/email\/inboxes$/, { status: 200, body: { data: [{ id: "ibx_2", bot_id: "b2", state: "active", address: "juniper@murage.email" }, { id: "ibx_3", bot_id: "b3", state: "active", address: "ivy@murage.email" }] } });
    fake.on("POST", /^\/api\/desktop\/bot-keys$/, { status: 201, body: { key: "bot-b2", key_id: "key_b2" } });
    bots.add("b2");
    const before = revokes().length;
    homeFrom(make()); cloud(runtime, A); runtime.secrets.setBotKey("b1", { token: "bot-new", keyId: "key_new" }); await runtime.probe.refresh();
    await runtime.start();
    expect(revokes()).toHaveLength(before);
    expect(await runtime.services()!.bindings.reconnect("b2")).toMatchObject({ ok: true });
    expect(revokes()).toHaveLength(before);
    // behavioural (was a source slice): a Reconnect whose mint meets a live key this home never minted holds and revokes nothing
    binding("b3", { state: "restored_unverified", emailKeyRef: "key_src3" });
    bots.add("b3");
    fake.on("POST", /^\/api\/desktop\/bot-keys$/, fluxError(409, "bot_key_exists", { key_id: "key_foreign" }));
    expect(await runtime.services()!.bindings.reconnect("b3")).toMatchObject({ ok: false, code: "rotation_live_conflict" });
    expect(revokes()).toHaveLength(before);
  });
});

describe("restore while the source home still runs (CLOUD-EMAIL-KEYSTORE-1019 open question 2)", () => {
  it("boot revokes no key while the binding is restored_unverified, and keeps the rotation intent for the Reconnect", async () => {
    binding("b1", { state: "restored_unverified" });
    const services = runtime.services()!;
    // the restored copy carries the source home's rotation intent; its old key may be the live key of the source home
    services.store.setCursor("rotate:b1", JSON.stringify({ oldKeyId: "key_old", opId: "op-r", at: clock }), clock);
    runtime.secrets.setBotKey("b1", { token: "bot-new", keyId: "key_new" });
    fake.on("DELETE", /^\/api\/desktop\/bot-keys\/key_old$/, { status: 200, body: {} });
    await runtime.start(); runtime.stop();
    expect(fake.calls("DELETE", /^\/api\/desktop\/bot-keys\//)).toHaveLength(0);
    expect(fake.calls("POST", /^\/api\/desktop\/bot-keys$/)).toHaveLength(0);
    expect(services.store.getCursor("rotate:b1")).not.toBeNull();
  });
});

describe("F22 and L2: bot deletion intents (2.6)", () => {
  it("record then withdraw (saveBots failed): no intent, the binding untouched", () => {
    binding();
    const hooks = runtime.deletionHooks();
    hooks.record("b1"); hooks.withdraw("b1");
    expect(runtime.services()!.store.tombstones()).toEqual([]);
    expect(runtime.services()!.store.getBinding("b1")!.state).toBe("active");
  });
  it("record then commit: the binding is removing at once, open rows withdrawn(bot_deleted), the reaper runs the removal", async () => {
    binding();
    const held = await heldByOwner() as { row?: { sendId: string; state: string } };
    expect(held.row?.state).toBe("awaiting_owner");
    fake.on("DELETE", /^\/v1\/email\/inboxes\/ibx_1$/, { status: 202, body: { id: "ibx_1", state: "closing" } });
    const hooks = runtime.deletionHooks();
    hooks.record("b1"); bots.delete("b1"); hooks.commit("b1");
    const store = runtime.services()!.store;
    expect(store.getBinding("b1")!.state).toBe("removing");
    expect(store.getSend(held.row!.sendId)).toMatchObject({ state: "withdrawn", code: "bot_deleted" });
    expect(store.tombstones()[0]).toMatchObject({ state: "removing", committed: true, reason: "bot_deleted" });
    await runtime.services()!.bindings.reap();
    expect(store.getBinding("b1")!.state).toBe("remove_requested");
  });
  it("boot: bot still here -> dropped; bot gone with proof -> committed; bot gone without proof -> untouched (L2)", async () => {
    binding("b1"); binding("b2", { inboxId: "ibx_2" }); binding("b3", { inboxId: "ibx_3" });
    const hooks = runtime.deletionHooks();
    for (const id of ["b1", "b2", "b3"]) hooks.record(id);
    bots = new Set(["b1"]); proofs = new Set(["b2"]);
    fake.always("DELETE", /^\/v1\/email\/inboxes\/ibx_2$/, { status: 202, body: { state: "closing" } });
    fake.always("GET", /^\/v1\/email\/inboxes\/ibx_2$/, { status: 200, body: { state: "closing" } });
    await runtime.start(); runtime.stop();
    const store = runtime.services()!.store;
    const tomb = (id: string) => store.tombstones().find(item => item.botId === id);
    expect(tomb("b1")).toBeUndefined();
    expect(tomb("b2")).toMatchObject({ committed: true });
    expect(store.getBinding("b2")!.state).toBe("remove_requested");
    expect(tomb("b3")).toMatchObject({ committed: false, state: "removing" });
    expect(store.getBinding("b3")!.state).toBe("active");
    expect(fake.calls("DELETE", /^\/v1\/email\/inboxes\/ibx_3$/)).toHaveLength(0);
  });
  it("with email off now, the hooks still write the intent when the tables exist, and never create them when they do not", () => {
    binding();
    fake.always("GET", /^\/v1\/email\/capabilities$/, { status: 200, body: { enabled: false } });
    const off = make();
    return off.probe.refresh().then(() => {
      off.deletionHooks().record("b1"); off.deletionHooks().commit("b1");
      expect(db.prepare("SELECT committed FROM email_tombstones WHERE bot_id='b1'").get()).toBeTruthy();
      const empty = new DatabaseSync(":memory:");
      const other = createMemoryEmailRuntime({ accountKey: () => null, database: () => empty, transaction: fn => fn(), workspaceRoot: () => undefined, bot: () => undefined });
      other.deletionHooks().record("b1");
      expect(empty.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'email_%'").all()).toEqual([]);
    });
  });
});

describe("F4: a pending approval with no local row", () => {
  it("is adopted as a held row with no payload on the bot's main thread (Don't send only), never approved", async () => {
    binding();
    fake.on("GET", /^\/v1\/email\/approvals$/, { status: 200, body: { data: [{ id: "apr_9", inbox_id: "ibx_1", state: "pending", held_ids: ["hld_9"] }] } });
    fake.on("GET", /^\/v1\/email\/approvals\/apr_9$/, { status: 200, body: { id: "apr_9", inbox_id: "ibx_1", held: [{ id: "hld_9", state: "pending", client_reference: "snd-lost", to: ["jane@acme.test"], subject: "Thursday", text: "Hi" }] } });
    await runtime.start(); runtime.stop();
    const row = runtime.services()!.store.getSend("snd-lost");
    expect(row).toMatchObject({ state: "held", threadId: "t-b1", heldIds: ["hld_9"], approvalId: "apr_9", why: "adopted" });
    expect(runtime.services()!.store.getPayload("snd-lost")).toEqual([]);
    expect(fake.calls("POST", /\/approve$/)).toHaveLength(0);
  });
});

describe("F29 account Off and account change (section 8)", () => {
  it("account Off: bindings account_off, open rows withdrawn(account_off)", async () => {
    binding();
    const held = await heldByOwner() as { row?: { sendId: string } };
    runtime.services()!.bindings.accountState(false);
    expect(runtime.services()!.store.getBinding("b1")!.state).toBe("account_off");
    expect(runtime.services()!.store.getSend(held.row!.sendId)).toMatchObject({ state: "withdrawn", code: "account_off" });
  });
  it("events from another account move the binding to restored_unverified; a binding without one records it", () => {
    binding("b1", { fluxAccountId: "acct_A" }); binding("b2", { inboxId: "ibx_2" });
    runtime.services()!.bindings.noteAccount("acct_B", "key_owner"); // r6 F3: stamped only for the owner credential that proved the row
    expect(runtime.services()!.store.getBinding("b1")!.state).toBe("restored_unverified");
    expect(runtime.services()!.store.getBinding("b2")).toMatchObject({ state: "active", fluxAccountId: "acct_B" });
  });
});

describe("EMAIL-ACCOUNT-CHANGE: bot email follows a Flux account change", () => {
  const cursorRefused = fluxError(400, "invalid_request", { param: "cursor" });
  const newKey = { status: 201, body: { key: "bot-email-key-new", key_id: "key_new" } };
  const svc = () => runtime.services()!;
  beforeEach(() => {
    fake.always("GET", /^\/v1\/email\/approvals$/, { status: 200, body: { data: [] } });
    fake.always("GET", /^\/v1\/email\/inboxes\/[^/]+\/messages$/, { status: 200, body: { data: [] } });
  });

  it("a new owner key on the same account: the dead cursor is dropped and the reader goes on from the head", async () => {
    binding();
    svc().store.setCursor("events", "c_old", clock);
    fake.on("GET", /^\/v1\/email\/events$/, cursorRefused);
    fake.always("GET", /^\/v1\/email\/inboxes\/ibx_1$/, { status: 200, body: { id: "ibx_1", bot_id: "b1", state: "active" } });
    expect(await svc().events.pollOnce()).toBe("ok");
    expect(svc().store.getCursor("events")).toBeNull();
    expect(svc().store.getBinding("b1")).toMatchObject({ state: "active", inboxId: "ibx_1" });
    expect(fake.calls("GET", /^\/v1\/email\/inboxes\/ibx_1\/messages$/)).toHaveLength(1);
    fake.on("GET", /^\/v1\/email\/events$/, { status: 200, body: { data: [], next_cursor: "c_new" } });
    expect(await svc().events.pollOnce()).toBe("ok");
    expect(fake.calls("GET", /^\/v1\/email\/events$/)[1]!.query.get("cursor")).toBeNull();
  });

  it("a different account that already has this bot's inbox: the inbox is adopted with a new key, no new inbox", async () => {
    binding();
    svc().store.setCursor("events", "c_old", clock);
    fake.on("GET", /^\/v1\/email\/events$/, cursorRefused);
    fake.on("GET", /^\/v1\/email\/inboxes\/ibx_1$/, fluxError(404, "inbox_not_found"));
    fake.on("GET", /^\/v1\/email\/inboxes$/, { status: 200, body: { data: [{ id: "ibx_9", bot_id: "b1", address: "juniper2@murage.email", state: "active" }] } });
    fake.on("POST", /^\/api\/desktop\/bot-keys$/, newKey);
    expect(await svc().events.pollOnce()).toBe("ok");
    expect(svc().store.getBinding("b1")).toMatchObject({ state: "active", inboxId: "ibx_9", address: "juniper2@murage.email", emailKeyRef: "key_new", failure: null });
    expect(runtime.secrets.botKey("b1")?.keyId).toBe("key_new");
    expect(fake.calls("POST", /^\/v1\/email\/inboxes$/)).toHaveLength(0);
    expect(svc().store.getCursor("events")).toBeNull();
  });

  it("a different account without the inbox: Reconnect sets the bot up again on it, with the same username", async () => {
    binding();
    const held = await heldByOwner() as { row?: { sendId: string } };
    svc().store.setCursor("events", "c_old", clock);
    fake.on("GET", /^\/v1\/email\/events$/, cursorRefused);
    fake.on("GET", /^\/v1\/email\/inboxes\/ibx_1$/, fluxError(404, "inbox_not_found"));
    fake.always("GET", /^\/v1\/email\/inboxes$/, { status: 200, body: { data: [] } });
    expect(await svc().events.pollOnce()).toBe("ok");
    expect(svc().store.getBinding("b1")).toMatchObject({ state: "restored_unverified", failure: "account_changed" });
    expect(svc().store.getSend(held.row!.sendId)).toMatchObject({ state: "withdrawn" });
    // nothing paid is made without the owner's press
    expect(fake.calls("POST", /^\/v1\/email\/inboxes$/)).toHaveLength(0);
    fake.on("POST", /^\/api\/desktop\/bot-keys$/, newKey);
    fake.on("POST", /^\/v1\/email\/inboxes$/, { status: 201, body: { id: "ibx_20", bot_id: "b1", address: "juniper@murage.email", state: "active", send_policy: "auto" } });
    expect(await svc().bindings.reconnect("b1")).toMatchObject({ ok: true });
    expect(svc().store.getBinding("b1")).toMatchObject({ state: "active", inboxId: "ibx_20", emailKeyRef: "key_new", failure: null });
    expect(fake.calls("POST", /^\/v1\/email\/inboxes$/)[0]!.body).toMatchObject({ bot_id: "b1", username: "juniper", display_name: "Juniper" });
  });

  it("an unanswered #5 keeps the cursor and backs off, so the next poll checks again", async () => {
    binding();
    svc().store.setCursor("events", "c_old", clock);
    fake.on("GET", /^\/v1\/email\/events$/, cursorRefused);
    fake.on("GET", /^\/v1\/email\/inboxes\/ibx_1$/, { status: 503, body: { error: "capability_unavailable", message: "x" } });
    expect(await svc().events.pollOnce()).toBe("backoff");
    expect(svc().store.getCursor("events")).toBe("c_old");
    expect(svc().store.getBinding("b1")).toMatchObject({ state: "active" });
  });

  it("events from another account: the binding waits, then adopts this account's inbox for the bot", async () => {
    binding("b1", { fluxAccountId: "acct_A" });
    fake.on("GET", /^\/v1\/email\/inboxes$/, { status: 200, body: { data: [{ id: "ibx_9", bot_id: "b1", address: "juniper@murage.email", state: "paused" }] } });
    fake.on("POST", /^\/api\/desktop\/bot-keys$/, newKey);
    expect(svc().bindings.noteAccount("acct_B").map(row => row.failure)).toEqual(["account_changed"]);
    expect(await svc().bindings.adoptAccountChanged()).toBe(true);
    expect(svc().store.getBinding("b1")).toMatchObject({ state: "paused", inboxId: "ibx_9", fluxAccountId: "acct_B", failure: null });
  });

  it("a restored backup (no account change) keeps today's Reconnect: no inbox on the account is inbox_not_found, nothing is made", async () => {
    binding("b1", { state: "restored_unverified" });
    fake.on("GET", /^\/v1\/email\/inboxes$/, { status: 200, body: { data: [] } });
    expect(await svc().bindings.reconnect("b1")).toMatchObject({ ok: false, code: "inbox_not_found" });
    expect(fake.calls("POST", /^\/api\/desktop\/bot-keys$/)).toHaveLength(0);
    expect(svc().store.getBinding("b1")).toMatchObject({ state: "restored_unverified" });
  });

  // ---- round 2 (Astra r1: three Highs and a Medium) ----

  const accountGone = () => {
    binding();
    svc().store.setCursor("events", "c_old", clock);
    fake.on("GET", /^\/v1\/email\/events$/, cursorRefused);
    fake.on("GET", /^\/v1\/email\/inboxes\/ibx_1$/, fluxError(404, "inbox_not_found"));
  };
  const theirInbox = { status: 200, body: { data: [{ id: "ibx_9", bot_id: "b1", address: "juniper2@murage.email", state: "active" }] } };

  it("r2 High 1: a failed adoption leaves a pending mark; the idle reader does not strand it, the tick finishes it", async () => {
    accountGone();
    fake.on("GET", /^\/v1\/email\/inboxes$/, { status: 503, body: { error: "capability_unavailable", message: "x" } });
    expect(await svc().events.pollOnce()).toBe("backoff");
    expect(svc().store.getBinding("b1")).toMatchObject({ state: "restored_unverified", failure: "account_changed" });
    expect(svc().store.getCursor("events")).toBe("c_old");
    expect(svc().store.getCursor("account-reconcile")).not.toBeNull();
    // nothing receives now, so the reader idles; the mark is what carries the retry
    expect(await svc().events.pollOnce()).toBe("idle");
    // the tick waits its backoff, then runs it again
    expect(await svc().events.reconcileAccount()).toBe(false);
    expect(fake.calls("GET", /^\/v1\/email\/inboxes$/)).toHaveLength(1);
    clock += 10_000;
    fake.on("GET", /^\/v1\/email\/inboxes$/, theirInbox);
    fake.on("POST", /^\/api\/desktop\/bot-keys$/, newKey);
    expect(await svc().events.reconcileAccount()).toBe(true);
    expect(svc().store.getBinding("b1")).toMatchObject({ state: "active", inboxId: "ibx_9", emailKeyRef: "key_new", failure: null });
    expect(svc().store.getCursor("events")).toBeNull();
    expect(svc().store.getCursor("account-reconcile")).toBeNull();
  });

  it("r2 High 1: a failed adoption is finished by the next boot", async () => {
    accountGone();
    fake.on("POST", /^\/api\/desktop\/bot-keys$/, "reset");
    fake.on("GET", /^\/v1\/email\/inboxes$/, theirInbox);
    expect(await svc().events.pollOnce()).toBe("backoff");
    expect(svc().store.getBinding("b1")).toMatchObject({ state: "restored_unverified", failure: "account_changed" });
    runtime.stop();
    runtime = make();
    runtime.secrets.setOwner({ token: "owner-fixture", keyId: "key_owner" });
    await runtime.probe.refresh();
    runtime.stop();
    fake.on("GET", /^\/v1\/email\/inboxes$/, theirInbox);
    fake.on("POST", /^\/api\/desktop\/bot-keys$/, newKey);
    await runtime.start();
    expect(svc().store.getBinding("b1")).toMatchObject({ state: "active", inboxId: "ibx_9", emailKeyRef: "key_new", failure: null });
    expect(svc().store.getCursor("events")).toBeNull();
    expect(svc().store.getCursor("account-reconcile")).toBeNull();
  });

  it("r2 High 1: events from another account with an unanswered list keep the mark; the tick adopts later", async () => {
    binding("b1", { fluxAccountId: "acct_A" });
    fake.on("GET", /^\/v1\/email\/events$/, { status: 200, body: { data: [{ id: "eev_1", type: "email.message.received", account_id: "acct_B", inbox_id: "ibx_other", created: "2026-11-06T00:00:00Z", data: {} }], next_cursor: "c_2" } });
    fake.on("GET", /^\/v1\/email\/inboxes$/, "reset");
    expect(await svc().events.pollOnce()).toBe("ok");
    expect(svc().store.getBinding("b1")).toMatchObject({ state: "restored_unverified", failure: "account_changed" });
    expect(svc().store.getCursor("account-reconcile")).not.toBeNull();
    clock += 10_000;
    fake.on("GET", /^\/v1\/email\/inboxes$/, theirInbox);
    fake.on("POST", /^\/api\/desktop\/bot-keys$/, newKey);
    expect(await svc().events.reconcileAccount()).toBe(true);
    expect(svc().store.getBinding("b1")).toMatchObject({ state: "active", inboxId: "ibx_9", fluxAccountId: "acct_B" });
    // an adoption-only run never drops a working cursor
    expect(svc().store.getCursor("events")).toBe("c_2");
  });

  it("r2 High 2: the account check withdraws only sends that never reached Flux; an in-flight send still lands as sent", async () => {
    runtime.secrets.setBotKey("b1", { token: "bot-old", keyId: "key_old" });
    accountGone();
    fake.always("GET", /^\/v1\/email\/inboxes$/, { status: 200, body: { data: [] } });
    svc().store.addTrusted("b1", "friend@acme.test", "allow", "owner", clock);
    let answer!: (reply: { status: number; body: unknown }) => void;
    fake.on("POST", /^\/v1\/email\/inboxes\/ibx_1\/messages$/, () => new Promise(resolve => { answer = resolve as typeof answer; }));
    const inFlight = svc().send.submit({ botId: "b1", generation: 1, threadId: "t-b1", draft: { kind: "send", to: ["friend@acme.test"], cc: [], subject: "Hi", text: "Hi", attachments: [], replyTo: null } });
    await vi.waitFor(() => expect(fake.calls("POST", /^\/v1\/email\/inboxes\/ibx_1\/messages$/)).toHaveLength(1));
    const owner = await heldByOwner() as { row?: { sendId: string } };
    const flying = svc().store.sendsOfBot("b1", ["dispatching"]);
    expect(flying).toHaveLength(1);
    expect(await svc().events.pollOnce()).toBe("ok");
    expect(svc().store.getBinding("b1")).toMatchObject({ state: "restored_unverified", failure: "account_changed" });
    expect(svc().store.getSend(owner.row!.sendId)).toMatchObject({ state: "withdrawn", code: "account_off" });
    expect(svc().store.getSend(flying[0]!.sendId)).toMatchObject({ state: "dispatching" });
    answer({ status: 200, body: { object: "email.send", status: "sent", message_id: "msg_late" } });
    await inFlight;
    expect(svc().store.getSend(flying[0]!.sendId)).toMatchObject({ state: "sent" });
  });

  it("r2 High 3: a crash after Reconnect committed the new setup but before the old key was cleared never reuses the old key", async () => {
    let persisted: unknown = null;
    runtime.stop();
    runtime = make({ persistSecrets: doc => { persisted = JSON.parse(JSON.stringify(doc)); } });
    runtime.secrets.setOwner({ token: "owner-fixture", keyId: "key_owner" });
    await runtime.probe.refresh();
    binding("b1", { state: "restored_unverified", failure: "account_changed" });
    runtime.secrets.setBotKey("b1", { token: "bot-old", keyId: "key_old" });
    fake.on("GET", /^\/v1\/email\/inboxes$/, { status: 200, body: { data: [] } });
    // the crash: the new setup op is in the database, the shell never saved the key's removal
    const crash = vi.spyOn(runtime.secrets, "replaceBotKey").mockImplementationOnce(() => { throw new Error("process killed"); });
    await expect(svc().bindings.reconnect("b1")).rejects.toThrow("process killed");
    crash.mockRestore();
    expect(svc().store.getBinding("b1")).toMatchObject({ state: "provisioning", step: "key" });
    expect((persisted as { bots: Record<string, { keyId: string }> }).bots.b1?.keyId).toBe("key_old");
    // restart: the shell pushes what it saved (the old key is still there)
    runtime.stop();
    runtime = make({ persistSecrets: doc => { persisted = JSON.parse(JSON.stringify(doc)); } });
    runtime.secrets.replaceAll(persisted);
    expect(runtime.secrets.botKey("b1")?.keyId).toBe("key_old");
    await runtime.probe.refresh();
    runtime.stop();
    fake.on("POST", /^\/api\/desktop\/bot-keys$/, newKey);
    fake.on("POST", /^\/v1\/email\/inboxes$/, { status: 201, body: { id: "ibx_20", bot_id: "b1", address: "juniper@murage.email", state: "active", send_policy: "auto" } });
    await runtime.start();
    expect(fake.calls("POST", /^\/api\/desktop\/bot-keys$/)).toHaveLength(1);
    const create = fake.calls("POST", /^\/v1\/email\/inboxes$/);
    expect(create).toHaveLength(1);
    expect(JSON.stringify(create[0]!.headers)).not.toContain("bot-old");
    expect(runtime.secrets.botKey("b1")?.keyId).toBe("key_new");
    expect(svc().store.getBinding("b1")).toMatchObject({ state: "active", inboxId: "ibx_20", emailKeyRef: "key_new" });
    expect(svc().store.getCursor("setup-stale-key:b1")).toBeNull();
  });

  it("r2 Medium: a bare 404 (no inbox_not_found) is not an account change: the binding stays, the cursor stays", async () => {
    binding();
    svc().store.setCursor("events", "c_old", clock);
    fake.on("GET", /^\/v1\/email\/events$/, cursorRefused);
    fake.on("GET", /^\/v1\/email\/inboxes\/ibx_1$/, { status: 404, body: "not found" });
    expect(await svc().events.pollOnce()).toBe("backoff");
    expect(svc().store.getBinding("b1")).toMatchObject({ state: "active", inboxId: "ibx_1", failure: null });
    expect(svc().store.getCursor("events")).toBe("c_old");
    expect(fake.calls("GET", /^\/v1\/email\/inboxes$/)).toHaveLength(0);
  });
});

describe("F30 resting", () => {
  it("402 key_budget_reached is the calm resting line", () => { expect(codeLine("key_budget_reached")).toBe(EMAIL_LINES.resting); });
});

describe("retention runs (Astra r1 High: the email tables never grow without bound)", () => {
  const DAY = 86_400_000;
  const sendRow = (sendId: string, state: SendState, settledAt: number | null): SendRow => ({
    sendId, botId: "b1", generation: 1, threadId: "t-b1", inboxId: "ibx_1", kind: "send", replyMessageId: null, payloadHash: `h-${sendId}`,
    summary: { to: ["a@x.test"], cc: [], subject: "s", textLength: 1, attachments: [], replySource: null }, idemSuffix: 1, state, code: null, why: null,
    stopRequested: false, ownerSent: false, replaces: null, receipt: null, revision: 1, attempts: [], heldIds: [], approvalId: null, messageId: null,
    reconcileStep: 0, dueAt: null, createdAt: clock - 400 * DAY, updatedAt: clock - 400 * DAY, dispatchedAt: null, settledAt, deliveryNote: null,
  });
  const part = () => [{ part: 0, name: null, contentType: "application/json", size: 2, sha256: "0".repeat(64), data: new Uint8Array([123, 125]) }];
  const event = (id: string, receivedAt: number) => runtime.services()!.store.recordEvent({ eventId: id, type: "email.message.received", inboxId: "ibx_1", botId: "b1", clientReference: null, heldId: null, created: null, data: {} }, receivedAt);
  const count = (table: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);

  it("boot prunes settled sends' bytes after 30 days, their records after 180 and events after the keep window; open sends stay", async () => {
    binding();
    const store = runtime.services()!.store;
    for (const [id, state, settled] of [["old", "sent", clock - 200 * DAY], ["month", "declined", clock - 40 * DAY], ["recent", "sent", clock - DAY], ["open", "unknown_expired", null]] as const) {
      store.insertSend(sendRow(id, state, settled)); store.putPayload(id, part());
    }
    event("e-old", clock - EMAIL_EVENT_KEEP_MS - DAY); event("e-new", clock - DAY);
    await runtime.start(); runtime.stop();
    expect(store.getSend("old")).toBeNull();
    expect(store.getSend("month")).not.toBeNull();
    expect(store.getPayload("month")).toEqual([]);
    expect(store.getPayload("recent")).toHaveLength(1);
    expect(store.getPayload("open")).toHaveLength(1);
    expect(store.getSend("open")).not.toBeNull();
    expect(store.hasEvent("e-old")).toBe(false);
    expect(store.hasEvent("e-new")).toBe(true);
  });

  it("Astra r2 Medium: the payload step keeps a scan cursor, so a pass never rescans sends whose bytes are already gone", () => {
    const store = new EmailStore(new DatabaseSync(":memory:"));
    const old = clock - 40 * DAY;
    for (const [i, id] of ["s1", "s2", "s3"].entries()) { store.insertSend(sendRow(id, "sent", old + i)); if (id === "s3") store.putPayload(id, part()); }
    expect(store.pruneSettledSends(clock, undefined, undefined, 2)).toEqual({ payloads: 0, rows: 0 });
    expect(store.getCursor(PRUNE_PAYLOADS_SCOPE)).toBe(`${old + 1}|s2`);
    expect(store.pruneSettledSends(clock, undefined, undefined, 2)).toEqual({ payloads: 1, rows: 0 });
    expect(store.getPayload("s3")).toEqual([]);
    expect(store.getCursor(PRUNE_PAYLOADS_SCOPE)).toBe(`${old + 2}|s3`);
    // nothing new past the cutoff: the cursor stays and nothing is scanned again
    expect(store.pruneSettledSends(clock, undefined, undefined, 2)).toEqual({ payloads: 0, rows: 0 });
    expect(store.getCursor(PRUNE_PAYLOADS_SCOPE)).toBe(`${old + 2}|s3`);
    // a send that settles later is past the cursor and is pruned once it is old enough; an open send never is
    store.insertSend(sendRow("s4", "declined", clock)); store.putPayload("s4", part());
    store.insertSend(sendRow("open", "unknown_expired", null)); store.putPayload("open", part());
    expect(store.pruneSettledSends(clock + 31 * DAY, undefined, undefined, 2)).toEqual({ payloads: 1, rows: 0 });
    expect(store.getPayload("s4")).toEqual([]);
    expect(store.getPayload("open")).toHaveLength(1);
  });

  it("each pass is bounded, and the tick runs it again until the backlog is gone", async () => {
    // the probe in beforeEach already started a real tick: stop it, so start() makes the tick on the fake clock
    runtime.stop();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      binding();
      const store = runtime.services()!.store;
      const old = clock - EMAIL_EVENT_KEEP_MS - DAY;
      for (let i = 0; i < EMAIL_PRUNE_BATCH * 2 + 7; i++) event(`e-${i}`, old + i);
      await runtime.start();
      expect(count("email_events")).toBe(EMAIL_PRUNE_BATCH + 7);
      vi.advanceTimersByTime(PRUNE_TICKS * 30_000);
      expect(count("email_events")).toBe(7);
      vi.advanceTimersByTime(PRUNE_TICKS * 30_000);
      expect(count("email_events")).toBe(0);
      expect(store.hasEvent("e-0")).toBe(false);
    } finally {
      runtime.stop();
      vi.useRealTimers();
    }
  });
});
