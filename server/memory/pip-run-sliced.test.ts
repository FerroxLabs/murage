// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// rc13 round 3 (2): the reflection run's choice of a thread (reflectableThreads, full form) read every source of every candidate thread in one
// hold of the serving thread: a 2292 ms stall on the owner's data (server3.log:27-31, ten whole-thread reads of about 103 ms each, plus a 158 ms
// "newest settled reply" read). The run now reads the same lists in pages of the thread's keys, handing the loop back between pages.
import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { captureMessage } from "./capture.ts";
import { setMemoryCaptureRoster } from "./capture-scope.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { admissibleOwnerSources, admissibleOwnerSourcesSliced, forEachThreadSourcePage, hasAdmissibleAfter, hasAdmissibleAfterSliced, THREAD_SOURCE_PAGE_ROWS } from "./pip-admission.ts";
import { readReflectState, reflectableThreads, reflectableThreadsSliced, sliceBetween, type ReflectDeps } from "./pip-reflect.ts";

const T0 = 1_760_000_000_000;
const roster = { bots: [{ id: "moss", threadId: "private", tasks: [] as Array<{ threadId: string }> }], groups: [] as never[] };
const LATER = T0 + 30 * 24 * 3600_000;
const deps = {
  now: () => LATER, bootEpoch: "boot" as never, tmpBase: "/tmp",
  bots: () => [{ id: "moss", threadIds: ["private"], continuity: true, options: { reflect: true } as never }],
  resolveRoute: async () => { throw new Error("not used"); }, memoryMode: () => "active",
} as unknown as ReflectDeps;
beforeEach(() => {
  closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster(roster); setMemoryMode("active"); setMemoryCaptureRoster(() => roster as never);
  database().exec("PRAGMA synchronous=OFF");
});
afterEach(() => { setMemoryCaptureRoster(null); });

function seed(count: number): void {
  const db = database();
  db.exec("BEGIN");
  for (let i = 1; i <= count; i++) {
    captureMessage(db, "private", { id: `o${i}`, at: T0 + i * 1000, role: "user", kind: "text", text: `Please be brief ${i}.`, origin: "desktop" } as never);
    captureMessage(db, "private", { id: `b${i}`, at: T0 + i * 1000 + 500, role: "bot", kind: "text", text: "Sure.", turnTerminal: true, from: { botId: "moss" } } as never);
  }
  db.exec("COMMIT");
  db.exec("UPDATE memory_jobs SET status='complete',cursor=100");
}
const ids = (rows: Array<{ sourceId: string }>) => rows.map(row => row.sourceId);

it("the paged owner list is the one-statement list, read a page of thread keys at a time with the loop handed back between pages", async () => {
  seed(300);
  const db = database();
  let pages = 0;
  const counted = async () => { pages++; };
  const sliced = await admissibleOwnerSourcesSliced(db, "moss", { threadId: "private" }, counted);
  expect(sliced.length).toBe(300);
  expect(ids(sliced)).toEqual(ids(admissibleOwnerSources(db, "moss", { threadId: "private" })));
  // 600 sources in the thread: every page but the last hands back
  const total = Number(db.prepare("SELECT count(*) AS n FROM memory_sources WHERE thread_id='private'").get()!.n);
  expect(pages).toBe(Math.ceil(total / THREAD_SOURCE_PAGE_ROWS) - (total % THREAD_SOURCE_PAGE_ROWS === 0 ? 0 : 1));
  // no page reads more than THREAD_SOURCE_PAGE_ROWS rows from the tables
  let largest = 0;
  await forEachThreadSourcePage(db, "private", "text", async () => {}, rows => { largest = Math.max(largest, rows.length); });
  expect(largest).toBeLessThanOrEqual(THREAD_SOURCE_PAGE_ROWS);
  // with a cursor, the same list as the one-statement read
  const q = { threadId: "private", afterAt: T0 + 250 * 1000, afterMessageId: "o250" };
  expect(ids(await admissibleOwnerSourcesSliced(db, "moss", q, counted))).toEqual(ids(admissibleOwnerSources(db, "moss", q)));
});

it("the paged pending check agrees with the one-statement check at every cursor", async () => {
  seed(200);
  const db = database();
  for (const at of [0, 1, 100, 199, 200]) {
    const q = at === 0 ? { threadId: "private" } : { threadId: "private", afterAt: T0 + at * 1000, afterMessageId: `o${at}` };
    expect(await hasAdmissibleAfterSliced(db, "moss", q, async () => {})).toBe(hasAdmissibleAfter(db, "moss", q));
  }
  expect(await hasAdmissibleAfterSliced(db, "moss", { threadId: "private", afterAt: T0 + 50_000, afterMessageId: "o50", untilAt: T0 + 40_000 }, async () => {}))
    .toBe(hasAdmissibleAfter(db, "moss", { threadId: "private", afterAt: T0 + 50_000, afterMessageId: "o50", untilAt: T0 + 40_000 }));
});

it("the run's sliced choice of threads is the one-hold choice, and the loop turns while it reads", async () => {
  seed(400);
  const db = database(), bot = deps.bots()[0]!, state = readReflectState(db, "moss");
  const whole = reflectableThreads(db, deps, bot, state, LATER);
  expect(whole.length).toBe(1);
  let turns = 0, ticking = true;
  const tick = () => { if (!ticking) return; turns++; setImmediate(tick); };
  setImmediate(tick);
  const sliced = await reflectableThreadsSliced(db, deps, bot, state, LATER, sliceBetween(0));
  ticking = false;
  expect(sliced.map(c => [c.threadId, c.surprise, c.cursorAt])).toEqual(whole.map(c => [c.threadId, c.surprise, c.cursorAt]));
  expect(turns).toBeGreaterThan(5);
  // a newest reply from the owner is not settled: no candidate either way
  captureMessage(db, "private", { id: "o-last", at: LATER - 1000, role: "user", kind: "text", text: "One more thing.", origin: "desktop" } as never);
  expect(reflectableThreads(db, deps, bot, state, LATER)).toEqual([]);
  expect(await reflectableThreadsSliced(db, deps, bot, state, LATER, async () => {})).toEqual([]);
});

it("the thread key page is read from the thread index alone", () => {
  seed(5);
  const plan = database().prepare("EXPLAIN QUERY PLAN SELECT rowid AS pos FROM memory_sources WHERE thread_id=? AND rowid>? ORDER BY rowid LIMIT ?")
    .all("private", 0, 64).map(row => String(row.detail)).join(" | ");
  expect(plan).toMatch(/USING COVERING INDEX memory_sources_thread/);
});
