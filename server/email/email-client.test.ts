// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Flux email client's outcome mapping, the capability probe (dark launch), the email secret store and the 3.3 decision.
import { describe, expect, it } from "vitest";
import { botKeysDark, classifyResponse, FluxEmailClient, parseFluxError } from "./flux-email-client.ts";
import { EmailCapabilityProbe, isEnabled } from "./capabilities.ts";
import { credentialFingerprint, EMAIL_SECRETS_ENV, EmailSecretStore, emailCredentialProvider, sanitizeEmailSecrets } from "./email-secrets.ts";
import { decideSend, distinctAddressesInText } from "./send-policy.ts";
import { canonicalPayload, emailRef, payloadHash, uuidv7 } from "./canonical.ts";
import { FakeFlux, fluxError } from "../testing/fake-flux-email.ts";
import { WORKSPACE_CREDENTIAL_ENV } from "../config.ts";

function client(fake: FakeFlux, account = true) {
  const secrets = new EmailSecretStore();
  secrets.setOwner({ token: "owner-token", keyId: "key_owner" });
  secrets.setBotKey("b1", { token: "bot-token", keyId: "key_b1" });
  return new FluxEmailClient({ fetch: fake.fetch, apiBase: "https://api.flux.test", appBase: "https://app.flux.test", credentials: emailCredentialProvider(secrets, () => account ? { token: "acct-token", keyId: "key_acct" } : null), timeoutMs: 200 });
}

describe("outcome mapping (3.4)", () => {
  it("reads the flat error body with `error` as a string or an object", () => {
    expect(parseFluxError({ error: "bot_paused", message: "Paused.", pause: { reason: "owner" } })).toEqual({ error: "bot_paused", message: "Paused.", fields: { pause: { reason: "owner" } } });
    expect(parseFluxError({ error: { code: "unavailable", message: "Down." } })).toEqual({ error: "unavailable", message: "Down.", fields: {} });
    expect(parseFluxError({ error: { type: "rate_limit_error" } })?.error).toBe("rate_limit_error");
    expect(parseFluxError({ error: {} })).toBeNull();
    expect(parseFluxError("oops")).toBeNull();
  });

  it.each([
    [200, { status: "sent", message_id: "m" }, "ok"],
    [201, { id: "ibx" }, "ok"],
    [204, undefined, "ok"],
    [202, { status: "pending_approval", held_id: "h" }, "held"],
    // r2.5: email never answers 502 settlement_unavailable; there is no settlement outcome left, a 502 body is an ordinary refusal
    [502, { error: "settlement_unavailable" }, "refused"],
    [409, { error: "idempotency_in_progress" }, "uncertain"],
    [409, { error: "idempotency_mismatch" }, "uncertain"],
    [503, undefined, "uncertain"],
    [500, "<html>", "uncertain"],
    [200, undefined, "uncertain"],
    [503, { error: "capability_unavailable", retry_after_s: 30 }, "refused"],
    [403, { error: "bot_paused" }, "refused"],
    [402, { error: "key_budget_reached" }, "refused"],
    [413, { error: "payload_too_large" }, "refused"],
    [415, { error: "attachment_type_blocked" }, "refused"],
    [429, { error: "daily_send_cap_reached" }, "refused"],
    [409, { error: "approval_scope_mismatch" }, "refused"],
    [404, undefined, "refused"],
  ])("%s %j -> %s", (status, body, kind) => {
    expect(classifyResponse(status as number, body, "key").kind).toBe(kind);
  });

  it("r2.5: 503 capability_unavailable is a definite refusal (nothing stored under the key, so the same key may be sent again)", () => {
    expect(classifyResponse(503, { error: "capability_unavailable", retry_after_s: 5 }, "k")).toMatchObject({ kind: "refused", status: 503, code: "capability_unavailable", error: { fields: { retry_after_s: 5 } } });
  });

  it("a 502 is a definite refusal, a 4xx without a body keeps its status as the code", () => {
    expect(classifyResponse(502, { error: "bad_gateway" }, "k")).toMatchObject({ kind: "refused", code: "bad_gateway" });
    expect(classifyResponse(404, undefined, "k")).toMatchObject({ kind: "refused", code: "http_404" });
  });
});

describe("the client", () => {
  it("sends Idempotency-Key, the right bearer per route, and never a bot key on owner routes", async () => {
    const fake = new FakeFlux()
      .on("POST", /\/messages$/, { status: 200, body: { status: "sent", message_id: "msg_1" } })
      .on("POST", /\/approve$/, { status: 200, body: { state: "approved_once", sends: [] } })
      .on("POST", /^\/api\/desktop\/bot-keys$/, { status: 200, body: { key: "k", key_id: "key_new" } })
      .on("GET", /capabilities$/, { status: 200, body: { enabled: false } });
    const c = client(fake);
    const sent = await c.send("b1", "ibx_1", { to: ["a@x.test"], cc: [], subject: "s", text: "t", attachments: [], client_reference: "sid" }, "murage-email:i:sid:1");
    expect(sent).toMatchObject({ kind: "ok", keyId: "key_b1" });
    await c.approve("apr_1", ["h1"]);
    await c.mintBotKey({ botId: "b1", botMonthlySpendLimitUsd: 12.5 }, "murage-key:i:op");
    await c.capabilities();
    const [send, approve, mint, caps] = fake.requests;
    expect(send.headers.authorization).toBe("Bearer bot-token");
    expect(send.headers["idempotency-key"]).toBe("murage-email:i:sid:1");
    expect(send.body).toMatchObject({ client_reference: "sid", on_new_recipient: "hold", html: null });
    expect(approve.headers.authorization).toBe("Bearer owner-token");
    expect(approve.body).toEqual({ scope: "once", held_ids: ["h1"], acknowledge_future_sends: false });
    expect(mint.host).toBe("app.flux.test");
    // r2.4/r2.5 body: {bot_id, scopes, bot_monthly_spend_limit_usd}; no label, no per-key budget
    expect(mint.body).toEqual({ bot_id: "b1", scopes: ["email:bot"], bot_monthly_spend_limit_usd: 12.5 });
    expect(mint.headers.authorization).toBe("Bearer owner-token");
    expect(mint.headers["idempotency-key"]).toBe("murage-key:i:op");
    expect(caps.headers.authorization).toBe("Bearer acct-token");
    expect(fake.unexpected).toEqual([]);
  });

  it("r2.5 routes: bot-keys mint without a budget, revoke, #3 by bot_id, #7 closing, #37 restore; a bodiless bot-keys 404 is dark", async () => {
    const fake = new FakeFlux()
      .on("POST", /^\/api\/desktop\/bot-keys$/, { status: 404 })
      .on("DELETE", /^\/api\/desktop\/bot-keys\/key_1$/, { status: 404 })
      .on("DELETE", /^\/api\/desktop\/bot-keys\/key_2$/, fluxError(404, "key_not_found"))
      .on("POST", /^\/v1\/email\/inboxes$/, fluxError(404, "bot_not_found"))
      .on("DELETE", /^\/v1\/email\/inboxes\/ibx_1$/, { status: 202, body: { object: "email.inbox", id: "ibx_1", state: "closing", closing_until: "2026-12-01T00:00:00Z" } })
      .on("POST", /^\/v1\/email\/inboxes\/ibx_1\/restore$/, { status: 200, body: { object: "email.inbox", id: "ibx_1", state: "active" } });
    const c = client(fake);
    const mint = await c.mintBotKey({ botId: "b1" }, "murage-key:i:op");
    expect(botKeysDark(mint)).toBe(true);
    expect(fake.requests[0].body).toEqual({ bot_id: "b1", scopes: ["email:bot"] });
    expect(botKeysDark(await c.revokeBotKey("key_1"))).toBe(true);
    const missing = await c.revokeBotKey("key_2");
    expect(missing).toMatchObject({ kind: "refused", status: 404, code: "key_not_found" });
    expect(botKeysDark(missing)).toBe(false);
    expect(await c.createInbox({ botId: "b1", username: "juniper" }, "murage-inbox:i:op")).toMatchObject({ kind: "refused", code: "bot_not_found" });
    const create = fake.calls("POST", /^\/v1\/email\/inboxes$/)[0];
    expect(create.body).toEqual({ bot_id: "b1", username: "juniper" });
    expect(create.headers.authorization).toBe("Bearer owner-token");
    expect(JSON.stringify(create.body)).not.toContain("bot_key_id");
    expect(await c.deleteInbox("ibx_1")).toMatchObject({ kind: "held", body: { state: "closing", closing_until: "2026-12-01T00:00:00Z" } });
    expect(await c.restoreInbox("ibx_1", "b1")).toMatchObject({ kind: "ok", body: { state: "active" } });
    expect(fake.calls("POST", /\/restore$/)[0]).toMatchObject({ body: { bot_id: "b1" }, headers: { authorization: "Bearer owner-token" } });
    expect(fake.unexpected).toEqual([]);
  });

  it("a reset, a timeout and a missing credential are uncertain", async () => {
    const fake = new FakeFlux().on("POST", /\/messages$/, "reset").on("POST", /\/messages$/, "timeout");
    const c = client(fake);
    const body = { to: ["a@x.test"], cc: [], subject: "s", text: "t", attachments: [], client_reference: "sid" };
    expect(await c.send("b1", "ibx_1", body, "k")).toMatchObject({ kind: "uncertain", reason: "network" });
    expect(await c.send("b1", "ibx_1", body, "k")).toMatchObject({ kind: "uncertain", reason: "timeout" });
    expect(await c.send("nobody", "ibx_1", body, "k")).toMatchObject({ kind: "uncertain", reason: "no_credential" });
  });
});

describe("the capability probe (dark launch, F28)", () => {
  it("is off unless the answer says enabled: true, and #33's available: false keeps it off", () => {
    expect(isEnabled(undefined)).toBe(false);
    expect(isEnabled({ enabled: false })).toBe(false);
    expect(isEnabled({})).toBe(false);
    expect(isEnabled({ enabled: "true" as unknown as boolean })).toBe(false);
    expect(isEnabled({ enabled: true, available: true })).toBe(true);
    expect(isEnabled({ enabled: true, available: false })).toBe(false);
  });

  it("a missing available is dark; eligible: false with not_rolled_out is dark; a 404 hides everything", async () => {
    expect(isEnabled({ enabled: true })).toBe(false);
    expect(isEnabled({ enabled: true, eligible: true, account_state: "active" })).toBe(false);
    expect(isEnabled({ enabled: true, available: true, eligible: false, reason: "not_rolled_out" } as never)).toBe(false);
    const fake = new FakeFlux().on("GET", /\/v1\/email\/capabilities$/, fluxError(404, "not_found"));
    const probe = new EmailCapabilityProbe({ client: client(fake), accountRef: () => "acct" });
    expect(isEnabled(await probe.refresh())).toBe(false);
    expect(probe.emailEnabled()).toBe(false);
  });

  it("r2.5: lights up only with enabled: true beside available/eligible; eligible: false keeps an account that never turned email on dark", () => {
    // #33 without the platform flag (the pre-r2.5 body) stays dark
    expect(isEnabled({ available: true, eligible: true, account_state: "active" })).toBe(false);
    expect(isEnabled({ enabled: false, available: true, eligible: true })).toBe(false);
    expect(isEnabled({ enabled: true, available: true, eligible: true, account_state: "off" })).toBe(true);
    expect(isEnabled({ enabled: true, available: true, eligible: false, account_state: "off" })).toBe(false);
    expect(isEnabled({ enabled: true, available: true, eligible: false })).toBe(false);
    // an account already on keeps its bots' addresses in view (the owner manages them)
    expect(isEnabled({ enabled: true, available: true, eligible: false, account_state: "active" })).toBe(true);
    expect(isEnabled({ enabled: true, available: false, eligible: true, account_state: "active" })).toBe(false);
  });

  it("caches per saved account, re-reads on email_not_enabled and capability_unavailable, keeps the last answer on no answer", async () => {
    let account = "acct-a";
    const fake = new FakeFlux()
      .on("GET", /capabilities$/, { status: 200, body: { enabled: true, available: true, price: { display_note: "From Flux.", display_surfaces: ["desktop"] }, limits: { max_inboxes: 5 } } })
      .on("GET", /capabilities$/, { status: 200, body: { enabled: false } })
      .on("GET", /capabilities$/, "reset")
      .on("GET", /capabilities$/, fluxError(401, "unauthorized"));
    const probe = new EmailCapabilityProbe({ client: client(fake), accountRef: () => account });
    const changes: boolean[] = [];
    probe.onChange(enabled => changes.push(enabled));
    expect(probe.emailEnabled()).toBe(false);
    await probe.refresh();
    expect(probe.emailEnabled()).toBe(true);
    expect(probe.priceNote()).toEqual({ note: "From Flux.", surfaces: ["desktop"] });
    expect(probe.limit("max_inboxes")).toBe(5);
    expect(probe.limit("max_bot_daily_send_cap")).toBeUndefined();
    account = "acct-b";
    expect(probe.emailEnabled()).toBe(false); // another saved account has its own answer
    account = "acct-a";
    await probe.noteRefusal("bot_paused"); // not a launch-switch code: no read
    expect(fake.calls("GET", /capabilities$/)).toHaveLength(1);
    await probe.noteRefusal("email_not_enabled");
    expect(probe.emailEnabled()).toBe(false);
    await probe.refresh(); // no answer: the last answer stays
    expect(probe.emailEnabled()).toBe(false);
    account = "acct-c";
    await probe.refresh(); // 401: off
    expect(probe.emailEnabled()).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  it("with no saved account nothing is read", async () => {
    const fake = new FakeFlux();
    const probe = new EmailCapabilityProbe({ client: client(fake), accountRef: () => null });
    expect(await probe.refresh()).toBeNull();
    expect(fake.requests).toHaveLength(0);
  });
});

describe("the email secret store (2.3, 2.4)", () => {
  it("reads MURAGE_EMAIL_SECRETS once, deletes it, and the name is stripped from every child env", () => {
    const env: NodeJS.ProcessEnv = { [EMAIL_SECRETS_ENV]: JSON.stringify({ owner: { token: "o", keyId: "key_o" }, bots: { b1: { token: "t", keyId: "key_1" }, "../x": { token: "t", keyId: "k" }, b2: { token: "", keyId: "k" } } }) };
    const store = new EmailSecretStore();
    expect(store.loadFromEnv(env)).toEqual({ loaded: 2 });
    expect(env[EMAIL_SECRETS_ENV]).toBeUndefined();
    expect(store.loadFromEnv(env)).toEqual({ loaded: 0 });
    expect(store.botKey("b1")).toEqual({ token: "t", keyId: "key_1", label: "bot-email:b1" });
    expect(store.botIds()).toEqual(["b1"]);
    expect(WORKSPACE_CREDENTIAL_ENV).toContain(EMAIL_SECRETS_ENV);
  });

  it("hands every change to the shell and compares by fingerprint only", () => {
    const pushed: unknown[] = [];
    const store = new EmailSecretStore(doc => pushed.push(doc));
    store.setBotKey("b1", { token: "tok", keyId: "key_1" });
    store.clearBotKey("b1");
    expect(pushed).toHaveLength(2);
    expect(sanitizeEmailSecrets(pushed[0])).toEqual({ bots: { b1: { token: "tok", keyId: "key_1", label: "bot-email:b1" } } });
    store.setOwner({ token: "own", keyId: "key_o" });
    expect(store.fingerprints()).toEqual([credentialFingerprint("own")]);
    expect(store.fingerprints().join()).not.toContain("own");
  });
});

describe("who can the bot email without asking (3.3)", () => {
  const approved = new Set(["jane@acme.test", "cc@acme.test"]);
  const base = { policy: "auto" as const, kind: "send" as const, to: ["jane@acme.test"], cc: [] as string[], subject: "Hi", text: "Hello", attachmentCount: 0, replySource: null, isApproved: (a: string) => approved.has(a) };
  const source = { from: "jane@acme.test", senderAuthenticated: true, scanStatus: "complete", scanVerdict: "clear", listMail: false };
  it.each([
    ["auto, approved address", {}, false, "trusted"],
    ["auto, new address", { to: ["new@x.test"] }, true, "waiting_new_contact"],
    ["ask holds everything", { policy: "ask" }, true, "waiting_ask"],
    ["attachment", { attachmentCount: 1 }, true, "waiting_attachment"],
    ["over 8000 characters", { text: "x".repeat(8001) }, true, "waiting_long"],
    ["more than 3 addresses in the text", { text: "a@x.test b@x.test c@x.test d@x.test" }, true, "waiting_many_addresses"],
    ["more than 3 recipients", { to: ["jane@acme.test", "a@x.test", "b@x.test", "c@x.test"] }, true, "waiting_many_addresses"],
    ["cc not approved", { cc: ["other@x.test"] }, true, "waiting_cc"],
    ["reply to an approved first-writer", { kind: "reply", to: ["jane@acme.test"], replySource: source }, false, "approved_first_writer"],
    ["reply to a new first-writer", { kind: "reply", to: ["bob@x.test"], replySource: { ...source, from: "bob@x.test" } }, true, "waiting_new_contact"],
    ["reply, unauthenticated source", { kind: "reply", replySource: { ...source, senderAuthenticated: false } }, true, "waiting_source_unverified"],
    ["reply, scan not clear", { kind: "reply", replySource: { ...source, scanVerdict: "review" } }, true, "waiting_source_unverified"],
    ["reply, scan pending", { kind: "reply", replySource: { ...source, scanStatus: "pending" } }, true, "waiting_source_unverified"],
    ["reply, list mail", { kind: "reply", replySource: { ...source, listMail: true } }, true, "waiting_source_unverified"],
    ["reply with a recipient besides the From", { kind: "reply", to: ["jane@acme.test", "cc@acme.test"], replySource: source }, true, "waiting_extra_recipients"],
    ["reply under ask", { kind: "reply", policy: "ask", replySource: source }, true, "waiting_ask"],
  ])("%s", (_name, patch, needsOwner, why) => {
    expect(decideSend({ ...base, ...(patch as object) })).toEqual({ needsOwner, why });
  });
  it("counts distinct addresses", () => { expect(distinctAddressesInText("A@x.test a@x.test b@y.test")).toBe(2); });
});

describe("canonical payload, ids and refs (3.4, 4.6)", () => {
  it("hashes the canonical form: address order and case do not matter, the text does", () => {
    const draft = { kind: "send" as const, to: ["B@x.test", "a@x.test"], cc: [], subject: "s", text: "t", attachments: [{ name: "a.pdf", contentType: "application/pdf", bytes: new Uint8Array([1, 2]) }], replyTo: null };
    expect(payloadHash(draft)).toBe(payloadHash({ ...draft, to: ["a@x.test", "b@x.test"] }));
    expect(payloadHash(draft)).not.toBe(payloadHash({ ...draft, text: "t2" }));
    expect(canonicalPayload(draft)).not.toContain("AQI"); // bytes are hashed, never inlined
  });
  it("mints UUIDv7 and E- references", () => {
    const id = uuidv7(1_700_000_000_000, new Uint8Array(10).fill(255));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(id.startsWith("018bcfe5-6800")).toBe(true);
    expect(emailRef(id)).toMatch(/^E-[A-Z0-9]{6}$/);
  });
});
