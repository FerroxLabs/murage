// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Section 8 credential health per email credential (Astra 12), G15 (a refused email key unmounts the tools), 2.3 rotation through
// Reconnect, and the section 7 import offer, against the fake-Flux stub through a real EmailRuntime on an in-memory database.
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { EmailRuntime } from "./runtime.ts";
import { classifyKeyHealth, EmailKeyHealth, KEY_BACKOFF_CEILING_MS, KEY_HEALTH_LINES } from "./key-health.ts";
import { classifyResponse, type CredentialRef } from "./flux-email-client.ts";
import { emailOwnerRoute, type OwnerRouteDeps } from "./owner-routes.ts";
import { FakeFlux, fluxError, scopeRequired } from "../testing/fake-flux-email.ts";
import { EMAIL_SETUP_COPY } from "../../shared/email-copy.ts";
import { EMAIL_UNAVAILABLE } from "./admission.ts";
import type { BotRecord } from "../store.ts";

const BOT_REF: CredentialRef = { kind: "bot", botId: "b1" };
const OWNER_REF: CredentialRef = { kind: "owner" };
const refused = (status: number, code: string) => classifyResponse(status, { error: code, message: "" }, "key_b1");

describe("classifyKeyHealth (section 8)", () => {
  it("tells a refused key from email off, not eligible, a pause and an outage", () => {
    expect(classifyKeyHealth(BOT_REF, refused(401, "unauthorized"))).toBe("rejected");
    expect(classifyKeyHealth(BOT_REF, classifyResponse(401, undefined, "key_b1"))).toBe("rejected");
    expect(classifyKeyHealth(OWNER_REF, refused(401, "key_expired"))).toBe("rejected");
    expect(classifyKeyHealth(BOT_REF, refused(403, "email_not_enabled"))).toBe("email_off");
    expect(classifyKeyHealth(BOT_REF, refused(402, "premium_locked"))).toBe("not_eligible");
    expect(classifyKeyHealth(BOT_REF, refused(503, "capability_unavailable"))).toBe("outage");
    expect(classifyKeyHealth(BOT_REF, classifyResponse(503, undefined, "key_b1"))).toBe("outage");
  });
  it("403 bot_paused is a pause, never a key problem", () => {
    expect(classifyKeyHealth(BOT_REF, refused(403, "bot_paused"))).toBe("paused");
    expect(classifyKeyHealth(BOT_REF, refused(403, "bot_paused"))).not.toBe("rejected");
  });
  it("a bot key without the email scope is refused; recipient refusals and lost answers say nothing about the key", () => {
    expect(classifyKeyHealth(BOT_REF, classifyResponse(403, (scopeRequired() as { body: unknown }).body, "k"))).toBe("rejected");
    // 1.0.11: the owner token without email scope is a sign-in, never a dead key
    expect(classifyKeyHealth(OWNER_REF, refused(403, "email_scope_required"))).toBe("scope");
    expect(classifyKeyHealth(BOT_REF, refused(400, "recipient_blocked"))).toBeNull();
    expect(classifyKeyHealth(BOT_REF, { kind: "uncertain", reason: "network" })).toBeNull();
    expect(classifyKeyHealth(BOT_REF, classifyResponse(200, { ok: true }, "key_b1"))).toBe("ok");
  });
});

describe("EmailKeyHealth", () => {
  it("keeps one record per credential; an ok answer clears it; a changed key starts clean", () => {
    let clock = 1_000;
    const health = new EmailKeyHealth({ now: () => clock });
    health.observe(BOT_REF, refused(401, "key_revoked"));
    health.observe(OWNER_REF, refused(402, "premium_locked"));
    expect(health.rejected("b1", "key_b1")).toBe(true);
    expect(health.line("bot:b1", "key_b1")).toBe(KEY_HEALTH_LINES.rejected);
    expect(KEY_HEALTH_LINES.rejected).toBe("Email is not reachable: Flux did not accept the saved key.");
    expect(health.line("owner", "key_b1")).toBe(KEY_HEALTH_LINES.not_eligible);
    // the bot's record never touches the owner's
    health.observe(BOT_REF, classifyResponse(200, {}, "key_b1"));
    expect(health.rejected("b1", "key_b1")).toBe(false);
    expect(health.line("owner", "key_b1")).toBe(KEY_HEALTH_LINES.not_eligible);
    health.observe(BOT_REF, refused(401, "key_revoked"));
    expect(health.rejected("b1", "key_b1_new")).toBe(false);
    expect(health.rejected("b1", "key_b1")).toBe(false);
    clock += 1;
  });

  it("an outage waits 2 s, doubling to a 5 minute ceiling, and answers locally while it waits", () => {
    let clock = 0;
    const health = new EmailKeyHealth({ now: () => clock });
    const waits: number[] = [];
    for (let i = 0; i < 12; i++) {
      health.observe(BOT_REF, refused(503, "capability_unavailable"));
      waits.push(health.record("bot:b1", "key_b1")!.retryAt! - clock);
    }
    expect(waits.slice(0, 4)).toEqual([2_000, 4_000, 8_000, 16_000]);
    expect(Math.max(...waits)).toBe(KEY_BACKOFF_CEILING_MS);
    const local = health.gate(BOT_REF);
    expect(local).toMatchObject({ kind: "refused", status: 503, code: "capability_unavailable" });
    expect(health.gate(OWNER_REF)).toBeNull();
    clock += KEY_BACKOFF_CEILING_MS;
    expect(health.gate(BOT_REF)).toBeNull();
  });
});

// ---- through the runtime and the owner routes ----

const BOT = { id: "b1", name: "Juniper", threadId: "t-b1" };
let fake: FakeFlux;
let db: DatabaseSync;
let runtime: EmailRuntime;
let clock: number;
let imported: { emailIntent?: "was-on" } | undefined;
let capsOn: boolean;

const deps = (): OwnerRouteDeps => ({
  runtime, bot: id => (id === BOT.id ? { ...BOT, ...(imported ? { installedPackage: imported } : {}) } : undefined), fluxKeyPresent: () => true, now: () => clock,
  freshProof: async () => null,
});
const call = (method: string, path: string, body?: unknown) =>
  emailOwnerRoute(deps(), { method, path, query: new URL(`http://x${path}`).searchParams, body, surface: "desktop", botCredential: false });
const live = { bot: () => ({ id: "b1", threadId: "t-b1" }), ownerSurface: () => true, notOwnerAudience: () => false, ownerThread: () => true, boundRequest: () => false };
const mountInput = {
  driverKind: "claudeAgent", agentsMcp: true, surfacesForOwner: true, directOwnerAudience: true, origin: "desktop", automationThread: false,
  bot: { id: "b1", threadId: "t-b1" }, threadId: "t-b1",
};

beforeEach(async () => {
  clock = 1_800_000_000_000;
  fake = new FakeFlux();
  db = new DatabaseSync(":memory:");
  imported = undefined;
  capsOn = true;
  runtime = new EmailRuntime({
    accountKey: () => "sk-flux-account-fixture", database: () => db, transaction: fn => fn(), fetch: fake.fetch, apiBase: "https://api.flux.test", appBase: "https://app.flux.test",
    now: () => clock, workspaceRoot: () => undefined, bot: id => (id === BOT.id ? BOT as unknown as BotRecord : undefined),
  });
  runtime.secrets.setOwner({ token: "owner-fixture-token", keyId: "key_owner" });
  fake.always("GET", /^\/v1\/email\/capabilities$/, () => ({ status: 200, body: { enabled: capsOn, available: true, account_state: "active", terms_version: "v1" } }));
  await runtime.probe.refresh();
});

async function giveAddress(): Promise<void> {
  fake.on("POST", /^\/api\/desktop\/bot-keys$/, { status: 201, body: { key: "bot-email-key-1", key_id: "key_b1" } });
  fake.on("POST", /^\/v1\/email\/inboxes$/, { status: 201, body: { id: "ibx_1", bot_id: "b1", address: "juniper@murage.email", state: "active", send_policy: "auto" } });
  const answer = await call("POST", "/api/email/bots/b1/setup", { username: "juniper", displayName: "Juniper" });
  expect(answer?.status, JSON.stringify(answer?.body)).toBe(200);
}

describe("G15 and 2.3 through the runtime", () => {
  it("a refused bot key unmounts the tools, refuses calls without reaching Flux, and Reconnect rotates it", async () => {
    await giveAddress();
    expect(runtime.mount("gen-1", mountInput).mounted).toBe(true);
    fake.always("GET", /^\/v1\/email\/inboxes\/ibx_1\/messages$/, { status: 200, body: { object: "list", data: [] } });
    expect((await runtime.call("email_list", { botId: "b1", threadId: "t-b1", generation: "gen-1" }, {}, live)).status).toBe(200);
    fake.on("GET", /^\/v1\/email\/inboxes\/ibx_1$/, fluxError(401, "key_revoked"));
    await runtime.client.getInbox({ kind: "bot", botId: "b1" }, "ibx_1");
    expect(runtime.keyRejected("b1")).toBe(true);
    expect(runtime.mount("gen-2", mountInput)).toEqual({ mounted: false, line: KEY_HEALTH_LINES.rejected });
    const before = fake.requests.length;
    const refusedCall = await runtime.call("email_list", { botId: "b1", threadId: "t-b1", generation: "gen-1" }, {}, live);
    expect(refusedCall).toEqual({ status: 403, body: { error: EMAIL_UNAVAILABLE } });
    expect(fake.requests.length).toBe(before);

    // the owner sees the section 8 line and Reconnect (the inbox re-read uses the owner token, which is fine)
    fake.always("GET", /^\/v1\/email\/inboxes\/ibx_1$/, req => req.headers.authorization === "Bearer bot-email-key-1"
      ? fluxError(401, "key_revoked") : { status: 200, body: { id: "ibx_1", bot_id: "b1", address: "juniper@murage.email", state: "active", sends_today: 0, daily_send_cap: 50 } });
    const view = (await call("GET", "/api/email/bots/b1"))!.body as Record<string, unknown>;
    expect(view).toMatchObject({ keyRejected: true, keyLine: KEY_HEALTH_LINES.rejected });

    fake.on("POST", /^\/api\/desktop\/bot-keys$/, { status: 201, body: { key: "bot-email-key-2", key_id: "key_b1_2" } });
    fake.on("DELETE", /^\/api\/desktop\/bot-keys\/key_b1$/, { status: 204, body: {} });
    const reconnected = await call("POST", "/api/email/bots/b1/reconnect", {});
    expect(reconnected?.status, JSON.stringify(reconnected?.body)).toBe(200);
    expect(runtime.secrets.botKey("b1")?.keyId).toBe("key_b1_2");
    expect(runtime.keyRejected("b1")).toBe(false);
    expect(runtime.mount("gen-3", mountInput).mounted).toBe(true);
    expect(fake.requests.some(req => req.method === "DELETE" && req.path === "/api/desktop/bot-keys/key_b1")).toBe(true);
    // the candidate key was checked against #5 before it was saved
    expect(fake.requests.some(req => req.path === "/v1/email/inboxes/ibx_1" && req.headers.authorization === "Bearer bot-email-key-2")).toBe(true);
  });

  it("403 bot_paused leaves the key good and the tools mounted", async () => {
    await giveAddress();
    fake.on("GET", /^\/v1\/email\/inboxes\/ibx_1$/, fluxError(403, "bot_paused"));
    await runtime.client.getInbox({ kind: "bot", botId: "b1" }, "ibx_1");
    expect(runtime.keyRejected("b1")).toBe(false);
    expect(runtime.botKeyLine("b1")).toBe(KEY_HEALTH_LINES.paused);
  });

  it("the owner token's health shows on the status view", async () => {
    fake.always("GET", /^\/v1\/email\/settings$/, fluxError(401, "key_expired"));
    fake.always("GET", /^\/v1\/email\/inboxes$/, fluxError(401, "key_expired"));
    const status = (await call("GET", "/api/email/status"))!.body as Record<string, unknown>;
    expect(status).toMatchObject({ ownerSignedIn: true, ownerKeyLine: KEY_HEALTH_LINES.rejected });
    // a new owner sign-in (another key id) starts clean
    runtime.secrets.setOwner({ token: "owner-fixture-token-2", keyId: "key_owner_2" });
    expect(runtime.ownerKeyLine()).toBeNull();
  });

  it("a backoff answers locally: Flux is not called again until the wait ends", async () => {
    await giveAddress();
    fake.on("GET", /^\/v1\/email\/inboxes\/ibx_1$/, fluxError(503, "capability_unavailable"));
    await runtime.client.getInbox({ kind: "bot", botId: "b1" }, "ibx_1");
    const count = fake.requests.filter(req => req.path === "/v1/email/inboxes/ibx_1").length;
    const local = await runtime.client.getInbox({ kind: "bot", botId: "b1" }, "ibx_1");
    expect(local).toMatchObject({ kind: "refused", code: "capability_unavailable" });
    expect(fake.requests.filter(req => req.path === "/v1/email/inboxes/ibx_1").length).toBe(count);
  });
});

describe("section 7 import offer", () => {
  it("an imported bot that had an address gets the offer line while it has none here, and not after", async () => {
    imported = { emailIntent: "was-on" };
    const view = (await call("GET", "/api/email/bots/b1"))!.body as Record<string, unknown>;
    expect(view.importOffer).toBe("This bot had an email address where it came from. Give it one here?");
    expect(view.importOffer).toBe(EMAIL_SETUP_COPY.importOffer);
    await giveAddress();
    expect(((await call("GET", "/api/email/bots/b1"))!.body as Record<string, unknown>).importOffer).toBeNull();
  });
  it("a bot without the intent gets no offer; probe off shows nothing at all", async () => {
    expect(((await call("GET", "/api/email/bots/b1"))!.body as Record<string, unknown>).importOffer).toBeNull();
    imported = { emailIntent: "was-on" };
    capsOn = false;
    await runtime.probe.refresh();
    const off = await call("GET", "/api/email/bots/b1");
    expect(off?.status).toBe(404);
    expect(JSON.stringify(off?.body)).not.toContain("came from");
  });
});
