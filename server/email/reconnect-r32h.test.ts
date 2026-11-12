// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// r3.2h product part: Reconnect saves its mint op on the binding (24 h replay like setup), and a 409 bot_key_exists {X} either holds
// (X is the key the bot holds now: rotation_live_conflict, never a revoke) or deletes the stray X and mints once more.
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { FluxEmailClient } from "./flux-email-client.ts";
import { EmailSecretStore, emailCredentialProvider } from "./email-secrets.ts";
import { EmailStore } from "./email-store.ts";
import { EmailBindingService, KEY_IDEMPOTENCY_WINDOW_MS, MINTED_KEEP_MS } from "./binding-service.ts";
import { FakeFlux, fluxError, type FakeRequest } from "../testing/fake-flux-email.ts";

let clock = 0;
let fake: FakeFlux;
let store: EmailStore;
let secrets: EmailSecretStore;
let service: EmailBindingService;
let n = 0;
/** Flux's idempotency: one key per Idempotency-Key, the same key again for the same header. */
let made: Map<string, string>;

beforeEach(() => {
  clock = 1_800_000_000_000; n = 0; made = new Map();
  fake = new FakeFlux();
  store = new EmailStore(new DatabaseSync(":memory:"));
  secrets = new EmailSecretStore();
  secrets.setOwner({ token: "owner-token", keyId: "key_owner" });
  const client = new FluxEmailClient({ fetch: fake.fetch, apiBase: "https://api.flux.test", appBase: "https://app.flux.test", credentials: emailCredentialProvider(secrets, () => null), timeoutMs: 100 });
  service = new EmailBindingService({ store, client, secrets, installId: "inst", now: () => clock, newId: () => `op-${++n}` });
  const now = clock;
  store.insertBinding({ botId: "b1", inboxId: "ibx_1", address: "juniper@murage.email", username: null, displayName: null, emailKeyRef: "key_src", fluxAccountId: null, state: "restored_unverified", step: null, opId: null, opStartedAt: null, policy: "auto", failure: null, updatedAt: now });
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

describe("reconnect mint op (r3.2h item 1)", () => {
  it("(a) a crash between the mint and the key save, then a second press: the same op, exactly one key at Flux, that key saved", async () => {
    fake.always("POST", /bot-keys$/, idemMint);
    const real = secrets.setBotKey.bind(secrets);
    let crashed = false;
    secrets.setBotKey = (botId, key) => { if (!crashed) { crashed = true; throw new Error("crash before the key save"); } real(botId, key); };
    await expect(service.reconnect("b1")).rejects.toThrow("crash");
    expect(secrets.botKey("b1")).toBeNull();
    expect(JSON.parse(store.getCursor("reconnect-op:b1")!)).toEqual({ opId: "op-1", at: clock });
    const second = await service.reconnect("b1");
    expect(second).toMatchObject({ ok: true });
    expect(mints()).toHaveLength(2);
    expect(new Set(mints().map(call => call.headers["idempotency-key"])).size).toBe(1);
    expect(made.size).toBe(1);
    expect(secrets.botKey("b1")).toMatchObject({ keyId: "key_m1" });
    expect(store.getBinding("b1")).toMatchObject({ state: "active", emailKeyRef: "key_m1" });
  });

  it("past the 24 h window a press starts a new op (the setup re-op)", async () => {
    fake.always("POST", /bot-keys$/, idemMint);
    const real = secrets.setBotKey.bind(secrets);
    let crashed = false;
    secrets.setBotKey = (botId, key) => { if (!crashed) { crashed = true; throw new Error("crash"); } real(botId, key); };
    await expect(service.reconnect("b1")).rejects.toThrow();
    clock += KEY_IDEMPOTENCY_WINDOW_MS;
    await service.reconnect("b1");
    expect(store.getCursor("reconnect-op:b1")).toBeNull(); // r3.2k: the op is cleared once the binding commits (nothing left for boot to resume)
    expect(new Set(mints().map(call => call.headers["idempotency-key"])).size).toBe(2);
  });
});

describe("reconnect 409 bot_key_exists (r3.2h item 2)", () => {
  /** The first press mints key_m1 and crashes before the key save: this home's record shows it minted key_m1. */
  const crashedFirstPress = async () => {
    fake.always("POST", /bot-keys$/, request => { const k = forced409; if (k && forcedOnce) forced409 = null; return k ? fluxError(409, "bot_key_exists", { key_id: k }) : idemMint(request); });
    const real = secrets.setBotKey.bind(secrets);
    let crashed = false;
    secrets.setBotKey = (botId, key) => { if (!crashed) { crashed = true; throw new Error("crash before the key save"); } real(botId, key); };
    await expect(service.reconnect("b1")).rejects.toThrow("crash");
  };
  let forced409: string | null = null;
  let forcedOnce = false;
  beforeEach(() => { forced409 = null; forcedOnce = false; });

  it("(c) a stray X this home minted, past 24 h: deleted, a fresh op is saved, the mint is tried once more and that key is saved", async () => {
    await crashedFirstPress();
    clock += KEY_IDEMPOTENCY_WINDOW_MS;
    forced409 = "key_m1"; forcedOnce = true; // Flux: the bot already has the live key the lost first op made
    fake.on("DELETE", /bot-keys\/key_m1$/, { status: 200, body: {} });
    const result = await service.reconnect("b1");
    expect(result).toMatchObject({ ok: true });
    expect(deletes().map(call => call.path)).toEqual(["/api/desktop/bot-keys/key_m1"]);
    expect(mints()).toHaveLength(3);
    expect(mints()[1]!.headers["idempotency-key"]).not.toBe(mints()[2]!.headers["idempotency-key"]);
    expect(secrets.botKey("b1")).toMatchObject({ keyId: "key_m2" });
  });

  it("(c2) the same key X this home minted but inside the 24 h window: held with the owner line, 0 DELETEs", async () => {
    await crashedFirstPress();
    clock += KEY_IDEMPOTENCY_WINDOW_MS - 1;
    forced409 = "key_m1";
    const result = await service.reconnect("b1");
    expect(result).toMatchObject({ ok: false, code: "rotation_live_conflict", status: 409 });
    expect((result as { detail: string }).detail).toContain("key_m1");
    expect(deletes()).toHaveLength(0);
    expect(secrets.botKey("b1")).toBeNull();
  });

  it("(d) an X this home never minted (another install on the same Flux account): alert naming the key with its one owner action, a hold, 0 DELETEs", async () => {
    fake.always("POST", /bot-keys$/, fluxError(409, "bot_key_exists", { key_id: "key_unknown" }));
    clock += 10 * KEY_IDEMPOTENCY_WINDOW_MS;
    const result = await service.reconnect("b1");
    expect(result).toEqual({ ok: false, code: "rotation_live_conflict", status: 409, detail: "This bot already has another email key, key_unknown. Revoke it in your Flux account, then press Reconnect." });
    expect(deletes()).toHaveLength(0);
    expect(mints()).toHaveLength(1);
    expect(secrets.botKey("b1")).toBeNull();
    expect(store.getBinding("b1")!.state).toBe("restored_unverified");
  });

  it("X is the key the bot holds now: alert rotation_live_conflict names the key and offers one action; nothing is revoked, nothing is overwritten", async () => {
    secrets.setBotKey("b1", { token: "sk-held", keyId: "key_held" });
    store.setCursor("minted:b1", JSON.stringify([{ keyId: "key_held", at: clock - 2 * KEY_IDEMPOTENCY_WINDOW_MS }]), clock); // this home minted it long ago: only the held-key rule stops a delete
    fake.always("POST", /bot-keys$/, fluxError(409, "bot_key_exists", { key_id: "key_held" }));
    const result = await service.reconnect("b1");
    expect(result).toEqual({ ok: false, code: "rotation_live_conflict", status: 409, detail: "Email key key_held is this bot's current key. Revoke it in your Flux account, then press Reconnect. The bot gets a fresh key, and its email pauses for a moment while it switches." });
    const detail = (result as { detail: string }).detail;
    expect(detail).toContain("key_held");
    expect(detail).not.toMatch(/[-–—]/);
    expect(detail.match(/\b(Revoke|press)\b/gi)).toHaveLength(2); // one action: revoke it, then the same Reconnect press
    expect(deletes()).toHaveLength(0);
    expect(secrets.botKey("b1")).toMatchObject({ keyId: "key_held" });
    expect(store.getBinding("b1")!.state).toBe("restored_unverified");
  });
});

const OTHER = (k: string) => `This bot already has another email key, ${k}. Revoke it in your Flux account, then press Reconnect.`;
const HELD = (k: string) => `Email key ${k} is this bot's current key. Revoke it in your Flux account, then press Reconnect. The bot gets a fresh key, and its email pauses for a moment while it switches.`;

describe("r3.2i owner copy: each hold case shows its own line, and KEY is the key id, never key material", () => {
  it("held key, unknown key and own key inside 24 h each show their own line; the two lines differ and carry no dashes", async () => {
    fake.always("POST", /bot-keys$/, fluxError(409, "bot_key_exists", { key_id: "key_x" }));
    secrets.setBotKey("b1", { token: "sk-held", keyId: "key_x" });
    expect(await service.reconnect("b1")).toMatchObject({ detail: HELD("key_x") });
    secrets.setBotKey("b1", { token: "sk-held", keyId: "key_other" });
    expect(await service.reconnect("b1")).toMatchObject({ detail: OTHER("key_x") }); // never minted by this home
    store.setCursor("minted:b1", JSON.stringify([{ keyId: "key_x", at: clock - 3_600_000 }]), clock);
    expect(await service.reconnect("b1")).toMatchObject({ detail: OTHER("key_x") }); // minted inside 24 h
    expect(HELD("k")).not.toBe(OTHER("k"));
    expect(HELD("k") + OTHER("k")).not.toMatch(/[-\u2013\u2014]/);
    expect(deletes()).toHaveLength(0);
  });
  it("a 409 that carries the key secret: the owner line and the whole result hold the key id and no 8+ character piece of the secret", async () => {
    const secret = "sk-live-SECRETMATERIAL9876";
    fake.always("POST", /bot-keys$/, fluxError(409, "bot_key_exists", { key_id: "key_unknown", key: secret, secret }));
    for (const held of [false, true]) {
      if (held) secrets.setBotKey("b1", { token: "sk-held", keyId: "key_unknown" });
      const result = await service.reconnect("b1");
      const text = JSON.stringify(result);
      expect((result as { detail: string }).detail).toContain("key_unknown");
      for (let i = 0; i + 8 <= secret.length; i++) expect(text.includes(secret.slice(i, i + 8)), `secret piece ${secret.slice(i, i + 8)}`).toBe(false);
    }
  });
});

describe("r3.2i minted:<bot> is written BEFORE the key save (setup and rotation)", () => {
  const spy = () => { const seen: (string | null)[] = []; const real = secrets.setBotKey.bind(secrets); secrets.setBotKey = (b, k) => { seen.push(store.getCursor("minted:" + b)); real(b, k); }; return seen; };
  it("setup: at the moment the key is saved, the minted record already names it", async () => {
    fake.always("POST", /bot-keys$/, idemMint);
    fake.always("POST", /\/v1\/email\/inboxes$/, { status: 201, body: { id: "ibx_2", bot_id: "b2", address: "x@murage.email", state: "active", send_policy: "auto" } });
    const seen = spy();
    await service.enable("b2", { username: "x", displayName: "X" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("key_m1");
  });
  it("rotation: at the moment the new key is saved, the minted record already names it", async () => {
    const now = clock;
    store.insertBinding({ botId: "b2", inboxId: "ibx_2", address: "x@murage.email", username: null, displayName: null, emailKeyRef: "key_old2", fluxAccountId: null, state: "active", step: null, opId: null, opStartedAt: null, policy: "auto", failure: null, updatedAt: now });
    secrets.setBotKey("b2", { token: "t-old", keyId: "key_old2" });
    fake.always("POST", /bot-keys$/, idemMint);
    fake.always("GET", /\/v1\/email\/inboxes\/ibx_2$/, { status: 200, body: { id: "ibx_2", bot_id: "b2", state: "active" } });
    fake.always("DELETE", /bot-keys\//, { status: 200, body: {} });
    const seen = spy();
    expect(await service.rotateKey("b2", () => true)).toEqual({ ok: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("key_m1");
  });
});

describe("r3.2j product follow-ups", () => {
  const note = (botId: string, keyId: string) => (service as unknown as { noteMinted(b: string, k: string): void }).noteMinted(botId, keyId);
  const minted = (botId: string) => JSON.parse(store.getCursor("minted:" + botId) ?? "[]") as { keyId: string; at: number }[];
  const DEL_OK = () => fake.always("DELETE", /bot-keys\//, { status: 200, body: {} });

  it("a key noted again keeps its FIRST time (the spec's logMint)", () => {
    note("b1", "key_a"); const first = clock; clock += 5 * 3_600_000; note("b1", "key_a");
    expect(minted("b1")).toEqual([{ keyId: "key_a", at: first }]);
  });
  it("records leave by age only: an own stray survives 25 later mints and is then deleted by Reconnect", async () => {
    store.setCursor("minted:b1", JSON.stringify([{ keyId: "key_old", at: clock - 2 * KEY_IDEMPOTENCY_WINDOW_MS }]), clock);
    for (let k = 0; k < 25; k++) note("b1", `key_later${k}`);
    expect(minted("b1").some(item => item.keyId === "key_old")).toBe(true);
    let first = true;
    fake.always("POST", /bot-keys$/, request => { if (first) { first = false; return fluxError(409, "bot_key_exists", { key_id: "key_old" }); } return idemMint(request); });
    DEL_OK();
    expect(await service.reconnect("b1")).toMatchObject({ ok: true });
    expect(deletes().map(call => call.path)).toEqual(["/api/desktop/bot-keys/key_old"]);
  });
  it("a record older than the age cap is dropped", () => {
    store.setCursor("minted:b1", JSON.stringify([{ keyId: "key_ancient", at: clock - MINTED_KEEP_MS - 1 }]), clock);
    note("b1", "key_new");
    expect(minted("b1").map(item => item.keyId)).toEqual(["key_new"]);
  });
  it("Reconnect: at the moment the key is saved, the minted record already names it", async () => {
    fake.always("POST", /bot-keys$/, idemMint);
    const seen: (string | null)[] = []; const real = secrets.setBotKey.bind(secrets);
    secrets.setBotKey = (b, k) => { seen.push(store.getCursor("minted:" + b)); real(b, k); };
    expect(await service.reconnect("b1")).toMatchObject({ ok: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("key_m1");
  });
  it("Astra 1: two Reconnects at once run one after the other; the second finds nothing to reconnect", async () => {
    fake.always("POST", /bot-keys$/, idemMint);
    const [a, b] = await Promise.all([service.reconnect("b1"), service.reconnect("b1")]);
    expect(a).toMatchObject({ ok: true });
    expect(b).toMatchObject({ ok: false, code: "not_restored" });
    expect(mints()).toHaveLength(1);
    expect(deletes()).toHaveLength(0);
    expect(secrets.botKey("b1")).toMatchObject({ keyId: "key_m1" });
  });
  it("Astra 1: a late answer of a replaced op never saves its key", async () => {
    fake.always("POST", /bot-keys$/, request => { store.setCursor("reconnect-op:b1", JSON.stringify({ opId: "op-newer", at: clock }), clock); return idemMint(request); });
    expect(await service.reconnect("b1")).toMatchObject({ ok: false, code: "unavailable" });
    expect(secrets.botKey("b1")).toBeNull();
    expect(minted("b1").map(item => item.keyId)).toEqual(["key_m1"]);
  });
  it("Astra 4: the mint after a stray delete that meets another key Y gets the same rule: the other-key line, no second delete", async () => {
    store.setCursor("minted:b1", JSON.stringify([{ keyId: "key_old", at: clock - 2 * KEY_IDEMPOTENCY_WINDOW_MS }]), clock);
    const answers = ["key_old", "key_y"];
    fake.always("POST", /bot-keys$/, request => { const k = answers.shift(); return k ? fluxError(409, "bot_key_exists", { key_id: k }) : idemMint(request); });
    DEL_OK();
    const result = await service.reconnect("b1");
    expect(result).toMatchObject({ ok: false, code: "rotation_live_conflict", status: 409, detail: OTHER("key_y") });
    expect(deletes().map(call => call.path)).toEqual(["/api/desktop/bot-keys/key_old"]);
  });
});
