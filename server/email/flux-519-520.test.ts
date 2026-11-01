// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Flux #519/#520 alignment (flux-router master 42ee7973): the account counters from #1 settings, 403 email_scope_required naming its
// scope, the account switch and renewal_due on #28, a bot key never mounting on closing or failed inboxes, a 202 hold without a receipt
// still making a card, and an owner resume that Flux keeps paused saying why instead of "resumed".
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { EmailRuntime } from "./runtime.ts";
import { emailOwnerRoute, type OwnerRouteRequest } from "./owner-routes.ts";
import { EMAIL_MOUNT_STATES } from "./admission.ts";
import { FakeFlux, fluxError, scopeRequired } from "../testing/fake-flux-email.ts";
import { EMAIL_OWNER_COPY, ownerRouteLine } from "../../shared/email-copy.ts";
import type { BotRecord } from "../store.ts";

const BOT = { id: "b1", name: "Juniper", threadId: "t-b1" };
const CAPS = { object: "email.capabilities", enabled: true, available: true, account_state: "active", terms_version: "v1", limits: {} };
let fake: FakeFlux;
let db: DatabaseSync;
let runtime: EmailRuntime;
let logs: string[];
let localBots: Set<string>;

beforeEach(async () => {
  fake = new FakeFlux();
  db = new DatabaseSync(":memory:");
  logs = [];
  localBots = new Set(["b1"]);
  runtime = new EmailRuntime({
    accountKey: () => "sk-flux-account-fixture", database: () => db, transaction: fn => fn(), fetch: fake.fetch, apiBase: "https://api.flux.test", appBase: "https://app.flux.test",
    now: () => 1_800_000_000_000, workspaceRoot: () => undefined, bot: id => (localBots.has(id) ? BOT as unknown as BotRecord : undefined), log: line => logs.push(line),
  });
  runtime.secrets.setOwner({ token: "owner-fixture", keyId: "key_owner" });
  runtime.secrets.setBotKey("b1", { token: "bot-fixture", keyId: "key_b1" });
  fake.always("GET", /^\/v1\/email\/capabilities$/, { status: 200, body: CAPS });
  await runtime.probe.refresh();
  runtime.services()!.store.insertBinding({ botId: "b1", inboxId: "ibx_1", address: "juniper@murage.email", username: "juniper", displayName: "Juniper", emailKeyRef: "key_b1", fluxAccountId: null, state: "active", step: null, opId: null, opStartedAt: null, policy: "auto", failure: null, updatedAt: 1 });
});

const call = (method: string, path: string, body?: unknown, patch: Partial<OwnerRouteRequest> = {}) => emailOwnerRoute({
  runtime, bot: id => (localBots.has(id) ? BOT : undefined), fluxKeyPresent: () => true, freshProof: async () => null,
}, { method, path, query: new URL(`http://x${path}`).searchParams, body, surface: "desktop", botCredential: false, ...patch });

describe("account counters (#1 settings)", () => {
  it("account_sends_today and account_sends_per_day give the account line; at the cap it is the design's cap line", async () => {
    fake.on("GET", /^\/v1\/email\/settings$/, { status: 200, body: { object: "email.settings", limits: { account_sends_today: 12, account_sends_per_day: 200 } } });
    fake.always("GET", /^\/v1\/email\/inboxes$/, { status: 200, body: { data: [] } });
    const answer = await call("GET", "/api/email/status");
    expect(answer?.body.accountSends).toEqual({ today: 12, perDay: 200 });
    expect(EMAIL_OWNER_COPY.accountSentToday(12, 200)).toBe("Your bots have sent 12 of 200 emails today.");
    expect(EMAIL_OWNER_COPY.accountSentToday(200, 200)).toBe("Your bots have sent today's 200 emails together.");
    expect(fake.calls("GET", /^\/v1\/email\/settings$/)[0]!.headers.authorization).toBe("Bearer owner-fixture");
  });
});

describe("email_scope_required", () => {
  it("a send refused 403 email_scope_required: the bot is refused, the owner log names the scope, never a key", async () => {
    fake.on("POST", /\/messages$/, scopeRequired(["email:bot"]));
    const send = runtime.services()!.send;
    runtime.services()!.store.addTrusted("b1", "jane@acme.test", "allow", "owner", 1);
    const result = await send.submit({ botId: "b1", generation: 1, threadId: "t1", draft: { kind: "send", to: ["jane@acme.test"], cc: [], subject: "Hi", text: "Hi", attachments: [], replyTo: null } }) as { row?: { state: string; code: string } };
    expect(result.row).toMatchObject({ state: "refused", code: "email_scope_required" });
    expect(logs.some(line => line === "[email] Flux asked for scope email:bot")).toBe(true);
    expect(logs.join("\n")).not.toContain("bot-fixture");
    expect(ownerRouteLine("email_scope_required")).toMatch(/Reconnect email/);
  });
});

describe("#28 account and renewal events", () => {
  it("email.account.disabled moves every live binding to account_off and enabled brings it back; renewal_due changes nothing", async () => {
    const bindings = runtime.services()!.bindings;
    expect(await bindings.applyLifecycle({ type: "email.inbox.renewal_due", inbox_id: "ibx_1", data: {} })).toBeNull();
    expect(runtime.services()!.store.getBinding("b1")!.state).toBe("active");
    await bindings.applyLifecycle({ type: "email.account.disabled", data: { inboxes: 1 } });
    expect(runtime.services()!.store.getBinding("b1")!.state).toBe("account_off");
    await bindings.applyLifecycle({ type: "email.account.enabled", data: { restored: 1 } });
    expect(runtime.services()!.store.getBinding("b1")!.state).toBe("active");
  });
  it("the event reader hands the account events to the binding service", async () => {
    fake.on("GET", /^\/v1\/email\/events$/, { status: 200, body: { data: [{ id: "eev_1", type: "email.account.disabled", created: "2026-10-27T00:00:00Z", data: {} }], next_cursor: "c1" } });
    expect(await runtime.services()!.events.pollOnce()).toBe("ok");
    expect(runtime.services()!.store.getBinding("b1")!.state).toBe("account_off");
  });
});

describe("what a bot key can read", () => {
  it("closing and failed inboxes never mount the tools (Flux answers the bot key only on active, paused, grace)", () => {
    expect(EMAIL_MOUNT_STATES.has("closing")).toBe(false);
    expect(EMAIL_MOUNT_STATES.has("failed")).toBe(false);
    expect(EMAIL_MOUNT_STATES.has("account_off")).toBe(false);
    expect(EMAIL_MOUNT_STATES.has("restored_unverified")).toBe(false);
  });
});

describe("owner resume that Flux keeps paused", () => {
  it("resume answered with state paused: 409 still_paused with the why line, not a resumed panel", async () => {
    const store = runtime.services()!.store;
    store.casBinding("b1", store.getBinding("b1")!.revision, { state: "paused" }, 2);
    fake.on("GET", /^\/v1\/email\/inboxes\/ibx_1$/, { status: 200, body: { id: "ibx_1", state: "paused", pause: { reason: "owner" } } });
    fake.on("POST", /^\/v1\/email\/inboxes\/ibx_1\/resume$/, { status: 200, body: { id: "ibx_1", state: "paused", pause: { reason: "complaint" } } });
    const answer = await call("POST", "/api/email/bots/b1/resume", { note: "fixed the list" });
    expect(answer?.status).toBe(409);
    expect(answer?.body).toMatchObject({ code: "still_paused", error: ownerRouteLine("still_paused") });
    expect(store.getBinding("b1")!.state).toBe("paused");
  });
  it("a support-only pause refused by Flux shows the support line", async () => {
    const store = runtime.services()!.store;
    store.casBinding("b1", store.getBinding("b1")!.revision, { state: "paused" }, 2);
    fake.on("GET", /^\/v1\/email\/inboxes\/ibx_1$/, { status: 200, body: { id: "ibx_1", state: "paused", pause: { reason: "abuse" } } });
    fake.on("POST", /^\/v1\/email\/inboxes\/ibx_1\/resume$/, fluxError(403, "bot_pause_requires_support"));
    const answer = await call("POST", "/api/email/bots/b1/resume", { note: "please" });
    expect(answer?.body.error).toBe(EMAIL_OWNER_COPY.supportPausedLine);
  });
});

describe("Email addresses from another setup (2.6, #4)", () => {
  it("lists inboxes whose bot is not local and not bound here, and Remove deletes one (desktop only, with confirm)", async () => {
    fake.always("GET", /^\/v1\/email\/settings$/, { status: 200, body: { limits: {} } });
    fake.always("GET", /^\/v1\/email\/inboxes$/, { status: 200, body: { data: [
      { id: "ibx_1", bot_id: "b1", address: "juniper@murage.email", state: "active" },
      { id: "ibx_9", bot_id: "gone-bot", address: "old@murage.email", state: "active" },
      { id: "ibx_8", bot_id: "gone-too", address: "done@murage.email", state: "deleted" },
    ] } });
    const status = await call("GET", "/api/email/status");
    expect(status?.body.otherSetups).toEqual([{ inboxId: "ibx_9", address: "old@murage.email" }]);
    expect((await call("POST", "/api/email/other-setups/ibx_9/remove", { confirm: true }, { surface: "phone" }))?.status).toBe(403);
    expect((await call("POST", "/api/email/other-setups/ibx_9/remove", {}))?.status).toBe(400);
    expect((await call("POST", "/api/email/other-setups/ibx_1/remove", { confirm: true }))?.status).toBe(404);
    fake.on("DELETE", /^\/v1\/email\/inboxes\/ibx_9$/, { status: 202, body: { id: "ibx_9", state: "closing" } });
    expect((await call("POST", "/api/email/other-setups/ibx_9/remove", { confirm: true }))?.status).toBe(200);
    expect(fake.calls("DELETE", /^\/v1\/email\/inboxes\/ibx_9$/)).toHaveLength(1);
  });
});
