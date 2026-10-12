// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Lane E (1.0.2 scale) golden: the engine payload a turn is built from must be
// exactly what the base (fea681604) built, over every thread shape that moves
// it: branches, edits, regenerations, quotes reaching into older pages,
// attachments and cards. The base computations are inlined here as the oracle
// (a whole-thread id map, the whole-thread quote map, the unbounded branch
// walk); the lane's bounded ones (walkActivePath, promptQuoteTargets, the
// floored wholeTurnText walk) are compared against them, with the thread both
// held in memory and evicted.
import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { database } from "./database.ts";
import { promptRows } from "./external-context-delivery.ts";
import { wholeTurnText } from "./memory/capture.ts";
import { partitionTranscriptMessages } from "./partition-sources.ts";
import { promptQuoteTargets } from "./prompt-quotes.ts";
import { authoredTurnPieces } from "./reply-action-guard.ts";
import { transcriptText } from "./replies.ts";
import { Store, type Message } from "./store.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const from = { botId: "b1", name: "Otter" };

/** Base: activePath through an id map of the whole thread. */
function baseActivePath(store: Store, threadId: string): Message[] {
  const byId = new Map(store.messagesFor(threadId).map((m) => [m.id, m]));
  const path: Message[] = [];
  for (let cur = byId.get(store.activeLeaf(threadId) ?? ""); cur; cur = cur.parentId ? byId.get(cur.parentId) : undefined) path.push(cur);
  return path.reverse();
}

/** Base: the whole-thread quote map startTurn built. */
const baseQuotes = (store: Store, botId: string, threadId: string, hasTools: boolean, pending: string[]) =>
  new Map(promptRows(partitionTranscriptMessages(database(), botId, threadId, store.messagesFor(threadId)), hasTools, pending).map((m) => [m.id, m]));

/** Base: wholeTurnText with the branch walk climbing to the root. */
function baseWholeTurnText(threadId: string, message: Message): string {
  if (!message.turnId) return message.text ?? "";
  const rows = database().prepare(`WITH RECURSIVE path(id,parent,json,depth) AS (
    SELECT id,json_extract(json,'$.parentId'),json,0 FROM messages WHERE thread_id=? AND id=(SELECT active_leaf_id FROM thread_state WHERE thread_id=?)
    UNION ALL SELECT m.id,json_extract(m.json,'$.parentId'),m.json,p.depth+1 FROM messages m JOIN path p ON m.id=p.parent WHERE m.thread_id=?
  ) SELECT json FROM path ORDER BY depth DESC`).all(threadId, threadId, threadId) as Array<{ json: string }>;
  const path = rows.map((row) => JSON.parse(String(row.json)) as Message);
  return authoredTurnPieces(path, message).map((piece) => (piece.id === message.id ? message.text : piece.text)).filter(Boolean).join("\n\n");
}

/** Everything a turn's prompt is built from: the replayed branch rendered with
 * its quotes, the terminal-answer candidate, and each turn's whole text. */
function payload(store: Store, botId: string, threadId: string, oracle: boolean, quoteStore: Store = store) {
  const out: Record<string, unknown> = {};
  for (const hasTools of [true, false]) {
    const pending: string[] = [];
    const path = oracle ? baseActivePath(store, threadId) : store.activePath(threadId);
    const rows = promptRows(partitionTranscriptMessages(database(), botId, threadId, path), hasTools, pending);
    const quotes = oracle ? baseQuotes(store, botId, threadId, hasTools, pending) : promptQuoteTargets(quoteStore, database(), botId, threadId, hasTools, pending);
    out[`transcript:${hasTools}`] = rows.map((m) => `${m.id}|${m.role}|${transcriptText(m, quotes, "Sean")}|${JSON.stringify(m.attachments ?? null)}|${JSON.stringify(m.card ?? null)}`);
  }
  const path = oracle ? baseActivePath(store, threadId) : store.activePath(threadId);
  out.turnText = path.filter((m) => m.turnId && m.role === "bot" && m.kind === "text").map((m) => (oracle ? baseWholeTurnText(threadId, m) : wholeTurnText(database(), threadId, m)));
  return out;
}

describe("engine payload parity with the base (lane E golden)", () => {
  beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));

  function shapes(store: Store) {
    const bot = store.createBot();
    const t = bot.threadId;
    const say = (text: string, extra: Partial<Message> = {}) => store.appendMessage(t, { role: "user", kind: "text", text, ...extra } as never);
    const reply = (text: string, turnId: string, extra: Partial<Message> = {}) => store.appendMessage(t, { role: "bot", kind: "text", text, turnId, from, ...extra } as never);
    // an early message the thread will quote from far later (an older page)
    const early = say("The launch date is the 14th, keep that in mind.");
    reply("Noted: the 14th.", "turn-0");
    for (let i = 0; i < 260; i++) {
      if (i % 2) reply(`filler ${i}`, `turn-f${i}`);
      else say(`filler ${i}`);
    }
    // attachments, and an image the turn left out
    say('See <attached-image path="/a/one.png" /> and <attached-image path="/a/two.png" />', {
      attachments: [{ kind: "image", path: "/a/one.png", mime: "image/png" }, { kind: "image", path: "/a/two.png", mime: "image/png" }],
      imagesNotSent: ["/a/two.png"],
    });
    // a turn in pieces around a tool call, with text saved before the tool row
    const tool = store.appendMessage(t, { role: "bot", kind: "activity", text: "ran a tool", turnId: "turn-1", from, tool: { name: "Bash", ok: true } } as never);
    store.insertMessageBefore(t, tool.id, { role: "bot", kind: "text", text: "Let me check.", turnId: "turn-1", from } as never);
    reply("Checked: all good.", "turn-1");
    store.markTerminalAssistantMessage(t, "turn-1");
    // a card, answered, and one still open
    store.appendMessage(t, { role: "bot", kind: "options", text: "May I run it?", card: { title: "May I run it?", options: [], requestId: "req-1", tool: "Bash", answered: "allow" } } as never);
    store.appendMessage(t, { role: "bot", kind: "options", text: "May I deploy?", card: { title: "May I deploy?", options: [], requestId: "req-2", tool: "Bash" } } as never);
    // a quote into the older page, and an action-only row hidden from tool-less engines
    const quoting = say("What date did I say?", { replyToId: early.id });
    reply("You said the 14th.", "turn-2");
    say("deploy it", { inboundKind: "action" } as never);
    // an edit: the question forks, and the fork gets its own answer
    const edited = store.branchMessage(t, quoting.id, "Which date did I give you?")!;
    store.appendMessage(t, { role: "bot", kind: "text", text: "The 14th.", turnId: "turn-3", from, replyToId: early.id } as never);
    // a regeneration: back to the edit, a second answer beside the first
    store.setActiveLeaf(t, edited.id);
    store.appendMessage(t, { role: "bot", kind: "text", text: "It was the 14th.", turnId: "turn-4", from, parentId: edited.id } as never);
    return { botId: bot.id, threadId: t, quoting, edited };
  }

  it("matches the base on every shape, held in memory and evicted", () => {
    const store = new Store(selection);
    const { botId, threadId, quoting, edited } = shapes(store);
    const check = (label: string) => {
      const warm = new Store(selection);
      warm.messagesFor(threadId);
      // quotes resolved by a store that never loads the thread (one indexed row each)
      const cold = new Store(selection);
      const golden = payload(new Store(selection), botId, threadId, true);
      expect(payload(warm, botId, threadId, false), `${label} (held)`).toEqual(golden);
      expect(payload(new Store(selection), botId, threadId, false, cold), `${label} (evicted)`).toEqual(golden);
      expect(cold.cachedThreadIds(), label).toEqual([]);
      return golden;
    };
    const regenerated = check("regenerated branch");
    expect(JSON.stringify(regenerated)).toContain("It was the 14th.");
    expect(JSON.stringify(regenerated)).toContain("replying to Sean");
    // the original question's branch, with its own answer and the quote
    store.setActiveLeaf(threadId, quoting.id);
    const original = check("original branch");
    expect(JSON.stringify(original)).toContain("You said the 14th.");
    // the edit's first answer
    store.setActiveLeaf(threadId, store.messagesFor(threadId).find((m) => m.text === "The 14th.")!.id);
    check("edited branch");
    // the terminal marker lands on the same row the base would pick
    const base = [...baseActivePath(store, threadId)].reverse().find((m) => m.role === "bot" && m.kind === "text" && m.turnId === "turn-3");
    expect(new Store(selection).markTerminalAssistantMessage(threadId, "turn-3")?.id).toBe(base?.id);
    expect(edited.id).toBeDefined();
  });
});
