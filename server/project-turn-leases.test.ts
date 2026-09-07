import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { ProjectTurnLeases, PROJECT_TURN_TOMBSTONE_LIMIT } from "./project-turn-leases.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "murage-project-turn-"));
  roots.push(cwd);
  const leases = new ProjectTurnLeases();
  const owners = () => leases.folders.conflicts(cwd, "restore").map(lease => lease.ownerId).sort();
  return { cwd, leases, owners };
}

it("releases a terminal-before-bind generation without touching another writer", () => {
  const { cwd, leases, owners } = fixture();
  leases.acquire("thread", "generation", cwd);
  leases.markDispatched("generation");
  leases.acquire("other-thread", "other-generation", cwd);
  leases.markDispatched("other-generation");
  leases.complete("thread", "early-turn");
  expect(owners()).toEqual(["generation", "other-generation"]);
  expect(leases.bind("thread", "generation", "early-turn")).toBe(false);
  expect(owners()).toEqual(["other-generation"]);
});

it("matches terminal events to their bound generation and never the latest thread owner", () => {
  const { cwd, leases, owners } = fixture();
  leases.acquire("same-thread", "old-generation", cwd);
  leases.markDispatched("old-generation");
  expect(leases.bind("same-thread", "old-generation", "old-turn")).toBe(true);
  leases.acquire("same-thread", "new-generation", cwd);
  leases.markDispatched("new-generation");
  expect(leases.bind("same-thread", "new-generation", "new-turn")).toBe(true);
  leases.complete("wrong-thread", "new-turn");
  expect(owners()).toHaveLength(2);
  leases.complete("same-thread", "old-turn");
  expect(owners()).toEqual(["new-generation"]);
  leases.complete("same-thread", "old-turn");
  expect(owners()).toEqual(["new-generation"]);
  leases.complete("same-thread", "new-turn");
  expect(owners()).toEqual([]);
});

it("releases pre-dispatch cancellation but holds abandoned dispatched work until completion", () => {
  const { cwd, leases, owners } = fixture();
  leases.acquire("thread", "setup", cwd);
  leases.abandon("setup");
  expect(owners()).toEqual([]);
  leases.acquire("thread", "dispatched", cwd);
  leases.markDispatched("dispatched");
  leases.abandon("dispatched");
  expect(owners()).toEqual(["dispatched"]);
  expect(leases.bind("thread", "dispatched", "turn")).toBe(true);
  leases.abandon("dispatched");
  expect(owners()).toEqual(["dispatched"]);
  leases.complete("thread", "turn");
  expect(owners()).toEqual([]);
});

it("confirmed disposal releases only the generations captured before the await", () => {
  const { cwd, leases, owners } = fixture();
  leases.acquire("old-thread", "old", cwd);
  leases.markDispatched("old");
  leases.abandon("old");
  const captured = leases.generations();
  leases.acquire("new-thread", "new", cwd);
  leases.markDispatched("new");
  leases.disposed(captured);
  expect(owners()).toEqual(["new"]);
  expect(captured).toEqual(["old"]);
  leases.disposed(captured);
  expect(leases.generations()).toEqual(["new"]);
});

it("rejects cross-thread generation capture and conflicting provider bindings", () => {
  const { cwd, leases, owners } = fixture();
  const first = leases.acquire("thread", "first", cwd);
  expect(first).toMatchObject({ ownerId: "first", mode: "writer" });
  expect(leases.acquire("thread", "first", cwd)).toEqual(first);
  expect(() => leases.acquire("other-thread", "first", cwd)).toThrow("another thread");
  leases.markDispatched("first");
  leases.acquire("thread", "second", cwd);
  leases.markDispatched("second");
  expect(leases.bind("thread", "first", "turn")).toBe(true);
  expect(leases.bind("thread", "second", "turn")).toBe(false);
  expect(leases.bind("thread", "first", "another-turn")).toBe(false);
  leases.complete("thread", "turn");
  expect(owners()).toEqual(["second"]);
});

it("bounds completion tombstones and supports turns that have no folder lease", () => {
  const { cwd, leases } = fixture();
  leases.markDispatched("no-cwd");
  leases.abandon("no-cwd");
  expect(leases.bind("thread", "no-cwd", "turn")).toBe(false);
  leases.complete("thread", "oldest");
  for (let index = 0; index < PROJECT_TURN_TOMBSTONE_LIMIT; index++) leases.complete("thread", "terminal-" + index);
  leases.acquire("thread", "late-old", cwd);
  expect(leases.bind("thread", "late-old", "oldest")).toBe(true);
  leases.acquire("thread", "recent", cwd);
  expect(leases.bind("thread", "recent", "terminal-" + (PROJECT_TURN_TOMBSTONE_LIMIT - 1))).toBe(false);
  expect(leases.generations()).toEqual(["late-old"]);
});
