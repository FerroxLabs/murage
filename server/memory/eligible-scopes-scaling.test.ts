// 1.0.2 bgwork: who a bot may recall for is worked out on every routine start (and every recall and
// assert). The audience walk read each task thread's human binding one by one: about 900k
// `SELECT intent FROM memory_scope_bindings WHERE id=? AND subject_type='human-thread'` a minute in the
// RC1 routine burst. The statements it runs must not grow with the number of tasks a bot has.
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { backgroundMemoryScopes, reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";

beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });

/** Counts statement runs (get, all, run, iterate) of statements prepared from now on, all of them and the binding reads. */
function counters(db: ReturnType<typeof database>) {
  const real = db.prepare.bind(db); const count = { all: 0, bindings: 0 };
  (db as any).prepare = (sql: string) => {
    const statement = real(sql);
    return new Proxy(statement, { get(target, key) {
      const value = (target as any)[key];
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (key === "get" || key === "all" || key === "run" || key === "iterate") { count.all++; if (sql.includes("human-thread")) count.bindings++; }
        return value.apply(target, args);
      };
    } });
  };
  return count;
}

function statementsPerAsk(tasks: number) {
  closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true });
  const bot = { id: "bot0", threadId: "bot0-main", section: "Ops", tasks: Array.from({ length: tasks }, (_, i) => ({ threadId: `bot0-task-${i}` })) };
  const roster: MemoryRoster = { bots: [bot], groups: [] };
  const db = database();
  reconcileMemoryRoster(roster); setMemoryMode("capture");
  const count = counters(db);
  const first = backgroundMemoryScopes("bot0", "bot0-main", roster);
  // every own task thread is recalled
  expect(first.length).toBeGreaterThanOrEqual(tasks);
  const before = { ...count };
  const second = backgroundMemoryScopes("bot0", "bot0-main", roster);
  expect([...second].sort()).toEqual([...first].sort());
  return { all: count.all - before.all, bindings: count.bindings - before.bindings };
}

it("one ask runs the same statements for a bot with 100 tasks as for one with 20,000", () => {
  const small = statementsPerAsk(100);
  const large = statementsPerAsk(20_000);
  expect(large).toEqual(small);
  // the thread bindings are read once per ask, not once per task
  expect(large.bindings).toBeLessThanOrEqual(2);
}, 120_000);
