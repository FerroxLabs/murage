// SPDX-License-Identifier: AGPL-3.0-or-later
// AMEND-13 Rule 82 (and Rule 81d's client side): the card speaks in actions
// and places, shows every operation in call order with its arguments, offers
// "Always allow for this routine" in the exact words the design gives, names
// a recipient as its own part, and says "Saved for" once the server saved it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";

import type { ApprovalActionRow, ApprovalGrantRequest, RoutineGrantOffer } from "../../shared/approval-grant-request";
import { loadPlainApproval } from "@/lib/plain-approval";
import {
  alsoRememberWords,
  freshRecipientWords,
  grantKeyWords,
  operationWords,
  routineChoiceWords,
  savedForWords,
} from "@/lib/routine-grant-words";
import type { Message } from "@/state/store";
import { PendingApprovalPanel, alwaysAllowLabel, approvalGrants, type Pending } from "./PendingApproval";
import { GrantRequestRows, RoutineGrantChoice, RoutineSavedNotice } from "./RoutineGrantParts";

beforeAll(() => loadPlainApproval());

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const row = (index: number, operation: string, extra: Partial<ApprovalActionRow> = {}): ApprovalActionRow => ({
  index, kind: "action", operation, app: operation.startsWith("GMAIL") ? "Gmail" : "Google Calendar", action: operation.toLowerCase(),
  destinations: [], findings: [], arguments: { query: `q${index}` }, ...extra,
});
const TRAINING: ApprovalActionRow[] = [
  row(0, "GMAIL_FETCH_EMAILS", { account: "sean@example.com" }),
  row(1, "GOOGLECALENDAR_EVENTS_LIST"),
  row(2, "GOOGLECALENDAR_CREATE_EVENT", { arguments: { summary: "Run", start: "2026-10-20T07:00" } }),
  row(3, "GMAIL_CREATE_EMAIL_DRAFT", { arguments: { recipient_email: "coach@example.com", body: "Plan" } }),
];
const ACTION_KEYS = TRAINING.map((r) => `app-action:${r.operation}`);
const BOB = { key: "stop:message:bob@example.com", what: "Message someone it has not written to before: bob@example.com", recipient: "bob@example.com" };
const offer = (extra: Partial<RoutineGrantOffer> = {}): RoutineGrantOffer => ({
  routineId: "r1", routineName: "Morning training", eligible: true, actionKeys: ACTION_KEYS, stopKeys: [], notRemembered: [], ...extra,
});
const LOOKUP_ROW: ApprovalActionRow = { index: 0, kind: "lookup", operation: "COMPOSIO_SEARCH_TOOLS", app: "Connected apps", action: "find app tools", destinations: [], findings: [], arguments: { query: "gmail" } };

function pending(card: Record<string, unknown>): Pending {
  const message = {
    id: "m1", role: "bot", kind: "options", at: 1, from: { botId: "b1", name: "Dax" },
    card: { title: "Approval", subtitle: "Run app tools", options: ["Allow", "Deny"], tool: "other", requestId: "req-1", ...card },
  } as unknown as Message;
  return { message, requestId: "req-1", tool: "other", detail: "Run app tools", allowKey: card.allowKey as string | undefined };
}

describe("Rule 82: operations in plain words", () => {
  it("tells reading Gmail, reading Calendar, creating an event and saving a draft apart from sending", () => {
    expect(TRAINING.map((r) => operationWords(r.operation))).toEqual(["read Gmail", "read Calendar", "create calendar events", "save Gmail drafts"]);
    expect(operationWords("GMAIL_SEND_EMAIL")).toBe("send messages with Gmail");
    expect(operationWords("GMAIL_SEND_EMAIL")).not.toBe(operationWords("GMAIL_CREATE_EMAIL_DRAFT"));
  });

  it("names a remembered key the same way, lookups included", () => {
    expect(ACTION_KEYS.map(grantKeyWords)).toEqual(["Read Gmail", "Read Calendar", "Create calendar events", "Save Gmail drafts"]);
    expect(grantKeyWords("mcp__murage_connectors__APPS_SEARCH_TOOLS")).toBe("Find app tools");
    expect(grantKeyWords("mcp__murage_connectors__APPS_GET_TOOL_SCHEMAS")).toBe("Read how an app tool works");
    expect(grantKeyWords(BOB.key)).toBe("Send to bob@example.com");
  });
});

describe("Rule 82b, 82c: the routine choice's exact words", () => {
  it("names only this card's operations, in the design's sentence", () => {
    expect(routineChoiceWords(offer(), TRAINING)?.lines).toEqual([
      "On future runs of Morning training, allow these actions: read Gmail, read Calendar, create calendar events and save Gmail drafts. Details such as dates and draft text can change. Murage checks each request and still asks before sending to anyone new.",
    ]);
    const two = routineChoiceWords(offer({ actionKeys: ACTION_KEYS.slice(0, 2) }), TRAINING.slice(0, 2))!.lines[0]!;
    expect(two).toContain("allow these actions: read Gmail and read Calendar.");
    expect(two).not.toMatch(/save Gmail drafts|create calendar events/);
  });

  it("says a lookup is for this routine only and runs nothing it finds", () => {
    expect(routineChoiceWords(offer({ actionKeys: ["mcp__murage_connectors__APPS_SEARCH_TOOLS"] }), [LOOKUP_ROW])?.lines).toEqual([
      "Find app tools. For this routine only. This does not allow the tools it finds to run.",
    ]);
  });

  it("names a recipient as its own part of the choice", () => {
    expect(alsoRememberWords(BOB)).toBe("Also remember permission to send to bob@example.com for this routine.");
  });

  it("explains in plain words when the choice is not offered", () => {
    expect(routineChoiceWords(offer({ eligible: false, reason: "This controls your computer, so Murage asks every time." }), TRAINING)).toBeUndefined();
    const html = renderToStaticMarkup(createElement(RoutineGrantChoice, { offer: offer({ eligible: false, reason: "This controls your computer, so Murage asks every time.", actionKeys: [] }), rows: TRAINING, chosen: [], onToggle: () => {} }));
    expect(html).toContain("This controls your computer, so Murage asks every time.");
    expect(html).not.toContain("checkbox");
  });

  it("offers each recipient unticked, and says what can never be remembered", () => {
    const html = renderToStaticMarkup(createElement(RoutineGrantChoice, { offer: offer({ stopKeys: [BOB], notRemembered: ["Pay someone new: acme"] }), rows: TRAINING, chosen: [], onToggle: () => {} }));
    expect(html).toContain("Also remember permission to send to bob@example.com for this routine.");
    expect(html).toContain('type="checkbox"');
    expect(html).not.toContain("checked");
    expect(html).toContain("Murage still asks about this every time: Pay someone new: acme.");
  });
});

describe("Rule 82: every operation on the card", () => {
  const request: ApprovalGrantRequest = { rows: TRAINING, routine: offer() };

  it("lists every row in call order, with app, account, recipient and inspectable arguments, in a scrolling list", () => {
    const html = renderToStaticMarkup(createElement(GrantRequestRows, { rows: TRAINING, routineName: "Morning training" }));
    const order = ["Read Gmail", "Read Calendar", "Create calendar events", "Save Gmail drafts"].map((title) => html.indexOf(title));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain("Routine: <span");
    expect(html).toContain("Morning training");
    expect(html).toContain("account sean@example.com");
    expect(html).toContain("coach@example.com");
    expect(html).toContain("2026-10-20T07:00");
    expect(html).toContain("overflow-y-auto");
    expect(html).toContain("4 actions, in the order they run");
  });

  it("shows the rows on the pending panel the composer and the phone use", () => {
    const html = renderToStaticMarkup(createElement(PendingApprovalPanel, { pending: pending({ routineId: "r1", grantRequest: request }), count: 1, index: 0 }));
    for (const title of ["Read Gmail", "Read Calendar", "Create calendar events", "Save Gmail drafts"]) expect(html).toContain(title);
  });

  it("names who is new and why the remembered action did not cover them", () => {
    const send = row(0, "GMAIL_SEND_EMAIL", { destinations: ["bob@example.com"], findings: [{ kind: "message", what: BOB.what, key: BOB.key }] });
    expect(freshRecipientWords(send, ["app-action:GMAIL_SEND_EMAIL"], "Morning training")).toBe(
      "bob@example.com is new. Morning training remembers permission to send messages with Gmail, but that never covers sending to someone new, so Murage asks first.",
    );
    expect(freshRecipientWords(send, [], "Morning training")).toBeUndefined();
  });
});

describe("Rule 82a, 81d: which choices a card offers", () => {
  const routineCard = pending({ routineId: "r1", grantRequest: { rows: TRAINING, routine: offer() }, allowKey: "app-action:GMAIL_FETCH_EMAILS", taskAllowKey: "stop:message:x@example.com" });

  it("offers the routine choice on the owner's computer and on the paired phone app, never in a browser pairing", () => {
    expect(approvalGrants(routineCard, { desktop: true, hasBot: true }).forRoutine).toBe(true);
    expect(approvalGrants(routineCard, { desktop: false, hasBot: true, surface: "app" }).forRoutine).toBe(true);
    expect(approvalGrants(routineCard, { desktop: false, hasBot: true, surface: "browser" }).forRoutine).toBe(false);
  });

  it("offers only Allow once, the routine choice and Deny on a routine card", () => {
    const grants = approvalGrants(routineCard, { desktop: true, hasBot: true });
    expect(grants).toMatchObject({ always: false, exact: false, forTask: false, forRoutine: true });
  });

  it("offers no routine choice when the server said it is not eligible", () => {
    const closed = pending({ routineId: "r1", grantRequest: { rows: TRAINING, routine: offer({ eligible: false, reason: "x", actionKeys: [] }) } });
    expect(approvalGrants(closed, { desktop: true, hasBot: true }).forRoutine).toBe(false);
  });

  it("outside a routine, remembers ALL displayed actions of a several-row call", () => {
    const set = pending({ allowKeys: ACTION_KEYS.slice(0, 2), grantRequest: { rows: TRAINING.slice(0, 2) } });
    expect(approvalGrants(set, { desktop: true, hasBot: true }).always).toBe(true);
    expect(alwaysAllowLabel(set)).toBe("Always allow these 2 actions: Gmail: fetch emails, Google Calendar: events list");
  });
});

describe("Rule 82d, 81b, 81d: saving and the permissions view", () => {
  it("says Saved for the routine and lists what was saved", () => {
    expect(savedForWords("Morning training", [...ACTION_KEYS, BOB.key])).toEqual({
      title: "Saved for Morning training",
      items: ["Read Gmail", "Read Calendar", "Create calendar events", "Save Gmail drafts", "Send to bob@example.com"],
    });
    const html = renderToStaticMarkup(createElement(RoutineSavedNotice, { title: "Saved for Morning training", items: ["Read Gmail"], onDismiss: () => {} }));
    expect(html).toContain("Saved for Morning training");
    expect(html).toContain('role="status"');
  });

  it("the routine's permissions use the same plain names, each removable", () => {
    const view = read("./RoutineApprovals.tsx");
    expect(view).toContain("grantKeyWords(key)");
    expect(view).toContain("always-allow/remove");
  });

  it("one request saves the whole set and answers the card, through the same fresh check as an Allow", () => {
    const store = read("../state/store.tsx");
    const branch = store.slice(store.indexOf("if (action.alwaysAllowRoutine)"), store.indexOf("if (action.alwaysAllow) {"));
    expect(branch).toContain("decideWithFreshAuth(");
    expect(branch).toContain("answer: true");
    expect(branch).toContain("stopKeys");
    expect(branch).not.toContain("respond()");
    const composer = read("./Composer.tsx");
    expect(composer).toContain("RoutineSavedNotice");
  });
});
