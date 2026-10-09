// A turn's memory bundle hydrates up to 20 hits and re-checks the reader's
// audience before and after each one (assertMemoryAccess). Each check walked
// the whole roster, confirming every room and thread scope by primary key
// (391,733 to 953,588 a minute on the live store) and read every owned
// thread's human binding (939,532 a minute). Inside one synchronous pass the
// audience is worked out once and a thread's binding is read once; any row
// this connection writes ends the memo, so a deleted scope or a revoked
// binding is never answered from memory.
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { appendMessage } from "../message-db.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { threadHumanPrincipal, OWNER } from "../human-principals.ts";
import { assertMemoryAccess, inMemoryAccessPass, memoryAccess, reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { inEligibilityPass } from "./eligibility-pass.ts";
import { buildMemoryBundle } from "./bundle.ts";
import { catchUpRecentMemory } from "./recent.ts";

beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); });

/** Counts RUNS (get, all, run) of statements whose SQL contains `needle`; install before first use. */
function runCounter(db: ReturnType<typeof database>, needle: string): () => number {
  const real = db.prepare.bind(db); let runs = 0;
  const previous = db.prepare;
  (db as any).prepare = (sql: string) => {
    const statement = previous.call(db, sql);
    if (!sql.includes(needle)) return statement;
    return new Proxy(statement, { get(target, key) {
      const value = (target as any)[key];
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => { if (key === "get" || key === "all" || key === "run" || key === "iterate") runs++; return value.apply(target, args); };
    } });
  };
  void real;
  return () => runs;
}
const CONFIRM = "WHERE id=? AND kind=? AND owner_key=?";
const BINDING = "memory_scope_bindings WHERE id=? AND subject_type='human-thread'";
const empty = { search: async () => ({ hits: [], vectorRows: 0, degradedReason: "keyword-only" }) };

function world() {
  // 12 bots with 10 tasks each, 40 rooms with 5 threads each: 320 threads
  const bots = Array.from({ length: 12 }, (_, i) => ({ id: `b${i}`, threadId: `b${i}-main`, section: "Ops", tasks: Array.from({ length: 10 }, (_, t) => ({ threadId: `b${i}-t${t}` })) }));
  const groups = Array.from({ length: 40 }, (_, r) => ({ id: `r${r}`, threadId: `r${r}-main`, section: "Ops", memberIds: bots.slice(0, 4).map(b => b.id), tasks: Array.from({ length: 4 }, (_, t) => ({ threadId: `r${r}-t${t}` })) }));
  return { bots, groups } as MemoryRoster;
}
function setup() {
  const roster = world(), db = database();
  const confirms = runCounter(db, CONFIRM), bindings = runCounter(db, BINDING);
  reconcileMemoryRoster(roster);
  for (const task of roster.bots[0]!.tasks!) for (let m = 0; m < 3; m++) appendMessage(task.threadId, { id: `${task.threadId}-${m}`, at: m + 1, role: "user", kind: "text", text: `Report colour charcoal ${m}` });
  const registry = new InternalCapabilities(), generation = registry.begin("b0", "b0-main");
  const token = registry.mint({ botId: "b0", threadId: "b0-main", generation, depth: 0, kind: "memory", skillAuthoring: false });
  const access = memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
  return { roster, db, access, confirms, bindings };
}

it("building a bundle from many hits confirms the roster's scopes a handful of times, not once per check", async () => {
  const { access, confirms } = setup();
  catchUpRecentMemory(access);  // the turn's one catch-up step runs before recall; recall itself writes nothing
  const before = confirms();
  const bundle = await buildMemoryBundle("report colour", access, empty);
  expect(bundle.text).toContain("charcoal");
  // one audience walk is ~215 confirmations; 20 hits used to cost ~3 walks each on top of the fixed checks (7,624 before, 3,560 after)
  console.error("AFTERC",confirms()-before);expect(confirms() - before).toBeLessThanOrEqual(215 * 18);
});

it("building a bundle reads a thread's human binding a handful of times, not once per check", async () => {
  const { access, bindings } = setup(), before = bindings();
  await buildMemoryBundle("report colour", access, empty);
  console.error("AFTERB",bindings()-before);expect(bindings() - before).toBeLessThanOrEqual(11 * 16);
});

it("inside a pass, repeated access checks walk the roster once; outside one each check walks it again", () => {
  const { access, confirms } = setup();
  let mark = confirms();
  inMemoryAccessPass(() => { for (let i = 0; i < 40; i++) assertMemoryAccess(access); });
  const inside = confirms() - mark;
  mark = confirms();
  for (let i = 0; i < 40; i++) assertMemoryAccess(access);
  const outside = confirms() - mark;
  expect(inside).toBeLessThanOrEqual(260);
  expect(outside).toBeGreaterThan(inside * 30);
});

it("a scope deleted or renamed mid-pass is not answered from the memo", () => {
  const { db, access } = setup();
  const room = String(db.prepare("SELECT id FROM memory_scopes WHERE kind='room' AND owner_key='r3'").get()!.id);
  inMemoryAccessPass(() => {
    expect(() => assertMemoryAccess(access, room)).not.toThrow();
    db.prepare("UPDATE memory_scopes SET owner_key='renamed' WHERE id=?").run(room);
    expect(() => assertMemoryAccess(access, room)).toThrow("MEMORY_SCOPE_DENIED");
  });
  const other = String(db.prepare("SELECT id FROM memory_scopes WHERE kind='room' AND owner_key='r4'").get()!.id);
  inMemoryAccessPass(() => {
    expect(() => assertMemoryAccess(access, other)).not.toThrow();
    db.prepare("DELETE FROM memory_scopes WHERE id=?").run(other);
    expect(() => assertMemoryAccess(access, other)).toThrow("MEMORY_SCOPE_DENIED");
  });
});

it("a thread's binding is read once per pass, and a binding written or revoked mid-pass is seen at once", () => {
  const { db, bindings } = setup();
  let mark = bindings();
  inEligibilityPass(db, () => { for (let i = 0; i < 100; i++) threadHumanPrincipal("b0-t1", db); });
  expect(bindings() - mark).toBe(1);
  mark = bindings();
  for (let i = 0; i < 100; i++) threadHumanPrincipal("b0-t1", db);
  expect(bindings() - mark).toBe(100);
  const scope = String(db.prepare("SELECT id FROM memory_scopes LIMIT 1").get()!.id);
  const person = { personId: "person-1", bindingId: "human-binding:x", revision: 2 };
  inEligibilityPass(db, () => {
    expect(threadHumanPrincipal("b0-t2", db)).toEqual(OWNER);
    db.prepare("INSERT INTO memory_scope_bindings VALUES('human-thread:b0-t2',?,'human-thread','b0-t2',2,'granted',?)").run(scope, JSON.stringify(person));
    expect(threadHumanPrincipal("b0-t2", db)).toEqual(person);
    db.prepare("DELETE FROM memory_scope_bindings WHERE id='human-thread:b0-t2'").run();
    expect(threadHumanPrincipal("b0-t2", db)).toEqual(OWNER);
  });
});
