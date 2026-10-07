// The startup notebook migration remembers a finished walk with what it saw: the next launch with
// the same bots and files reads no file and writes nothing; a new topic or an edited file walks again.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { ensureWorkspace } from "../workspace.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { migrateDetectedMemoryNotebooks } from "./import.ts";

const reads = vi.hoisted(() => ({ count: 0 }));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => { reads.count++; return actual.readFileSync(...args); }) as typeof actual.readFileSync };
});

const roster = { bots: [{ id: "a", threadId: "thread-a" }], groups: [] };
beforeEach(() => {
  closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster(roster); database().exec("UPDATE memory_meta SET mode='active'");
});
const changes = () => Number(database().prepare("SELECT total_changes() AS n").get()!.n);
/** One launch's walk: calls until no cursor is left. */
function walk() {
  let cursor: string | undefined, imported = 0;
  do { const result = migrateDetectedMemoryNotebooks(roster, cursor); imported += result.imported; cursor = result.nextCursor; } while (cursor);
  return imported;
}

it("a launch that finds the same bots and files reads nothing and writes nothing", () => {
  const root = ensureWorkspace("a");
  writeFileSync(join(root, "MEMORY.md"), "Durable notebook text, longer than the seed.");
  expect(walk()).toBe(1);
  const after = changes();
  reads.count = 0;
  expect(walk()).toBe(0);
  expect(reads.count).toBe(0);
  expect(changes()).toBe(after);
});

it("a new topic file, or an edit, is walked and imported", () => {
  const root = ensureWorkspace("a");
  writeFileSync(join(root, "MEMORY.md"), "Durable notebook text, longer than the seed.");
  walk();
  mkdirSync(join(root, "memory"), { recursive: true });
  writeFileSync(join(root, "memory", "topic.md"), "A new topic worth keeping.");
  expect(walk()).toBe(1);
  writeFileSync(join(root, "MEMORY.md"), "Durable notebook text, longer than the seed, and edited.");
  expect(walk()).toBe(1);
  expect(walk()).toBe(0);
});

it("an unchanged notebook rescanned by a walk that does run leaves its link row alone", () => {
  const root = ensureWorkspace("a");
  writeFileSync(join(root, "MEMORY.md"), "Durable notebook text, longer than the seed.");
  walk();
  database().prepare("DELETE FROM memory_scope_bindings WHERE id='notebook-migration-done'").run();
  const after = changes();
  expect(walk()).toBe(0);
  // only the done marker is written again
  expect(changes() - after).toBeLessThanOrEqual(1);
});
