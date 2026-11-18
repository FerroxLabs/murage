import { createMemoryEmailSecrets } from "../testing/email-store-fixture.ts";
import { createRemovalTransport } from "./removal-transport.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// EMAIL-ACCOUNT-CHANGE r4 section 4 and r5 (designs/EMAIL-ACCOUNT-CHANGE-r5.md), tests 10, 10b, 10c, 11 to 16 and r4 tests 6 and 8.
// The fake Flux records every request with the credential that made it. Nothing reaches a network; every paid call is a scripted fake.
// Test 10 and its variants run on a DATA COPY of files the int/1019 runtime itself wrote (testing/fixtures/migration-1019, made by
// migration-fixture.gen.ts at ae51f55c1); the originals are checksummed before and after and must not change.
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FluxEmailClient } from "./flux-email-client.ts";
import * as secretsModule from "./email-secrets.ts";
import { EmailSecretStore, emailCredentialProvider } from "./email-secrets.ts";
import { EmailStore } from "./email-store.ts";
import { EmailBindingService } from "./binding-service.ts";
import { FakeFlux } from "../testing/fake-flux-email.ts";

const FIXTURE_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "testing", "fixtures", "migration-1019");
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const REF_B = "key_owner_B";
const REF_C = "key_owner_C";
const minted = { status: 200, body: { key: "tok-bot-C", key_id: "key_bot_C", label: "bot-email:b1" } };
const inboxC = { id: "ibx_C", bot_id: "b1", address: "juniper@murage.email", state: "active", send_policy: "auto" };

let dir: string;
let fake: FakeFlux;
let store: EmailStore;
let secrets: EmailSecretStore;
let service: EmailBindingService;
let db: DatabaseSync;
let clock: number;
let persisted: unknown;

function build(dbPath: string | null, doc: unknown) {
  db = new DatabaseSync(dbPath ?? ":memory:");
  store = new EmailStore(db);
  secrets = createMemoryEmailSecrets(saved => { persisted = JSON.parse(JSON.stringify(saved)); });
  if (doc) secrets.replaceAll(doc);
  makeService();
}
function makeService() {
  const client = new FluxEmailClient({ fetch: fake.fetch, apiBase: "https://api.flux.test", appBase: "https://app.flux.test", credentials: emailCredentialProvider(secrets, () => null), timeoutMs: 100 });
  let n = 0;
  service = new EmailBindingService({ store, client, secrets, installId: "inst-r5", now: () => clock, newId: () => `op-new-${++n}` });
}
/** The data copy of the int/1019 fixture, owner switched to C (the Flux key is untouched: there is none in this fixture). */
function fixtureCopy() {
  const before = { db: sha(join(FIXTURE_DIR, "email.db")), cred: sha(join(FIXTURE_DIR, "credentials.json")) };
  dir = mkdtempSync(join(tmpdir(), "murage-r5-"));
  copyFileSync(join(FIXTURE_DIR, "email.db"), join(dir, "email.db"));
  copyFileSync(join(FIXTURE_DIR, "credentials.json"), join(dir, "credentials.json"));
  build(join(dir, "email.db"), JSON.parse(readFileSync(join(dir, "credentials.json"), "utf8")));
  secrets.setOwner({ token: "tok-owner-C", keyId: "key_owner_C" });
  return before;
}
const originalsUnchanged = (before: { db: string; cred: string }) => {
  expect(sha(join(FIXTURE_DIR, "email.db"))).toBe(before.db);
  expect(sha(join(FIXTURE_DIR, "credentials.json"))).toBe(before.cred);
};
const paid = () => fake.requests.filter(r => (r.method === "POST" && (/bot-keys$/.test(r.path) || /\/v1\/email\/inboxes$/.test(r.path))) || (r.method === "DELETE" && /bot-keys/.test(r.path)));
const createInboxCalls = () => fake.calls("POST", /\/v1\/email\/inboxes$/);

beforeEach(() => { clock = 1_800_000_000_000; fake = new FakeFlux(); persisted = null; });
afterEach(() => { try { db?.close(); } catch { /* closed */ } if (dir) rmSync(dir, { recursive: true, force: true }); dir = ""; });

describe("r5 test 10: migration on a data copy of an int/1019 database", () => {
  it("the int/1019 fixture is what it claims: step=inbox, K_B in the credential doc, no owner record", () => {
    fixtureCopy();
    expect(store.getBinding("b1")).toMatchObject({ state: "provisioning", step: "inbox", emailKeyRef: "key_bot_B", inboxId: null, fluxAccountId: null });
    expect(store.getCursor("setup-account:b1")).toBeNull();
    expect(secrets.botKey("b1")?.keyId).toBe("key_bot_B");
  });

  it("10: owner on C, boot: zero mint, createInbox or revoke; cancelled to restored_unverified/account_changed; K_B stale-listed and dropped; no record holds C's ref; originals untouched", async () => {
    const before = fixtureCopy();
    fake.always("GET", /\/v1\/email\/inboxes$/, { status: 200, body: { data: [] } });
    await service.reconcileBindings();
    expect(paid()).toEqual([]);
    expect(store.getBinding("b1")).toMatchObject({ state: "restored_unverified", failure: "account_changed", step: null, opId: null, opStartedAt: null, inboxId: null, emailKeyRef: null, fluxAccountId: null });
    expect(JSON.parse(store.getCursor("setup-stale-key:b1")!)).toContain("key_bot_B");
    expect(secrets.botKey("b1")).toBeNull();
    expect((persisted as { bots: Record<string, unknown> }).bots.b1).toBeUndefined();
    for (const scope of ["setup-account:b1", "setup-retry:b1"]) expect(store.getCursor(scope)).toBeNull();
    expect(JSON.stringify(db.prepare("SELECT * FROM email_event_cursor").all())).not.toContain(REF_C);
    expect(fake.unexpected).toEqual([]);
    originalsUnchanged(before);
  });

  it("10b: C holds an inbox for the bot: adopted through listInboxes with the owner token C, zero createInbox", async () => {
    const before = fixtureCopy();
    fake.on("GET", /\/v1\/email\/inboxes$/, { status: 200, body: { data: [inboxC] } }).on("POST", /bot-keys$/, minted);
    await service.reconcileBindings();
    expect(createInboxCalls()).toHaveLength(0);
    expect(store.getBinding("b1")).toMatchObject({ state: "active", inboxId: "ibx_C", emailKeyRef: "key_bot_C", failure: null });
    expect(fake.calls("GET", /\/v1\/email\/inboxes$/)[0]!.headers.authorization).toBe("Bearer tok-owner-C");
    expect(secrets.botKey("b1")?.keyId).toBe("key_bot_C");
    originalsUnchanged(before);
  });

  it("10c: same account, new owner token, and the old run had made the inbox before the crash: adopted, zero createInbox", async () => {
    const before = fixtureCopy();
    fake.on("GET", /\/v1\/email\/inboxes$/, { status: 200, body: { data: [{ ...inboxC, id: "ibx_made_by_old_run" }] } }).on("POST", /bot-keys$/, minted);
    await service.reconcileBindings();
    expect(createInboxCalls()).toHaveLength(0);
    expect(store.getBinding("b1")).toMatchObject({ state: "active", inboxId: "ibx_made_by_old_run" });
    originalsUnchanged(before);
  });
});

describe("r5 tests 11 to 16", () => {
  it("11: a step=key row with K_B saved and no record (the base skip to inbox): cancelled, zero createInbox, zero mint", async () => {
    fixtureCopy();
    db.prepare("UPDATE email_bindings SET step='key', email_key_ref=NULL WHERE bot_id='b1'").run();
    expect(store.getBinding("b1")).toMatchObject({ step: "key", emailKeyRef: null });
    fake.always("GET", /\/v1\/email\/inboxes$/, { status: 200, body: { data: [] } });
    await service.reconcileBindings();
    expect(createInboxCalls()).toHaveLength(0);
    expect(fake.calls("POST", /bot-keys$/)).toHaveLength(0);
    expect(store.getBinding("b1")).toMatchObject({ state: "restored_unverified", failure: "account_changed", step: null });
  });

  it("12a: a failed row (setup_no_answer, inside 24 h, K_B saved), owner on C, Retry; C has an inbox: adopted, no request carries K_B or the old op id", async () => {
    fixtureCopy();
    db.prepare("UPDATE email_bindings SET state='failed', failure='setup_no_answer' WHERE bot_id='b1'").run();
    fake.on("GET", /\/v1\/email\/inboxes$/, { status: 200, body: { data: [inboxC] } }).on("POST", /bot-keys$/, minted);
    const row = await service.enable("b1", {});
    expect(row).toMatchObject({ state: "active", inboxId: "ibx_C" });
    expect(createInboxCalls()).toHaveLength(0);
    for (const request of fake.requests) { expect(request.headers.authorization).not.toContain("tok-bot-B"); expect(request.headers["idempotency-key"] ?? "").not.toContain("op-fixture-1"); }
  });

  it("12b: the same Retry with no inbox on C starts a fresh setup: a new op id, step key first, and a record equal to C's ref", async () => {
    fixtureCopy();
    db.prepare("UPDATE email_bindings SET state='failed', failure='setup_no_answer' WHERE bot_id='b1'").run();
    fake.on("GET", /\/v1\/email\/inboxes$/, { status: 200, body: { data: [] } }).on("POST", /bot-keys$/, minted).on("POST", /\/v1\/email\/inboxes$/, "reset");
    await service.enable("b1", {});
    const row = store.getBinding("b1")!;
    expect(row).toMatchObject({ state: "provisioning", step: "inbox", emailKeyRef: "key_bot_C" });
    expect(row.opId).toBe("op-new-1");
    expect(JSON.parse(store.getCursor("setup-account:b1")!)).toEqual({ ownerRef: REF_C });
    expect(fake.calls("POST", /bot-keys$/)[0]!.headers["idempotency-key"]).toBe("murage-key:inst-r5:op-new-1");
    for (const request of fake.requests) { expect(request.headers.authorization).not.toContain("tok-bot-B"); expect(request.headers["idempotency-key"] ?? "").not.toContain("op-fixture-1"); }
  });

  it("13: F1 unit: a missing, empty or different expectOwnerRef is refused with zero requests, for mint, createInbox, listInboxes and revoke", async () => {
    build(null, null);
    secrets.setOwner({ token: "tok-owner-C", keyId: "key_owner_C" });
    const client = new FluxEmailClient({ fetch: fake.fetch, apiBase: "https://api.flux.test", appBase: "https://app.flux.test", credentials: emailCredentialProvider(secrets, () => null), timeoutMs: 100 });
    fake.always("POST", /bot-keys$/, minted).always("POST", /\/v1\/email\/inboxes$/, { status: 201, body: inboxC }).always("GET", /\/v1\/email\/inboxes$/, { status: 200, body: { data: [] } }).always("DELETE", /bot-keys/, { status: 200, body: {} });
    const calls: Array<(ref: string | undefined) => Promise<{ kind: string; reason?: string }>> = [
      ref => client.mintBotKey({ botId: "b1" }, "k", ref as string),
      ref => client.createInbox({ botId: "b1" }, "k", ref as string),
      ref => client.listInboxes({ kind: "owner", expectOwnerRef: ref as string }),
      ref => createRemovalTransport(client, () => ref ?? "").revokeBotKey("key_x"),
    ];
    for (const call of calls) {
      for (const bad of [undefined, "", REF_B]) {
        const answer = await call(bad);
        expect(answer).toMatchObject({ kind: "uncertain", reason: "owner_changed" });
      }
    }
    expect(fake.requests).toHaveLength(0);
    for (const call of calls) expect((await call(REF_C)).kind).toBe("ok");
    expect(fake.requests).toHaveLength(4);
    expect((secretsModule as unknown as { emailOwnerRef?: (s: EmailSecretStore, a: () => null) => string | null }).emailOwnerRef?.(secrets, () => null)).toBe(REF_C);
  });

  it("14: F3: a #28 event naming C does not stamp a setup row; it is still cancelled", async () => {
    fixtureCopy();
    service.noteAccount("acct_C");
    expect(store.getBinding("b1")!.fluxAccountId).toBeNull();
    fake.always("GET", /\/v1\/email\/inboxes$/, { status: 200, body: { data: [] } });
    await service.reconcileBindings();
    expect(store.getBinding("b1")).toMatchObject({ state: "restored_unverified", failure: "account_changed", fluxAccountId: null });
    expect(paid()).toEqual([]);
  });

  it("15: a crash between the cancel tx and the key-drop save, then a restart: K_B is stale-listed, never committed, zero createInbox", async () => {
    fixtureCopy();
    const crash = vi.spyOn(secrets, "replaceBotKey").mockImplementationOnce(() => { throw new Error("process killed"); });
    await expect(service.advance("b1")).rejects.toThrow("process killed");
    crash.mockRestore();
    expect(store.getBinding("b1")).toMatchObject({ state: "restored_unverified", emailKeyRef: null });
    expect(secrets.botKey("b1")?.keyId).toBe("key_bot_B");
    // restart: same database, the shell still holds K_B
    const dump = JSON.parse(readFileSync(join(dir, "credentials.json"), "utf8"));
    secrets = createMemoryEmailSecrets(); secrets.replaceAll(dump); secrets.setOwner({ token: "tok-owner-C", keyId: "key_owner_C" });
    makeService();
    expect(JSON.parse(store.getCursor("setup-stale-key:b1")!)).toContain("key_bot_B");
    fake.always("GET", /\/v1\/email\/inboxes$/, { status: 200, body: { data: [] } });
    await service.reconcileBindings();
    await service.healKeys();
    expect(createInboxCalls()).toHaveLength(0);
    expect(fake.calls("POST", /bot-keys$/)).toHaveLength(0);
    expect(store.getBinding("b1")).toMatchObject({ state: "restored_unverified", emailKeyRef: null });
    expect(fake.requests.filter(r => (r.headers.authorization ?? "").includes("tok-bot-B"))).toHaveLength(0);
  });

  describe("16: U2, an int/1019 rotation intent (no owner record), owner on C", () => {
    function legacy(slotKey: { token: string; keyId: string } | null) {
      build(null, null);
      secrets.setOwner({ token: "tok-owner-C", keyId: "key_owner_C" });
      store.insertBinding({ botId: "b1", inboxId: "ibx_1", address: "j@murage.email", username: "j", displayName: "J", emailKeyRef: "key_K1", fluxAccountId: null, state: "active", step: null, opId: "op-1", opStartedAt: clock, policy: "auto", failure: null, updatedAt: clock });
      if (slotKey) secrets.setBotKey("b1", slotKey);
      store.setCursor("rotate:b1", JSON.stringify({ oldKeyId: "key_K1", opId: "op-rot", at: clock }), clock);
    }
    it("(a) the slot equals the ref: the intent is cleared, keys untouched, no mint or revoke", async () => {
      legacy({ token: "tok-K1", keyId: "key_K1" });
      await service.reconcileBindings();
      expect(paid()).toEqual([]); expect(fake.requests).toEqual([]);
      expect(store.getCursor("rotate:b1")).toBeNull();
      expect(store.getBinding("b1")!.emailKeyRef).toBe("key_K1");
    });
    it("(b) K2 in the slot, K1 off disk, candidate read ok: the ref becomes K2, K1 is not revoked", async () => {
      legacy({ token: "tok-K2", keyId: "key_K2" });
      fake.on("GET", /\/v1\/email\/inboxes\/ibx_1$/, { status: 200, body: { id: "ibx_1", state: "active" } });
      await service.reconcileBindings();
      expect(fake.calls("GET", /ibx_1$/)[0]!.headers.authorization).toBe("Bearer tok-K2");
      expect(paid()).toEqual([]);
      expect(store.getBinding("b1")!.emailKeyRef).toBe("key_K2");
      expect(store.getCursor("rotate:b1")).toBeNull();
    });
    it("(c) candidate read 404: the ref is unchanged, no revoke, the intent is cleared", async () => {
      legacy({ token: "tok-K2", keyId: "key_K2" });
      fake.on("GET", /\/v1\/email\/inboxes\/ibx_1$/, { status: 404, body: { error: "inbox_not_found", message: "no" } });
      await service.reconcileBindings();
      expect(paid()).toEqual([]);
      expect(store.getBinding("b1")!.emailKeyRef).toBe("key_K1");
      expect(store.getCursor("rotate:b1")).toBeNull();
    });
  });
});

describe("r4 tests 6 and 8: a setup run follows its own record", () => {
  it("the email-owner sign-in to C alone (the Flux key unchanged) between the key and createInbox: no createInbox on C; adopt on C, else wait for Reconnect", async () => {
    build(null, null);
    secrets.setOwner({ token: "tok-owner-B", keyId: "key_owner_B" });
    fake.on("POST", /bot-keys$/, { status: 200, body: { key: "tok-bot-B", key_id: "key_bot_B" } }).on("POST", /\/v1\/email\/inboxes$/, "reset");
    await service.enable("b1", { username: "juniper", displayName: "Juniper" });
    expect(store.getBinding("b1")).toMatchObject({ state: "provisioning", step: "inbox" });
    expect(JSON.parse(store.getCursor("setup-account:b1")!)).toEqual({ ownerRef: REF_B });
    secrets.setOwner({ token: "tok-owner-C", keyId: "key_owner_C" });
    fake.always("GET", /\/v1\/email\/inboxes$/, { status: 200, body: { data: [] } });
    await service.advance("b1");
    expect(createInboxCalls()).toHaveLength(1); // only the one B-era call
    expect(store.getBinding("b1")).toMatchObject({ state: "restored_unverified", failure: "account_changed" });
    // the press: a fresh setup stamped with C's ref
    fake.on("POST", /bot-keys$/, minted).on("POST", /\/v1\/email\/inboxes$/, { status: 201, body: inboxC });
    const pressed = await service.reconnect("b1");
    expect(pressed).toMatchObject({ ok: true });
    expect(store.getBinding("b1")).toMatchObject({ state: "active", inboxId: "ibx_C" });
    expect(createInboxCalls()[1]!.headers.authorization).toBe("Bearer tok-owner-C");
  });

  it("a mint answered by another owner credential than the run's record is not committed", async () => {
    build(null, null);
    secrets.setOwner({ token: "tok-owner-B", keyId: "key_owner_B" });
    fake.on("POST", /bot-keys$/, () => { secrets.setOwner({ token: "tok-owner-C", keyId: "key_owner_C" }); return { status: 200, body: { key: "tok-bot-B", key_id: "key_bot_B" } }; });
    await service.enable("b1", {});
    expect(store.getBinding("b1")).toMatchObject({ emailKeyRef: null });
    expect(secrets.botKey("b1")).toBeNull();
  });

  it("a rotation records the owner ref in its intent; an owner change mid-way ends it and touches no key", async () => {
    build(null, null);
    secrets.setOwner({ token: "tok-owner-B", keyId: "key_owner_B" });
    store.insertBinding({ botId: "b1", inboxId: "ibx_1", address: "j@murage.email", username: "j", displayName: "J", emailKeyRef: "key_K1", fluxAccountId: null, state: "active", step: null, opId: "op-1", opStartedAt: clock, policy: "auto", failure: null, updatedAt: clock });
    secrets.setBotKey("b1", { token: "tok-K1", keyId: "key_K1" });
    fake.on("POST", /bot-keys$/, () => { secrets.setOwner({ token: "tok-owner-C", keyId: "key_owner_C" }); return { status: 200, body: { key: "tok-K2", key_id: "key_K2" } }; });
    const answer = await service.rotateKey("b1", () => true);
    expect(answer).toEqual({ ok: false, code: "account_changed" });
    expect(secrets.botKey("b1")?.keyId).toBe("key_K1");
    expect(store.getBinding("b1")!.emailKeyRef).toBe("key_K1");
    expect(fake.calls("DELETE", /bot-keys/)).toHaveLength(0);
    expect(store.getCursor("rotate:b1")).toBeNull();
  });
});
