// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// r3.2k product fixes (Astra H1, H2, M1, M4; Opus L1): a stale Reconnect or rotation answer never saves a key after the binding was removed or
// replaced; Reconnect makes its key durable before it commits active, and boot finishes an interrupted one (a crash test at every step of the save
// sequence); every key operation of a bot is serial; the 4th 409 of one press holds with the owner line; a key a rotation intent protects holds.
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { FluxEmailClient } from "./flux-email-client.ts";
import { EmailSecretStore, emailCredentialProvider } from "./email-secrets.ts";
import { EmailStore } from "./email-store.ts";
import { EmailBindingService, KEY_IDEMPOTENCY_WINDOW_MS } from "./binding-service.ts";
import { FakeFlux, fluxError, type FakeRequest } from "../testing/fake-flux-email.ts";

let clock = 0;
let fake: FakeFlux;
let store: EmailStore;
let secrets: EmailSecretStore;
let service: EmailBindingService;
let n = 0;
let made: Map<string, string>;
/** The supervisor's copy of the secret doc: updated only when a durable() is acknowledged. */
let acked: unknown;
let pending: unknown;
let durableHook: () => Promise<void>;

const mkClient = (s: EmailSecretStore) => new FluxEmailClient({ fetch: fake.fetch, apiBase: "https://api.flux.test", appBase: "https://app.flux.test", credentials: emailCredentialProvider(s, () => null), timeoutMs: 100 });
const mkService = (s: EmailSecretStore) => new EmailBindingService({ store, client: mkClient(s), secrets: s, installId: "inst", now: () => clock, newId: () => `op-${++n}` });
const mkSecrets = () => new EmailSecretStore(doc => { pending = doc; }, async () => { await durableHook(); acked = pending; return true; });
const restored = (botId = "b1", inboxId = "ibx_1") => store.insertBinding({ botId, inboxId, address: "juniper@murage.email", username: null, displayName: null, emailKeyRef: "key_src", fluxAccountId: "acct1", state: "restored_unverified", step: null, opId: null, opStartedAt: null, policy: "auto", failure: null, updatedAt: clock });

beforeEach(() => {
  clock = 1_800_000_000_000; n = 0; made = new Map(); acked = { bots: {} }; pending = { bots: {} }; durableHook = async () => {};
  fake = new FakeFlux();
  store = new EmailStore(new DatabaseSync(":memory:"));
  secrets = mkSecrets();
  secrets.setOwner({ token: "owner-token", keyId: "key_owner" });
  service = mkService(secrets);
  restored();
  fake.always("GET", /^\/v1\/email\/inboxes$/, { status: 200, body: { data: [{ id: "ibx_1", bot_id: "b1", state: "active", address: "juniper@murage.email" }] } });
});

const idemMint = (request: FakeRequest) => {
  const idem = request.headers["idempotency-key"] ?? "";
  if (!made.has(idem)) made.set(idem, `key_m${made.size + 1}`);
  const keyId = made.get(idem)!;
  return { status: 200, body: { key: `sk-${keyId}`, key_id: keyId } };
};
const mints = () => fake.calls("POST", /bot-keys$/);
const deletes = () => fake.calls("DELETE", /bot-keys\//);
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 5)); };
const deferred = () => { let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); return { gate, release }; };
const OTHER = (k: string) => `This bot already has another email key, ${k}. Revoke it in your Flux account, then press Reconnect.`;

describe("r3.2k H1: a stale Reconnect answer after a removal or a replacement fails closed", () => {
  const stalePress = () => {
    const d = deferred();
    fake.always("POST", /bot-keys$/, async request => { const reply = idemMint(request); if (request.headers["idempotency-key"]?.includes("op-1")) await d.gate; return reply; });
    return d;
  };
  const removeBinding = async () => {
    fake.on("DELETE", /\/v1\/email\/inboxes\/ibx_1$/, { status: 404, body: { error: "inbox_not_found", message: "gone" } });
    await service.remove("b1");
  };
  it("remove, then a NEW setup that saves its own key Y; the late answer of the old press: nothing saved, Y untouched, the revoked X never installed", async () => {
    const d = stalePress();
    const press = service.reconnect("b1");
    await tick();
    expect(mints()).toHaveLength(1);
    await removeBinding();
    expect(store.getBinding("b1")).toBeNull();
    fake.always("POST", /\/v1\/email\/inboxes$/, { status: 201, body: { id: "ibx_2", bot_id: "b1", address: "new@murage.email", state: "active", send_policy: "auto" } });
    await service.enable("b1", { username: "new", displayName: "New" });
    const replacement = secrets.botKey("b1");
    expect(replacement).not.toBeNull();
    expect(store.getBinding("b1")).toMatchObject({ inboxId: "ibx_2" });
    d.release();
    const result = await press;
    expect(result.ok).toBe(false);
    expect(secrets.botKey("b1")).toEqual(replacement);
    expect(secrets.botKey("b1")!.keyId).not.toBe("key_m1");
    expect(store.getBinding("b1")).toMatchObject({ inboxId: "ibx_2", emailKeyRef: replacement!.keyId });
  });
  it("a removal that lands while the key is being made durable: the press recheck fails closed, nothing is committed", async () => {
    fake.always("POST", /bot-keys$/, idemMint);
    const d = deferred();
    durableHook = async () => { await d.gate; };
    const press = service.reconnect("b1");
    await tick();
    expect(secrets.botKey("b1")).toMatchObject({ keyId: "key_m1" }); // saved, now waiting for the durable acknowledgement
    await removeBinding();
    expect(store.getBinding("b1")).toBeNull();
    d.release();
    const result = await press;
    expect(result.ok).toBe(false);
    expect(store.getBinding("b1")).toBeNull(); // no row resurrected or committed active
  });
  it("belt and braces: even if the old op were somehow current again, a replaced generation never saves (the generation check alone)", async () => {
    const d = stalePress();
    const press = service.reconnect("b1");
    await tick();
    await removeBinding();
    fake.always("POST", /\/v1\/email\/inboxes$/, { status: 201, body: { id: "ibx_2", bot_id: "b1", address: "new@murage.email", state: "active", send_policy: "auto" } });
    await service.enable("b1", { username: "new", displayName: "New" });
    const replacement = secrets.botKey("b1");
    store.setCursor("reconnect-op:b1", JSON.stringify({ opId: "op-1", at: clock }), clock);
    d.release();
    expect((await press).ok).toBe(false);
    expect(secrets.botKey("b1")).toEqual(replacement);
  });
  it("remove only (no new setup): the late answer saves no key and the binding stays gone", async () => {
    const d = stalePress();
    const press = service.reconnect("b1");
    await tick();
    await removeBinding();
    d.release();
    expect((await press).ok).toBe(false);
    expect(secrets.botKey("b1")).toBeNull();
    expect(store.getBinding("b1")).toBeNull();
  });
  it("a removal clears reconnect-op:<bot> and rotate:<bot>; a new setup clears both of an earlier generation", async () => {
    store.setCursor("reconnect-op:b1", JSON.stringify({ opId: "op-9", at: clock }), clock);
    store.setCursor("rotate:b1", JSON.stringify({ oldKeyId: "k", opId: "r-9", at: clock }), clock);
    await removeBinding();
    expect(store.getCursor("reconnect-op:b1")).toBeNull();
    expect(store.getCursor("rotate:b1")).toBeNull();
    store.setCursor("reconnect-op:b2", JSON.stringify({ opId: "op-8", at: clock }), clock);
    store.setCursor("rotate:b2", JSON.stringify({ oldKeyId: "k", opId: "r-8", at: clock }), clock);
    fake.always("POST", /bot-keys$/, idemMint);
    fake.always("POST", /\/v1\/email\/inboxes$/, { status: 201, body: { id: "ibx_3", bot_id: "b2", address: "x@murage.email", state: "active", send_policy: "auto" } });
    await service.enable("b2", { username: "x", displayName: "X" });
    expect(store.getCursor("reconnect-op:b2")).toBeNull();
    expect(store.getCursor("rotate:b2")).toBeNull();
  });
  it("a stale ROTATION answer (remove, new setup) never saves its key over the replacement's", async () => {
    store.deleteBinding("b1", store.getBinding("b1")!.revision);
    const now = clock;
    store.insertBinding({ botId: "b1", inboxId: "ibx_1", address: "juniper@murage.email", username: null, displayName: null, emailKeyRef: "key_old", fluxAccountId: "acct1", state: "active", step: null, opId: "setup-1", opStartedAt: now, policy: "auto", failure: null, updatedAt: now });
    secrets.setBotKey("b1", { token: "t-old", keyId: "key_old" });
    const d = deferred();
    fake.always("POST", /bot-keys$/, async request => { const reply = idemMint(request); if (made.size === 1) await d.gate; return reply; });
    fake.always("GET", /\/v1\/email\/inboxes\/ibx_[19]$/, { status: 200, body: { id: "ibx_1", bot_id: "b1", state: "active" } });
    fake.always("DELETE", /bot-keys\//, { status: 200, body: {} });
    const rotating = service.rotateKey("b1", () => true);
    await tick();
    expect(mints()).toHaveLength(1);
    fake.on("DELETE", /\/v1\/email\/inboxes\/ibx_1$/, { status: 404, body: { error: "inbox_not_found", message: "gone" } });
    await service.remove("b1");
    expect(store.getBinding("b1")).toBeNull();
    secrets.setBotKey("b1", { token: "t-new", keyId: "key_replacement" });
    store.insertBinding({ botId: "b1", inboxId: "ibx_9", address: "n@murage.email", username: null, displayName: null, emailKeyRef: "key_replacement", fluxAccountId: "acct1", state: "active", step: null, opId: "setup-2", opStartedAt: now, policy: "auto", failure: null, updatedAt: now });
    d.release();
    expect((await rotating).ok).toBe(false);
    expect(secrets.botKey("b1")).toMatchObject({ keyId: "key_replacement" });
  });
});

describe("r3.2k H2: a crash at every step of the Reconnect save sequence; boot leaves a consistent state", () => {
  /** Runs the press up to the crash point and abandons it (the process died); returns the state a restarted process loads. */
  const crashAt = async (point: "before-setBotKey" | "after-setBotKey-before-durable" | "after-durable-before-commit" | "after-commit") => {
    fake.always("POST", /bot-keys$/, idemMint);
    const never = new Promise<never>(() => {});
    const realSet = secrets.setBotKey.bind(secrets);
    const realCas = store.casBinding.bind(store);
    if (point === "before-setBotKey") secrets.setBotKey = () => { throw new Error("crash"); };
    if (point === "after-setBotKey-before-durable") durableHook = () => never;
    if (point === "after-durable-before-commit") store.casBinding = ((botId: string, rev: number, patch: { state?: string }, at: number) => { if (patch.state === "active") throw new Error("crash"); return realCas(botId, rev, patch as never, at); }) as typeof store.casBinding;
    const press = service.reconnect("b1").catch(() => "crashed");
    if (point === "after-commit") { await press; } else await tick();
    secrets.setBotKey = realSet; store.casBinding = realCas;
    return { press };
  };
  const restart = async () => {
    const reborn = mkSecrets();
    reborn.setOwner({ token: "owner-token", keyId: "key_owner" });
    reborn.replaceAll({ ...(acked as object), owner: { token: "owner-token", keyId: "key_owner" } });
    durableHook = async () => {};
    const boot = mkService(reborn);
    await boot.reconcileBindings();
    return { reborn, boot };
  };
  const consistent = (reborn: EmailSecretStore) => {
    const row = store.getBinding("b1")!;
    expect(row.state).toBe("active");
    expect(reborn.botKey("b1")).toMatchObject({ keyId: "key_m1" });
    expect(row.emailKeyRef).toBe(reborn.botKey("b1")!.keyId);
    expect((acked as { bots: Record<string, { keyId: string }> }).bots["b1"]?.keyId).toBe("key_m1"); // durably acknowledged
    expect(made.size).toBe(1); // exactly one key was ever made at Flux
    expect(deletes()).toHaveLength(0);
  };
  it("crash before setBotKey: restored, no key; boot replays the op and finishes", async () => {
    await crashAt("before-setBotKey");
    expect(store.getBinding("b1")!.state).toBe("restored_unverified");
    expect(secrets.botKey("b1")).toBeNull();
    const { reborn } = await restart();
    consistent(reborn);
  });
  it("crash after setBotKey, before the key is durable: still restored (never active on a key that is not durable); boot finishes", async () => {
    await crashAt("after-setBotKey-before-durable");
    expect(secrets.botKey("b1")).toMatchObject({ keyId: "key_m1" });
    expect((acked as { bots: object }).bots).toEqual({});
    expect(store.getBinding("b1")!.state).toBe("restored_unverified");
    const { reborn } = await restart();
    consistent(reborn);
  });
  it("crash after durable, before the commit: the key is durable, the binding restored; boot commits it", async () => {
    await crashAt("after-durable-before-commit");
    expect((acked as { bots: Record<string, { keyId: string }> }).bots["b1"]?.keyId).toBe("key_m1");
    expect(store.getBinding("b1")!.state).toBe("restored_unverified");
    const { reborn } = await restart();
    consistent(reborn);
  });
  it("crash after the commit: active on a durable key; boot changes nothing and mints nothing", async () => {
    await crashAt("after-commit");
    expect(store.getBinding("b1")).toMatchObject({ state: "active", emailKeyRef: "key_m1" });
    const before = mints().length;
    const { reborn } = await restart();
    consistent(reborn);
    expect(mints()).toHaveLength(before);
  });
  it("a key that is not acknowledged: 503 save_pending, the binding stays restored, and the next press (same op) finishes", async () => {
    fake.always("POST", /bot-keys$/, idemMint);
    let ack = false;
    secrets = new EmailSecretStore(() => {}, async () => ack);
    secrets.setOwner({ token: "owner-token", keyId: "key_owner" });
    service = mkService(secrets);
    expect(await service.reconnect("b1")).toMatchObject({ ok: false, code: "save_pending", status: 503 });
    expect(store.getBinding("b1")!.state).toBe("restored_unverified");
    ack = true;
    expect(await service.reconnect("b1")).toMatchObject({ ok: true });
    expect(made.size).toBe(1);
    expect(store.getBinding("b1")).toMatchObject({ state: "active", emailKeyRef: "key_m1" });
  });
  it("without a saved op a restored binding is NOT resumed by boot", async () => {
    fake.always("POST", /bot-keys$/, idemMint);
    await service.reconcileBindings();
    expect(mints()).toHaveLength(0);
    expect(store.getBinding("b1")!.state).toBe("restored_unverified");
  });
});

describe("r3.2k M1: one key operation per bot across Reconnect, rotateKey and boot's finishRotation", () => {
  const live = () => {
    store.deleteBinding("b1", store.getBinding("b1")!.revision);
    store.insertBinding({ botId: "b1", inboxId: "ibx_1", address: "juniper@murage.email", username: null, displayName: null, emailKeyRef: "key_old", fluxAccountId: "acct1", state: "active", step: null, opId: "setup-1", opStartedAt: clock, policy: "auto", failure: null, updatedAt: clock });
    secrets.setBotKey("b1", { token: "t-old", keyId: "key_old" });
    fake.always("GET", /\/v1\/email\/inboxes\/ibx_1$/, { status: 200, body: { id: "ibx_1", bot_id: "b1", state: "active" } });
    fake.always("DELETE", /bot-keys\//, { status: 200, body: {} });
  };
  it("a Reconnect pressed while a rotation is in flight waits for it (one mint at a time)", async () => {
    live();
    const d = deferred();
    fake.always("POST", /bot-keys$/, async request => { const reply = idemMint(request); if (made.size === 1) await d.gate; return reply; });
    const rotating = service.rotateKey("b1", () => true);
    await tick();
    expect(service.noteAccount("acct2")).toHaveLength(1); // the account changed: the binding is restored_unverified now
    const press = service.reconnect("b1");
    await tick();
    expect(mints()).toHaveLength(1); // the Reconnect has not started its mint
    d.release();
    await rotating; await press;
    expect(mints().length).toBeLessThanOrEqual(2);
  });
  it("boot's finishRotation waits for a rotateKey in flight", async () => {
    live();
    const d = deferred();
    fake.always("POST", /bot-keys$/, async request => { const reply = idemMint(request); if (mints().length === 1) await d.gate; return reply; });
    const rotating = service.rotateKey("b1", () => true);
    await tick();
    const boot = service.reconcileBindings();
    await tick();
    expect(mints()).toHaveLength(1);
    d.release();
    await rotating; await boot;
    expect(made.size).toBe(1);
    expect(secrets.botKey("b1")).toMatchObject({ keyId: "key_m1" });
  });
});

describe("r3.2k M4 + L1", () => {
  it("M4: four 409s in one press: three own strays deleted, the 4th holds with the owner line (never the raw code), no 4th delete", async () => {
    store.setCursor("minted:b1", JSON.stringify([1, 2, 3, 4].map(k => ({ keyId: `key_o${k}`, at: clock - 2 * KEY_IDEMPOTENCY_WINDOW_MS }))), clock);
    const answers = ["key_o1", "key_o2", "key_o3", "key_o4"];
    fake.always("POST", /bot-keys$/, request => { const k = answers.shift(); return k ? fluxError(409, "bot_key_exists", { key_id: k }) : idemMint(request); });
    fake.always("DELETE", /bot-keys\//, { status: 200, body: {} });
    const result = await service.reconnect("b1");
    expect(result).toMatchObject({ ok: false, code: "rotation_live_conflict", status: 409, detail: OTHER("key_o4") });
    expect(deletes().map(call => call.path)).toEqual(["/api/desktop/bot-keys/key_o1", "/api/desktop/bot-keys/key_o2", "/api/desktop/bot-keys/key_o3"]);
    expect(mints()).toHaveLength(4);
  });
  it("L1: an own key older than 24 h that a rotation intent still protects (its old key) holds: owner line, 0 DELETEs", async () => {
    store.setCursor("minted:b1", JSON.stringify([{ keyId: "key_x", at: clock - 2 * KEY_IDEMPOTENCY_WINDOW_MS }]), clock);
    store.setCursor("rotate:b1", JSON.stringify({ oldKeyId: "key_x", opId: "r-1", at: clock - 3_600_000 }), clock);
    fake.always("POST", /bot-keys$/, fluxError(409, "bot_key_exists", { key_id: "key_x" }));
    const result = await service.reconnect("b1");
    expect(result).toMatchObject({ ok: false, code: "rotation_live_conflict", detail: OTHER("key_x") });
    expect(deletes()).toHaveLength(0);
  });
});

describe("r3.2l: each generation / op check is isolated, M3 state clause, M4 post-durable recheck, pending-op age", () => {
  const goneInbox = () => fake.on("DELETE", /\/v1\/email\/inboxes\/ibx_1$/, { status: 404, body: { error: "inbox_not_found", message: "gone" } });
  const newGeneration = (state: "active" | "restored_unverified", inbox = "ibx_2", ref = "key_repl") => store.insertBinding({ botId: "b1", inboxId: inbox, address: "n@murage.email", username: null, displayName: null, emailKeyRef: ref, fluxAccountId: "acct1", state, step: null, opId: "setup-2", opStartedAt: clock, policy: "auto", failure: null, updatedAt: clock });
  const liveRow = () => {
    store.deleteBinding("b1", store.getBinding("b1")!.revision);
    store.insertBinding({ botId: "b1", inboxId: "ibx_1", address: "juniper@murage.email", username: null, displayName: null, emailKeyRef: "key_old", fluxAccountId: "acct1", state: "active", step: null, opId: "setup-1", opStartedAt: clock, policy: "auto", failure: null, updatedAt: clock });
    secrets.setBotKey("b1", { token: "t-old", keyId: "key_old" });
    fake.always("GET", /\/v1\/email\/inboxes\/ibx_[19]$/, { status: 200, body: { id: "ibx_1", bot_id: "b1", state: "active" } });
    fake.always("DELETE", /bot-keys\//, { status: 200, body: {} });
  };
  const reinstateReconnectOp = () => store.setCursor("reconnect-op:b1", JSON.stringify({ opId: "op-1", at: clock }), clock);

  it("Reconnect generation check ALONE (before the save): a replacement that is itself restored, with the old op cursor reinstated, never receives the old press's key", async () => {
    const d = deferred();
    fake.always("POST", /bot-keys$/, async request => { const reply = idemMint(request); if (request.headers["idempotency-key"]?.includes("op-1")) await d.gate; return reply; });
    const press = service.reconnect("b1");
    await tick();
    goneInbox(); await service.remove("b1");
    newGeneration("restored_unverified");
    reinstateReconnectOp(); // op current, state restored: ONLY the generation comparison can refuse
    d.release();
    expect((await press).ok).toBe(false);
    expect(secrets.botKey("b1")).toBeNull();
    expect(store.getBinding("b1")).toMatchObject({ state: "restored_unverified", emailKeyRef: "key_repl", inboxId: "ibx_2" });
  });
  it("Reconnect generation check ALONE (after the durable await): same replacement, op cursor reinstated while the key is being made durable: the replacement is not flipped active", async () => {
    fake.always("POST", /bot-keys$/, idemMint);
    const d = deferred();
    durableHook = async () => { await d.gate; };
    const press = service.reconnect("b1");
    await tick();
    expect(secrets.botKey("b1")).toMatchObject({ keyId: "key_m1" });
    goneInbox(); await service.remove("b1");
    newGeneration("restored_unverified");
    reinstateReconnectOp();
    d.release();
    expect((await press).ok).toBe(false);
    expect(store.getBinding("b1")).toMatchObject({ state: "restored_unverified", emailKeyRef: "key_repl", inboxId: "ibx_2" });
  });
  it("a removal during durable(): the secrets that end up durable hold no key for b1 (the removed generation's key is not resurrected)", async () => {
    fake.always("POST", /bot-keys$/, idemMint);
    fake.always("DELETE", /bot-keys\//, { status: 200, body: {} });
    const d = deferred();
    durableHook = async () => { await d.gate; };
    const press = service.reconnect("b1");
    await tick();
    goneInbox(); await service.remove("b1");
    d.release();
    expect((await press).ok).toBe(false);
    expect(secrets.botKey("b1")).toBeNull();
    expect((acked as { bots: Record<string, unknown> }).bots["b1"]).toBeUndefined();
    expect((pending as { bots: Record<string, unknown> }).bots["b1"]).toBeUndefined();
  });
  it("M3: Remove pressed while the Reconnect awaits its mint: the press fails closed (503), the row stays removing and is never flipped to active; the removal then finishes", async () => {
    const mintGate = deferred(); const inboxGate = deferred();
    fake.always("POST", /bot-keys$/, async request => { const reply = idemMint(request); await mintGate.gate; return reply; });
    fake.always("DELETE", /\/v1\/email\/inboxes\/ibx_1$/, async () => { await inboxGate.gate; return { status: 404, body: { error: "inbox_not_found", message: "gone" } }; });
    const press = service.reconnect("b1");
    await tick();
    const removal = service.remove("b1");
    await tick();
    expect(store.getBinding("b1")).toMatchObject({ state: "removing" });
    mintGate.release();
    const result = await press;
    expect(result).toMatchObject({ ok: false, code: "unavailable", status: 503 });
    expect(store.getBinding("b1")).toMatchObject({ state: "removing" });
    expect(secrets.botKey("b1")).toBeNull();
    inboxGate.release();
    await removal;
    expect(store.getBinding("b1")).toBeNull();
  });
  it("rotation generation check ALONE (before the save): a replacement binding with the rotate cursor reinstated (same op id) gets none of the old rotation's key", async () => {
    liveRow();
    const d = deferred();
    fake.always("POST", /bot-keys$/, async request => { const reply = idemMint(request); await d.gate; return reply; });
    const rotating = service.rotateKey("b1", () => true);
    await tick();
    const cursor = store.getCursor("rotate:b1")!;
    expect(mints()).toHaveLength(1);
    goneInbox(); await service.remove("b1");
    secrets.setBotKey("b1", { token: "t-repl", keyId: "key_repl" });
    newGeneration("active", "ibx_9");
    store.setCursor("rotate:b1", cursor, clock); // the op is current; only the generation comparison can refuse
    d.release();
    expect((await rotating).ok).toBe(false);
    expect(secrets.botKey("b1")).toMatchObject({ keyId: "key_repl" });
    expect(store.getBinding("b1")).toMatchObject({ emailKeyRef: "key_repl" });
  });
  it("rotation current-op check ALONE (before the save): same generation, but the rotate intent was replaced by another op while the mint was out: the key is not saved", async () => {
    liveRow();
    const d = deferred();
    fake.always("POST", /bot-keys$/, async request => { const reply = idemMint(request); await d.gate; return reply; });
    const rotating = service.rotateKey("b1", () => true);
    await tick();
    store.setCursor("rotate:b1", JSON.stringify({ oldKeyId: "key_old", opId: "other-op", at: clock }), clock);
    d.release();
    expect((await rotating).ok).toBe(false);
    expect(secrets.botKey("b1")).toMatchObject({ keyId: "key_old" });
  });
  it("M4 rotation generation check ALONE (after the durable await): a replacement with the cursor reinstated keeps its key ref and its rotate cursor", async () => {
    liveRow();
    fake.always("POST", /bot-keys$/, idemMint);
    const d = deferred();
    durableHook = async () => { await d.gate; };
    const rotating = service.rotateKey("b1", () => true);
    await tick();
    expect(secrets.botKey("b1")).toMatchObject({ keyId: "key_m1" }); // saved, waiting for the acknowledgement
    const cursor = store.getCursor("rotate:b1")!;
    goneInbox(); await service.remove("b1");
    secrets.setBotKey("b1", { token: "t-repl", keyId: "key_repl" });
    newGeneration("active", "ibx_9");
    store.setCursor("rotate:b1", cursor, clock);
    d.release();
    expect((await rotating).ok).toBe(false);
    expect(store.getBinding("b1")).toMatchObject({ emailKeyRef: "key_repl", inboxId: "ibx_9" });
    expect(store.getCursor("rotate:b1")).toBe(cursor); // not cleared by the stale run
  });
  it("M4 rotation current-op check ALONE (after the durable await): same generation, intent replaced during durable(): no ref write, the new intent stays", async () => {
    liveRow();
    fake.always("POST", /bot-keys$/, idemMint);
    const d = deferred();
    durableHook = async () => { await d.gate; };
    const rotating = service.rotateKey("b1", () => true);
    await tick();
    const other = JSON.stringify({ oldKeyId: "key_old", opId: "other-op", at: clock });
    store.setCursor("rotate:b1", other, clock);
    d.release();
    expect((await rotating).ok).toBe(false);
    expect(store.getBinding("b1")).toMatchObject({ emailKeyRef: "key_old" });
    expect(store.getCursor("rotate:b1")).toBe(other);
  });
  it("pending-op age: a saved Reconnect op older than Flux's 24 h window is NOT resumed by boot (no mint)", async () => {
    fake.always("POST", /bot-keys$/, idemMint);
    store.setCursor("reconnect-op:b1", JSON.stringify({ opId: "op-old", at: clock - KEY_IDEMPOTENCY_WINDOW_MS - 1 }), clock);
    await service.reconcileBindings();
    expect(mints()).toHaveLength(0);
    expect(store.getBinding("b1")!.state).toBe("restored_unverified");
  });
  it("pending-op age (control): the same op inside the window IS resumed by boot", async () => {
    fake.always("POST", /bot-keys$/, idemMint);
    store.setCursor("reconnect-op:b1", JSON.stringify({ opId: "op-new", at: clock - 1000 }), clock);
    await service.reconcileBindings();
    expect(mints()).toHaveLength(1);
    expect(store.getBinding("b1")).toMatchObject({ state: "active" });
  });
});

describe("r3.2m: Astra M1 (a Remove that begins during an await), pending-op 24 h boundary, sameBinding op id", () => {
  const liveRow2 = (opId = "setup-1") => {
    store.deleteBinding("b1", store.getBinding("b1")!.revision);
    store.insertBinding({ botId: "b1", inboxId: "ibx_1", address: "juniper@murage.email", username: null, displayName: null, emailKeyRef: "key_old", fluxAccountId: "acct1", state: "active", step: null, opId, opStartedAt: clock, policy: "auto", failure: null, updatedAt: clock });
    secrets.setBotKey("b1", { token: "t-old", keyId: "key_old" });
    fake.always("GET", /\/v1\/email\/inboxes\/ibx_[19]$/, { status: 200, body: { id: "ibx_1", bot_id: "b1", state: "active" } });
    fake.always("DELETE", /bot-keys\//, { status: 200, body: {} });
  };
  const inboxGone = { status: 404, body: { error: "inbox_not_found", message: "gone" } };
  it("M1 (Astra interleaving): rotation saves X and awaits durable(); Remove starts and awaits the inbox deletion; durable() completes: no emailKeyRef write, the removal finishes", async () => {
    liveRow2();
    fake.always("POST", /bot-keys$/, idemMint);
    const durableGate = deferred(); const inboxGate = deferred();
    durableHook = async () => { await durableGate.gate; };
    fake.always("DELETE", /\/v1\/email\/inboxes\/ibx_1$/, async () => { await inboxGate.gate; return inboxGone; });
    const rotating = service.rotateKey("b1", () => true);
    await tick();
    expect(secrets.botKey("b1")).toMatchObject({ keyId: "key_m1" }); // saved, waiting for the acknowledgement
    const removal = service.remove("b1");
    await tick();
    const during = store.getBinding("b1")!;
    expect(during.state).toBe("removing");
    durableGate.release();
    expect((await rotating).ok).toBe(false);
    const after = store.getBinding("b1")!;
    expect(after.emailKeyRef).toBe("key_old"); // no rotation write
    expect(after.revision).toBe(during.revision);
    inboxGate.release();
    await removal;
    expect(store.getBinding("b1")).toBeNull(); // the removal's sameGeneration still held, so it finished
  });
  it("M1 (before the save): Remove begins while the rotation's candidate check is out: the new key is not saved", async () => {
    const checkGate = deferred(); const inboxGate = deferred();
    fake.always("GET", /\/v1\/email\/inboxes\/ibx_1$/, async () => { await checkGate.gate; return { status: 200, body: { id: "ibx_1", bot_id: "b1", state: "active" } }; }); // registered first: earlier scripts match first
    liveRow2();
    fake.always("POST", /bot-keys$/, idemMint);
    fake.always("DELETE", /\/v1\/email\/inboxes\/ibx_1$/, async () => { await inboxGate.gate; return inboxGone; });
    const rotating = service.rotateKey("b1", () => true);
    await tick();
    expect(mints()).toHaveLength(1);
    const removal = service.remove("b1");
    await tick();
    expect(store.getBinding("b1")!.state).toBe("removing");
    checkGate.release();
    expect((await rotating).ok).toBe(false);
    expect(secrets.botKey("b1")).toMatchObject({ keyId: "key_old" });
    inboxGate.release();
    await removal;
    expect(store.getBinding("b1")).toBeNull();
  });
  it("pending-op age boundary: a saved Reconnect op exactly 24 h old is NOT resumed by boot; one millisecond younger IS", async () => {
    fake.always("POST", /bot-keys$/, idemMint);
    store.setCursor("reconnect-op:b1", JSON.stringify({ opId: "op-edge", at: clock - KEY_IDEMPOTENCY_WINDOW_MS }), clock);
    await service.reconcileBindings();
    expect(mints()).toHaveLength(0);
    expect(store.getBinding("b1")!.state).toBe("restored_unverified");
    store.setCursor("reconnect-op:b1", JSON.stringify({ opId: "op-edge", at: clock - KEY_IDEMPOTENCY_WINDOW_MS + 1 }), clock);
    await service.reconcileBindings();
    expect(mints()).toHaveLength(1);
  });
  it("saved-op reuse boundary: a Reconnect press does not reuse a saved op exactly 24 h old (new op id); one millisecond younger it does", async () => {
    fake.always("POST", /bot-keys$/, idemMint);
    store.setCursor("reconnect-op:b1", JSON.stringify({ opId: "op-edge", at: clock - KEY_IDEMPOTENCY_WINDOW_MS }), clock);
    await service.reconnect("b1");
    expect(mints()[0].headers["idempotency-key"]).not.toContain("op-edge");
    store.deleteBinding("b1", store.getBinding("b1")!.revision);
    restored();
    store.setCursor("reconnect-op:b1", JSON.stringify({ opId: "op-edge", at: clock - KEY_IDEMPOTENCY_WINDOW_MS + 1 }), clock);
    await service.reconnect("b1");
    expect(mints()[1].headers["idempotency-key"]).toContain("op-edge");
  });
  it("sameBinding op id ALONE (Reconnect, before the save): a replacement identical in inbox and key ref but made by another setup op never receives the old press's key", async () => {
    const d = deferred();
    fake.always("POST", /bot-keys$/, async request => { const reply = idemMint(request); if (request.headers["idempotency-key"]?.includes("op-1")) await d.gate; return reply; });
    const press = service.reconnect("b1");
    await tick();
    fake.on("DELETE", /\/v1\/email\/inboxes\/ibx_1$/, inboxGone); await service.remove("b1");
    store.insertBinding({ botId: "b1", inboxId: "ibx_1", address: "juniper@murage.email", username: null, displayName: null, emailKeyRef: "key_src", fluxAccountId: "acct1", state: "restored_unverified", step: null, opId: "setup-other", opStartedAt: clock, policy: "auto", failure: null, updatedAt: clock });
    store.setCursor("reconnect-op:b1", JSON.stringify({ opId: "op-1", at: clock }), clock); // op current, state restored, inbox and ref equal: only opId differs
    d.release();
    expect((await press).ok).toBe(false);
    expect(secrets.botKey("b1")).toBeNull();
    expect(store.getBinding("b1")).toMatchObject({ state: "restored_unverified", opId: "setup-other" });
  });
});
