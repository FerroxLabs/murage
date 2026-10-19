// Lane E measurements (1.0.2 scale). Skipped unless LANE_E_BENCH=1; prints one
// BENCH {json} line. Runs unchanged on the base commit and on the lane, using
// only what both have, so the two numbers are comparable.
//   LANE_E_BENCH=1 LANE_E_ROWS=100000 vitest run server/transcript-scale.bench.test.ts
import { randomUUID } from "node:crypto";

import { describe, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { database, transaction } from "./database.ts";
import { promptRows } from "./external-context-delivery.ts";
import * as mdb from "./message-db.ts";
import { partitionTranscriptMessages } from "./partition-sources.ts";
import { Store, type Message } from "./store.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const ROWS = Number(process.env.LANE_E_ROWS ?? 100_000);
const ms = (t0: number) => Math.round((performance.now() - t0) * 10) / 10;
const mb = (n: number) => Math.round(n / 1048576);

describe.skipIf(!process.env.LANE_E_BENCH)("lane E bench", () => {
  it("measures", { timeout: 1_800_000 }, async () => {
    removeTempDirSync(DATA_DIR);
    const out: Record<string, unknown> = { rows: ROWS };
    const store = new Store(selection);
    const bots = Array.from({ length: 60 }, () => store.createBot());
    const long = bots[0]!;
    const body = "x".repeat(400);
    // a long thread, one unanswered card near its start, and 150 tasks on the long bot
    const t0 = performance.now();
    let parent: string | null = null;
    transaction(() => {
      for (let i = 0; i < ROWS; i++) {
        const id = randomUUID();
        const old = i === 20;
        const message = (old
          ? { id, at: 1_000 + i, role: "bot", kind: "options", text: "May I?", parentId: parent, card: { title: "May I?", options: [], requestId: "req-old", tool: "Bash" } }
          : { id, at: 1_000 + i, role: i % 2 ? "bot" : "user", kind: "text", text: `${i} ${body}`, parentId: parent }) as Message;
        mdb.appendMessage(long.threadId, message);
        parent = id;
      }
    });
    out.seedMs = ms(t0);
    for (let i = 0; i < 150; i++) store.createTask(long.id, undefined, false);
    const s = (_n: number) => new Store(selection);

    // 1. opening the long thread (a switch frame): newest page, as the server builds it
    {
      const reader = s(0);
      const t = performance.now();
      const anyStore = reader as unknown as { branchHeadSpan?: (id: string) => number; openCardsOutside?: (id: string, page: Message[]) => Message[] };
      const limit = anyStore.branchHeadSpan ? Math.max(100, Math.min(anyStore.branchHeadSpan(long.threadId), 500)) : Math.max(100, reader.newestPageSpan(long.threadId));
      const page = reader.messagePage(long.threadId, limit)!;
      const cards = anyStore.openCardsOutside?.(long.threadId, page.messages) ?? [];
      out.switchOpenMs = ms(t);
      out.switchPageRows = page.messages.length;
      out.switchFrameKB = Math.round(JSON.stringify({ messages: page.messages, openCards: cards }).length / 1024);
      out.switchOpenCards = cards.length;
      // the same switch again on the same server (what each later switch costs)
      const again = performance.now();
      const later = reader.messagePage(long.threadId, limit)!;
      anyStore.openCardsOutside?.(long.threadId, later.messages);
      out.switchOpenAgainMs = ms(again);
    }

    // 2. per-turn transcript prep on the long thread, cold then warm (activePath + partition + prompt rows + quote map)
    {
      const reader = s(0);
      const quotes = await import("./prompt-quotes.ts").catch(() => null);
      const prep = () => {
        const t = performance.now();
        const branch = partitionTranscriptMessages(database(), "b", long.threadId, reader.activePath(long.threadId));
        const active = promptRows(branch, true, []);
        const lookup = quotes
          ? quotes.promptQuoteTargets(reader as never, database(), "b", long.threadId, true, [])
          : new Map(promptRows(partitionTranscriptMessages(database(), "b", long.threadId, reader.messagesFor(long.threadId)), true, []).map((m) => [m.id, m]));
        for (const m of active.slice(-40)) if (m.replyToId) lookup.get(m.replyToId);
        return ms(t);
      };
      out.turnPrepColdMs = prep();
      out.turnPrepWarmMs = prep();
      const turnId = "bench-turn";
      reader.appendMessage(long.threadId, { role: "bot", kind: "text", text: "answer", turnId, from: { botId: long.id, name: long.name } } as never);
      const t = performance.now();
      reader.markTerminalAssistantMessage(long.threadId, turnId);
      out.terminalMarkMs = ms(t);
      const w = performance.now();
      const last = reader.messagesFor(long.threadId).at(-1)!;
      const { wholeTurnText } = await import("./memory/capture.ts");
      wholeTurnText(database(), long.threadId, last);
      out.wholeTurnTextMs = ms(w);
    }

    // 3. server memory after touching 50 threads of 5,000 messages each
    {
      const reader = s(0);
      const threads = bots.slice(1, 51).map((bot) => bot.threadId);
      transaction(() => {
        for (const threadId of threads) {
          let p: string | null = null;
          for (let i = 0; i < 5_000; i++) {
            const id = randomUUID();
            mdb.appendMessage(threadId, { id, at: 5_000 + i, role: i % 2 ? "bot" : "user", kind: "text", text: `${i} ${body}`, parentId: p } as Message);
            p = id;
          }
        }
      });
      globalThis.gc?.();
      const before = process.memoryUsage();
      const t = performance.now();
      for (const threadId of threads) reader.messagesFor(threadId);
      out.touch50Ms = ms(t);
      globalThis.gc?.();
      const after = process.memoryUsage();
      out.touch50HeapMB = mb(after.heapUsed - before.heapUsed);
      out.touch50RssMB = mb(after.rss - before.rss);
      out.touch50Cached = (reader as unknown as { cachedThreadIds?: () => string[] }).cachedThreadIds?.().length ?? "all";
    }
    console.log("BENCH " + JSON.stringify(out));
  });
});
