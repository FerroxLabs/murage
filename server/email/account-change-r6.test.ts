import { legacyEmailDecisionFixture } from "./testing/legacy-decision-fixture.ts";
import type { ServiceAuthority } from "../narrow-denials.ts";
import { createMemoryEmailSecrets } from "../testing/email-store-fixture.ts";
import { createRemovalTransport } from "./removal-transport.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// EMAIL-ACCOUNT-CHANGE r6 (designs/EMAIL-ACCOUNT-CHANGE-r6.md): tests 17 to 17g, 18, 18b, 19, 20 and 21, and the held-inbox line.
// Active inbox rows with no owner record are held (U3): bot sends wait as prepared, owner acts answer retry_later, no Flux call, until one owner #5 read
// proves the inbox for the owner credential signed in now. The fake Flux records every request with the credential that made it.
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FluxEmailClient, type CredentialRef } from "./flux-email-client.ts";
import { EmailSecretStore, emailCredentialProvider, emailOwnerRef } from "./email-secrets.ts";
import { EmailStore, type SendRow } from "./email-store.ts";
import { EmailBindingService, PROVE_RETRY_MS } from "./binding-service.ts";
import { EmailSendService, FENCE_RETRY_MS } from "./send-service.ts";
import type { EmailDraft } from "./canonical.ts";
import { FakeFlux, type FakeReply } from "../testing/fake-flux-email.ts";
import { EMAIL_OWNER_COPY } from "../../shared/email-copy.ts";

const OWNER_B = { token: "tok-owner-B", keyId: "key_owner_B" };
const OWNER_C = { token: "tok-owner-C", keyId: "key_owner_C" };
const T0 = 1_800_000_000_000;
const sentOk = (id = "msg_1"): FakeReply => ({ status: 200, body: { object: "email.send", status: "sent", message_id: id } });
const draft = (): EmailDraft => ({ kind: "send", to: ["jane@acme.test"], cc: [], subject: "Thursday", text: "Hi Jane", attachments: [], replyTo: null });
const notFound: FakeReply = { status: 404, body: { error: "inbox_not_found", message: "no such inbox" } };
const okInbox: FakeReply = { status: 200, body: { id: "ibx_1", state: "active" } };

let authority: ServiceAuthority;
let clock: number;
let fake: FakeFlux;
let store: EmailStore;
let secrets: EmailSecretStore;
let client: FluxEmailClient;
let bindings: EmailBindingService;
let send: EmailSendService;
let dir = "";

/** The runtime's wiring in miniature: the same fence, owner ref source and client gate runtime.ts installs. */
function rig(opts: { proven?: boolean; db?: DatabaseSync; keepSecrets?: boolean } = {}) {
  clock = T0;
  fake = new FakeFlux();
  store = new EmailStore(opts.db ?? new DatabaseSync(":memory:"));
  if (!opts.keepSecrets) { secrets = createMemoryEmailSecrets(); secrets.setOwner(OWNER_B); secrets.setBotKey("b1", { token: "tok-bot-B", keyId: "key_K_B" }); }
  wire();
  if (!opts.db) {
    store.insertBinding({ botId: "b1", inboxId: "ibx_1", address: "juniper@murage.email", username: "juniper", displayName: "Juniper", emailKeyRef: "key_K_B", fluxAccountId: null, state: "active", step: null, opId: "op-1", opStartedAt: clock, policy: "auto", failure: null, updatedAt: clock });
    if (opts.proven) store.setCursor("inbox-owner:b1", JSON.stringify({ ownerRef: OWNER_B.keyId, inboxId: "ibx_1", at: clock }), clock);
    store.addTrusted("b1", "jane@acme.test", "allow", "owner", clock);
  }
}
function wire() {
  let n = 0;
  client = new FluxEmailClient({
    fetch: fake.fetch, apiBase: "https://api.flux.test", appBase: "https://app.flux.test", credentials: emailCredentialProvider(secrets, () => null), timeoutMs: 100,
    gate: ref => (ref.kind === "bot" && ref.charge === true && bindings.ownerProven(ref.botId) === false ? { kind: "local_refused", code: "owner_unproven" } as const : null),
  });
  bindings = new EmailBindingService({ store, client, secrets, installId: "inst", now: () => clock, newId: () => `op-new-${++n}`, withdrawUndispatched: botId => { send.withdrawUndispatchedForBot(botId, "account_off"); } });
  send = new EmailSendService({ store, client, authorityFor: () => authority, installId: "inst", now: () => clock, newId: () => `send-${++n}`, fence: botId => bindings.holdsSends(botId), ownerRefFor: botId => bindings.ownerRefFor(botId) });
}
const submit = async () => (await send.submit({ botId: "b1", generation: 1, threadId: "t1", draft: draft() })) as { status: string; row: SendRow };
const posts = () => fake.calls("POST", /\/messages$/);
const record = () => JSON.parse(store.getCursor("inbox-owner:b1") ?? "null") as { ownerRef: string; inboxId: string } | null;

beforeEach(async () => { authority = await legacyEmailDecisionFixture(); rig(); });
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ""; });

describe("17 H5: Astra's exact sequence", () => {
  it("B's active row (null account, no cursor), owner signs in to C, a C #28 batch, then the bot submits: no stamp, the send waits, #5 404 gives account_changed and adopts on C", async () => {
    secrets.setOwner(OWNER_C);
    bindings.noteAccount("acct_C", OWNER_C.keyId);
    expect(store.getBinding("b1")!.fluxAccountId).toBeNull();
    expect(bindings.ownerProven("b1")).toBe(false);
    const result = await submit();
    expect(result.status).toBe("accepted");
    expect(store.getSend(result.row.sendId)).toMatchObject({ state: "prepared" });
    expect(store.getSend(result.row.sendId)!.dueAt).toBe(clock + FENCE_RETRY_MS);
    expect(posts()).toHaveLength(0);
    fake.on("GET", /\/v1\/email\/inboxes\/ibx_1$/, notFound)
      .on("GET", /\/v1\/email\/inboxes$/, { status: 200, body: { data: [{ id: "ibx_C", bot_id: "b1", address: "j@murage.email", state: "active" }] } })
      .on("POST", /bot-keys$/, { status: 200, body: { key: "tok-bot-C", key_id: "key_K_C" } });
    await bindings.proveOwners(true);
    expect(fake.calls("GET", /ibx_1$/)[0]!.headers.authorization).toBe("Bearer tok-owner-C");
    expect(store.getSend(result.row.sendId)).toMatchObject({ state: "withdrawn" });
    expect(store.getBinding("b1")).toMatchObject({ state: "active", inboxId: "ibx_C", emailKeyRef: "key_K_C" });
    expect(record()).toMatchObject({ ownerRef: OWNER_C.keyId, inboxId: "ibx_C" });
    expect(posts()).toHaveLength(0);
    expect(fake.requests.filter(r => (r.headers.authorization ?? "").includes("tok-bot-B"))).toHaveLength(0);
  });
});

describe("17b to 17g", () => {
  it("17b restart: still held after boot (derived from local state), zero sends, and proveOwners runs in the boot order before the reader", async () => {
    secrets.setOwner(OWNER_C);
    await submit();
    wire(); // a restart: new services over the same database
    expect(bindings.ownerProven("b1")).toBe(false);
    expect(posts()).toHaveLength(0);
    const runtime = readFileSync(fileURLToPath(new URL("./runtime.ts", import.meta.url)), "utf8");
    expect(runtime).toMatch(/reconcileBindings\(\);[^\n]*proveOwners\(true\);[^\n]*bindings\.reap\(\)/);
    expect(runtime.indexOf("proveOwners(true)")).toBeLessThan(runtime.indexOf("events.reconcileAccount(true)"));
  });

  it("17c #5 never answers for 7 days: zero sends, held, gaps grow to 15 min, K_B on disk, and a bot read of an in-flight row is still made", async () => {
    secrets.setOwner(OWNER_C);
    await submit();
    fake.always("GET", /\/v1\/email\/inboxes\/ibx_1$/, "reset");
    const at: number[] = [];
    const seen = () => fake.calls("GET", /ibx_1$/).length;
    let last = 0;
    for (let tick = 0; tick < (7 * 86_400_000) / 30_000; tick++) {
      clock += 30_000;
      await bindings.proveOwners();
      await send.tick();
      if (seen() > last) { at.push(clock); last = seen(); }
    }
    expect(posts()).toHaveLength(0);
    expect(bindings.ownerProven("b1")).toBe(false);
    expect(secrets.botKey("b1")?.keyId).toBe("key_K_B");
    const gaps = at.slice(1).map((time, index) => time - at[index]!);
    expect(gaps.slice(0, 5)).toEqual([30_000, 60_000, 120_000, 300_000, 900_000]);
    expect(Math.max(...gaps)).toBe(PROVE_RETRY_MS[PROVE_RETRY_MS.length - 1]);
    expect(gaps.slice(-5).every(gap => gap === 900_000)).toBe(true);
    fake.on("GET", /\/approvals\/apr_1$/, { status: 200, body: { id: "apr_1", state: "pending", held: [] } });
    expect((await client.getApproval({ kind: "bot", botId: "b1" }, "apr_1")).kind).toBe("ok");
  });

  it("17d same account, new owner token: #5 ok re-stamps the record and the held send goes out exactly once", async () => {
    rig({ proven: true });
    secrets.setOwner({ token: "tok-owner-B2", keyId: "key_owner_B2" });
    const result = await submit();
    expect(store.getSend(result.row.sendId)!.state).toBe("prepared");
    fake.on("GET", /\/v1\/email\/inboxes\/ibx_1$/, okInbox).on("POST", /\/messages$/, sentOk());
    await bindings.proveOwners(true);
    expect(record()).toMatchObject({ ownerRef: "key_owner_B2", inboxId: "ibx_1" });
    clock += FENCE_RETRY_MS;
    await send.tick();
    await send.tick();
    expect(posts()).toHaveLength(1);
    expect(store.getSend(result.row.sendId)).toMatchObject({ state: "sent" });
  });

  it("17e proof race: the owner token changes while the proof awaits: no record is written, and the next run uses the new generation", async () => {
    fake.on("GET", /\/v1\/email\/inboxes\/ibx_1$/, () => { secrets.setOwner(OWNER_C); return okInbox; });
    expect(await bindings.proveOwner("b1")).toBe("held");
    expect(record()).toBeNull();
    fake.on("GET", /\/v1\/email\/inboxes\/ibx_1$/, okInbox);
    expect(await bindings.proveOwner("b1")).toBe("proven");
    expect(record()).toMatchObject({ ownerRef: OWNER_C.keyId });
    expect(fake.calls("GET", /ibx_1$/)[1]!.headers.authorization).toBe("Bearer tok-owner-C");
  });

  it("17f dispatch race: the owner switches after the dispatching CAS and before credential selection: zero requests, back to prepared with the same idemSuffix", async () => {
    rig({ proven: true });
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const holding = send.locks.exclusive("ibx_1", () => wait);
    const submitted = submit();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(store.sendsInStates(["dispatching"])).toHaveLength(1);
    secrets.setOwner(OWNER_C);
    release();
    await holding;
    const result = await submitted;
    expect(posts()).toHaveLength(0);
    expect(store.getSend(result.row.sendId)).toMatchObject({ state: "prepared", idemSuffix: 1 });
    expect(store.getSend(result.row.sendId)!.dueAt).toBe(clock + FENCE_RETRY_MS);
  });

  it("17g upgrade: a pre-upgrade active row (no record), same account: zero sends before boot's #5; one #5 proves it; sends resume", async () => {
    const result = await submit();
    expect(store.getSend(result.row.sendId)!.state).toBe("prepared");
    expect(posts()).toHaveLength(0);
    fake.on("GET", /\/v1\/email\/inboxes\/ibx_1$/, okInbox).on("POST", /\/messages$/, sentOk());
    await bindings.reconcileBindings();
    await bindings.proveOwners(true);
    expect(fake.calls("GET", /ibx_1$/)).toHaveLength(1);
    expect(record()).toMatchObject({ ownerRef: OWNER_B.keyId, inboxId: "ibx_1" });
    clock += FENCE_RETRY_MS;
    await send.tick();
    expect(posts()).toHaveLength(1);
    expect(store.getSend(result.row.sendId)).toMatchObject({ state: "sent" });
  });
});

describe("18 and 18b: the owner fence covers every owner entry point", () => {
  const ok = { status: 200, body: { id: "x", data: [], limits: {}, held: [] } };
  const entries: Array<[string, (c: FluxEmailClient, ref: string | undefined) => Promise<{ kind: string; reason?: string }>]> = [
    ["mintBotKey", (c, r) => c.mintBotKey({ botId: "b1" }, "k", r as string)],
    ["createInbox", (c, r) => c.createInbox({ botId: "b1" }, "k", r as string)],
    ["listInboxes", (c, r) => c.listInboxes({ kind: "owner", expectOwnerRef: r as string })],
    ["revokeBotKey", (c, r) => createRemovalTransport(c, () => r ?? "").revokeBotKey("key_x")],
    ["getInbox (owner)", (c, r) => c.getInbox({ kind: "owner", expectOwnerRef: r as string }, "ibx_1")],
    ["approve", (c, r) => c.approve("apr_1", ["h1"], r as string)],
    ["retryHeld", (c, r) => c.retryHeld("h1", "k", r as string)],
    ["patchInbox", (c, r) => c.patchInbox("ibx_1", { paused: true }, r as string)],
    ["setSendPolicy", (c, r) => c.setSendPolicy("ibx_1", "ask", r as string)],
    ["resumeInbox", (c, r) => c.resumeInbox("ibx_1", "why", r as string)],
    ["deleteInbox", (c, r) => createRemovalTransport(c, () => r ?? "").deleteInbox("ibx_1")],
    ["restoreInbox", (c, r) => c.restoreInbox("ibx_1", "b1", r as string)],
    ["addRecipient", (c, r) => c.addRecipient("ibx_1", "a@b.test", "allow", r as string)],
    ["removeRecipient", (c, r) => c.removeRecipient("ibx_1", "a@b.test", r as string)],
    ["getSettings", (c, r) => c.getSettings(r as string)],
    ["disable", (c, r) => c.disable("ack", r as string)],
    ["enable", (c, r) => c.enable("v1", r as string)],
    ["events (owner)", (c, r) => c.events({ kind: "owner", expectOwnerRef: r as string }, { wait: 0 })],
    ["listApprovals (owner)", (c, r) => c.listApprovals({ kind: "owner", expectOwnerRef: r as string })],
    ["listMessages (owner)", (c, r) => c.listMessages({ kind: "owner", expectOwnerRef: r as string }, "ibx_1")],
    ["raw request (owner)", (c, r) => c.request({ kind: "owner", expectOwnerRef: r as string }, "GET", "/v1/email/settings")],
  ];
  it.each(entries)("%s: a missing, empty or mismatched expectOwnerRef makes zero requests; the right one is sent", async (_name, call) => {
    secrets.setOwner(OWNER_C);
    fake.always("GET", /./, ok).always("POST", /./, ok).always("PATCH", /./, ok).always("DELETE", /./, ok);
    for (const bad of [undefined, "", OWNER_B.keyId]) expect(await call(client, bad)).toMatchObject({ kind: "uncertain", reason: "owner_changed" });
    expect(fake.requests).toHaveLength(0);
    expect((await call(client, OWNER_C.keyId)).kind).not.toBe("uncertain");
    expect(fake.requests).toHaveLength(1);
  });
  it("types: request({ kind: 'owner' }) without expectOwnerRef does not compile", () => {
    // @ts-expect-error the owner variant requires expectOwnerRef
    const ref: CredentialRef = { kind: "owner" };
    expect(ref.kind).toBe("owner");
  });

  it("18b: Approve, Send and retry on a U3 binding answer retry_later with zero requests; after the proof they run with the record's ref", async () => {
    rig({ proven: true });
    fake.on("POST", /\/messages$/, { status: 202, body: { status: "pending_approval", held_id: "h1", approval: { id: "apr_1", held_ids: ["h1"], state: "pending" } } });
    const held = (await submit()).row;
    expect(store.getSend(held.sendId)).toMatchObject({ state: "held", approvalId: "apr_1" });
    const requestsBefore = fake.requests.length;
    secrets.setOwner(OWNER_C);
    expect(await send.ownerSend(held.sendId, store.getSend(held.sendId)!.revision)).toMatchObject({ status: "retry_later" });
    store.casSend(held.sendId, store.getSend(held.sendId)!.revision, { state: "approved_unsent", code: "send_failed" }, clock);
    expect(await send.retry(store.getSend(held.sendId)!)).toMatchObject({ status: "retry_later" });
    expect(fake.requests).toHaveLength(requestsBefore);
    fake.on("GET", /\/v1\/email\/inboxes\/ibx_1$/, okInbox);
    await bindings.proveOwners(true);
    expect(bindings.ownerRefFor("b1")).toBe(OWNER_C.keyId);
    fake.on("POST", /\/held\/h1\/send$/, { status: 200, body: { status: "sent", message_id: "m9" } });
    expect((await send.retry(store.getSend(held.sendId)!)).status).toBe("done");
    expect(fake.calls("POST", /\/held\/h1\/send$/)[0]!.headers.authorization).toBe("Bearer tok-owner-C");
  });
});

describe("19: the owner credential source", () => {
  it("(a) a Flux key and no owner token: ownerRef() is null, no owner run starts, and every inbox row stays held", async () => {
    secrets = createMemoryEmailSecrets();
    secrets.setBotKey("b1", { token: "tok-bot-B", keyId: "key_K_B" });
    rig({ keepSecrets: true });
    const flux = { token: "sk-flux-B", keyId: "account:fp" };
    expect(emailOwnerRef(secrets)).toBeNull();
    expect(flux.keyId).toBeTruthy(); // the Flux key exists in the app; the email owner identity never falls back to it
    expect(await bindings.enable("b2", { username: "x" })).toBeNull();
    expect(await bindings.proveOwner("b1")).toBe("held");
    expect(bindings.ownerProven("b1")).toBe(false);
    expect(fake.requests).toHaveLength(0);
  });
  it("(b) owner token C, Flux key B, account() returning the Flux key: ownerRef() is C's key id and the fence compares against secrets.owner()", async () => {
    secrets.setOwner(OWNER_C);
    const withFluxAccount = emailCredentialProvider(secrets, () => ({ token: "sk-flux-B", keyId: "account:fpB" }));
    expect(withFluxAccount.ownerRef?.()).toBe(OWNER_C.keyId);
    expect(emailOwnerRef(secrets)).toBe(OWNER_C.keyId);
    const c = new FluxEmailClient({ fetch: fake.fetch, apiBase: "https://api.flux.test", appBase: "https://app.flux.test", credentials: withFluxAccount, timeoutMs: 100 });
    fake.always("GET", /./, { status: 200, body: { limits: {} } });
    expect(await c.getSettings("account:fpB")).toMatchObject({ kind: "uncertain", reason: "owner_changed" });
    expect((await c.getSettings(OWNER_C.keyId)).kind).toBe("ok");
    expect(fake.requests[0]!.headers.authorization).toBe("Bearer tok-owner-C");
  });
});

describe("20: a cancel and a Retry racing", () => {
  const FIXTURE = join(fileURLToPath(new URL(".", import.meta.url)), "testing", "fixtures", "migration-1019");
  it("a U1 failed row, a Retry press and a boot advance started together: one cancel tx, at most one fresh setup op, K_B never sent, the fresh key not dropped", async () => {
    dir = mkdtempSync(join(tmpdir(), "murage-r6-"));
    copyFileSync(join(FIXTURE, "email.db"), join(dir, "email.db"));
    const db = new DatabaseSync(join(dir, "email.db"));
    secrets = createMemoryEmailSecrets();
    secrets.replaceAll(JSON.parse(readFileSync(join(FIXTURE, "credentials.json"), "utf8")));
    secrets.setOwner(OWNER_C);
    rig({ db, keepSecrets: true });
    db.prepare("UPDATE email_bindings SET state='failed', failure='setup_no_answer' WHERE bot_id='b1'").run();
    let cancels = 0;
    const original = store.casBinding.bind(store);
    store.casBinding = ((botId: string, revision: number, patch: Record<string, unknown>, now: number) => { if (patch.state === "restored_unverified" && patch.failure === "account_changed") cancels++; return original(botId, revision, patch as never, now); }) as typeof store.casBinding;
    fake.always("GET", /\/v1\/email\/inboxes$/, { status: 200, body: { data: [] } })
      .on("POST", /bot-keys$/, { status: 200, body: { key: "tok-bot-C", key_id: "key_K_C" } }).on("POST", /\/v1\/email\/inboxes$/, "reset");
    const press = bindings.enable("b1", {});
    const boot = bindings.advance("b1");
    const reconcile = bindings.reconcileBindings();
    await Promise.all([press, boot, reconcile]);
    expect(cancels).toBe(1);
    expect(fake.calls("POST", /bot-keys$/).length).toBeLessThanOrEqual(1);
    for (const request of fake.requests) { expect(request.headers.authorization).not.toContain("tok-bot-B"); expect(request.headers["idempotency-key"] ?? "").not.toContain("op-fixture-1"); }
    expect(secrets.botKey("b1")?.keyId).toBe("key_K_C");
    db.close();
  });
});

describe("21: F3, no stamp from the present", () => {
  it("noteAccount with a batch whose usedOwnerRef is C stamps nothing on a row whose record is B or missing; it stamps a row proven by C", () => {
    store.insertBinding({ botId: "b2", inboxId: "ibx_2", address: "b2@murage.email", username: "b2", displayName: "B2", emailKeyRef: "key_K_B2", fluxAccountId: null, state: "active", step: null, opId: "op-2", opStartedAt: clock, policy: "auto", failure: null, updatedAt: clock });
    store.insertBinding({ botId: "b3", inboxId: "ibx_3", address: "b3@murage.email", username: "b3", displayName: "B3", emailKeyRef: "key_K_B3", fluxAccountId: null, state: "active", step: null, opId: "op-3", opStartedAt: clock, policy: "auto", failure: null, updatedAt: clock });
    store.setCursor("inbox-owner:b2", JSON.stringify({ ownerRef: OWNER_B.keyId, inboxId: "ibx_2", at: clock }), clock);
    store.setCursor("inbox-owner:b3", JSON.stringify({ ownerRef: OWNER_C.keyId, inboxId: "ibx_3", at: clock }), clock);
    bindings.noteAccount("acct_C", OWNER_C.keyId);
    expect(store.getBinding("b1")!.fluxAccountId).toBeNull(); // no record
    expect(store.getBinding("b2")!.fluxAccountId).toBeNull(); // record is B
    expect(store.getBinding("b3")!.fluxAccountId).toBe("acct_C"); // record is C: the positive control
  });
});

describe("the held inbox line", () => {
  it("heldBots lists exactly the unproven inboxes, and the line is one plain sentence in the copy and in all 8 locales", () => {
    expect(bindings.heldBots()).toEqual(["b1"]);
    store.setCursor("inbox-owner:b1", JSON.stringify({ ownerRef: OWNER_B.keyId, inboxId: "ibx_1", at: clock }), clock);
    expect(bindings.heldBots()).toEqual([]);
    secrets.setOwner(OWNER_C);
    expect(bindings.heldBots()).toEqual(["b1"]);
    const dirLocales = fileURLToPath(new URL("../../src/locales/", import.meta.url));
    for (const locale of ["de", "en", "es", "fr", "hi", "ja", "pt-br", "zh"]) {
      const line = (JSON.parse(readFileSync(join(dirLocales, `${locale}.json`), "utf8")) as Record<string, string>)["email.inbox.held"];
      expect(line, locale).toBeTruthy();
      expect(line, locale).not.toMatch(/—|–|\b(safe|unsafe|safety|free|forge|will fail)\b/i);
    }
    expect(EMAIL_OWNER_COPY.checkingAccount).toMatch(/^Murage is checking the email account\./);
  });
});
