// Tracked notebook links are polled with a stat first: a file that has not changed costs no
// read and no database write, so the replay verdict cache is not flushed by the poll; a changed
// file is still imported at once and written once.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { ensureWorkspace } from "../workspace.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { commitMemoryImport, previewMemoryImport, syncTrackedMemoryImports } from "./import.ts";

const reads = vi.hoisted(() => ({ count: 0 }));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => { reads.count++; return actual.readFileSync(...args); }) as typeof actual.readFileSync };
});

const roster = { bots: [{ id: "a", threadId: "thread-a" }], groups: [] };
beforeEach(() => {
  closeDatabase(); rmSync(DATA_DIR, { recursive: true, force: true }); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster(roster); database().exec("UPDATE memory_meta SET mode='active'");
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => { vi.useRealTimers(); });
const changes = () => Number(database().prepare("SELECT total_changes() AS n").get()!.n);
const pass = () => { vi.setSystemTime(Date.now() + 11_000); syncTrackedMemoryImports(roster); };

it("an unchanged notebook costs no read and no write after its first look, and a changed one is imported once", () => {
  const root = ensureWorkspace("a"), path = join(root, "MEMORY.md"), ticket = ownerMemoryTicket();
  writeFileSync(path, "Original notebook");
  commitMemoryImport(ticket, previewMemoryImport(ticket, [{ kind: "bot", botId: "a" }], roster).previewId, roster, true);
  pass();  // first look since launch: read once, nothing to write
  const settled = changes();
  reads.count = 0;
  for (let i = 0; i < 5; i++) pass();
  expect(reads.count).toBe(0);
  expect(changes()).toBe(settled);
  writeFileSync(path, "Original notebook, now with a second line of context");
  pass();
  expect(reads.count).toBeGreaterThan(0);
  expect(changes()).toBeGreaterThan(settled);
  const imported = Number(database().prepare("SELECT count(*) AS n FROM memory_sources WHERE kind='legacy-import' AND revision=2").get()!.n);
  expect(imported).toBe(1);
  const after = changes();
  for (let i = 0; i < 3; i++) pass();
  expect(changes()).toBe(after);
});
