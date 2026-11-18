// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOTIFY-EVERYWHERE-1019 banner actions, step 0: an outside answer is bound to the exact pending card. The server names the registered
// approval (approvalId, requestRef, actionHash) in the attention reads only when that card may be answered outside, and `answerOutside`
// re-runs the same test synchronously on the live approval and requires the three posted values to match.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { judgeOutsideBinding, outsideBinding, parseOutsideBody, type OutsideBindingRecord } from "./desktop-attention.ts";
import { OUTSIDE_ENVELOPES } from "../shared/outside-limits.mjs";

const D = "a".repeat(64);
const BOUND = { approvalId: "ap-1", requestRef: "ref-1", actionHash: "h".repeat(64) };
const card = (over: Record<string, unknown> = {}) => ({ requestId: "r1", tool: "Bash", title: "Run a command", subtitle: "ls -la", ...BOUND, ...over }) as never;
const registered = (over: Record<string, unknown> = {}) => ({
  ref: { approvalId: "ap-1" }, threadId: "t1", chatMessageId: "m1", requestId: "ref-1", state: "open", why: "base", actionHash: BOUND.actionHash,
  level: "ask", evidence: [], action: { requestId: "r1" }, actor: "owner", ...over,
}) as unknown as OutsideBindingRecord;
const judge = (cardOver: Record<string, unknown> = {}, recordOver: Record<string, unknown> | null = {}, where: { threadId?: string; messageId?: string; noLimitsNow?: unknown } = {}) =>
  outsideBinding({ threadId: where.threadId ?? "t1", messageId: "messageId" in where ? where.messageId : "m1", card: card(cardOver), registered: recordOver === null ? undefined : registered(recordOver), noLimitsNow: ("noLimitsNow" in where ? where.noLimitsNow : false) as boolean });
const body = (over: Record<string, unknown> = {}) => ({ requestId: "r1", behavior: "allow", outside: { digest: D, surface: "pill" }, ...BOUND, ...over });

describe("outsideBinding: which card may be answered outside", () => {
  it("binds an open card the owner's own request raised, below No limits, with no deny or wipe evidence", () => {
    expect(judge()).toEqual({ ok: true, binding: BOUND });
    for (const level of ["ask", "auto", "full"]) expect(judge({}, { level }), level).toMatchObject({ ok: true });
  });
  it("a card with no registered approval, or without its three ids, is never bound", () => {
    expect(judge({}, null)).toEqual({ ok: false, code: "binding_unregistered" });
    for (const field of ["approvalId", "requestRef", "actionHash"]) {
      expect(judge({ [field]: undefined }), field).toEqual({ ok: false, code: "binding_unregistered" });
      expect(judge({ [field]: "" }), field).toEqual({ ok: false, code: "binding_unregistered" });
      expect(judge({ [field]: 7 }), field).toEqual({ ok: false, code: "binding_unregistered" });
      expect(judge({ [field]: "x".repeat(201) }), field).toEqual({ ok: false, code: "binding_unregistered" });
    }
    expect(judge({}, {}, { messageId: undefined })).toEqual({ ok: false, code: "binding_unregistered" });
    expect(outsideBinding({ threadId: "t1", messageId: "m1", card: undefined, registered: registered(), noLimitsNow: false })).toEqual({ ok: false, code: "binding_unregistered" });
  });
  it("a stale card: the registered approval is for another approval, request, action, thread or message", () => {
    const stale = { ok: false, code: "binding_stale" };
    expect(judge({}, { ref: { approvalId: "ap-2" } })).toEqual(stale);
    expect(judge({}, { requestId: "ref-2" })).toEqual(stale);
    expect(judge({}, { actionHash: "i".repeat(64) })).toEqual(stale);
    expect(judge({}, { threadId: "t2" })).toEqual(stale);
    expect(judge({}, { chatMessageId: "m2" })).toEqual(stale);
    expect(judge({}, { action: { requestId: "r2" } })).toEqual(stale);
    expect(judge({}, {}, { threadId: "t2" })).toEqual(stale);
    expect(judge({}, {}, { messageId: "m2" })).toEqual(stale);
  });
  it("a replay: an approval that is no longer open", () => {
    for (const state of ["answered", "expired", "cancelled", "superseded"]) expect(judge({}, { state }), state).toEqual({ ok: false, code: "binding_not_open" });
  });
  it("another user's request, the owner's routine and an unproven actor stay Open only", () => {
    for (const actor of ["owner-routine", "other", "unproven"]) expect(judge({}, { actor }), actor).toEqual({ ok: false, code: "binding_not_owner" });
  });
  it("a deny card, a wipe card, a question and any card carrying deny or wipe evidence stay Open only", () => {
    for (const why of ["deny", "wipe", "question"]) expect(judge({}, { why }), why).toEqual({ ok: false, code: "binding_evidence" });
    for (const kind of ["deny", "wipe"]) expect(judge({}, { evidence: [{ kind, class: "c", ruleId: "r", span: "s" }] }), kind).toEqual({ ok: false, code: "binding_evidence" });
    expect(judge({}, { evidence: undefined })).toEqual({ ok: false, code: "binding_evidence" });
  });
  it("nothing is bound under No limits, or at a level it does not know", () => {
    expect(judge({}, { level: "unlimited" })).toEqual({ ok: false, code: "binding_no_limits" });
    expect(judge({}, { level: "something-new" })).toEqual({ ok: false, code: "binding_no_limits" });
    expect(judge({}, { level: undefined })).toEqual({ ok: false, code: "binding_no_limits" });
  });
  it("a card raised before No limits was turned on is not bound once it is on, whatever its registered level says", () => {
    for (const level of ["ask", "auto", "full"]) expect(judge({}, { level }, { noLimitsNow: true }), level).toEqual({ ok: false, code: "binding_no_limits" });
    expect(judge({}, {}, { noLimitsNow: undefined })).toEqual({ ok: false, code: "binding_no_limits" });
  });
});

describe("judgeOutsideBinding: the answer names exactly the live approval", () => {
  const live = { ok: true as const, binding: BOUND };
  it("passes the same three values", () => expect(judgeOutsideBinding(live, { ...BOUND })).toEqual({ ok: true }));
  it("409s when any one posted value differs", () => {
    for (const field of ["approvalId", "requestRef", "actionHash"] as const) expect(judgeOutsideBinding(live, { ...BOUND, [field]: "other" }), field).toEqual({ ok: false, status: 409, code: "binding_changed" });
  });
  it("409s on the live refusal's own name, whatever was posted", () => {
    for (const code of ["binding_unregistered", "binding_stale", "binding_not_open", "binding_not_owner", "binding_evidence", "binding_no_limits"] as const) expect(judgeOutsideBinding({ ok: false, code }, { ...BOUND })).toEqual({ ok: false, status: 409, code });
  });
});

describe("parseOutsideBody: the three binding values are required", () => {
  it("carries them through", () => expect(parseOutsideBody(body())).toMatchObject({ ok: true, binding: BOUND }));
  it("refuses a body missing any one of them, or with one that is not a short string", () => {
    for (const field of ["approvalId", "requestRef", "actionHash"]) {
      const missing: Record<string, unknown> = body(); delete missing[field];
      expect(parseOutsideBody(missing), field).toEqual({ ok: false, status: 400, code: "bad_outside_body" });
      for (const bad of ["", 5, null, ["ap-1"], "x".repeat(201)]) expect(parseOutsideBody(body({ [field]: bad })), `${field} ${JSON.stringify(bad).slice(0, 20)}`).toMatchObject({ ok: false, status: 400 });
    }
  });
});

describe("answerOutside checks the binding synchronously before it answers (static guard on server/index.ts)", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const section = (name: string) => { const start = source.indexOf(`function ${name}(`); return start < 0 ? "" : source.slice(start, source.indexOf("\n}\n", start)).replace(/\/\/.*$/gm, ""); };
  it("re-reads the registered approval for the pending card and refuses before answerRequest", () => {
    const answer = section("answerOutside");
    const check = answer.indexOf("judgeOutsideBinding(outsideBinding({ threadId, messageId: asked.pending?.id, card, registered: asked.pending ? lookupApproval(threadId, asked.pending.id) : undefined, noLimitsNow: outsideNoLimitsNow(threadId, botId) }), parsed.binding)");
    expect(check).toBeGreaterThan(0);
    const refusal = answer.indexOf("if (!bound.ok) return json(res, bound.status,");
    expect(refusal).toBeGreaterThan(check);
    expect(answer.indexOf("answerRequest(")).toBeGreaterThan(refusal);
    expect(answer.indexOf("answeredWhere.attempt(")).toBeGreaterThan(refusal);
    expect(answer).not.toMatch(/\bawait\b/);
  });
  it("the card read and the open list name the approval only through the same test, and close every surface without it", () => {
    const record = section("attentionCardRecord");
    expect(record).toContain("outsideBinding({ threadId, messageId, card, registered: lookupApproval(threadId, messageId), noLimitsNow: outsideNoLimitsNow(threadId, botId) })");
    expect(section("attentionOpenBinding")).toContain("noLimitsNow: outsideNoLimitsNow(threadId, message?.from?.botId) })");
    expect(section("outsideNoLimitsNow")).toContain(`return (wireTaskPermissions(threadId) as { noLimits?: boolean }).noLimits === true || (botId ? botPermissionMode(store.bot(botId)) === "unlimited" : false);`);
    expect(record).toContain("outsideOk: previews && bound.ok ? outsideOkMap(card, { stopHit, botName }) : closedOutsideMap()");
    expect(record).toContain("...(previews && bound.ok ? bound.binding : {})");
    expect(section("attentionOpenBinding")).toContain("return bound.ok ? bound.binding : null;");
    expect(source).toContain("outsideOk: binding ? item.outsideOk : closedOutsideMap()");
  });
});

describe("step 0 ships no actionable OS banner", () => {
  it("every OS banner and the menu stay Open only until MAIN flips one constant", () => {
    for (const surface of ["banner-mac", "banner-win", "banner-linux", "menu"] as const) expect(OUTSIDE_ENVELOPES[surface], surface).toEqual({ maxLines: 0, maxLineChars: 0, titleChars: 0, nameChars: 0, repertoire: "ascii" });
  });
});
