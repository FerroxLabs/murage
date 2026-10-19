// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// "What I've been working on" pays for what changed and for the lines it shows, never for the history (1.0.2
// turnctx): the same statements at 1,000 and at 100,000 threads per bot, on a turn where none of the bot's threads
// changed only the shown lines are read (each judged again), and no work at all on a scheduled or webhook run.
import { mkdirSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeDatabase, database, transaction } from "./database.ts";
import { appendMessage } from "./message-db.ts";
import { workingContextBlock, type WorkingContextInput } from "./working-context.ts";
import { LineageAllowance } from "./memory/lineage-allowance.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);

/** Counts every statement run from now on, and those that read messages. */
function counter(db: ReturnType<typeof database>) {
  const real = db.prepare.bind(db);
  const counts = { all: 0, messages: 0 };
  (db as any).prepare = (sql: string) => {
    const statement = real(sql);
    const readsMessages = /\bFROM messages\b/.test(sql);
    return new Proxy(statement, { get(target, key) {
      const value = (target as any)[key];
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (key === "get" || key === "all" || key === "run" || key === "iterate") { counts.all++; if (readsMessages) counts.messages++; }
        return value.apply(target, args);
      };
    } });
  };
  return { take: () => { const now = { ...counts }; counts.all = 0; counts.messages = 0; return now; }, restore: () => { (db as any).prepare = real; } };
}

function seed(threads: number): WorkingContextInput {
  const db = database();
  const tasks = Array.from({ length: threads }, (_, index) => ({ threadId: `task-${index}`, title: `Task ${index}` }));
  transaction(() => {
    const insert = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)");
    for (let index = 0; index < threads; index++) {
      const message = { id: `r${index}`, role: "bot", kind: "text", text: `Did thing ${index}.`, at: NOW - (threads - index) * 1000, from: { botId: "reed", name: "Reed", color: "blue" } };
      insert.run(`task-${index}`, message.id, message.at, "bot", "text", message.text, JSON.stringify(message));
    }
  });
  return { botId: "reed", currentThreadId: "reed-direct", now: NOW, bots: [{ id: "reed", threadId: "reed-direct", tasks }], groups: [], routines: [{ name: "Digest", botId: "reed", enabled: true }] };
}

type Round = { first: { all: number; messages: number }; again: { all: number; messages: number }; afterChange: { all: number; messages: number }; routine: { all: number; messages: number }; againMs: number; text: string; textAgain: string; textAfter: string };
function rounds(threads: number): Round {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  const input = seed(threads);
  const db = database();
  const count = counter(db);
  try {
    const text = workingContextBlock(LineageAllowance.tool(), true, input, db).text;
    const first = count.take();
    const started = performance.now();
    const textAgain = workingContextBlock(LineageAllowance.tool(), true, { ...input, now: NOW + 1000 }, db).text;
    const againMs = performance.now() - started;
    const again = count.take();
    appendMessage(`task-${Math.floor(threads / 2)}`, { id: "fresh", role: "bot", kind: "text", text: "Just finished the middle task.", at: NOW + 2000, from: { botId: "reed", name: "Reed", color: "blue" } } as never);
    count.take();
    const textAfter = workingContextBlock(LineageAllowance.tool(), true, { ...input, now: NOW + 3000 }, db).text;
    const afterChange = count.take();
    const routineText = workingContextBlock(LineageAllowance.tool(), true, { ...input, now: NOW + 4000, trigger: "schedule" }, db).text;
    const routine = count.take();
    expect(routineText).toBe("");
    expect(workingContextBlock(LineageAllowance.tool(), true, { ...input, now: NOW + 5000, trigger: "webhook" }, db).text).toBe("");
    expect(count.take().all).toBe(0);
    return { first, again, afterChange, routine, againMs, text, textAgain, textAfter };
  } finally { count.restore(); }
}

beforeEach(() => { closeDatabase(); });

it("costs the same at 1,000 and at 100,000 threads per bot, and nothing on a routine run", () => {
  const small = rounds(1_000);
  const large = rounds(100_000);
  // a first build reads a bounded number of rows, whatever the history
  expect(large.first.all).toBeLessThanOrEqual(small.first.all + 4);
  expect(large.first.all).toBeLessThan(200);
  // a change to one thread reads that thread again and the lines shown, not the others
  expect(large.afterChange.all).toBeLessThanOrEqual(small.afterChange.all + 2);
  // (1.0.2 S6: each shown line is judged by the write-time lookup, which reads its stored row; the count follows the lines shown, not the history)
  expect(large.afterChange.messages).toBeLessThanOrEqual(small.afterChange.messages + 2);
  expect(large.afterChange.messages).toBeLessThan(120);
  // a scheduled or webhook run does no work for the block
  expect(small.routine.all).toBe(0);
  expect(large.routine.all).toBe(0);
  // the newest work is listed, and the thread that just changed moves to the top
  expect(large.text).toContain("Did thing 99999.");
  expect(large.textAfter.split("\n")[1]).toContain("Just finished the middle task.");
}, 180_000);

it("a second turn with no change to any of the bot's threads reuses what was discovered: it reads only the lines it shows, the same at 1,000 and 100,000 threads", () => {
  const small = rounds(1_000);
  const large = rounds(100_000);
  // each shown line is judged again (its message by key, its label, its lineage verdict): at most two message reads a line
  expect(large.again.messages).toBeLessThanOrEqual(2 * 8);
  expect(large.again.all).toBeLessThanOrEqual(small.again.all + 2);
  expect(large.again.all).toBeLessThan(120);
  expect(large.againMs).toBeLessThan(50);
  expect(large.textAgain).toBe(large.text);
}, 180_000);
