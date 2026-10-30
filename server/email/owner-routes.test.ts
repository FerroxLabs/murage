// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The owner's /api/email/* routes (BOT-EMAIL-MURAGE-109 2.0, 2.4 to 2.6, 3.3, 3.5, 6, 8) against the fake-Flux stub, through a real
// EmailRuntime on an in-memory database: dark launch, F18 (a bot or engine credential never reaches a route), the phone's fresh proof,
// the account switch, setup, pause and resume, the trusted and Never email lists, the policy row, Remove, Activity and the price line.
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { EmailRuntime } from "./runtime.ts";
import { emailOwnerRoute, type OwnerRouteDeps, type OwnerRouteRequest } from "./owner-routes.ts";
import { FakeFlux, fluxError, type FakeReply } from "../testing/fake-flux-email.ts";
import { EMAIL_OWNER_COPY, EMAIL_POLICY_COPY, EMAIL_SETUP_COPY, emailOwnerActionCard, emailOwnerActionRequestId } from "../../shared/email-copy.ts";
import type { BotRecord } from "../store.ts";

const ACCOUNT = "sk-flux-account-fixture";
const OWNER = "owner-fixture-token";
const BOT = { id: "b1", name: "Juniper", threadId: "t-b1" };
const CAPS = { object: "email.capabilities", enabled: true, available: true, account_state: "active", terms_version: "2026-11-email-v1", limits: { max_inboxes: 5, inboxes_used: 0 },
  price: { display_note: "One plain cost line from Flux.", display_surfaces: ["desktop", "web"] } };

let fake: FakeFlux;
let db: DatabaseSync;
let runtime: EmailRuntime;
let accountKey: string | null;
let notices: Array<{ kind: string; body: string }>;
let proofs: Array<{ threadId: string; requestId: string; card: unknown }>;
let proofAnswer: { status: number; body: Record<string, unknown> } | null;
let clock: number;

function makeRuntime(): EmailRuntime {
  const made = new EmailRuntime({
    accountKey: () => accountKey, database: () => db, transaction: fn => fn(), fetch: fake.fetch, apiBase: "https://api.flux.test", appBase: "https://app.flux.test", now: () => clock,
    workspaceRoot: () => undefined, bot: id => (id === BOT.id ? BOT as unknown as BotRecord : undefined),
    cardHost: {
      botName: () => BOT.name, threadExists: () => true, card: () => null, appendCard: () => "m1", patchCard: () => undefined, outcome: () => undefined, activity: () => undefined,
      notify: (kind, _botId, _threadId, body) => notices.push({ kind, body }),
    },
  });
  made.secrets.setOwner({ token: OWNER, keyId: "key_owner" });
  return made;
}

const deps = (): OwnerRouteDeps => ({
  runtime, bot: id => (id === BOT.id ? BOT : undefined), fluxKeyPresent: () => accountKey !== null, now: () => clock,
  freshProof: async (threadId, requestId, card) => { proofs.push({ threadId, requestId, card }); return proofAnswer; },
});
const call = (method: string, path: string, body?: unknown, patch: Partial<OwnerRouteRequest> = {}) =>
  emailOwnerRoute(deps(), { method, path, query: new URL(`http://x${path}`).searchParams, body, surface: "desktop", botCredential: false, ...patch });
const tables = () => (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'email_%'").all() as Array<{ name: string }>).map(row => row.name);

async function enable(caps: Record<string, unknown> = CAPS): Promise<void> {
  fake.always("GET", /^\/v1\/email\/capabilities$/, { status: 200, body: caps });
  await runtime.probe.refresh();
}
async function giveAddress(): Promise<void> {
  fake.on("POST", /^\/api\/desktop\/bot-keys$/, { status: 201, body: { key: "bot-email-key", key_id: "key_b1" } });
  fake.on("POST", /^\/v1\/email\/inboxes$/, { status: 201, body: { id: "ibx_1", bot_id: "b1", address: "juniper@murage.email", state: "active", send_policy: "auto" } });
  const answer = await call("POST", "/api/email/bots/b1/setup", { username: "juniper", displayName: "Juniper" });
  expect(answer?.status, JSON.stringify(answer?.body)).toBe(200);
}
const inboxRead = (state: string, pause: unknown = null): FakeReply => ({ status: 200, body: { id: "ibx_1", bot_id: "b1", address: "juniper@murage.email", state, pause, sends_today: 3, daily_send_cap: 50 } });

beforeEach(() => {
  clock = 1_800_000_000_000;
  fake = new FakeFlux();
  db = new DatabaseSync(":memory:");
  accountKey = ACCOUNT;
  notices = []; proofs = []; proofAnswer = null;
  runtime = makeRuntime();
});

describe("dark launch (2.0, section 8)", () => {
  it("probe off: every route is the one not-available refusal, no email table is made and only #31 reached Flux", async () => {
    fake.always("GET", /^\/v1\/email\/capabilities$/, { status: 200, body: { enabled: false } });
    await runtime.probe.refresh();
    for (const [method, path, body] of [["GET", "/api/email/status"], ["GET", "/api/email/bots/b1"], ["POST", "/api/email/account", { on: true }], ["POST", "/api/email/bots/b1/setup", { username: "juniper", displayName: "J" }], ["POST", "/api/email/bots/b1/trusted-add", { entry: "a@b.test" }]] as const) {
      expect(await call(method, path, body), path).toEqual({ status: 404, body: { error: EMAIL_OWNER_COPY.notAvailable } });
    }
    expect(tables()).toEqual([]);
    expect(fake.requests.every(request => request.path === "/v1/email/capabilities")).toBe(true);
  });

  it("the Flux line shows only for an install that had email on and lost its key; never for one that never had email", async () => {
    accountKey = null;
    expect((await call("GET", "/api/email/status"))?.body).toEqual({ error: EMAIL_OWNER_COPY.notAvailable });
    accountKey = ACCOUNT;
    await enable();
    runtime.services();
    accountKey = null;
    expect((await call("GET", "/api/email/status"))?.body).toEqual({ error: EMAIL_OWNER_COPY.notAvailable, fluxOff: EMAIL_SETUP_COPY.fluxOff });
    // a fresh runtime on the same data folder still knows (read only, nothing made)
    runtime = makeRuntime();
    expect((await call("GET", "/api/email/status"))?.body).toEqual({ error: EMAIL_OWNER_COPY.notAvailable, fluxOff: EMAIL_SETUP_COPY.fluxOff });
  });
});

describe("the saved Flux key stopped working (1.0.11)", () => {
  const refusedBody = { error: EMAIL_OWNER_COPY.notAvailable, fluxRefused: EMAIL_SETUP_COPY.fluxKeyRefused };
  it("a probe 401 on the account key answers the status read with the sign-in-again line, never a bare not-available", async () => {
    fake.on("GET", /^\/v1\/email\/capabilities$/, { status: 401, body: { error: "invalid_api_key", message: "" } });
    await runtime.probe.refresh();
    expect(runtime.probe.accountKeyRefused()).toBe(true);
    expect(await call("GET", "/api/email/status")).toEqual({ status: 404, body: refusedBody });
    // only the status read carries the line; every other route stays the one refusal
    expect(await call("GET", "/api/email/bots/b1")).toEqual({ status: 404, body: { error: EMAIL_OWNER_COPY.notAvailable } });
    expect(tables()).toEqual([]);
  });

  it("the refresh read sees the 401 too, and a readable answer afterwards clears it", async () => {
    fake.on("GET", /^\/v1\/email\/capabilities$/, { status: 401, body: { error: "key_revoked", message: "" } });
    expect((await call("GET", "/api/email/status", undefined, { query: new URLSearchParams("refresh=1") }))?.body).toEqual(refusedBody);
    fake.on("GET", /^\/v1\/email\/capabilities$/, { status: 200, body: { enabled: false } });
    expect((await call("GET", "/api/email/status", undefined, { query: new URLSearchParams("refresh=1") }))?.body).toEqual({ error: EMAIL_OWNER_COPY.notAvailable });
    expect(runtime.probe.accountKeyRefused()).toBe(false);
  });

  it("a 403, a lost answer or a new saved key is not a refused key; with no key saved the line never shows", async () => {
    fake.on("GET", /^\/v1\/email\/capabilities$/, { status: 403, body: { error: "email_not_enabled", message: "" } });
    await runtime.probe.refresh();
    expect((await call("GET", "/api/email/status"))?.body).toEqual({ error: EMAIL_OWNER_COPY.notAvailable });
    fake.on("GET", /^\/v1\/email\/capabilities$/, { status: 401, body: { error: "invalid_api_key", message: "" } });
    await runtime.probe.refresh();
    expect((await call("GET", "/api/email/status"))?.body).toEqual(refusedBody);
    // a new key (Sign in with Flux again) is a different account: nothing refused until Flux answers for it
    accountKey = "sk-flux-new-account-fixture";
    expect(runtime.probe.accountKeyRefused()).toBe(false);
    expect((await call("GET", "/api/email/status"))?.body).toEqual({ error: EMAIL_OWNER_COPY.notAvailable });
    accountKey = null;
    expect((await call("GET", "/api/email/status"))?.body).toEqual({ error: EMAIL_OWNER_COPY.notAvailable });
  });

  it("the probe keeps a refused key across a network blip (uncertain answer keeps the last word)", async () => {
    fake.on("GET", /^\/v1\/email\/capabilities$/, { status: 401, body: { error: "invalid_api_key", message: "" } });
    await runtime.probe.refresh();
    fake.on("GET", /^\/v1\/email\/capabilities$/, "reset");
    await runtime.probe.refresh();
    expect(runtime.probe.accountKeyRefused()).toBe(true);
  });
});

describe("who may call (2.1, 2.4, F18)", () => {
  it("a bot or engine credential never reaches a route, on or off, and Flux is never called for it", async () => {
    await enable();
    const before = fake.requests.length;
    for (const path of ["/api/email/status", "/api/email/bots/b1"]) expect(await call("GET", path, undefined, { botCredential: true })).toEqual({ status: 403, body: { error: EMAIL_OWNER_COPY.ownerOnly } });
    expect(await call("POST", "/api/email/bots/b1/setup", { username: "juniper", displayName: "J" }, { botCredential: true, surface: "desktop" })).toEqual({ status: 403, body: { error: EMAIL_OWNER_COPY.ownerOnly } });
    expect(await call("POST", "/api/email/account", { on: false, confirm: true }, { surface: null })).toEqual({ status: 403, body: { error: EMAIL_OWNER_COPY.ownerOnly } });
    expect(fake.requests.length).toBe(before);
    expect(await emailOwnerRoute(deps(), { method: "GET", path: "/api/other", query: new URLSearchParams(), body: undefined, surface: "desktop", botCredential: true })).toBeNull();
  });

  it("a phone act carries a fresh device proof over the exact act; a refused proof stops it before Flux", async () => {
    await enable();
    proofAnswer = { status: 403, body: { code: "fresh_auth", challenge: { v: 1 } } };
    const before = fake.requests.length;
    const body = { username: "juniper", displayName: "Juniper" };
    expect(await call("POST", "/api/email/bots/b1/setup", body, { surface: "phone" })).toEqual(proofAnswer);
    expect(proofs).toEqual([{ threadId: BOT.threadId, requestId: emailOwnerActionRequestId("setup", "b1"), card: emailOwnerActionCard("setup", "b1", body) }]);
    expect(fake.requests.length).toBe(before);
    // the desktop never asks for one
    proofs = [];
    await giveAddress();
    expect(proofs).toEqual([]);
  });

  it("the account switch is desktop only", async () => {
    await enable();
    expect(await call("POST", "/api/email/account", { on: false, confirm: true }, { surface: "phone" })).toEqual({ status: 403, body: { error: EMAIL_OWNER_COPY.computerOnly } });
  });
});

describe("account on and off (2.0)", () => {
  it("Off needs the confirm line, then pauses every binding as account_off; On sends the terms version and brings them back", async () => {
    await enable();
    await giveAddress();
    expect(await call("POST", "/api/email/account", { on: false })).toMatchObject({ status: 400, body: { error: EMAIL_SETUP_COPY.accountOffConfirm } });
    fake.on("POST", /^\/v1\/email\/disable$/, { status: 200, body: { account_state: "disabled" } });
    expect((await call("POST", "/api/email/account", { on: false, confirm: true }))?.status).toBe(200);
    expect(fake.calls("POST", /disable$/)[0]!.headers.authorization).toBe(`Bearer ${OWNER}`);
    expect(runtime.services()!.store.getBinding("b1")?.state).toBe("account_off");
    fake.on("POST", /^\/v1\/email\/enable$/, { status: 200, body: { enabled: true } });
    expect((await call("POST", "/api/email/account", { on: true }))?.status).toBe(200);
    expect(fake.calls("POST", /enable$/)[0]!.body).toEqual({ accept_terms_version: "2026-11-email-v1" });
    expect(runtime.services()!.store.getBinding("b1")?.state).toBe("active");
  });

  it("the price line is the capabilities display_note, desktop only and only where Flux lets it show", async () => {
    await enable();
    expect((await call("GET", "/api/email/status"))?.body.priceNote).toBe("One plain cost line from Flux.");
    expect((await call("GET", "/api/email/status", undefined, { surface: "phone" }))?.body.priceNote).toBeUndefined();
    runtime = makeRuntime();
    fake = new FakeFlux();
    runtime = makeRuntime();
    await enable({ ...CAPS, price: { display_note: "Web only.", display_surfaces: ["web"] } });
    expect((await call("GET", "/api/email/status"))?.body.priceNote).toBeUndefined();
  });
});

describe("a bot's address (2.5, 2.6, section 6)", () => {
  it("setup takes an owner-typed username and display name, made with the email:owner token; a bad username never reaches Flux", async () => {
    await enable();
    const before = fake.requests.length;
    expect(await call("POST", "/api/email/bots/b1/setup", { username: "-x", displayName: "J" })).toEqual({ status: 400, body: { error: EMAIL_OWNER_COPY.invalidUsername } });
    expect(fake.requests.length).toBe(before);
    await giveAddress();
    const created = fake.calls("POST", /^\/v1\/email\/inboxes$/)[0]!;
    expect(created.headers.authorization).toBe(`Bearer ${OWNER}`);
    expect(created.body).toMatchObject({ username: "juniper", display_name: "Juniper" });
    fake.on("GET", /^\/v1\/email\/inboxes\/ibx_1$/, inboxRead("active"));
    const view = (await call("GET", "/api/email/bots/b1"))!.body;
    expect(view).toMatchObject({ state: "active", address: "juniper@murage.email", chip: "juniper@murage.email", panelLine: EMAIL_OWNER_COPY.sentToday(3, 50), policy: "auto" });
  });

  it("a failed setup shows its line with Retry; Retry runs the setup again", async () => {
    await enable();
    fake.on("POST", /^\/api\/desktop\/bot-keys$/, { status: 201, body: { key: "bot-email-key", key_id: "key_b1" } });
    fake.on("POST", /^\/v1\/email\/inboxes$/, fluxError(409, "username_unavailable"));
    const failed = (await call("POST", "/api/email/bots/b1/setup", { username: "juniper", displayName: "Juniper" }))!.body;
    expect(failed).toMatchObject({ state: "failed", chip: EMAIL_SETUP_COPY.failed });
    fake.on("POST", /^\/v1\/email\/inboxes$/, { status: 201, body: { id: "ibx_1", bot_id: "b1", address: "juniper2@murage.email", state: "active" } });
    fake.on("GET", /^\/v1\/email\/inboxes\/ibx_1$/, inboxRead("active"));
    expect((await call("POST", "/api/email/bots/b1/retry", {}))!.body).toMatchObject({ state: "active", address: "juniper2@murage.email" });
  });

  it("Pause sending pauses at Flux (#6) and raises one email-status notice; Resume asks for a note and acknowledges the pause reason (#8)", async () => {
    await enable();
    await giveAddress();
    fake.on("PATCH", /^\/v1\/email\/inboxes\/ibx_1$/, inboxRead("paused", { reason: "owner", resumable_by: "owner" }));
    let fluxState = "paused";
    fake.always("GET", /^\/v1\/email\/inboxes\/ibx_1$/, () => fluxState === "paused" ? inboxRead("paused", { reason: "owner", resumable_by: "owner" }) : inboxRead("active"));
    const paused = (await call("POST", "/api/email/bots/b1/pause", {}))!.body;
    expect(fake.calls("PATCH", /ibx_1$/)[0]!.body).toEqual({ paused: true });
    expect(paused).toMatchObject({ state: "paused", chip: "Email paused", panelLine: EMAIL_OWNER_COPY.pausedLine("Juniper"), pauseReason: "owner" });
    expect(notices.filter(notice => notice.kind === "email-status")).toHaveLength(1);
    expect(await call("POST", "/api/email/bots/b1/resume", { note: "  " })).toEqual({ status: 400, body: { error: EMAIL_OWNER_COPY.resumeNoteNeeded } });
    fake.on("POST", /^\/v1\/email\/inboxes\/ibx_1\/resume$/, fluxError(403, "pause_cooloff", { resumable_at: "2026-11-12T08:00:00Z" }));
    expect(await call("POST", "/api/email/bots/b1/resume", { note: "Fixed the list" })).toMatchObject({ status: 403, body: { code: "pause_cooloff" } });
    fake.on("POST", /^\/v1\/email\/inboxes\/ibx_1\/resume$/, () => { fluxState = "active"; return inboxRead("active"); });
    const resumed = await call("POST", "/api/email/bots/b1/resume", { note: "Fixed the list" });
    expect(fake.calls("POST", /resume$/).at(-1)!.body).toEqual({ acknowledge: "owner" });
    expect(resumed?.body.state).toBe("active");
  });

  it("Remove needs the 2.6 confirm, then withdraws and asks Flux to delete", async () => {
    await enable();
    await giveAddress();
    expect(await call("POST", "/api/email/bots/b1/remove", {})).toMatchObject({ status: 400, body: { error: EMAIL_SETUP_COPY.removeConfirm("juniper@murage.email", "Juniper") } });
    fake.on("DELETE", /^\/v1\/email\/inboxes\/ibx_1$/, { status: 202, body: { id: "ibx_1", state: "closing" } });
    const removed = (await call("POST", "/api/email/bots/b1/remove", { confirm: true }))!.body;
    expect(removed).toMatchObject({ state: "remove_requested", chip: EMAIL_SETUP_COPY.removing });
    expect((await call("GET", "/api/email/status"))!.body.removing).toEqual([{ botId: "b1", address: "juniper@murage.email" }]);
  });
});

describe("who the bot can email (3.3, 3.5)", () => {
  beforeEach(async () => { await enable(); await giveAddress(); fake.always("GET", /^\/v1\/email\/inboxes\/ibx_1$/, inboxRead("active")); });

  it("the policy row writes email_policy_sync and Flux's send_policy with the owner token", async () => {
    fake.on("PATCH", /^\/v1\/email\/inboxes\/ibx_1$/, { status: 200, body: { id: "ibx_1", send_policy: "ask" } });
    const view = (await call("POST", "/api/email/bots/b1/policy", { policy: "ask" }))!.body;
    expect(fake.calls("PATCH", /ibx_1$/)[0]!.body).toEqual({ send_policy: "ask" });
    expect(view).toMatchObject({ policy: "ask", policyPending: false });
    expect(await call("POST", "/api/email/bots/b1/policy", { policy: "everyone" })).toMatchObject({ status: 400 });
  });

  it("trusted takes exact addresses only; a domain_allow_not_available answer shows the one line; Never email takes addresses or domains as block", async () => {
    const before = fake.requests.length;
    expect(await call("POST", "/api/email/bots/b1/trusted-add", { entry: "acme.test" })).toEqual({ status: 400, body: { error: EMAIL_OWNER_COPY.invalidAddress } });
    expect(fake.requests.length).toBe(before);
    fake.on("POST", /recipients$/, fluxError(400, "domain_allow_not_available"));
    expect(await call("POST", "/api/email/bots/b1/trusted-add", { entry: "Jane@Acme.test" })).toEqual({ status: 400, body: { error: EMAIL_POLICY_COPY.domainAllowNotAvailable("Juniper"), code: "domain_allow_not_available" } });
    fake.on("POST", /recipients$/, { status: 201, body: { entry: "jane@acme.test", rule: "allow" } });
    const view = (await call("POST", "/api/email/bots/b1/trusted-add", { entry: "Jane@Acme.test" }))!.body;
    expect(fake.calls("POST", /recipients$/).at(-1)!.body).toEqual({ entry: "jane@acme.test", rule: "allow" });
    expect(view.trusted).toEqual([{ entry: "jane@acme.test", source: "owner", sourceLabel: "Added by you" }]);
    fake.on("POST", /recipients$/, { status: 201, body: { entry: "spam.test", rule: "block" } });
    const blocked = (await call("POST", "/api/email/bots/b1/blocked-add", { entry: "spam.test" }))!.body;
    expect(fake.calls("POST", /recipients$/).at(-1)!.body).toEqual({ entry: "spam.test", rule: "block" });
    expect(blocked.blocked).toEqual([{ entry: "spam.test", source: "owner", sourceLabel: "Added by you" }]);
    fake.on("DELETE", /recipients\/jane%40acme\.test$/, { status: 204 });
    expect(((await call("POST", "/api/email/bots/b1/trusted-remove", { entry: "jane@acme.test" }))!.body.trusted as unknown[])).toEqual([]);
  });

  it("Activity lists one plain line per email with its reference", async () => {
    const store = runtime.services()!.store;
    const base = { botId: "b1", generation: 1, threadId: "t-b1", inboxId: "ibx_1", kind: "send" as const, replyMessageId: null, payloadHash: "h", idemSuffix: 0, code: null, stopRequested: false, ownerSent: false, replaces: null, receipt: null, attempts: [], heldIds: [], approvalId: null, messageId: null, reconcileStep: 0, dueAt: null, updatedAt: clock, dispatchedAt: null, settledAt: null, deliveryNote: null, revision: 0 };
    const summary = { to: ["new@x.test"], cc: [], subject: "Hi", textLength: 2, attachments: [], replySource: null };
    store.insertSend({ ...base, sendId: "s1", summary, state: "sent", why: "owner_send", createdAt: clock - 10 });
    store.insertSend({ ...base, sendId: "s2", summary, state: "awaiting_owner", why: "waiting_new_contact", createdAt: clock });
    const view = (await call("GET", "/api/email/bots/b1"))!.body as { activity: Array<{ line: string }>; waiting: number; chip: string };
    expect(view.activity.map(item => item.line)).toEqual(["Waiting: first reply to someone new", "Sent: you pressed Send"]);
    expect(view.waiting).toBe(1);
    expect(view.chip).toBe("1 email waiting for you");
  });
});

describe("contract r2.5 (dark bot keys, closing, Keep address)", () => {
  it("setup while Flux's bot key switch is off (bodiless 404): the dark answer, no failed row, no error card", async () => {
    await enable();
    fake.on("POST", /^\/api\/desktop\/bot-keys$/, { status: 404 });
    const answer = await call("POST", "/api/email/bots/b1/setup", { username: "juniper", displayName: "Juniper" });
    expect(answer).toEqual({ status: 404, body: { error: EMAIL_OWNER_COPY.notAvailable, code: "email_dark" } });
    expect(runtime.services()!.store.getBinding("b1")).toBeNull();
    expect(fake.calls("POST", /^\/v1\/email\/inboxes$/)).toHaveLength(0);
    const view = await call("GET", "/api/email/bots/b1");
    expect(view?.body).toMatchObject({ state: null, failure: null });
  });

  it("Remove answers 202 closing: the section says the address stays until closing_until and offers Keep address, which restores it", async () => {
    await enable();
    await giveAddress();
    fake.on("DELETE", /^\/v1\/email\/inboxes\/ibx_1$/, { status: 202, body: { object: "email.inbox", id: "ibx_1", state: "closing", closing_until: "2026-12-01T00:00:00Z" } });
    const removed = await call("POST", "/api/email/bots/b1/remove", { confirm: true });
    expect(removed?.body).toMatchObject({ state: "remove_requested", panelLine: "juniper@murage.email stays yours until 2026-12-01. Choose Keep address to bring it back." });
    expect(String((removed?.body as { panelLine: string }).panelLine)).not.toMatch(/\u2014|safe/i);
    fake.on("POST", /^\/v1\/email\/inboxes\/ibx_1\/restore$/, { status: 200, body: { id: "ibx_1", state: "active" } }).always("GET", /^\/v1\/email\/inboxes\/ibx_1$/, inboxRead("active"));
    const kept = await call("POST", "/api/email/bots/b1/keep", {});
    expect(kept?.status).toBe(200);
    expect(kept?.body).toMatchObject({ state: "active", address: "juniper@murage.email" });
    expect(fake.calls("POST", /\/restore$/)[0].body).toEqual({ bot_id: "b1" });
  });

  it("PATCH during closing (403 inbox_closing, restorable) is a plain owner line; Keep on an open address says it is open", async () => {
    await enable();
    await giveAddress();
    fake.on("PATCH", /^\/v1\/email\/inboxes\/ibx_1$/, fluxError(403, "inbox_closing", { closing_until: "2026-12-01T00:00:00Z", restorable: true }));
    const paused = await call("POST", "/api/email/bots/b1/pause", {});
    expect(paused).toMatchObject({ status: 403, body: { code: "inbox_closing", error: "This address is closing, so changes wait. Choose Keep address to bring it back first." } });
    const keep = await call("POST", "/api/email/bots/b1/keep", {});
    expect(keep).toMatchObject({ status: 409, body: { code: "not_closing", error: "This address is already open." } });
  });
});
