// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Lane E round 2 (ui-review-r2/REPORT.md, P1): the page a client gets depends
// on what it says it can fold. A 1.0.2 renderer takes open request cards beside
// its page; a 1.0.1 renderer, the phone and the companion never read that field
// and are sent every open card inside their page, as they always were.

import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { SseReplay } from "./sse-buffer.ts";
import { Store } from "./store.ts";
import { takesCardsBeside, transcriptPage, wirePage } from "./transcript-page.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });

describe("the page each client is sent", () => {
  beforeEach(() => removeTempDirSync(DATA_DIR));

  function longThreadWithOldCard() {
    const store = new Store(selection);
    const bot = store.createBot();
    const card = store.appendMessage(bot.threadId, { role: "bot", kind: "options", text: "May I?", card: { title: "May I?", options: [], requestId: "req-old", tool: "Bash" } } as never);
    for (let i = 0; i < 300; i++) store.appendMessage(bot.threadId, { role: i % 2 ? "bot" : "user", kind: "text", text: `line ${i}` });
    return { store: new Store(selection), threadId: bot.threadId, card };
  }

  it("a client that did not negotiate gets the old card inside its page and none of the new fields", () => {
    const { store, threadId, card } = longThreadWithOldCard();
    const wire = wirePage(store, threadId, transcriptPage(store, threadId, 100, false), false, true) as Record<string, unknown>;
    expect((wire.messages as Array<{ id: string }>).some((m) => m.id === card.id)).toBe(true);
    expect(wire.openCards).toBeUndefined();
    expect(wire.openCardsLeaf).toBeUndefined();
    expect(wire.olderFrom).toBeUndefined();
  });

  it("a client that did negotiate gets a bounded page, the card beside it, and the head the card was worked out for", () => {
    const { store, threadId, card } = longThreadWithOldCard();
    const page = transcriptPage(store, threadId, 100, true);
    const wire = wirePage(store, threadId, page, true, true) as { messages: unknown[]; openCards?: Array<{ id: string }>; openCardsLeaf?: string; hasMore: boolean };
    expect(wire.messages).toHaveLength(100);
    expect(wire.openCards?.map((m) => m.id)).toEqual([card.id]);
    expect(wire.openCardsLeaf).toBe(store.activeLeafOf(threadId));
    expect(wire.hasMore).toBe(true);
  });

  it("negotiation is read from the header or the stream query", () => {
    expect(takesCardsBeside({}, new URLSearchParams())).toBe(false);
    expect(takesCardsBeside({ "x-murage-cards": "beside" }, new URLSearchParams())).toBe(true);
    expect(takesCardsBeside({}, new URLSearchParams("cards=beside"))).toBe(true);
    expect(takesCardsBeside({ "x-murage-cards": "nope" }, new URLSearchParams("cards=nope"))).toBe(false);
  });
});

describe("a page frame kept in the cards-beside shape only", () => {
  it("is found after a cursor, so a stream that cannot fold it hydrates instead of resuming", () => {
    const replay = new SseReplay();
    const subject = { scope: "global" } as never;
    replay.append({ seq: 1, kind: "bot", subject }, "id: 1\n\n");
    replay.append({ seq: 2, kind: "bot", subject, besideOnly: true }, "id: 2\n\n");
    replay.append({ seq: 3, kind: "bot", subject }, "id: 3\n\n");
    expect(replay.hasBesideOnlySince(0)).toBe(true);
    expect(replay.hasBesideOnlySince(1)).toBe(true);
    expect(replay.hasBesideOnlySince(2)).toBe(false);
    expect(replay.hasBesideOnlySince(null)).toBe(false);
  });
});
