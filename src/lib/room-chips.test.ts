// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Remembered / Learned chip in rooms: several member bots share one
// thread, the ledger is per bot, so each chip item is tagged with its bot and
// every tap goes to that bot.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/state/store", () => ({ api: vi.fn() }));

import type { ChipItem } from "../../shared/learned-chip";
import { fetchRoomChips, roomChipHandlers, roomFrameAccepted, tagChipItems, mergeChipMaps, rememberedItemFromFrame } from "./learned-chips";

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
const lesson = (over: Partial<ChipItem> = {}): ChipItem => ({
  eventId: "e1", kind: "lesson", group: "lesson", template: 1, text: "Lead with the decision", state: "active", undoneAt: null, replyMessageId: "r1",
  lessonId: "l1", lessonVersion: 2, actions: { edit: true, undo: true, forget: false, notQuite: false, notExample: false, restorable: true }, ...over,
});

describe("room chips: tagging and merging", () => {
  it("tags every item with the bot it came from", () => {
    const tagged = tagChipItems(new Map([["r1", [lesson()]]]), "ember");
    expect(tagged.get("r1")![0]!.botId).toBe("ember");
  });
  it("merges member maps by reply id, keeping one list per reply and never duplicating an event", () => {
    const a = tagChipItems(new Map([["r1", [lesson()]]]), "ember");
    const b = tagChipItems(new Map([["r1", [lesson({ eventId: "e2" })]], ["r2", [lesson({ eventId: "e3", replyMessageId: "r2" })]]]), "dax");
    const merged = mergeChipMaps([a, b, a]);
    expect(merged.get("r1")!.map(i => i.eventId)).toEqual(["e1", "e2"]);
    expect(merged.get("r2")!.map(i => i.botId)).toEqual(["dax"]);
  });
  it("fetches each member's lessons for the room thread and tags them", async () => {
    const request = vi.fn(async (path: string) => ({ chips: path.includes("/ember/") ? [lesson()] : [lesson({ eventId: "e9", replyMessageId: "r9" })] }));
    const merged = await fetchRoomChips(request, ["ember", "dax"], "room-thread");
    expect(request).toHaveBeenCalledWith("/api/bots/ember/lessons?threadId=room-thread");
    expect(request).toHaveBeenCalledWith("/api/bots/dax/lessons?threadId=room-thread");
    expect(merged.get("r1")![0]!.botId).toBe("ember");
    expect(merged.get("r9")![0]!.botId).toBe("dax");
  });
  it("one member's failed read leaves the others' chips", async () => {
    const request = vi.fn(async (path: string) => { if (path.includes("/dax/")) throw new Error("down"); return { chips: [lesson()] }; });
    const merged = await fetchRoomChips(request, ["ember", "dax"], "t");
    expect(merged.get("r1")).toHaveLength(1);
  });
});

describe("room chips: live frames", () => {
  const frame = { botId: "ember", threadId: "room-thread", eventId: "e1", replyMessageId: "r1", text: "Board meets Tuesday", template: 1 };
  it("accepts a frame only for the room's thread from a member", () => {
    const parsed = rememberedItemFromFrame(frame)!;
    expect(roomFrameAccepted(parsed, ["ember", "dax"], "room-thread")).toBe(true);
    expect(roomFrameAccepted(parsed, ["dax"], "room-thread")).toBe(false);
    expect(roomFrameAccepted(parsed, ["ember"], "other")).toBe(false);
  });
});

describe("room chips: taps go to the bot that learned it", () => {
  it("routes by item.botId and falls back to the first member", async () => {
    const request = vi.fn(async (..._args: unknown[]) => ({}));
    const handlers = roomChipHandlers(request, "ember");
    await handlers.edit(lesson({ botId: "dax" }), "New words");
    expect(request.mock.calls[0]![0]).toBe("/api/bots/dax/lessons/l1");
    await handlers.edit(lesson(), "More words");
    expect(request.mock.calls[1]![0]).toBe("/api/bots/ember/lessons/l1");
  });
});

describe("room chips: wiring", () => {
  const group = read("../components/GroupView.tsx");
  it("GroupView wraps the transcript in ChipsProvider and renders MessageChip for member replies", () => {
    expect(group).toContain("<ChipsProvider value={chips}>");
    expect(group).toMatch(/markOwner\(m\) && <MessageChip messageId=\{m\.id\} botName=\{markOwner\(m\)!\.name\}/);
    expect(group).toContain("useRoomChips(");
  });
  it("holds the reader's row before a chip attaches", () => {
    expect(group).toContain("captureViewportAnchor(el, transcriptKey)");
  });
  it("ChatView keeps its own hook", () => {
    expect(read("../components/ChatView.tsx")).toContain("useThreadChips(bot.id");
  });
});
