// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The live side of the memory chip (B5m): the frame the server sends when the
// memory worker keeps something, how the chat turns it into a chip item, and
// that attaching it never moves the reader's view.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/state/store", () => ({ api: vi.fn() }));

import { REMEMBERED_EVENT, TEMPLATE_COUNTS, buildChip } from "../../shared/learned-chip";
import { chipHandlers, rememberedItemFromFrame, withChipItem } from "./learned-chips";

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
const frame = { kind: "learning.remembered", botId: "ember", threadId: "t1", sourceMessageId: "u1", replyMessageId: "b1", eventId: "e1", text: "The board meets on the first Tuesday", template: 2 };

describe("Edit on the Remembered chip uses the Memory view's own correction", () => {
  const withEntry = { ...frame, recordId: "rec1", recordVersion: 3 };
  it("a frame that names its entry offers Edit as well as Forget", () => {
    expect(rememberedItemFromFrame(withEntry)!.item).toMatchObject({ recordId: "rec1", recordVersion: 3, edited: false, actions: { edit: true, forget: true, undo: false } });
  });
  it("Edit sends the existing correct action for that entry and version", async () => {
    const request = vi.fn(async () => ({}));
    await chipHandlers(request, "ember").edit(rememberedItemFromFrame(withEntry)!.item, "The board meets on the second Tuesday");
    expect(request).toHaveBeenCalledWith("/api/memory/action", { method: "POST", body: JSON.stringify({ action: "correct", id: "rec1", version: 3, text: "The board meets on the second Tuesday" }) });
  });
  it("Forget on an untouched entry is the activation event's undo; once edited it archives the current version", async () => {
    const request = vi.fn(async () => ({}));
    const item = rememberedItemFromFrame(withEntry)!.item;
    await chipHandlers(request, "ember").undo(item);
    expect(JSON.parse((request.mock.calls[0] as any)[1].body)).toEqual({ action: "learning-undo", eventId: "e1" });
    await chipHandlers(request, "ember").undo({ ...item, edited: true, recordVersion: 4 });
    expect(JSON.parse((request.mock.calls[1] as any)[1].body)).toEqual({ action: "archive", id: "rec1", version: 4 });
  });
});

describe("rememberedItemFromFrame", () => {
  it("turns a frame without its entry into a Remembered item with Forget only", () => {
    expect(rememberedItemFromFrame(frame)).toEqual({
      botId: "ember", threadId: "t1",
      item: { eventId: "e1", kind: "remembered", group: "remembered", template: 2, text: "The board meets on the first Tuesday", state: "active", undoneAt: null, replyMessageId: "b1",
        actions: { edit: false, undo: false, forget: true, notQuite: false, notExample: false, restorable: false } },
    });
  });
  it("is nothing unless every part is there: no event, no text, no reply to sit under, no valid template, no chip", () => {
    for (const bad of [{ eventId: "" }, { text: "   " }, { replyMessageId: "" }, { botId: "" }, { threadId: undefined }, { template: 0 }, { template: TEMPLATE_COUNTS.remembered + 1 }, { template: 1.5 }]) {
      expect(rememberedItemFromFrame({ ...frame, ...bad }), JSON.stringify(bad)).toBeNull();
    }
    expect(rememberedItemFromFrame(null)).toBeNull();
    expect(rememberedItemFromFrame("x")).toBeNull();
  });
});

describe("withChipItem", () => {
  const item = rememberedItemFromFrame(frame)!.item;
  it("puts the item under its reply without touching the other replies", () => {
    const other = { ...item, eventId: "e0", replyMessageId: "b0" };
    const next = withChipItem(new Map([["b0", [other]]]), item);
    expect([...next.keys()]).toEqual(["b0", "b1"]);
    expect(next.get("b0")).toEqual([other]);
    expect(next.get("b1")).toEqual([item]);
  });
  it("never adds the same event twice (a replayed frame, a read that already has it)", () => {
    const once = withChipItem(new Map(), item);
    expect(withChipItem(once, item).get("b1")).toHaveLength(1);
  });
  it("a second item under the same reply merges into the one chip", () => {
    const next = withChipItem(withChipItem(new Map(), item), { ...item, eventId: "e2", text: "Q4 deadline is Nov 15" });
    expect(next.size).toBe(1);
    const model = buildChip(next.get("b1")!, 0)!;
    expect(model.mode).toBe("merged");
    expect(model.counts).toEqual({ remembered: 2, learned: 0 });
  });
  it("does not change the list it was given", () => {
    const base = new Map([["b1", [item]]]);
    withChipItem(base, { ...item, eventId: "e2" });
    expect(base.get("b1")).toHaveLength(1);
  });
});

describe("the wiring", () => {
  const hook = read("./learned-chips.ts");
  it("the live frame becomes a window event, and the chat hook listens for it", () => {
    expect(read("../state/store.tsx")).toContain('frame.kind === "learning.remembered"');
    expect(read("../state/store.tsx")).toContain("new CustomEvent(REMEMBERED_EVENT");
    expect(hook).toContain("window.addEventListener(REMEMBERED_EVENT");
    expect(REMEMBERED_EVENT).toBe("murage:learning-remembered");
  });
  it("only this chat's bot and thread attach it", () => {
    expect(hook).toMatch(/parsed\.botId !== botId \|\| parsed\.threadId !== threadId\) return/);
  });
  it("attaching a chip never scrolls: the hook has no scroll call, and the chat holds the reader's row first", () => {
    expect(hook).not.toMatch(/scrollTo|scrollIntoView|scrollTop|focus\(/);
    const chat = read("../components/ChatView.tsx");
    expect(chat).toContain("captureViewportAnchor(el, transcriptKey)");
    expect(chat).toMatch(/\}, \[chips\.byReply\]\);/);
    expect(chat).not.toMatch(/chips\.[a-zA-Z]+.*scrollTo/);
  });
  it("the stream frame is kept off remote streams (the text is the owner's)", () => {
    expect(read("../../server/sse-visibility.ts")).toMatch(/case "learning\.remembered":\s+return \{ scope: "desktop" \}/);
  });
});

describe("an automatic skill or routine change arrives live (learning.improved)", () => {
  const improved = { kind: "learning.improved", botId: "ember", threadId: "t1", replyMessageId: "b1", eventId: "e9", text: "weekly brief", template: 3, procedureKind: "routine" };
  it("becomes the improved chip with Undo, under its reply", () => {
    expect(rememberedItemFromFrame(improved)).toMatchObject({ botId: "ember", threadId: "t1", item: { kind: "improved", group: "improved", template: 3, text: "weekly brief", procedureKind: "routine", state: "active", actions: { undo: true, forget: false, edit: false } } });
  });
  it("is refused when it names no reply or a template that does not exist", () => {
    expect(rememberedItemFromFrame({ ...improved, replyMessageId: "" })).toBeNull();
    expect(rememberedItemFromFrame({ ...improved, template: 7 })).toBeNull();
  });
});
