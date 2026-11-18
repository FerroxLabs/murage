// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { removeTempDirSync } from "./testing/cleanup.ts";
const fault = vi.hoisted(() => ({ short: false, sync: false, open: false, paths: new Map<number, string>() }));
vi.mock("node:fs", async original => {
  const real = await original<typeof import("node:fs")>();
  const wrapped = { ...real,
    openSync: ((path: unknown, ...args: unknown[]) => { if (fault.open && String(path).endsWith(".jsonl")) { fault.open = false; throw new Error("first-file fault"); } const fd = (real.openSync as (...args: unknown[]) => number)(path, ...args); fault.paths.set(fd, String(path)); return fd; }) as typeof real.openSync,
    closeSync: ((fd: number) => { fault.paths.delete(fd); real.closeSync(fd); }) as typeof real.closeSync,
    writeSync: ((fd: number, data: string | Uint8Array, ...args: unknown[]) => {
      if (fault.short && fault.paths.get(fd)?.endsWith(".jsonl")) {
        const buffer = typeof data === "string" ? Buffer.from(data) : data, offset = typeof data === "string" ? 0 : Number(args[0] ?? 0), length = typeof data === "string" ? buffer.length : Number(args[1] ?? buffer.length);
        return real.writeSync(fd, buffer, offset, Math.min(length, 7));
      }
      return (real.writeSync as (...args: unknown[]) => number)(fd, data, ...args);
    }) as typeof real.writeSync,
    fsyncSync: ((fd: number) => { real.fsyncSync(fd); if (fault.sync && fault.paths.get(fd)?.endsWith(".jsonl")) { fault.sync = false; throw new Error("landed fsync fault"); } }) as typeof real.fsyncSync,
  }; return { ...wrapped, default: wrapped };
});
const { RoutineRunsJournal, readRoutineRuns, routineRunsDir, routineRunsFileName } = await import("./routine-runs-journal.ts");
const roots: string[] = [];
afterEach(() => { fault.short = false; fault.sync = false; fault.open = false; roots.splice(0).forEach(root => removeTempDirSync(root)); });
function root() { const dir = mkdtempSync(join(tmpdir(), "murage-journal-exact-red-")); roots.push(dir); return dir; }
const run = { id: "run", routineId: "routine", status: "queued", output: "UTF-8 café 🐈" };
for (const writer of ["append", "sync"] as const) it(`exact-base P18/P30 ${writer} short writes preserve the complete UTF-8 record`, () => {
  const dir = root(), journal = new RoutineRunsJournal(dir); journal.load(0, "generation"); fault.short = true;
  if (writer === "append") journal.append({ runs: [run], routines: [], removed: [] }); else journal.sync([run]);
  expect(readRoutineRuns(dir, 0), "short successful writes must not truncate a committed record").toEqual([run]);
});
it("exact-base P18 failed fsync of a new append still requires a durable deletion", () => {
  const dir = root(), journal = new RoutineRunsJournal(dir); journal.load(0, "generation"); fault.sync = true;
  expect(() => journal.append({ runs: [run], routines: [], removed: [] })).toThrow();
  journal.append({ runs: [], routines: [], removed: [run] }); expect(readRoutineRuns(dir, 0), "failed append must not resurrect after deletion reconciliation").toEqual([]);
});
it("exact-base P30 failed first open has registered unclean file metadata", () => {
  const dir = root(), journal = new RoutineRunsJournal(dir); journal.load(0, "generation"); fault.open = true;
  expect(() => journal.append({ runs: [run], routines: [], removed: [] })).toThrow();
  const files = (journal as unknown as { files: Map<string, { clean: boolean }> }).files;
  expect(files.get(routineRunsFileName("routine"))?.clean, "attempted first file must remain registered and unclean").toBe(false);
});
for (const marker of [undefined, -1]) it(`exact-base P36 legacy marker ${marker} pins every accepted tag before a new tagged write`, () => {
  const dir = root(); writeFileSync(join(dir, "routines.json"), JSON.stringify({ version: 1, routines: [], ...(marker === undefined ? {} : { runsCommit: marker }) }));
  mkdirSync(routineRunsDir(dir), { recursive: true }); writeFileSync(join(routineRunsDir(dir), routineRunsFileName("routine")), JSON.stringify({ ...run, $c: 7 }) + "\n");
  const journal = new RoutineRunsJournal(dir); journal.load(undefined, "generation");
  expect(JSON.parse(readFileSync(join(dir, "routines.json"), "utf8")).runsCommit, "legacy acceptance must be pinned before another writer can append a tag").toBe(7);
});
