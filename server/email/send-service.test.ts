// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Every send transition (design 9.1) and the failures F1 to F11, F25, F27 against a scripted fake Flux. In-memory SQLite, injected clock.
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { FluxEmailClient } from "./flux-email-client.ts";
import { EmailSecretStore, emailCredentialProvider } from "./email-secrets.ts";
import { EmailStore, type SendRow } from "./email-store.ts";
import { EmailSendService, HOLD_LIFETIME_MS, type EmailOutcomeEvent } from "./send-service.ts";
import { EmailBindingService } from "./binding-service.ts";
import { emailCardView } from "./cards.ts";
import type { EmailDraft } from "./canonical.ts";
import { FakeFlux, fluxError, type FakeReply } from "../testing/fake-flux-email.ts";

const INBOX = "ibx_1";
let clock = 0;
let fake: FakeFlux;
let store: EmailStore;
let service: EmailSendService;
let outcomes: EmailOutcomeEvent[];
let refusals: string[];

function setup(policy: "ask" | "auto" = "auto") {
  clock = 1_800_000_000_000;
  fake = new FakeFlux();
  store = new EmailStore(new DatabaseSync(":memory:"));
  const secrets = new EmailSecretStore();
  secrets.setOwner({ token: "owner-token", keyId: "key_owner" });
  secrets.setBotKey("b1", { token: "bot-token", keyId: "key_b1" });
  const client = new FluxEmailClient({ fetch: fake.fetch, apiBase: "https://api.flux.test", appBase: "https://app.flux.test", credentials: emailCredentialProvider(secrets, () => null), timeoutMs: 100 });
  outcomes = []; refusals = [];
  let n = 0;
  service = new EmailSendService({ store, client, installId: "inst", now: () => clock, newId: () => `send-${++n}`, onOutcome: event => outcomes.push(event), onRefusal: code => refusals.push(code) });
  store.insertBinding({ botId: "b1", inboxId: INBOX, address: "juniper@murage.email", username: "juniper", displayName: "Juniper", emailKeyRef: "key_b1", fluxAccountId: null, state: "active", step: null, opId: null, opStartedAt: null, policy, failure: null, updatedAt: clock });
  store.addTrusted("b1", "jane@acme.test", "allow", "owner", clock);
  return { secrets, client };
}

const draft = (patch: Partial<EmailDraft> = {}): EmailDraft => ({ kind: "send", to: ["jane@acme.test"], cc: [], subject: "Thursday", text: "Hi Jane", attachments: [], replyTo: null, ...patch });
const submit = async (patch: Partial<EmailDraft> = {}, generation = 1) => (await service.submit({ botId: "b1", generation, threadId: "t1", draft: draft(patch) })) as { status: string; row?: SendRow };
const sentOk = (id = "msg_1"): FakeReply => ({ status: 200, body: { object: "email.send", status: "sent", message_id: id } });
const held = (heldId: string, approvalId = "apr_1", heldIds = [heldId]): FakeReply => ({ status: 202, body: { status: "pending_approval", held_id: heldId, approval: { id: approvalId, held_ids: heldIds, state: "pending" } } });
const heldItem = (id: string, ref: string, patch: Record<string, unknown> = {}) => ({ id, state: "held", client_reference: ref, to: ["new@x.test"], cc: [], subject: "Thursday", text: "Hi Jane", attachments: [], ...patch });
const approval = (items: unknown[], approvalId = "apr_1"): FakeReply => ({ status: 200, body: { id: approvalId, state: "pending", held_ids: (items as Array<{ id: string }>).map(item => item.id), held: items } });
const row = (id: string): SendRow => store.getSend(id)!;

beforeEach(() => { setup(); });

describe("dispatch without the owner (auto, approved address)", () => {
  it("200: sent, with Idempotency-Key :1, client_reference = send_id and the key id of the attempt", async () => {
    fake.on("POST", /\/messages$/, sentOk());
    const result = await submit();
    expect(result).toMatchObject({ status: "accepted", row: { state: "sent", messageId: "msg_1", why: "trusted" } });
    const [call] = fake.requests;
    expect(call.headers["idempotency-key"]).toBe("murage-email:inst:send-1:1");
    expect(call.body).toMatchObject({ client_reference: "send-1", to: ["jane@acme.test"] });
    expect(row("send-1").attempts).toEqual([{ suffix: 1, keyId: "key_b1", at: clock, route: "#9" }]);
    expect(outcomes).toEqual([expect.objectContaining({ sendId: "send-1", outcome: "sent", ref: expect.stringMatching(/^E-[A-Z0-9]{6}$/) })]);
    expect(JSON.stringify(outcomes)).not.toMatch(/jane|Thursday|Hi Jane/);
  });

  it("r2.5: no 502 settlement path; a provider-accepted send is a 200 and reads as sent", async () => {
    fake.on("POST", /\/messages$/, sentOk());
    const sent = (await submit()).row!;
    expect(sent).toMatchObject({ state: "sent" });
    expect(sent.code).not.toBe("charge_unconfirmed");
  });

  it.each([
    [403, "bot_paused"], [402, "key_budget_reached"], [413, "payload_too_large"], [415, "attachment_type_blocked"], [429, "daily_send_cap_reached"],
    [403, "email_not_enabled"], [503, "capability_unavailable"], [400, "invalid_recipient"],
  ])("a definite refusal %s %s before any owner Send: refused(code), the probe hears it", async (status, code) => {
    fake.on("POST", /\/messages$/, fluxError(status, code));
    expect((await submit()).row).toMatchObject({ state: "refused", code });
    expect(refusals).toEqual([code]);
    expect(outcomes.map(event => event.outcome)).toEqual(["not_sent"]);
  });

  it.each([
    ["no answer (reset)", "reset" as FakeReply],
    ["timeout", "timeout" as FakeReply],
    ["503 without a body", { status: 503 } as FakeReply],
    ["409 idempotency_in_progress", fluxError(409, "idempotency_in_progress")],
    ["409 idempotency_mismatch", fluxError(409, "idempotency_mismatch")],
  ])("%s: unknown, never replayed, the suffix stays", async (_name, reply) => {
    fake.on("POST", /\/messages$/, reply);
    const result = await submit();
    expect(result.row).toMatchObject({ state: "unknown", idemSuffix: 1, reconcileStep: 0, dueAt: clock + 60_000 });
    expect(fake.calls("POST", /\/messages$/)).toHaveLength(1);
  });
});

describe("idempotency (3.4, F1, F2, L3)", () => {
  it("F1: an engine retry in the same turn gets the same row, nothing new goes out", async () => {
    fake.on("POST", /\/messages$/, sentOk());
    await submit();
    expect(await submit()).toMatchObject({ status: "existing", row: { sendId: "send-1" } });
    expect(fake.calls("POST", /\/messages$/)).toHaveLength(1);
  });

  it("F2: the same email from a later turn is refused while sent in the last 24 h, unknown or waiting; allowed after 24 h", async () => {
    fake.on("POST", /\/messages$/, sentOk());
    await submit({}, 1);
    expect(await submit({}, 2)).toMatchObject({ status: "duplicate", row: { sendId: "send-1" } });
    clock += 24 * 3_600_000 + 1;
    fake.on("POST", /\/messages$/, sentOk("msg_2"));
    expect(await submit({}, 3)).toMatchObject({ status: "accepted", row: { state: "sent" } });
  });

  it("F2: refused while another turn's copy waits for the owner or is uncertain", async () => {
    await submit({ to: ["new@x.test"] }, 1);
    expect(row("send-1").state).toBe("awaiting_owner");
    expect(await submit({ to: ["new@x.test"] }, 2)).toMatchObject({ status: "duplicate" });
    fake.on("POST", /\/messages$/, "reset");
    await submit({ text: "other" }, 3);
    expect(await submit({ text: "other" }, 4)).toMatchObject({ status: "duplicate" });
  });

  it("no inbox, or an inbox that is not active: nothing is written and Flux is never called", async () => {
    const binding = store.getBinding("b1")!;
    store.casBinding("b1", binding.revision, { state: "removing" }, clock);
    expect(await submit()).toEqual({ status: "no_inbox" });
    expect(fake.requests).toHaveLength(0);
  });
});

describe("Murage-held: the owner's Send (4.4)", () => {
  it("a new contact waits with no Flux call; Send dispatches, trusts that exact address and counts toward earned trust", async () => {
    const waiting = await submit({ to: ["new@x.test"] });
    expect(waiting.row).toMatchObject({ state: "awaiting_owner", why: "waiting_new_contact" });
    expect(fake.requests).toHaveLength(0);
    fake.on("POST", /\/messages$/, sentOk());
    const answer = await service.ownerSend("send-1", row("send-1").revision);
    expect(answer).toMatchObject({ status: "done", row: { state: "sent", ownerSent: true, why: "owner_send" } });
    expect(store.isApproved("b1", "new@x.test")).toBe(true);
    expect(store.trustedEntries("b1").find(entry => entry.entry === "new@x.test")).toMatchObject({ source: "approval", rule: "allow" });
    expect(store.isApproved("b1", "x.test")).toBe(false);
  });

  it("ask holds even an approved address", async () => {
    setup("ask");
    expect((await submit()).row).toMatchObject({ state: "awaiting_owner", why: "waiting_ask" });
  });

  it("F5: a second Send (other device, old revision) sees the row as it is now", async () => {
    await submit({ to: ["new@x.test"] });
    const revision = row("send-1").revision;
    fake.on("POST", /\/messages$/, sentOk());
    await service.ownerSend("send-1", revision, "desktop");
    expect(await service.ownerSend("send-1", revision, "phone")).toMatchObject({ status: "stale", row: { state: "sent" } });
    expect(fake.calls("POST", /\/messages$/)).toHaveLength(1);
  });

  it("one card per email: a Send whose dispatch comes back 202 is approved at once with the exact held id", async () => {
    await submit({ to: ["new@x.test"] });
    fake.on("POST", /\/messages$/, held("hld_1"))
      .on("GET", /\/approvals\/apr_1$/, approval([heldItem("hld_1", "send-1")]))
      .on("POST", /\/approvals\/apr_1\/approve$/, { status: 200, body: { state: "approved_once", sends: [{ held_id: "hld_1", status: "sent", message_id: "msg_9" }] } });
    const answer = await service.ownerSend("send-1", row("send-1").revision);
    expect(answer.row).toMatchObject({ state: "sent", messageId: "msg_9" });
    expect(fake.calls("POST", /approve$/)[0].body).toMatchObject({ held_ids: ["hld_1"], scope: "once" });
    expect(row("send-1").receipt).toMatchObject({ used: true, payloadHash: row("send-1").payloadHash });
  });

  it.each([[429, "rate_limit_error"], [503, "capability_unavailable"]])("a definite refusal %s %s after the owner's Send is approved_unsent; Retry goes out with the SAME Idempotency-Key (r2.5)", async (status, code) => {
    await submit({ to: ["new@x.test"] });
    fake.on("POST", /\/messages$/, fluxError(status, code, code === "capability_unavailable" ? { retry_after_s: 5 } : {}));
    await service.ownerSend("send-1", row("send-1").revision);
    expect(row("send-1")).toMatchObject({ state: "approved_unsent", code });
    fake.on("POST", /\/messages$/, fluxError(status, code)).on("POST", /\/messages$/, sentOk());
    await service.ownerSend("send-1", row("send-1").revision);
    expect(row("send-1")).toMatchObject({ state: "approved_unsent", code });
    await service.ownerSend("send-1", row("send-1").revision);
    expect(row("send-1")).toMatchObject({ state: "sent", idemSuffix: 1 });
    // never a new key on retry: Flux stores only 2xx answers, so nothing sits under the first key
    expect(fake.calls("POST", /\/messages$/).map(call => call.headers["idempotency-key"])).toEqual(["murage-email:inst:send-1:1", "murage-email:inst:send-1:1", "murage-email:inst:send-1:1"]);
    expect(row("send-1").attempts.map(item => item.suffix)).toEqual([1, 1, 1]);
  });
});

describe("Flux-held (202) and the approve (4.4, F6 to F8)", () => {
  async function heldRow(heldIds = ["hld_1"]) {
    fake.on("POST", /\/messages$/, held("hld_1", "apr_1", heldIds));
    store.addTrusted("b1", "new@x.test", "allow", "owner", clock); // Murage clears it, Flux holds it
    const result = await submit({ to: ["new@x.test"] });
    expect(result.row).toMatchObject({ state: "held", heldIds: ["hld_1"], approvalId: "apr_1" });
    return result.row!;
  }

  it("Send: #20 frozen text and hashes checked, #21 names exactly the held ids, sends[] sent -> sent", async () => {
    await heldRow();
    fake.on("GET", /\/approvals\/apr_1$/, approval([heldItem("hld_1", "send-1")]))
      .on("POST", /approve$/, { status: 200, body: { sends: [{ held_id: "hld_1", status: "sent", message_id: "msg_2" }] } });
    expect(await service.ownerSend("send-1", row("send-1").revision)).toMatchObject({ status: "done", row: { state: "sent" } });
  });

  it("F6: approve 200 but the send failed a check: approved_unsent(check); Retry is #32 under the same approval", async () => {
    await heldRow();
    fake.on("GET", /\/approvals\/apr_1$/, approval([heldItem("hld_1", "send-1")]))
      .on("POST", /approve$/, { status: 200, body: { sends: [{ held_id: "hld_1", status: "send_failed", check: "burst" }] } });
    await service.ownerSend("send-1", row("send-1").revision);
    expect(row("send-1")).toMatchObject({ state: "approved_unsent", code: "burst" });
    fake.on("POST", /\/held\/hld_1\/send$/, { status: 200, body: { status: "sent", message_id: "msg_3" } });
    await service.ownerSend("send-1", row("send-1").revision);
    expect(row("send-1")).toMatchObject({ state: "sent", messageId: "msg_3" });
    expect(fake.calls("POST", /approve$/)).toHaveLength(1);
  });

  it("#32 send_failed again stays approved_unsent with the new check", async () => {
    await heldRow();
    fake.on("GET", /\/approvals\/apr_1$/, approval([heldItem("hld_1", "send-1")]))
      .on("POST", /approve$/, { status: 200, body: { sends: [{ held_id: "hld_1", status: "send_failed", check: "burst" }] } })
      .on("POST", /\/held\/hld_1\/send$/, { status: 200, body: { status: "send_failed", check: "daily_cap" } });
    await service.ownerSend("send-1", row("send-1").revision);
    await service.ownerSend("send-1", row("send-1").revision);
    expect(row("send-1")).toMatchObject({ state: "approved_unsent", code: "daily_cap" });
  });

  it("r2.5 #32 Idempotency-Key: a 503 capability_unavailable retry keeps the key; only after a 2xx (stored 24 h) does Retry take the next", async () => {
    await heldRow();
    fake.on("GET", /\/approvals\/apr_1$/, approval([heldItem("hld_1", "send-1")]))
      .on("POST", /approve$/, { status: 200, body: { sends: [{ held_id: "hld_1", status: "send_failed", check: "burst" }] } })
      .on("POST", /\/held\/hld_1\/send$/, fluxError(503, "capability_unavailable", { retry_after_s: 5 }))
      .on("POST", /\/held\/hld_1\/send$/, { status: 200, body: { status: "send_failed", check: "daily_cap" } })
      .on("POST", /\/held\/hld_1\/send$/, { status: 200, body: { status: "sent", message_id: "msg_7" } });
    await service.ownerSend("send-1", row("send-1").revision);
    await service.ownerSend("send-1", row("send-1").revision);
    expect(row("send-1")).toMatchObject({ state: "approved_unsent", code: "capability_unavailable" });
    await service.ownerSend("send-1", row("send-1").revision);
    expect(row("send-1")).toMatchObject({ state: "approved_unsent", code: "daily_cap" });
    await service.ownerSend("send-1", row("send-1").revision);
    expect(row("send-1")).toMatchObject({ state: "sent", messageId: "msg_7" });
    expect(fake.calls("POST", /\/held\/hld_1\/send$/).map(call => call.headers["idempotency-key"])).toEqual([
      "murage-email:inst:send-1:1:held:1", "murage-email:inst:send-1:1:held:1", "murage-email:inst:send-1:1:held:2",
    ]);
  });

  it("Flux #516: #21 carries only scope, held_ids and acknowledge_future_sends (no send_held)", async () => {
    await heldRow();
    fake.on("GET", /\/approvals\/apr_1$/, approval([heldItem("hld_1", "send-1")]))
      .on("POST", /approve$/, { status: 200, body: { sends: [{ held_id: "hld_1", status: "sent", message_id: "msg_2" }] } });
    await service.ownerSend("send-1", row("send-1").revision);
    expect(Object.keys(fake.calls("POST", /approve$/)[0].body as object).sort()).toEqual(["acknowledge_future_sends", "held_ids", "scope"]);
  });

  it.each([
    ["sent", "sent", null], ["send_failed", "approved_unsent", "burst2"], ["sending", "approving", null],
  ])("Flux #516: #32 409 held_not_retryable re-reads the hold (#20): %s -> %s, never a refusal", async (holdState, state, code) => {
    await heldRow();
    fake.on("GET", /\/approvals\/apr_1$/, approval([heldItem("hld_1", "send-1")]))
      .on("POST", /approve$/, { status: 200, body: { sends: [{ held_id: "hld_1", status: "send_failed", check: "burst" }] } })
      .on("POST", /\/held\/hld_1\/send$/, fluxError(409, "held_not_retryable"))
      .on("GET", /\/approvals\/apr_1$/, approval([heldItem("hld_1", "send-1", { state: holdState, ...(holdState === "send_failed" ? { check: "burst2" } : {}) })]));
    await service.ownerSend("send-1", row("send-1").revision);
    await service.ownerSend("send-1", row("send-1").revision);
    expect(row("send-1")).toMatchObject({ state, ...(code ? { code } : {}) });
    expect(refusals).not.toContain("held_not_retryable");
    expect(fake.calls("POST", /\/held\/hld_1\/send$/)).toHaveLength(1);
  });

  it("F8: 202 with an extra held id whose row the owner has not answered: the approve waits, no #21", async () => {
    await heldRow(["hld_1", "hld_0"]);
    // the sibling: an earlier email of the bot to the same person, still held and unanswered
    store.insertSend({ ...row("send-1"), sendId: "sib", payloadHash: "other", heldIds: ["hld_0"], ownerSent: false, revision: 1 });
    fake.on("GET", /\/approvals\/apr_1$/, approval([heldItem("hld_0", "sib"), heldItem("hld_1", "send-1")]));
    expect(await service.ownerSend("send-1", row("send-1").revision)).toMatchObject({ status: "waiting_sibling", siblingSendId: "sib", row: { state: "held" } });
    expect(fake.calls("POST", /approve$/)).toHaveLength(0);
  });

  it("a sibling the owner declined is withdrawn first (#23), then #21 names only this hold", async () => {
    await heldRow(["hld_1", "hld_0"]);
    store.insertSend({ ...row("send-1"), sendId: "sib", payloadHash: "other", heldIds: ["hld_0"], state: "declined", revision: 1 });
    fake.on("GET", /\/approvals\/apr_1$/, approval([heldItem("hld_0", "sib"), heldItem("hld_1", "send-1")]))
      .on("DELETE", /\/held\/hld_0$/, { status: 204 })
      .on("POST", /approve$/, { status: 200, body: { sends: [{ held_id: "hld_1", status: "sent", message_id: "m" }] } });
    await service.ownerSend("send-1", row("send-1").revision);
    expect(fake.calls("POST", /approve$/)[0].body).toMatchObject({ held_ids: ["hld_1"] });
    expect(row("send-1").state).toBe("sent");
  });

  it("an unknown held id, or frozen text that differs, stops the approve and refreshes the card", async () => {
    await heldRow();
    fake.on("GET", /\/approvals\/apr_1$/, approval([heldItem("hld_1", "send-1"), heldItem("hld_x", "nobody")]));
    expect(await service.ownerSend("send-1", row("send-1").revision)).toMatchObject({ status: "refresh", reason: "unknown_held" });
    fake.on("GET", /\/approvals\/apr_1$/, approval([heldItem("hld_1", "send-1", { text: "Changed" })]));
    expect(await service.approve(row("send-1"))).toMatchObject({ status: "refresh", reason: "content_mismatch" });
    fake.on("GET", /\/approvals\/apr_1$/, approval([heldItem("hld_1", "send-1", { attachments: [{ filename: "a", sha256: "ff" }] })]));
    expect(await service.approve(row("send-1"))).toMatchObject({ status: "refresh", reason: "content_mismatch" });
    expect(fake.calls("POST", /approve$/)).toHaveLength(0);
    expect(row("send-1").state).toBe("held");
  });

  it("409 approval_scope_mismatch puts the row back to held and never sends", async () => {
    await heldRow();
    fake.on("GET", /\/approvals\/apr_1$/, approval([heldItem("hld_1", "send-1")])).on("POST", /approve$/, fluxError(409, "approval_scope_mismatch", { unlisted_held_ids: ["hld_9"] }));
    expect(await service.ownerSend("send-1", row("send-1").revision)).toMatchObject({ status: "refresh", reason: "scope_mismatch", row: { state: "held" } });
  });

  it.each([["timeout", "timeout" as FakeReply], ["409 approval_not_pending", fluxError(409, "approval_not_pending", { state: "approved_once" })]])(
    "F7: approve %s -> unknown, then a read-only reconcile; never a second approve", async (_name, reply) => {
      await heldRow();
      fake.on("GET", /\/approvals\/apr_1$/, approval([heldItem("hld_1", "send-1")])).on("POST", /approve$/, reply);
      await service.ownerSend("send-1", row("send-1").revision);
      expect(row("send-1").state).toBe("unknown");
      clock += 60_000;
      fake.on("GET", /\/messages$/, { status: 200, body: { data: [{ id: "msg_5", client_reference: "send-1" }] } });
      await service.tick();
      expect(row("send-1")).toMatchObject({ state: "sent", messageId: "msg_5" });
      expect(fake.calls("POST", /approve$/)).toHaveLength(1);
      expect(fake.calls("GET", /\/messages$/)[0].query.get("client_reference")).toBe("send-1");
    });

  it("an email.held.send_failed event moves the row even with no approve waiting", async () => {
    await heldRow();
    service.applyEvent({ id: "eev_1", type: "email.held.send_failed", data: { held_id: "hld_1", check: "suppressed", client_reference: "send-1" } });
    expect(row("send-1")).toMatchObject({ state: "approved_unsent", code: "suppressed" });
    // the same event again is deduplicated
    expect(service.applyEvent({ id: "eev_1", type: "email.held.send_failed", data: { held_id: "hld_1" } })).toBeNull();
  });
});

describe("every other ending (4.5, F9 to F11, M2, L1, L3)", () => {
  async function heldRow() {
    store.addTrusted("b1", "new@x.test", "allow", "owner", clock);
    fake.on("POST", /\/messages$/, held("hld_1"));
    await submit({ to: ["new@x.test"] });
    return row("send-1");
  }

  it("Don't send: Murage-held -> declined; Flux-held -> #23 (404 is success) -> declined", async () => {
    await submit({ to: ["a@x.test"] }, 1);
    expect(await service.dontSend("send-1", row("send-1").revision)).toMatchObject({ row: { state: "declined" } });
    await heldRow();
    fake.on("DELETE", /\/held\/hld_1$/, fluxError(404, "held_not_found"));
    await service.dontSend("send-2", row("send-2").revision);
    expect(row("send-2").state).toBe("declined");
    expect(outcomes.map(event => event.outcome)).toEqual(["declined", "declined"]);
  });

  it("F9: Stop while held -> withdraw_pending -> #23; a network failure is retried later; the card never offers Send again", async () => {
    await heldRow();
    await submit({ to: ["z@x.test"], text: "other" });
    fake.on("DELETE", /\/held\/hld_1$/, "reset");
    await service.stop("b1", 1);
    expect(row("send-1")).toMatchObject({ state: "withdraw_pending", code: "stopped" });
    expect(row("send-2")).toMatchObject({ state: "withdrawn", code: "stopped" }); // Murage-held: nothing at Flux
    expect(await service.ownerSend("send-1", row("send-1").revision)).toMatchObject({ status: "done", row: { state: "withdraw_pending" } });
    clock += 30_000;
    fake.on("DELETE", /\/held\/hld_1$/, { status: 204 });
    await service.tick();
    expect(row("send-1")).toMatchObject({ state: "withdrawn", code: "stopped" });
  });

  it("F10: Stop during an in-flight dispatch waits for the answer: 200 is reported sent, never withdrawn", async () => {
    let answer!: (reply: FakeReply) => void;
    fake.on("POST", /\/messages$/, () => new Promise<FakeReply>(resolve => { answer = resolve; }));
    const pending = submit();
    await new Promise(resolve => setTimeout(resolve, 5));
    await service.stop("b1", 1);
    expect(row("send-1")).toMatchObject({ state: "dispatching", stopRequested: true });
    answer(sentOk());
    expect((await pending).row).toMatchObject({ state: "sent" });
  });

  it("F10: Stop during an in-flight dispatch that comes back 202 withdraws the hold", async () => {
    store.addTrusted("b1", "new@x.test", "allow", "owner", clock);
    let answer!: (reply: FakeReply) => void;
    fake.on("POST", /\/messages$/, () => new Promise<FakeReply>(resolve => { answer = resolve; })).on("DELETE", /\/held\/hld_1$/, { status: 204 });
    const pending = submit({ to: ["new@x.test"] });
    await new Promise(resolve => setTimeout(resolve, 5));
    await service.stop("b1", 1);
    answer(held("hld_1"));
    expect((await pending).row).toMatchObject({ state: "withdrawn", code: "stopped" });
  });

  it("Stop on an uncertain row flags it; the 2 h read with nothing found ends withdrawn(stopped)", async () => {
    fake.on("POST", /\/messages$/, "reset");
    await submit();
    await service.stop("b1", 1);
    expect(row("send-1")).toMatchObject({ state: "unknown", stopRequested: true });
    fake.always("GET", /\/messages$/, { status: 200, body: { data: [] } }).always("GET", /\/v1\/email\/approvals$/, { status: 200, body: { data: [] } });
    for (const gap of [60_000, 240_000, 1_500_000, 5_400_000]) { clock += gap; await service.tick(); }
    expect(row("send-1")).toMatchObject({ state: "withdrawn", code: "stopped" });
  });

  it("L1: #23 answers 409 held_not_withdrawable; #20 shows it sent: the row ends sent, no retry loop", async () => {
    await heldRow();
    fake.on("DELETE", /\/held\/hld_1$/, fluxError(409, "held_not_withdrawable", { state: "sent" }))
      .on("GET", /\/approvals\/apr_1$/, approval([heldItem("hld_1", "send-1", { state: "sent" })]));
    await service.stop("b1", 1);
    expect(row("send-1").state).toBe("sent");
  });

  it("L1: still sending: approving, settled later by the read-only reconcile", async () => {
    await heldRow();
    fake.on("DELETE", /\/held\/hld_1$/, fluxError(409, "held_not_withdrawable", { state: "sending" }))
      .on("GET", /\/approvals\/apr_1$/, approval([heldItem("hld_1", "send-1", { state: "sending" })]));
    await service.stop("b1", 1);
    expect(row("send-1").state).toBe("approving");
    service.applyEvent({ id: "eev_9", type: "email.message.sent", data: { message_id: "m7", client_reference: "send-1", held_id: "hld_1" } });
    expect(row("send-1")).toMatchObject({ state: "sent", messageId: "m7" });
  });

  it("F11: owner away 72 h: expired, for a Murage-held and a Flux-held card", async () => {
    await heldRow();
    await submit({ to: ["z@x.test"], text: "other" });
    clock += HOLD_LIFETIME_MS;
    await service.tick();
    expect([row("send-1").state, row("send-2").state]).toEqual(["expired", "expired"]);
  });

  it("M2 Edit: the old row is withdrawn(edited) through #23, a new row with its own id waits for its own Send", async () => {
    await heldRow();
    fake.on("DELETE", /\/held\/hld_1$/, { status: 204 });
    const edited = await service.edit("send-1", row("send-1").revision, draft({ to: ["new@x.test"], text: "Hi Jane, edited" }));
    expect(edited).toMatchObject({ status: "done", row: { sendId: "send-2", state: "awaiting_owner", replaces: "send-1", idemSuffix: 1 }, replaced: { state: "withdrawn", code: "edited" } });
    expect(row("send-2").payloadHash).not.toBe(row("send-1").payloadHash);
    store.addTrusted("b1", "new@x.test", "allow", "owner", clock);
    fake.on("POST", /\/messages$/, sentOk());
    await service.ownerSend("send-2", row("send-2").revision);
    expect(fake.calls("POST", /\/messages$/).at(-1)!.body).toMatchObject({ text: "Hi Jane, edited", client_reference: "send-2" });
  });

  it("L3: Send on an unknown_expired card is a new send_id, exempt from the identical-payload refusal", async () => {
    fake.on("POST", /\/messages$/, "reset");
    await submit();
    fake.always("GET", /\/messages$/, { status: 200, body: { data: [] } }).always("GET", /\/v1\/email\/approvals$/, { status: 200, body: { data: [] } });
    for (const gap of [60_000, 240_000, 1_500_000, 5_400_000]) { clock += gap; await service.tick(); }
    expect(row("send-1").state).toBe("unknown_expired");
    expect(outcomes.at(-1)).toMatchObject({ outcome: "unknown" });
    fake.on("POST", /\/messages$/, sentOk());
    const answer = await service.ownerSend("send-1", row("send-1").revision);
    expect(answer.row).toMatchObject({ sendId: "send-2", replaces: "send-1", state: "sent" });
    expect(row("send-1")).toMatchObject({ state: "withdrawn", code: "owner_resent" });
    expect(fake.calls("POST", /\/messages$/).at(-1)!.headers["idempotency-key"]).toBe("murage-email:inst:send-2:1");
  });

  const expireUnknown = async () => {
    fake.on("POST", /\/messages$/, "reset");
    await submit();
    fake.always("GET", /\/messages$/, { status: 200, body: { data: [] } }).always("GET", /\/v1\/email\/approvals$/, { status: 200, body: { data: [] } });
    for (const gap of [60_000, 240_000, 1_500_000, 5_400_000]) { clock += gap; await service.tick(); }
    expect(row("send-1").state).toBe("unknown_expired");
  };

  it("Astra r1 High: a resend is made once: a click racing it, a second device and a fresh click on the refreshed card send nothing more", async () => {
    await expireUnknown();
    const revision = row("send-1").revision;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    fake.always("POST", /\/messages$/, async () => { await gate; return sentOk(); });
    const first = service.ownerSend("send-1", revision);
    const racing = service.ownerSend("send-1", revision, "phone");
    // the replacement is still in flight: the original's card was refreshed, and its new revision is pressed again
    const again = service.ownerSend("send-1", row("send-1").revision);
    release();
    const [one, two, three] = await Promise.all([first, racing, again]);
    expect(one).toMatchObject({ status: "done", row: { sendId: "send-2", replaces: "send-1", state: "sent" } });
    expect(two.status).toBe("stale");
    expect(three).toMatchObject({ row: { sendId: "send-1", state: "withdrawn", code: "owner_resent" } });
    // after delivery, the settled original offers no Send, and pressing it anyway sends nothing
    expect((await service.ownerSend("send-1", row("send-1").revision)).row).toMatchObject({ sendId: "send-1", state: "withdrawn" });
    const posts = fake.calls("POST", /\/messages$/);
    expect(posts).toHaveLength(2);
    expect(posts.map(call => call.headers["idempotency-key"])).toEqual(["murage-email:inst:send-1:1", "murage-email:inst:send-2:1"]);
    expect(store.getSend("send-3")).toBeNull();
    const card = emailCardView(row("send-1"), { botName: "Juniper", text: "Hi Jane", approved: () => true });
    expect(card.emailSend).toMatchObject({ phase: "settled", actions: [], note: "You sent this again as a new email." });
    expect(outcomes.filter(event => event.sendId === "send-1").map(event => event.outcome)).toEqual(["unknown"]);
  });

  it("Astra r1 High: an original that already has a replacement never makes a second one, whatever its state says", async () => {
    await expireUnknown();
    // a row left by an earlier build: still unknown_expired after its resend
    store.insertSend({ ...row("send-1"), sendId: "send-9", replaces: "send-1", state: "sent", revision: 1 });
    const answer = await service.ownerSend("send-1", row("send-1").revision);
    expect(answer.status).toBe("stale");
    expect(fake.calls("POST", /\/messages$/)).toHaveLength(1);
    expect(row("send-1").state).toBe("unknown_expired");
  });

  it("F25: Remove with cards open: every open row withdrawn(inbox_removed)", async () => {
    const { secrets, client } = { ...setup() };
    const bindings = new EmailBindingService({ store, client, secrets, installId: "inst", now: () => clock, withdrawSends: (botId, reason) => service.withdrawAllForBot(botId, reason) });
    store.addTrusted("b1", "new@x.test", "allow", "owner", clock);
    fake.on("POST", /\/messages$/, held("hld_1"));
    await submit({ to: ["new@x.test"] });
    await submit({ to: ["z@x.test"], text: "other" });
    fake.on("DELETE", /\/inboxes\/ibx_1$/, { status: 202, body: { id: INBOX, state: "deleting" } });
    await bindings.remove("b1");
    expect([row("send-1"), row("send-2")].map(item => [item.state, item.code])).toEqual([["withdrawn", "inbox_removed"], ["withdrawn", "inbox_removed"]]);
  });
});

describe("crash and restart (F3, F4, F27)", () => {
  it("F3: a prepared row is re-decided by 3.3 at boot; a dispatching row with no answer becomes unknown", async () => {
    await submit({ to: ["a@x.test"] });
    const base = row("send-1");
    store.insertSend({ ...base, sendId: "p1", payloadHash: "p1", state: "prepared", why: null, revision: 1 });
    store.putPayload("p1", store.getPayload("send-1"));
    store.insertSend({ ...base, sendId: "d1", payloadHash: "d1", state: "dispatching", revision: 1 });
    await service.recover();
    expect(row("p1")).toMatchObject({ state: "awaiting_owner", why: "waiting_new_contact" });
    expect(row("d1")).toMatchObject({ state: "unknown", dueAt: clock + 60_000 });
    expect(fake.requests).toHaveLength(0);
  });

  it("F4: crash after a 202 before the card: boot's reconcile finds the hold on the pending approvals and the card comes back", async () => {
    await submit();
    const base = row("send-1");
    store.insertSend({ ...base, sendId: "d2", payloadHash: "d2", state: "dispatching", revision: 1 });
    await service.recover();
    clock += 60_000;
    fake.on("GET", /\/messages$/, { status: 200, body: { data: [] } })
      .on("GET", /\/v1\/email\/approvals$/, { status: 200, body: { data: [{ id: "apr_7" }] } })
      .on("GET", /\/approvals\/apr_7$/, approval([heldItem("hld_7", "d2")], "apr_7"));
    await service.tick();
    expect(row("d2")).toMatchObject({ state: "held", heldIds: ["hld_7"], approvalId: "apr_7" });
  });

  it("F27: the attachment bytes are frozen at the call; a later change to the file is not what goes out", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    await submit({ attachments: [{ name: "a.pdf", contentType: "application/pdf", bytes }] });
    expect(row("send-1")).toMatchObject({ state: "awaiting_owner", why: "waiting_attachment" });
    bytes[0] = 9;
    fake.on("POST", /\/messages$/, sentOk());
    await service.ownerSend("send-1", row("send-1").revision);
    expect((fake.requests[0].body as { attachments: Array<{ content: string }> }).attachments[0].content).toBe(Buffer.from([1, 2, 3]).toString("base64"));
  });

  it("rotation waits while a row is dispatching or uncertain", async () => {
    expect(service.canRotate("b1")).toBe(true);
    fake.on("POST", /\/messages$/, "reset");
    await submit();
    expect(service.canRotate("b1")).toBe(false);
  });
});

describe("the per-inbox mutual lock", () => {
  it("an approve waits for in-flight dispatches, and a dispatch waits for an in-flight approve", async () => {
    const order: string[] = [];
    let releaseDispatch!: () => void;
    const dispatch = service.locks.shared(INBOX, () => new Promise<void>(resolve => { order.push("dispatch-start"); releaseDispatch = () => { order.push("dispatch-end"); resolve(); }; }));
    await new Promise(resolve => setTimeout(resolve, 1));
    const approve = service.locks.exclusive(INBOX, async () => { order.push("approve"); });
    const second = service.locks.shared(INBOX, async () => { order.push("dispatch-2"); });
    await new Promise(resolve => setTimeout(resolve, 1));
    expect(order).toEqual(["dispatch-start"]);
    releaseDispatch();
    await Promise.all([dispatch, approve, second]);
    expect(order).toEqual(["dispatch-start", "dispatch-end", "approve", "dispatch-2"]);
    expect(service.locks.busy(INBOX)).toBe(false);
  });
});

describe("delivery events", () => {
  it("a bounce from every recipient tells the bot not_sent and marks the address for earned trust", async () => {
    fake.on("POST", /\/messages$/, sentOk());
    await submit();
    service.applyEvent({ id: "eev_b", type: "email.message.bounced", data: { message_id: "msg_1", recipient: "jane@acme.test", client_reference: "send-1", bounce: { class: "hard" } } });
    expect(row("send-1")).toMatchObject({ state: "sent", deliveryNote: "bounced:jane@acme.test" });
    expect(outcomes.map(event => event.outcome)).toEqual(["sent", "not_sent"]);
  });

  it("earned trust: three owner Sends in 30 days, no bounce, make the address eligible", () => {
    for (let i = 0; i < 3; i++) store.noteOwnerSent("b1", "pat@x.test", clock + i);
    expect(store.trustOfferEligible("b1", "pat@x.test", clock + 10)).toBe(true);
    store.noteComplaintOrBounce("b1", "pat@x.test", clock + 11);
    expect(store.trustOfferEligible("b1", "pat@x.test", clock + 12)).toBe(false);
  });
});
