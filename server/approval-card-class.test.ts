// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// UX-TRUST-MOMENTS-1012 test 2 (gate tier): what a card carries. A payment
// card carries the task key and no "always" key; a guard, unread,
// always-ask or unattended card carries no bot-level key; a routine's card
// carries no bot-level key; a host card no `local-computer:` program key; an
// unread card is answerable with Allow once, no standing key, the unread
// why-line. And the why-line per class (1.4).
import { describe, expect, it } from "vitest";

import { approvalCardGrants, type CardGrantInput } from "./approval-card-grants.ts";
import { cardLevelOf, cardWhy } from "./approval-card-why.ts";
import type { AutoVerdictSource } from "./auto-approve.ts";
import { grantRequestFor, ROUTINE_PAY_NOT_REMEMBERED } from "./approval-grant-request.ts";
import type { StopHit } from "./stop-line.ts";
import { exactCommandKey } from "../shared/exact-command.ts";
import { foldScopes } from "../shared/fold-scopes.ts";

const EXACT = exactCommandKey({ engine: "claude", cwd: "/Users/alex/site", command: "git push" })!;
const PAY: StopHit = { kind: "pay", place: "stripe:brightline", what: "Pay $4,120 to Brightline" };
const DELETE: StopHit = { kind: "delete", place: "/Users/alex/site/build", what: "Delete outside its folder" };
const DANA: StopHit = { kind: "message", place: "dana@acme.example", recipients: ["dana@acme.example"], what: "Message someone new: dana@acme.example" };
const PUBLIC: StopHit = { kind: "message", place: "public:github:ferrox/murage", recipients: ["github:ferrox/murage"], what: "Post on GitHub" };

const input = (extra: Partial<CardGrantInput>): CardGrantInput => ({
  permission: true, questionAsk: false, inputCut: false, tool: "Bash", summary: "git push", routineAllowCard: {}, verdict: { source: "no-grant" }, ...extra,
});

describe("test 2: the keys a card carries", () => {
  it("a payment card carries the task key and no always key", () => {
    const card = approvalCardGrants(input({ stopHit: PAY, verdict: { source: "stop-line" } }));
    expect(card.taskAllowKey).toBe("stop:pay:stripe:brightline");
    expect(card.allowKey).toBeUndefined();
    expect(card.cardClass).toMatchObject({ reason: "stop-line", stop: { kind: "pay", placed: true, places: 1 } });
  });

  for (const source of ["always-ask", "sensitive-guard", "unread-call", "destructive-guard", "prompt-guard", "unattended-block", "local-computer-block"] as AutoVerdictSource[]) {
    it(`a ${source} card carries no standing key`, () => {
      for (const stopHit of [null, DELETE]) {
        const card = approvalCardGrants(input({ verdict: { source }, exactAllowKey: stopHit ? undefined : EXACT, stopHit }));
        expect(card.allowKey).toBeUndefined();
        expect(card.exactAllowKey).toBeUndefined();
        expect(card.taskAllowKey).toBeUndefined();
        expect(card.allowKeys).toBeUndefined();
        expect(foldScopes(card.cardClass, card)).toEqual([]);
      }
    });
  }

  it("an unattended card carries no standing key, whatever its reason", () => {
    for (const source of ["no-grant", "stop-line"] as AutoVerdictSource[]) {
      const card = approvalCardGrants(input({ verdict: { source }, stopHit: source === "stop-line" ? DELETE : null, exactAllowKey: source === "no-grant" ? EXACT : undefined, unattended: true }));
      expect(card).not.toHaveProperty("allowKey");
      expect(card).not.toHaveProperty("exactAllowKey");
      expect(card).not.toHaveProperty("taskAllowKey");
      expect(card.cardClass?.unattended).toBe(true);
    }
  });

  it("a routine's card carries no bot-level key (scalar, exact or action set)", () => {
    const grantRequest = grantRequestFor({ ask: { tool: "Bash", summary: "git push" }, stopHit: null, exactAllowKey: EXACT, inputCut: false, routine: { routineId: "r1", routineName: "Morning brief" } });
    const card = approvalCardGrants(input({ exactAllowKey: EXACT, routineAllowCard: { routineAllowKey: EXACT, routineId: "r1" }, grantCard: { grantRequest, allowKeys: ["app-action:GMAIL_FETCH_EMAILS", "app-action:GMAIL_SEND_EMAIL"] } }));
    expect(card.allowKey).toBeUndefined();
    expect(card.exactAllowKey).toBeUndefined();
    expect(card.allowKeys).toBeUndefined();
    expect(card).toMatchObject({ routineAllowKey: EXACT, routineId: "r1" });
    expect(card.cardClass?.routine).toEqual({ routineId: "r1" });
    expect(foldScopes(card.cardClass, { ...card, routineOffer: card.grantRequest?.routine }).map((row) => row.scope)).toEqual(["routine"]);
  });

  it("a routine's pay finding is listed as not remembered, and its key is never the routine key", () => {
    const grantRequest = grantRequestFor({ ask: { tool: "Bash", summary: "pay" }, stopHit: PAY, inputCut: false, routine: { routineId: "r1", routineName: "Bills" } });
    expect(grantRequest?.routine?.notRemembered).toEqual([ROUTINE_PAY_NOT_REMEMBERED]);
    expect(grantRequest?.routine?.stopKeys).toEqual([]);
    const card = approvalCardGrants(input({ stopHit: PAY, verdict: { source: "stop-line" }, routineAllowCard: { routineAllowKey: "stop:pay:stripe:brightline", routineId: "r1" }, grantCard: { grantRequest } }));
    expect(card.routineAllowKey).toBeUndefined();
    expect(card.allowKey).toBeUndefined();
  });

  it("a host card carries no local-computer program key", () => {
    const card = approvalCardGrants(input({ approvalScope: "local-computer", summary: "git status", exactAllowKey: undefined }));
    expect(card.allowKey).toBeUndefined();
    expect(card.cardClass?.scope).toBe("local-computer");
  });

  it("a message to someone new carries no key: sending makes them known", () => {
    const card = approvalCardGrants(input({ stopHit: DANA, verdict: { source: "stop-line" } }));
    expect(card.allowKey).toBeUndefined();
    expect(card.taskAllowKey).toBeUndefined();
  });

  it("a public post carries the task and the always key", () => {
    const card = approvalCardGrants(input({ stopHit: PUBLIC, verdict: { source: "stop-line" } }));
    expect(card).toMatchObject({ allowKey: "stop:public:github:ferrox/murage", taskAllowKey: "stop:public:github:ferrox/murage" });
    expect(card.cardClass?.stop).toEqual({ kind: "message", public: true, placed: true, places: 1 });
  });

  it("a no-grant command card at Ask keeps its program and exact keys", () => {
    const card = approvalCardGrants(input({ exactAllowKey: EXACT }));
    expect(card).toMatchObject({ allowKey: "Bash:git", exactAllowKey: EXACT });
    expect(card.taskAllowKey).toBeUndefined();
  });

  // Rendering, not verdict: an unread card on each turn kind the verdict retains it on
  for (const turn of [{ name: "owner desktop" }, { name: "covered owner channel", automated: false }, { name: "routine run", routine: true }]) {
    it(`an unread-call card (${turn.name}) is answerable once, offers nothing and says why`, () => {
      const card = approvalCardGrants(input({ verdict: { source: "unread-call" }, exactAllowKey: EXACT, ...(turn.routine ? { routineAllowCard: { routineAllowKey: EXACT, routineId: "r1" }, automated: true } : {}) }));
      expect(card.allowKey).toBeUndefined();
      expect(card.exactAllowKey).toBeUndefined();
      expect(card.taskAllowKey).toBeUndefined();
      expect(foldScopes(card.cardClass, card)).toEqual([]);
      expect(cardWhy({ cardClass: card.cardClass!, level: "full", botName: "Nova" })).toEqual({ key: "ux.l1.why.unreadCall", params: {} });
    });
  }

  it("a question is never classified as a permission", () => {
    expect(approvalCardGrants(input({ permission: false }))).toEqual({});
    expect(approvalCardGrants(input({ questionAsk: true })).cardClass?.reason).toBe("question");
  });
});

describe("1.4: the why-line per class", () => {
  const cls = (extra: Partial<CardGrantInput>) => approvalCardGrants(input(extra)).cardClass!;
  const why = (extra: Partial<CardGrantInput>, level: Parameters<typeof cardWhy>[0]["level"] = "auto", more: Partial<Parameters<typeof cardWhy>[0]> = {}) =>
    cardWhy({ cardClass: cls(extra), stopHit: extra.stopHit ?? null, level, botName: "Nova", ...more });

  it("words each class from its key", () => {
    expect(why({ stopHit: DANA, verdict: { source: "stop-line" } })).toEqual({ key: "ux.l1.why.messageNew", params: { bot: "Nova", name: "dana@acme.example" } });
    expect(why({ stopHit: DANA, verdict: { source: "stop-line" } }, "ask")?.key).toBe("ux.l1.why.messageNewAsk");
    expect(why({ stopHit: { kind: "message", place: "a@x.com,b@x.com", recipients: ["a@x.com", "b@x.com"], what: "x" }, verdict: { source: "stop-line" } })).toEqual({ key: "ux.l1.why.messageSeveral", params: { bot: "Nova", n: 2 } });
    expect(why({ stopHit: PUBLIC, verdict: { source: "stop-line" } })).toEqual({ key: "ux.l1.why.messagePublic", params: { bot: "Nova", where: "github:ferrox/murage" } });
    expect(why({ stopHit: DELETE, verdict: { source: "stop-line" } })?.key).toBe("ux.l1.why.deleteOutside");
    expect(why({ stopHit: { kind: "delete", place: "app:github", what: "x" }, verdict: { source: "stop-line" } })).toEqual({ key: "ux.l1.why.deleteOn", params: { bot: "Nova", place: "github" } });
    expect(why({ stopHit: PAY, verdict: { source: "stop-line" } })?.key).toBe("ux.l1.why.pay");
    expect(why({ stopHit: PAY, verdict: { source: "stop-line" }, automated: true })?.key).toBe("ux.l1.why.payRoutine");
    expect(why({}, "ask")?.key).toBe("ux.l1.why.askOwner");
    expect(why({ routineAllowCard: { routineAllowKey: EXACT, routineId: "r1" }, exactAllowKey: EXACT }, "ask", { routineName: "Morning brief" })).toEqual({ key: "ux.l1.why.askRoutine", params: { bot: "Nova", routine: "Morning brief" } });
    expect(why({ unattended: true }, "auto", { origin: "webhook" })?.key).toBe("ux.l1.why.webhook");
    expect(why({ unattended: true }, "auto", { origin: "channel", channel: "Telegram" })).toEqual({ key: "ux.l1.why.channel", params: { bot: "Nova", channel: "Telegram" } });
    expect(why({ unattended: true }, "auto", { origin: "channel" })?.key).toBe("ux.l1.why.channelUnnamed");
    expect(why({ unattended: true })?.key).toBe("ux.l1.why.unattended");
    for (const [source, key] of [["always-ask", "alwaysAsk"], ["sensitive-guard", "sensitiveGuard"], ["unread-call", "unreadCall"], ["destructive-guard", "destructiveGuard"], ["prompt-guard", "promptGuard"]] as const) {
      expect(why({ verdict: { source } })?.key).toBe(`ux.l1.why.${key}`);
    }
    // an ordinary no-grant card above Ask has no why-line to give
    expect(why({}, "auto")).toBeUndefined();
  });

  it("reads the level from the flags", () => {
    expect(cardLevelOf({})).toBe("ask");
    expect(cardLevelOf({ autoApprove: true })).toBe("auto");
    expect(cardLevelOf({ autoApprove: true, fullAccess: true })).toBe("full");
    expect(cardLevelOf({ autoApprove: true, fullAccess: true, noLimits: true })).toBe("unlimited");
    expect(cardLevelOf({ fullAccess: true, noLimits: true })).toBe("ask");
  });
});
