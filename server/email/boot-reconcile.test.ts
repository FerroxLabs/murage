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
import { EMAIL_LINES, codeLine } from "./tools.ts";
import { FakeFlux, fluxError } from "../testing/fake-flux-email.ts";
import type { BotRecord } from "../store.ts";

const CAPS = { object: "email.capabilities", enabled: true, available: true, account_state: "active", terms_version: "v1", limits: {} };
let fake: FakeFlux;
let db: DatabaseSync;
let runtime: EmailRuntime;
let clock: number;
let bots: Set<string>;
let proofs: Set<string>;

const make = () => new EmailRuntime({
  accountKey: () => "sk-flux-account-fixture", database: () => db, transaction: fn => fn(), fetch: fake.fetch, apiBase: "https://api.flux.test", appBase: "https://app.flux.test",
  now: () => clock, workspaceRoot: () => undefined, bot: id => (bots.has(id) ? { id, name: "Juniper", threadId: `t-${id}` } as unknown as BotRecord : undefined),
  deletionProof: id => proofs.has(id),
});
const binding = (botId = "b1", patch: Record<string, unknown> = {}) => runtime.services()!.store.insertBinding({ botId, inboxId: "ibx_1", address: "juniper@murage.email", username: "juniper", displayName: "Juniper", emailKeyRef: "key_old", fluxAccountId: null, state: "active", step: null, opId: null, opStartedAt: null, policy: "auto", failure: null, updatedAt: clock, ...patch } as never);
const heldByOwner = () => runtime.services()!.send.submit({ botId: "b1", generation: 1, threadId: "t-b1", draft: { kind: "send", to: ["stranger@acme.test"], cc: [], subject: "Hi", text: "Hi", attachments: [], replyTo: null } });

beforeEach(async () => {
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
  it("a key already stored at step key skips to inbox; 409 inbox_exists is adopted", async () => {
    binding("b1", { inboxId: null, address: null, state: "provisioning", step: "key", opId: "op-1", opStartedAt: clock - 1000 });
    runtime.secrets.setBotKey("b1", { token: "bot-new", keyId: "key_new" });
    fake.on("POST", /^\/v1\/email\/inboxes$/, fluxError(409, "inbox_exists", { inbox_id: "ibx_7" }));
    fake.on("GET", /^\/v1\/email\/inboxes\/ibx_7$/, { status: 200, body: { id: "ibx_7", address: "juniper@murage.email", state: "active" } });
    await runtime.start(); runtime.stop();
    expect(fake.calls("POST", /^\/api\/desktop\/bot-keys$/)).toHaveLength(0);
    expect(runtime.services()!.store.getBinding("b1")).toMatchObject({ state: "active", inboxId: "ibx_7", emailKeyRef: "key_new" });
  });
  it("inside 24 h the same op id is replayed; past 24 h the step reruns with a new op id", async () => {
    binding("b1", { inboxId: null, address: null, state: "provisioning", step: "key", opId: "op-1", opStartedAt: clock - 1000 });
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
    services.store.setCursor("rotate:b1", JSON.stringify({ oldKeyId: "key_old", opId: "op-r", at: clock }), clock);
    runtime.secrets.setBotKey("b1", { token: "bot-new", keyId: "key_new" });
    fake.on("DELETE", /^\/api\/desktop\/bot-keys\/key_old$/, { status: 200, body: {} });
    await runtime.start(); runtime.stop();
    expect(fake.calls("DELETE", /^\/api\/desktop\/bot-keys\/key_old$/)).toHaveLength(1);
    expect(fake.calls("POST", /^\/api\/desktop\/bot-keys$/)).toHaveLength(0);
    expect(services.store.getCursor("rotate:b1")).toBeNull();
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
      const other = new EmailRuntime({ accountKey: () => null, database: () => empty, transaction: fn => fn(), workspaceRoot: () => undefined, bot: () => undefined });
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
    runtime.services()!.bindings.noteAccount("acct_B");
    expect(runtime.services()!.store.getBinding("b1")!.state).toBe("restored_unverified");
    expect(runtime.services()!.store.getBinding("b2")).toMatchObject({ state: "active", fluxAccountId: "acct_B" });
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
