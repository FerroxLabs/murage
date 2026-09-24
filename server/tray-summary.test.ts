import { describe, expect, it } from "vitest";
import type { InboxItem } from "../shared/inbox.ts";
import type { BotRecord, Message } from "./store.ts";
import { TRAY_ITEM_LIMIT, trayQuickAnswer, traySummary } from "./tray-summary.ts";

const card = (extra: Partial<NonNullable<Message["card"]>> = {}) =>
  ({ title: "Approval needed", subtitle: "Read the weekly report draft", options: ["Allow", "Deny"], requestId: "r1", tool: "Read", allowKey: "Read", ...extra }) as NonNullable<Message["card"]>;

describe("trayQuickAnswer", () => {
  it("offers Allow and Deny only for an ordinary tool approval", () => {
    expect(trayQuickAnswer(card())).toBe(true);
  });
  it("keeps stop-line cards on the full card", () => {
    expect(trayQuickAnswer(card({ taskAllowKey: "stop:pay:stripe.com" }))).toBe(false);
    expect(trayQuickAnswer(card(), { stopHit: true })).toBe(false);
  });
  it("keeps keys, secrets and destructive commands on the full card", () => {
    expect(trayQuickAnswer(card({ tool: "Bash", subtitle: "cat ~/.ssh/id_ed25519" }))).toBe(false);
    expect(trayQuickAnswer(card({ tool: "Bash", subtitle: "cat .env" }))).toBe(false);
    expect(trayQuickAnswer(card({ tool: "Bash", subtitle: "git reset --hard" }))).toBe(false);
  });
  it("keeps questions, proposals, local-computer control, long or settled cards on the full card", () => {
    expect(trayQuickAnswer(card({ tool: undefined, questions: [{ question: "Which?", options: [] }] as never }))).toBe(false);
    expect(trayQuickAnswer(card({ approvalScope: "local-computer" }))).toBe(false);
    expect(trayQuickAnswer(card({ skillRequest: {} as never }))).toBe(false);
    expect(trayQuickAnswer(card({ routineRequest: {} as never }))).toBe(false);
    expect(trayQuickAnswer(card({ subtitle: "x".repeat(400) }))).toBe(false);
    expect(trayQuickAnswer(card({ answered: "allow" }))).toBe(false);
    expect(trayQuickAnswer(undefined)).toBe(false);
  });
});

describe("traySummary", () => {
  const bots = [
    { id: "b-zed", name: "Zed", threadId: "t-zed", busy: true, activity: "working", tasks: [{ threadId: "t-zed", title: "Inbox sweep", busy: true, activity: "working", turnStartedAt: 1000 }] },
    { id: "b-chief", name: "Sable", threadId: "t-chief" },
    { id: "b-amy", name: "amy", threadId: "t-amy", busy: true, activity: "waiting-on-you" },
    { id: "b-gone", name: "Gone", threadId: "t-gone", hidden: true },
  ] as unknown as BotRecord[];
  const item = (n: number): InboxItem => ({ id: `i${n}`, version: "v", kind: "request", segment: "approval", status: "pending", decision: true, toRead: false,
    title: "Approval", summary: "fallback", sourceLabel: "Zed · Inbox sweep", botId: "b-zed", at: n, read: false, snoozedUntil: null, duplicates: 0,
    link: { threadId: "t-zed", messageId: `m${n}` } });
  const messages: Record<string, Message[]> = {
    "t-zed": [
      { id: "m1", role: "bot", kind: "options", at: 1, card: card() },
      { id: "m2", role: "bot", kind: "options", at: 2, card: card({ requestId: "r2", taskAllowKey: "stop:message:x" }) },
      { id: "a1", role: "bot", kind: "activity", at: 2000, tool: { name: "Read", spoken: "reading a file" } },
    ] as Message[],
  };
  const summary = traySummary({ page: { decisions: 7, items: [1, 2, 3, 4, 5].map(item) }, bots, chiefId: "b-chief",
    messagesFor: id => messages[id] ?? [], stopHit: () => false });

  it("counts the Inbox umbrella and lists at most the limit", () => {
    expect(summary.needsYou).toBe(7);
    expect(summary.items).toHaveLength(TRAY_ITEM_LIMIT);
    expect(summary.items[0]).toMatchObject({ botName: "Zed", summary: "Read the weekly report draft", requestId: "r1", quick: true, threadId: "t-zed", messageId: "m1" });
    expect(summary.items[1]).toMatchObject({ quick: false, requestId: "r2" });
  });
  // The sidebar's "Needs you" adds engines nobody is signed in to (they have
  // no Inbox row, so the renderer folds them in). The 0.1.59 customer pass
  // saw the tray say 1 while the sidebar said 4. Same number, both places.
  it("counts signed-out engines the way the sidebar badge does", () => {
    const withEngines = traySummary({ page: { decisions: 1, items: [item(1)] }, bots, chiefId: "b-chief",
      messagesFor: id => messages[id] ?? [], stopHit: () => false, signedOutEngines: 3 });
    expect(withEngines.needsYou).toBe(4);
    expect(withEngines.items).toHaveLength(1);
  });
  it("lists working bots with what they are doing, never ones waiting on the owner", () => {
    expect(summary.working).toEqual([{ botId: "b-zed", botName: "Zed", threadId: "t-zed", doing: "reading a file", startedAt: 1000 }]);
  });
  it("puts the Chief first, then the others alphabetically, without hidden bots", () => {
    expect(summary.bots.map(bot => bot.name)).toEqual(["Sable", "amy", "Zed"]);
    expect(summary.bots[0]!.chief).toBe(true);
    expect(summary.moreBots).toBe(false);
  });
});
