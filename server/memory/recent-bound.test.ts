// The inline catch-up on the turn path (recent.ts) is bounded: at most two jobs per call whatever the
// backlog, and the statements it runs for them do not grow with the backlog.
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { appendMessage } from "../message-db.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { memoryAccess, reconcileMemoryRoster, type MemoryRoster } from "./policy.ts";
import { materializeRecentMemory } from "./recent.ts";
import { setMemoryMode } from "./repository.ts";

const roster: MemoryRoster = { bots: [{ id: "bot", threadId: "chat" }], groups: [] };
beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("active"); reconcileMemoryRoster(roster); });
function access() {
  const registry = new InternalCapabilities(); registry.begin("bot", "chat", "g");
  return memoryAccess(registry, registry.resolve(`Bearer ${registry.mint({ botId: "bot", threadId: "chat", generation: "g", depth: 0, kind: "memory", skillAuthoring: false })}`)!, () => roster);
}
function statementsFor(backlog: number) {
  closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); setMemoryMode("active"); reconcileMemoryRoster(roster);
  for (let i = 0; i < backlog; i++) appendMessage("chat", { id: `m${i}`, ...(i ? { parentId: `m${i - 1}` } : {}), at: i + 1, role: "user", kind: "text", text: `Durable evidence number ${i}` } as any);
  const turn = access(), db = database(), real = db.prepare.bind(db); let count = 0;
  (db as any).prepare = (sql: string) => { count++; return real(sql); };
  let completed: number;
  try { completed = materializeRecentMemory(turn); } finally { (db as any).prepare = real; }
  return { completed, count };
}
it("at most two jobs and a statement count that does not grow with the backlog", () => {
  const small = statementsFor(4), large = statementsFor(120);
  expect(small.completed).toBeLessThanOrEqual(2);
  expect(large.completed).toBeLessThanOrEqual(2);
  expect(large.count).toBeLessThanOrEqual(small.count * 2 + 20);
  expect(large.count).toBeLessThan(400);
});
