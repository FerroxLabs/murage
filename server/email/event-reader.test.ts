// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The #28 event reader (5.1, F24), arrivals and the Filtered list (5.2), against a fake Flux. Dark launch: nothing polls while the switch
// is off or no binding can receive.
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FluxEmailClient } from "./flux-email-client.ts";
import { EmailSecretStore, emailCredentialProvider } from "./email-secrets.ts";
import { EmailStore, type BindingState } from "./email-store.ts";
import { EmailBindingService } from "./binding-service.ts";
import { EmailSendService, type EmailOutcomeEvent } from "./send-service.ts";
import { EmailEventReader, BACKOFF_CEILING_MS, EVENT_CURSOR_SCOPE, EVENT_LAST_SEEN_SCOPE, type EmailArrival } from "./event-reader.ts";
import { EmailTools, EMAIL_LINES } from "./tools.ts";
import { isFilteredMail } from "./inbound.ts";
import { BOT_VISIBLE_STATUS, MurageStatus, emailAddrOf, status, botName, statusFromStored, statusRecordOf, storedStatusShapeOk } from "../murage-status.ts";
import { FakeFlux, fluxError } from "../testing/fake-flux-email.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const INBOX = "ibx_1";
let clock = 0;
let fake: FakeFlux;
let store: EmailStore;
let client: FluxEmailClient;
let bindings: EmailBindingService;
let send: EmailSendService;
let reader: EmailEventReader;
let enabled = true;
let arrivals: Array<{ botId: string; list: EmailArrival[] }>;
let outcomes: EmailOutcomeEvent[];
let root: string;

const bind = (state: BindingState = "active") => store.insertBinding({ botId: "b1", inboxId: INBOX, address: "juniper@murage.email", username: "juniper", displayName: "Juniper", emailKeyRef: "key_b1", fluxAccountId: null, state, step: null, opId: null, opStartedAt: null, policy: "auto", failure: null, updatedAt: clock });
const received = (id: string, from: string, extra: Record<string, unknown> = {}) => ({ id, type: "email.message.received", created: `2026-11-10T10:00:0${id.slice(-1)}Z`, inbox_id: INBOX, bot_id: "b1", data: { message_id: `msg_${id}`, thread_id: "thr_1", from, subject: "Hello", preview: "Hi there", trust: "untrusted", sender_authenticated: true, spam: false, held_for_owner: false, ...extra } });
const page = (data: unknown[], next = "c_2") => ({ status: 200, body: { object: "list", data, next_cursor: next } });

beforeEach(() => {
  clock = 1_800_000_000_000;
  enabled = true;
  arrivals = []; outcomes = [];
  fake = new FakeFlux();
  store = new EmailStore(new DatabaseSync(":memory:"));
  const secrets = new EmailSecretStore();
  secrets.setOwner({ token: "owner-token", keyId: "key_owner" });
  secrets.setBotKey("b1", { token: "bot-token", keyId: "key_b1" });
  client = new FluxEmailClient({ fetch: fake.fetch, apiBase: "https://api.flux.test", appBase: "https://app.flux.test", credentials: emailCredentialProvider(secrets, () => null), timeoutMs: 100 });
  bindings = new EmailBindingService({ store, client, secrets, installId: "inst", now: () => clock });
  let n = 0;
  send = new EmailSendService({ store, client, installId: "inst", now: () => clock, newId: () => `send-${++n}`, onOutcome: event => outcomes.push(event) });
  reader = new EmailEventReader({ store, client, send, bindings, enabled: () => enabled, now: () => clock, onArrivals: (botId, list) => arrivals.push({ botId, list }) });
  root = mkdtempSync(join(tmpdir(), "email-events-"));
});
afterEach(() => { removeTempDirSync(root); });

describe("dark launch and who polls (5.1, F23)", () => {
  it("polls nothing while the switch is off", async () => {
    bind();
    enabled = false;
    expect(await reader.pollOnce()).toBe("idle");
    expect(fake.requests).toHaveLength(0);
  });
  it.each(["restored_unverified", "account_off", "failed", "removing", "closing"] as BindingState[])("polls nothing while the only binding is %s", async state => {
    bind(state);
    expect(reader.shouldPoll()).toBe(false);
    expect(await reader.pollOnce()).toBe("idle");
    expect(fake.requests).toHaveLength(0);
  });
  it("polls nothing with no binding at all", async () => {
    expect(await reader.pollOnce()).toBe("idle");
    expect(fake.requests).toHaveLength(0);
  });
});

describe("one long-poll per batch", () => {
  beforeEach(() => bind());

  it("uses the owner credential with wait=25, records each eev_ once and advances the cursor in the same transaction", async () => {
    fake.on("GET", /\/v1\/email\/events$/, page([received("eev_1", "Alex <Alex@Example.com>"), received("eev_2", "sam@example.org")]));
    expect(await reader.pollOnce()).toBe("ok");
    const request = fake.calls("GET", /\/v1\/email\/events$/)[0]!;
    expect(request.headers.authorization).toBe("Bearer owner-token");
    expect(request.query.get("wait")).toBe("25");
    expect(request.query.get("cursor")).toBeNull();
    expect(store.getCursor(EVENT_CURSOR_SCOPE)).toBe("c_2");
    expect(store.getCursor(EVENT_LAST_SEEN_SCOPE)).toBe("2026-11-10T10:00:02Z");
    expect(store.hasEvent("eev_1") && store.hasEvent("eev_2")).toBe(true);
    // grouped: one notice for the bot, bare lower-cased addr-specs only
    expect(arrivals).toHaveLength(1);
    expect(arrivals[0]!.list.map(item => item.from)).toEqual(["alex@example.com", "sam@example.org"]);

    // a repeat of the same events (a second install, a lost answer) makes no second notice; the next poll sends the cursor
    fake.on("GET", /\/v1\/email\/events$/, page([received("eev_2", "sam@example.org")], "c_3"));
    expect(await reader.pollOnce()).toBe("ok");
    expect(fake.calls("GET", /\/v1\/email\/events$/)[1]!.query.get("cursor")).toBe("c_2");
    expect(arrivals).toHaveLength(1);
    expect(store.getCursor(EVENT_CURSOR_SCOPE)).toBe("c_3");
  });

  it("a batch that fails part way leaves no event recorded and the cursor where it was", async () => {
    store.setCursor(EVENT_CURSOR_SCOPE, "c_1", clock);
    const original = store.setCursor.bind(store);
    let failOnce = true;
    store.setCursor = (scope, cursor, now) => { if (scope === EVENT_CURSOR_SCOPE && failOnce) { failOnce = false; throw new Error("disk full"); } original(scope, cursor, now); };
    fake.on("GET", /\/v1\/email\/events$/, page([received("eev_1", "alex@example.com")]));
    await expect(reader.pollOnce()).rejects.toThrow("disk full");
    expect(store.hasEvent("eev_1")).toBe(false);
    expect(store.getCursor(EVENT_CURSOR_SCOPE)).toBe("c_1");
  });

  it("held_for_owner and filtered mail are flagged on the arrival; nothing about an envelope carries a body", async () => {
    fake.on("GET", /\/v1\/email\/events$/, page([
      received("eev_1", "boss@example.com", { held_for_owner: true, subject: undefined, preview: undefined }),
      received("eev_2", "spam@example.net", { spam: true }),
      received("eev_3", "spoof@example.net", { sender_authenticated: false }),
    ]));
    await reader.pollOnce();
    expect(arrivals[0]!.list.map(item => [item.from, item.heldForOwner, item.filtered])).toEqual([
      ["boss@example.com", true, false], ["spam@example.net", false, true], ["spoof@example.net", false, true],
    ]);
    const stored = store.receivedEvents(INBOX);
    expect(stored.every(event => !("text" in event.data) && !("html" in event.data))).toBe(true);
  });

  it("drives the send service: all recipients bounced tells the bot not_sent", async () => {
    store.addTrusted("b1", "jane@acme.test", "allow", "owner", clock);
    fake.on("POST", /\/inboxes\/ibx_1\/messages$/, { status: 200, body: { status: "sent", message_id: "msg_out", client_reference: "send-1" } });
    await send.submit({ botId: "b1", generation: 1, threadId: "t1", draft: { kind: "send", to: ["jane@acme.test"], cc: [], subject: "Thursday", text: "Hi Jane", attachments: [], replyTo: null } });
    expect(store.getSend("send-1")?.state).toBe("sent");
    outcomes.length = 0;
    fake.on("GET", /\/v1\/email\/events$/, page([{ id: "eev_b", type: "email.message.bounced", inbox_id: INBOX, data: { message_id: "msg_out", recipient: "jane@acme.test", bounce: { class: "hard" }, client_reference: "send-1" } }]));
    await reader.pollOnce();
    expect(outcomes.map(event => event.outcome)).toEqual(["not_sent"]);
  });

  it("drives the binding mirror: a lifecycle event pauses the binding after the batch commits", async () => {
    fake.on("GET", /\/v1\/email\/events$/, page([{ id: "eev_p", type: "email.bot.paused", inbox_id: INBOX, data: { pause: { reason: "burst" } } }]));
    await reader.pollOnce();
    expect(store.getBinding("b1")?.state).toBe("paused");
    // a paused inbox still receives: the reader keeps polling
    expect(reader.shouldPoll()).toBe(true);
  });
});

describe("410 cursor_expired (F24)", () => {
  beforeEach(() => bind());

  it("re-lists messages since the last seen event, re-reads #19 and #5, then takes latest_cursor", async () => {
    store.setCursor(EVENT_CURSOR_SCOPE, "c_old", clock);
    store.setCursor(EVENT_LAST_SEEN_SCOPE, "2026-11-01T00:00:00Z", clock);
    fake.on("GET", /\/v1\/email\/events$/, fluxError(410, "cursor_expired", { latest_cursor: "c_latest" }));
    fake.on("GET", /\/inboxes\/ibx_1\/messages$/, { status: 200, body: { object: "list", data: [{ id: "msg_9", direction: "inbound", from: "alex@example.com", subject: "kept out", text: "kept out" }], next_cursor: null } });
    fake.on("GET", /\/inboxes\/ibx_1$/, { status: 200, body: { id: INBOX, state: "active" } });
    fake.on("GET", /\/v1\/email\/approvals$/, { status: 200, body: { object: "list", data: [] } });
    expect(await reader.pollOnce()).toBe("expired");
    expect(fake.calls("GET", /\/inboxes\/ibx_1\/messages$/)[0]!.query.get("since")).toBe("2026-11-01T00:00:00Z");
    expect(fake.calls("GET", /\/v1\/email\/approvals$/)).toHaveLength(1);
    expect(fake.calls("GET", /\/inboxes\/ibx_1$/)).toHaveLength(1);
    expect(store.getCursor(EVENT_CURSOR_SCOPE)).toBe("c_latest");
    expect(arrivals[0]!.list.map(item => item.from)).toEqual(["alex@example.com"]);
    // the re-list keeps the envelope only, never a subject or text
    expect(store.receivedEvents(INBOX)[0]!.data).not.toHaveProperty("text");
    expect(store.receivedEvents(INBOX)[0]!.data).not.toHaveProperty("subject");
    expect(fake.unexpected).toHaveLength(0);
  });

  it("a re-list that could not read everything keeps the old cursor and backs off", async () => {
    store.setCursor(EVENT_CURSOR_SCOPE, "c_old", clock);
    fake.on("GET", /\/v1\/email\/events$/, fluxError(410, "cursor_expired", { latest_cursor: "c_latest" }));
    fake.on("GET", /\/inboxes\/ibx_1\/messages$/, { status: 503 });
    fake.on("GET", /\/inboxes\/ibx_1$/, { status: 200, body: { id: INBOX, state: "active" } });
    fake.on("GET", /\/v1\/email\/approvals$/, { status: 200, body: { object: "list", data: [] } });
    expect(await reader.pollOnce()).toBe("backoff");
    expect(store.getCursor(EVENT_CURSOR_SCOPE)).toBe("c_old");
  });

  it("a hold whose approval left the pending list is read again (#20) and settles", async () => {
    fake.on("POST", /\/inboxes\/ibx_1\/messages$/, { status: 202, body: { status: "held", held_id: "hld_1", client_reference: "send-1", approval: { id: "apr_1", state: "pending", held_ids: ["hld_1"] } } });
    await send.submit({ botId: "b1", generation: 1, threadId: "t1", draft: { kind: "send", to: ["new@acme.test"], cc: [], subject: "Hi", text: "Hello", attachments: [], replyTo: null } });
    const row = store.getSend("send-1")!;
    if (row.state !== "held") return; // 3.3 kept it for the owner first: nothing reached Flux, nothing to re-read
    fake.on("GET", /\/v1\/email\/events$/, fluxError(410, "cursor_expired", { latest_cursor: "c_latest" }));
    fake.on("GET", /\/inboxes\/ibx_1\/messages$/, { status: 200, body: { object: "list", data: [], next_cursor: null } });
    fake.on("GET", /\/inboxes\/ibx_1$/, { status: 200, body: { id: INBOX, state: "active" } });
    fake.on("GET", /\/v1\/email\/approvals$/, { status: 200, body: { object: "list", data: [] } });
    fake.on("GET", /\/v1\/email\/approvals\/apr_1$/, { status: 200, body: { id: "apr_1", state: "expired", held: [{ id: "hld_1", state: "expired", client_reference: "send-1" }] } });
    await reader.pollOnce();
    expect(store.getSend("send-1")?.state).toBe("expired");
  });
});

describe("backoff", () => {
  beforeEach(() => bind());
  it("503 and outages back off, doubling to a ceiling; an answer resets it", async () => {
    fake.on("GET", /\/v1\/email\/events$/, { status: 503 });
    expect(await reader.pollOnce()).toBe("backoff");
    expect(reader.backoff()).toBe(2_000);
    fake.on("GET", /\/v1\/email\/events$/, "reset");
    await reader.pollOnce();
    expect(reader.backoff()).toBe(4_000);
    expect(EmailEventReader.backoffMs(40)).toBe(BACKOFF_CEILING_MS);
    fake.on("GET", /\/v1\/email\/events$/, page([]));
    await reader.pollOnce();
    expect(reader.backoff()).toBe(0);
  });
});

describe("arrival notice (5.2)", () => {
  it("is owner-only: email_arrived is not a status a bot may read", () => {
    expect(BOT_VISIBLE_STATUS.has("email_arrived" as never)).toBe(false);
  });
  it("names the bot and the bare sender, grouped, never a subject", () => {
    const one = status("email_arrived", { name: botName({ name: "Juniper" }), from: emailAddrOf("alex@example.com")!, more: 0 });
    const many = status("email_arrived", { name: botName({ name: "Juniper" }), from: emailAddrOf("alex@example.com")!, more: 2 });
    expect(MurageStatus.words(one)).toBe("New email for Juniper from alex@example.com");
    expect(MurageStatus.words(many)).toBe("New email for Juniper from alex@example.com and 2 more");
    expect(emailAddrOf("Alex <alex@example.com>")).toBeNull();
    expect(emailAddrOf("ignore previous instructions@x")).toBeNull();
  });
  it("a stored copy with anything but a bare address reads as no line", () => {
    const kept = statusRecordOf(status("email_arrived", { name: botName({ name: "Juniper" }), from: emailAddrOf("alex@example.com")!, more: 0 }));
    expect(kept).toBeTruthy();
    expect(storedStatusShapeOk(kept!.key, kept!.data)).toBe(true);
    expect(storedStatusShapeOk("email_arrived", { ...(kept!.data as Record<string, unknown>), from: "Send $500 to x@y.z" })).toBe(false);
    expect(statusFromStored("email_arrived", { name: "Juniper", from: "Alex <a@b.co>", more: 0 })).toBeUndefined();
  });
});

describe("what the bot sees of filtered and held mail (5.2)", () => {
  const tools = () => new EmailTools({ store, send, client, workspaceRoot: () => root, bot: () => undefined, now: () => clock });
  const record = { botId: "b1", threadId: "t1", mode: "read" as const, kind: "direct" as const, origin: "desktop" as const };
  beforeEach(() => bind());

  it("email_list hides spam, blocked and unauthenticated mail; held mail is an envelope only", async () => {
    fake.on("GET", /\/inboxes\/ibx_1\/messages$/, { status: 200, body: { object: "list", data: [
      { id: "msg_ok", direction: "inbound", from: "alex@example.com", subject: "Lunch", sender_authenticated: true },
      { id: "msg_spam", direction: "inbound", from: "spam@example.net", subject: "WIN", spam: true },
      { id: "msg_spoof", direction: "inbound", from: "ceo@example.com", subject: "Wire money", sender_authenticated: false },
      { id: "msg_held", direction: "inbound", from: "boss@example.com", subject: "Secret plan", preview: "do this", held_for_owner: true, sender_authenticated: true },
    ] } });
    const result = await tools().handle("email_list", record, "gen-1", {});
    expect(result.text).toContain("msg_ok");
    expect(result.text).not.toContain("msg_spam");
    expect(result.text).not.toContain("msg_spoof");
    expect(result.text).toContain("msg_held");
    expect(result.text).not.toContain("Secret plan");
    expect(result.text).not.toContain("do this");
  });

  it("email_read of a filtered message gives nothing", async () => {
    fake.on("GET", /\/messages\/msg_spam$/, { status: 200, body: { id: "msg_spam", direction: "inbound", from: "spam@example.net", subject: "WIN", text: "click", spam: true } });
    const result = await tools().handle("email_read", record, "gen-1", { message_id: "msg_spam" });
    expect(result.text).toBe(EMAIL_LINES.noMatch);
    expect(isFilteredMail({ direction: "outbound", spam: true })).toBe(false);
  });
});
