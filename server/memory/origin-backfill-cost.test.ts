// The origin backfill: rows that already carry an origin are filtered where the data lives and their
// payload never reaches the caller, an empty last window still writes done, and once done is recorded
// a later call reads only the marker (no join over sources and versions).
import { mkdirSync, rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { ensureScope, reconcileMemoryRoster } from "./policy.ts";
import { backfillMemoryOrigins } from "./origin-backfill.ts";

const roster = { bots: [{ id: "bot", threadId: "chat" }], groups: [] };
beforeEach(() => { closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true }); reconcileMemoryRoster(roster); });
function seed(count: number) {
  const db = database(), scope = ensureScope("bot", "bot");
  for (let i = 0; i < count; i++) {
    db.prepare("INSERT INTO memory_sources VALUES(?,?,?,?,NULL,1,?,'text','owner','recorded',NULL,'active')").run(`s${String(i).padStart(3, "0")}`, scope, "chat", `m${i}`, `h${i}`);
    db.prepare("INSERT INTO memory_source_versions VALUES(?,1,?,?,1)").run(`s${String(i).padStart(3, "0")}`, `h${i}`, JSON.stringify(i === 1 ? { text: "x", origin: { kind: "schedule" } } : { text: "x".repeat(2000) }));
  }
  return scope;
}
const runs = [{ threadId: "chat", triggerSource: "schedule" as const, manual: false }] as any;
function statements(run: () => void) {
  const db = database(), real = db.prepare.bind(db), seen: string[] = [];
  (db as any).prepare = (sql: string) => { seen.push(sql); return real(sql); };
  try { run(); } finally { (db as any).prepare = real; }
  return seen;
}

it("an exactly full last window is followed by an empty one that writes done, and then nothing is read but the marker", () => {
  seed(4);  // one of the four already has an origin, so a window of three is exactly full
  expect(backfillMemoryOrigins(database(), runs, 3).done).toBe(false);
  expect(backfillMemoryOrigins(database(), runs, 3).done).toBe(true);
  const marker = JSON.parse(String(database().prepare("SELECT intent FROM memory_scope_bindings WHERE id='memory-origin-backfill'").get()!.intent));
  expect(marker.done).toBe(true);
  const later = statements(() => { expect(backfillMemoryOrigins(database(), runs, 3).done).toBe(true); });
  expect(later.filter(sql => sql.includes("memory_source_versions"))).toEqual([]);
});

it("a row that already has an origin is not bound again and no payload is selected", () => {
  seed(3);
  const seen = statements(() => { backfillMemoryOrigins(database(), runs, 100); });
  const select = seen.find(sql => sql.includes("memory_source_versions"))!;
  expect(select.split("FROM")[0]).not.toContain("payload");
  const bound = database().prepare("SELECT id FROM memory_scope_bindings WHERE subject_type='source-origin' ORDER BY id").all().map(row => String(row.id));
  expect(bound).toEqual(["source-origin:s000", "source-origin:s002"]);
});
