// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Flux billing #518 alignment: 403 inbox_closing and grace (credit code + inbox_state "grace") reach the bot's line, the binding mirror,
// the owner's panel line and chip; #28 lifecycle events move the binding; manage_url is never what decides a line.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { FluxEmailClient } from "./flux-email-client.ts";
import { EmailSecretStore, emailCredentialProvider } from "./email-secrets.ts";
import { EmailStore, type BindingState } from "./email-store.ts";
import { EmailBindingService } from "./binding-service.ts";
import { EmailSendService } from "./send-service.ts";
import { EMAIL_LINES, codeLine } from "./tools.ts";
import { EMAIL_MOUNT_STATES } from "./admission.ts";
import { EMAIL_OWNER_COPY, headerChip } from "../../shared/email-copy.ts";
import { FakeFlux, fluxError, inGrace, inboxClosing } from "../testing/fake-flux-email.ts";

const INBOX = "ibx_1";
let clock = 0;
let fake: FakeFlux;
let store: EmailStore;
let bindings: EmailBindingService;
let send: EmailSendService;
let changes: BindingState[];

beforeEach(() => {
  clock = 1_800_000_000_000;
  fake = new FakeFlux();
  store = new EmailStore(new DatabaseSync(":memory:"));
  const secrets = new EmailSecretStore();
  secrets.setOwner({ token: "owner-token", keyId: "key_owner" });
  secrets.setBotKey("b1", { token: "bot-token", keyId: "key_b1" });
  const client = new FluxEmailClient({ fetch: fake.fetch, apiBase: "https://api.flux.test", appBase: "https://app.flux.test", credentials: emailCredentialProvider(secrets, () => null), timeoutMs: 100 });
  changes = [];
  bindings = new EmailBindingService({ store, client, secrets, installId: "inst", now: () => clock, onStateChange: row => changes.push(row.state) });
  let n = 0;
  send = new EmailSendService({ store, client, installId: "inst", now: () => clock, newId: () => `send-${++n}`, onRefusal: (code, botId, fields) => { if (botId) bindings.noteRefusal(botId, code, fields); } });
  store.insertBinding({ botId: "b1", inboxId: INBOX, address: "juniper@murage.email", username: "juniper", displayName: "Juniper", emailKeyRef: "key_b1", fluxAccountId: null, state: "active", step: null, opId: null, opStartedAt: null, policy: "auto", failure: null, updatedAt: clock });
  store.addTrusted("b1", "jane@acme.test", "allow", "owner", clock);
});

const submit = () => send.submit({ botId: "b1", generation: 1, threadId: "t1", draft: { kind: "send", to: ["jane@acme.test"], cc: [], subject: "Thursday", text: "Hi Jane", attachments: [], replyTo: null } });

describe("send refusals that name the inbox state", () => {
  it("403 inbox_closing: refused, the bot hears the closing line, the binding mirrors closing with closing_until", async () => {
    fake.on("POST", /\/messages$/, inboxClosing("2026-12-01T00:00:00Z"));
    const result = await submit() as { row?: { state: string; code: string } };
    expect(result.row).toMatchObject({ state: "refused", code: "inbox_closing" });
    expect(codeLine("inbox_closing")).toBe(EMAIL_LINES.closing);
    expect(store.getBinding("b1")).toMatchObject({ state: "closing", closingUntil: "2026-12-01T00:00:00Z" });
    expect(changes).toEqual(["closing"]);
    expect(EMAIL_OWNER_COPY.closingLine("2026-12-01T00:00:00Z")).toBe("Email is closing: mail is deleted on 2026-12-01. Top up and choose Keep address to restore it.");
    expect(headerChip("closing", 0, null)).toBe("Email closing");
    expect(EMAIL_MOUNT_STATES.has("closing")).toBe(false);
  });

  it("grace: a credit code with inbox_state grace -> billing-hold line for the bot, grace binding (still mounts to read), calm panel line", async () => {
    fake.on("POST", /\/messages$/, inGrace());
    await submit();
    expect(store.getBinding("b1")?.state).toBe("grace");
    expect(codeLine("credit_unresolved")).toBe(EMAIL_LINES.billingHold);
    expect(EMAIL_MOUNT_STATES.has("grace")).toBe(true);
    expect(headerChip("grace", 0, null)).toBe("Email on hold");
    expect(EMAIL_OWNER_COPY.graceLine("Juniper")).toBe("Juniper still receives email. It can send again once your Flux credit is topped up.");
    expect(EMAIL_OWNER_COPY.graceLine("Juniper")).not.toMatch(/\$|price|safe/i);
  });

  it("a credit code without inbox_state leaves the binding alone; bot_paused mirrors paused without reading manage_url", async () => {
    fake.on("POST", /\/messages$/, fluxError(402, "credit_unresolved"));
    await submit();
    expect(store.getBinding("b1")?.state).toBe("active");
    fake.on("POST", /\/messages$/, fluxError(403, "bot_paused", { pause: { reason: "owner", resumable_by: "owner" } }));
    await send.submit({ botId: "b1", generation: 2, threadId: "t1", draft: { kind: "send", to: ["jane@acme.test"], cc: [], subject: "Friday", text: "Hi", attachments: [], replyTo: null } });
    expect(store.getBinding("b1")?.state).toBe("paused");
  });

  it("no email module or email UI reads manage_url (bot_paused and email_not_enabled come without it)", () => {
    const files = [...readdirSync("server/email").filter(name => name.endsWith(".ts") && !name.endsWith(".test.ts")).map(name => `server/email/${name}`),
      "shared/email-copy.ts", "src/lib/bot-email.ts", "src/components/BotEmailSettings.tsx", "src/components/EmailSendCard.tsx"];
    for (const file of files) expect(readFileSync(file, "utf8"), file).not.toMatch(/manage_url/);
  });
});

describe("#5 mirror and #28 lifecycle events", () => {
  it("#5 state grace / closing (with closing_until) are mirrored; sends_today feeds the panel count", async () => {
    fake.on("GET", /\/inboxes\/ibx_1$/, { status: 200, body: { id: INBOX, state: "grace", sends_today: 4, daily_send_cap: 50 } });
    const read = await bindings.refresh("b1");
    expect(read).toMatchObject({ row: { state: "grace" }, sendsToday: 4, dailyCap: 50 });
    fake.on("GET", /\/inboxes\/ibx_1$/, { status: 200, body: { id: INBOX, state: "closing", closing_until: "2026-12-02T00:00:00Z" } });
    expect((await bindings.refresh("b1")).row).toMatchObject({ state: "closing", closingUntil: "2026-12-02T00:00:00Z" });
  });

  it("email.bot.paused, email.inbox.grace, email.inbox.closing move the binding; renewed and resumed re-read #5", async () => {
    await bindings.applyLifecycle({ type: "email.bot.paused", inbox_id: INBOX, data: { pause: { reason: "flux_review" } } });
    expect(store.getBinding("b1")?.state).toBe("paused");
    await bindings.applyLifecycle({ type: "email.inbox.grace", inbox_id: INBOX, data: { until: "2026-11-15T00:00:00Z" } });
    expect(store.getBinding("b1")?.state).toBe("grace");
    fake.on("GET", /\/inboxes\/ibx_1$/, { status: 200, body: { id: INBOX, state: "active" } });
    await bindings.applyLifecycle({ type: "email.inbox.renewed", inbox_id: INBOX, data: {} });
    expect(store.getBinding("b1")?.state).toBe("active");
    await bindings.applyLifecycle({ type: "email.inbox.closing", inbox_id: INBOX, data: { reason: "billing", until: "2026-12-15T00:00:00Z" } });
    expect(store.getBinding("b1")).toMatchObject({ state: "closing", closingUntil: "2026-12-15T00:00:00Z" });
    expect(changes).toEqual(["paused", "grace", "active", "closing"]);
    expect(await bindings.applyLifecycle({ type: "email.inbox.grace", inbox_id: "ibx_other" })).toBeNull();
  });
});
