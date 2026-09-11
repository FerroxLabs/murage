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

// ── restore admission across the Stop → close window (STOPRESTORE1) ────────
it("restore admission waits for a stopped writer's release and then holds the folder", async () => {
  const { cwd, leases, owners } = fixture();
  leases.acquire("thread", "generation", cwd);
  leases.markDispatched("generation");
  expect(leases.bind("thread", "generation", "turn")).toBe(true);
  expect(leases.markStopRequested("generation")).toBe(true);
  let settled: unknown;
  const admission = leases.acquireRestoreWhenStopped("restore:1", cwd, { timeoutMs: 5_000 }).then(value => { settled = value; return value; });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(settled, "the restore must not be admitted while the stopped turn still holds the folder").toBeUndefined();
  expect(owners()).toEqual(["generation"]);
  leases.complete("thread", "turn");
  await expect(admission).resolves.toMatchObject({ ok: true, lease: { ownerId: "restore:1", mode: "restore" } });
  expect(owners()).toEqual(["restore:1"]);
});

it("restore admission refuses a live writer at once and never waits on it", async () => {
  const { cwd, leases, owners } = fixture();
  leases.acquire("thread", "generation", cwd);
  leases.markDispatched("generation");
  const started = Date.now();
  await expect(leases.acquireRestoreWhenStopped("restore:1", cwd, { timeoutMs: 5_000 })).resolves.toEqual({ ok: false, reason: "conflict", code: "conflict" });
  expect(Date.now() - started).toBeLessThan(1_000);
  expect(owners()).toEqual(["generation"]);
});

it("restore admission refuses when one holder is stopped but another is live, or when a restore already holds the folder", async () => {
  const { cwd, leases } = fixture();
  leases.acquire("thread", "stopped", cwd);
  leases.markDispatched("stopped");
  leases.markStopRequested("stopped");
  leases.acquire("other-thread", "live", cwd);
  leases.markDispatched("live");
  await expect(leases.acquireRestoreWhenStopped("restore:1", cwd, { timeoutMs: 5_000 })).resolves.toEqual({ ok: false, reason: "conflict", code: "conflict" });
  const alone = fixture();
  alone.leases.folders.acquireRestore("restore:first", alone.cwd);
  await expect(alone.leases.acquireRestoreWhenStopped("restore:second", alone.cwd, { timeoutMs: 5_000 })).resolves.toEqual({ ok: false, reason: "conflict", code: "conflict" });
  // An unusable path is a refusal with the registry's own code, never a wait.
  await expect(alone.leases.acquireRestoreWhenStopped("restore:third", "/definitely/not/a/folder", { timeoutMs: 5_000 })).resolves.toEqual({ ok: false, reason: "conflict", code: "invalid-path" });
  // Re-using a held owner id for another folder is `owner-in-use`, not a busy folder.
  await expect(alone.leases.acquireRestoreWhenStopped("restore:first", cwd, { timeoutMs: 5_000 })).resolves.toEqual({ ok: false, reason: "conflict", code: "owner-in-use" });
});

it("restore admission reports a stopped writer that does not release within the bound as still closing", async () => {
  const { cwd, leases, owners } = fixture();
  leases.acquire("thread", "generation", cwd);
  leases.markDispatched("generation");
  leases.markStopRequested("generation");
  await expect(leases.acquireRestoreWhenStopped("restore:1", cwd, { timeoutMs: 50 })).resolves.toEqual({ ok: false, reason: "still-closing" });
  // Nothing was taken and the stopped turn still owns the folder; a later
  // release lets a retry through.
  expect(owners()).toEqual(["generation"]);
  leases.disposed(["generation"]);
  await expect(leases.acquireRestoreWhenStopped("restore:2", cwd, { timeoutMs: 50 })).resolves.toMatchObject({ ok: true });
});

it("marking a stop on an unknown or already released generation is a no-op", () => {
  const { cwd, leases } = fixture();
  expect(leases.markStopRequested("nobody")).toBe(false);
  leases.acquire("thread", "generation", cwd);
  leases.abandon("generation");
  expect(leases.markStopRequested("generation")).toBe(false);
});
