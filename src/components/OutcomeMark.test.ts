// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The outcome mark's contracts. The renderer suite runs in node with no DOM,
// so what is pinned here is the logic (which messages can be marked, what the
// phone's sheet offers, what the routes are sent) and that ChatView carries the
// wiring; the tap itself is proved in a browser.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const calls: Array<{ path: string; init?: RequestInit }> = [];
vi.mock("@/state/store", () => ({
  api: async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    if (init?.method === "POST") return { outcome: { id: "o1", kind: "won", state: "confirmed", messageId: "m1", revision: 1 } };
    return { outcomes: [{ id: "o1", kind: "won", state: "confirmed", messageId: "m1", revision: 1 }] };
  },
}));

import { fetchOutcomes, markReply } from "@/lib/outcomes";
import { isMarkableReply, outcomeSheetActions } from "./OutcomeMark";

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
const reply = { id: "m1", role: "bot", kind: "text", text: "Here is the quote." };

describe("which messages can be marked", () => {
  it("a bot's own reply, not the owner's message, a status line or an empty one", () => {
    expect(isMarkableReply(reply)).toBe(true);
    expect(isMarkableReply({ ...reply, role: "user" })).toBe(false);
    expect(isMarkableReply({ ...reply, actorKind: "murage" })).toBe(false);
    expect(isMarkableReply({ ...reply, kind: "activity" })).toBe(false);
    expect(isMarkableReply({ ...reply, text: "  " })).toBe(false);
  });
});

describe("the phone's message sheet", () => {
  const outcomes = { marks: new Map(), proposal: undefined, mark: vi.fn(async () => ({}) as never), details: vi.fn(), undo: vi.fn(), answer: vi.fn() };
  it("offers two role-appropriate choices, sales first as won and lost", () => {
    expect(outcomeSheetActions(outcomes as never, { name: "Dax", title: "Sales" }, reply).map(action => action.label)).toEqual(["Mark as won", "Mark as lost"]);
    expect(outcomeSheetActions(outcomes as never, { name: "Ember", title: "Chief of Staff" }, reply).map(action => action.label)).toEqual(["Mark as good", "Mark as bad"]);
  });
  it("offers nothing on a message that cannot be marked, or without the outcomes", () => {
    expect(outcomeSheetActions(outcomes as never, { name: "Dax" }, { ...reply, role: "user" })).toEqual([]);
    expect(outcomeSheetActions(null, { name: "Dax" }, reply)).toEqual([]);
  });
  it("a tap records the mark with no further step", () => {
    outcomeSheetActions(outcomes as never, { name: "Dax", title: "Sales" }, reply)[0]!.onSelect();
    expect(outcomes.mark).toHaveBeenCalledWith("m1", "won", undefined);
  });
});

describe("the routes it talks to", () => {
  it("reads one conversation's outcomes", async () => {
    const list = await fetchOutcomes("bot 1", "t1");
    expect(calls.at(-1)!.path).toBe("/api/bots/bot%201/outcomes?threadId=t1");
    expect(list[0]!.id).toBe("o1");
  });
});

describe("ChatView carries the wiring", () => {
  const chat = read("./ChatView.tsx");
  it("puts the mark in the sheet, the desktop rail and under the reply, and the proposal card after the transcript", () => {
    expect(chat).toContain("...outcomeSheetActions(outcomes, bot, message)");
    expect(chat).toContain("<OutcomeRailButtons");
    expect(chat).toContain("<MessageOutcome messageId={message.id} />");
    expect(chat).toMatch(/!bot\.busy && <ProposedOutcomeCard bot=\{bot\} \/>/);
    expect(chat).toContain("<OutcomesProvider value={outcomes}>");
  });
  it("is not a dialog and has no required step", () => {
    const source = read("./OutcomeMark.tsx");
    expect(source).not.toMatch(/aria-modal|createPortal|role="dialog"/);
    expect(source).not.toMatch(/<input[^>]*\brequired\b/);
  });
  it("keeps to the copy rules: no em dash, no safety talk, no price talk, no vendor name", () => {
    const source = read("./OutcomeMark.tsx") + read("../lib/outcomes.ts");
    expect(source).not.toMatch(/—|\b(safe|safely|safety|unsafe)\b|composio|\bfree\b|always-on/i);
  });
});

describe("in a room (B5m)", () => {
  const outcomes = { marks: new Map(), proposal: undefined, mark: vi.fn(async () => ({}) as never), details: vi.fn(), undo: vi.fn(), answer: vi.fn() };
  it("a tap marks the reply for the member who wrote it", () => {
    outcomeSheetActions(outcomes as never, { name: "Dax", title: "Sales" }, reply, "dax")[0]!.onSelect();
    expect(outcomes.mark).toHaveBeenCalledWith("m1", "won", "dax");
  });
  it("records against that member's own route, and retries once with the revision the server names", async () => {
    calls.length = 0;
    const done = await markReply("dax 1", "room-thread", "m1", "good", 0);
    expect(done.id).toBe("o1");
    expect(calls.at(-1)!.path).toBe("/api/bots/dax%201/outcomes");
    expect(JSON.parse(String(calls.at(-1)!.init?.body))).toEqual({ threadId: "room-thread", messageId: "m1", kind: "good", expectedRevision: 0 });
  });
  const room = read("./GroupView.tsx");
  it("GroupView carries the same wiring as ChatView: sheet, desktop rail, strip under the reply, proposal card, provider", () => {
    expect(room).toContain("outcomeSheetActions(outcomes, markOwner(m)!, m, markOwner(m)!.id)");
    expect(room).toContain("<OutcomeRailButtons");
    expect(room).toContain("<MessageOutcome messageId={m.id} />");
    expect(room).toContain("<ProposedOutcomeCard bot={proposalBot} />");
    expect(room).toContain("<OutcomesProvider value={outcomes}>");
    expect(room).toContain("useRoomOutcomes(group.memberIds, group.threadId");
  });
  it("only a member's reply can be marked here", () => {
    expect(room).toMatch(/members\.some\(\(member\) => member\.id === m\.from!\.botId\)/);
  });
});

describe("a win chip appears when a mark or an answer is saved", () => {
  it("ChatView reads the chips again as soon as one is saved, and the hook says when", () => {
    const chat = read("./ChatView.tsx");
    expect(chat).toMatch(/useThreadOutcomes\(bot\.id, bot\.threadId, Boolean\(bot\.busy\), chips\.reload\)/);
    expect(chat.indexOf("const chips = useThreadChips")).toBeLessThan(chat.indexOf("const outcomes = useThreadOutcomes"));
    expect(read("../lib/outcomes.ts")).toMatch(/stored\.current\?\.\(\)/);
  });
});
