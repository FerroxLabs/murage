import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { acquireProjectWriteRoots } from "./project-run-events.ts";
import { ProjectTurnLeases, PROJECT_TURN_TOMBSTONE_LIMIT } from "./project-turn-leases.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import { wiring } from "./decision-wiring/fixture.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTempDirSync(root); });
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "murage-project-turn-"));
  roots.push(cwd);
  const leases = new ProjectTurnLeases();
  const owners = () => leases.folders.conflicts(cwd, "restore").map(lease => lease.ownerId).sort();
  return { cwd, leases, owners };
}

it("keeps the separate output writer until terminal evidence and releases both roots", async () => {
  const f = fixture(), output = fixture().cwd;
  f.leases.acquire("thread", "run", f.cwd);
  f.leases.acquireOutput("thread", "run", output);
  f.leases.markDispatched("run"); f.leases.bind("thread", "run", "turn");
  f.leases.abandon("run");
  expect(f.leases.folders.conflicts(output, "restore")).toHaveLength(1);
  f.leases.markStopRequested("run");
  const restore = f.leases.acquireRestoreWhenStopped("restore", output, { timeoutMs: 1000 });
  f.leases.complete("thread", "turn");
  expect(await restore).toMatchObject({ ok: true });
  expect(f.owners()).toEqual([]);
  f.leases.folders.release("restore");
  expect(f.leases.folders.conflicts(output, "restore")).toEqual([]);
});

it("rolls back output acquisition failures and releases output owners on abandon/disposal", () => {
  const f = fixture(), output = fixture().cwd;
  f.leases.folders.acquireRestore("restore", output);
  f.leases.acquire("thread", "failed", f.cwd);
  expect(() => f.leases.acquireOutput("thread", "failed", output)).toThrow("conflict");
  expect(f.owners()).toEqual([]);
  f.leases.folders.release("restore");
  for (const dispatched of [false, true]) {
    f.leases.acquire("thread", "run", f.cwd); f.leases.acquireOutput("thread", "run", output);
    if (dispatched) { f.leases.markDispatched("run"); f.leases.disposed(["run"]); }
    else f.leases.abandon("run");
    expect(f.owners()).toEqual([]);
    expect(f.leases.folders.conflicts(output, "restore")).toEqual([]);
  }
});

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

it("a confirmed close releases the stopped writer's folder lease and admits a restore at once", async () => {
  const { cwd, leases, owners } = fixture();
  leases.acquire("thread", "generation", cwd);
  leases.markDispatched("generation");
  expect(leases.bind("thread", "generation", "turn")).toBe(true);
  leases.markStopRequested("generation");
  // Unconfirmed: the lease stays and a restore still reports the folder as closing.
  await expect(leases.acquireRestoreWhenStopped("restore:1", cwd, { timeoutMs: 20 })).resolves.toEqual({ ok: false, reason: "still-closing" });
  expect(owners()).toEqual(["generation"]);
  // Confirmed close: the lease goes now, without waiting for a terminal event.
  expect(leases.releaseClosed("generation")).toBe(true);
  expect(owners()).toEqual([]);
  await expect(leases.acquireRestoreWhenStopped("restore:2", cwd, { timeoutMs: 20 })).resolves.toMatchObject({ ok: true });
  expect(leases.releaseClosed("generation")).toBe(false);
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

// FOLLOW2 (STOPRESTORE2 verifier note): the registry throws only its own
// refusals, but a throw of anything else is not a busy folder and must not
// read as one (`code: "conflict"` sent the workspace editor to `bot-writing`
// where its synchronous path answers `root-changed`). It is reported apart,
// with the error, and never waited on.
it("restore admission reports a throw that is not the registry's own refusal as an error, not a conflict", async () => {
  const { cwd, leases } = fixture();
  const exploded = new TypeError("registry exploded");
  // FOLLOW4: every caller folds this into an unusable-path answer, so the
  // throw is logged here, once per event, name and message and no path.
  const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
  const logged = () => warned.mock.calls.map(call => call.map(String).join(" ")).filter(line => line.includes("registry exploded"));
  const acquireRestore = leases.folders.acquireRestore;
  leases.folders.acquireRestore = () => { throw exploded; };
  const started = Date.now();
  await expect(leases.acquireRestoreWhenStopped("restore:1", cwd, { timeoutMs: 5_000 })).resolves.toEqual({ ok: false, reason: "error", error: exploded });
  expect(Date.now() - started).toBeLessThan(1_000);
  expect(logged()).toHaveLength(1);
  expect(logged()[0]).toMatch(/TypeError: registry exploded/);
  expect(logged()[0]).not.toContain(cwd);
  // The same from the conflict check that follows a `conflict` refusal.
  leases.folders.acquireRestore = acquireRestore;
  leases.acquire("thread", "generation", cwd);
  leases.markDispatched("generation");
  leases.folders.conflicts = () => { throw exploded; };
  await expect(leases.acquireRestoreWhenStopped("restore:2", cwd, { timeoutMs: 5_000 })).resolves.toEqual({ ok: false, reason: "error", error: exploded });
  expect(logged()).toHaveLength(2);
  expect(logged()[1]).not.toContain(cwd);
  warned.mockRestore();
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

// TRAINRED-STOPWRITE: an asked Stop holds the folder past the turn's terminal
// event (an unconfirmed stop still ends the turn); only a confirmed close frees it.
it("a turn whose Stop was asked keeps its writer lease past the terminal event until the close is confirmed", () => {
  const f = fixture(), output = fixture().cwd;
  f.leases.acquire("thread", "generation", f.cwd);
  f.leases.acquireOutput("thread", "generation", output);
  f.leases.markDispatched("generation");
  expect(f.leases.bind("thread", "generation", "turn")).toBe(true);
  expect(f.leases.heldByStop("thread", "turn")).toBe(false);
  expect(f.leases.markStopAsked("generation")).toBe(true);
  expect(f.leases.heldByStop("thread", "turn")).toBe(true);
  f.leases.complete("thread", "turn");
  expect(f.owners()).toEqual(["generation"]);
  expect(f.leases.folders.conflicts(output, "restore")).toHaveLength(1);
  // The held turn is still tombstoned: a generation that later names it is refused and released.
  f.leases.acquire("thread", "late-bind", fixture().cwd);
  expect(f.leases.bind("thread", "late-bind", "turn")).toBe(false);
  expect(f.leases.markStopAsked("late-bind")).toBe(false);
  // A Stop on another turn of the thread is not this turn's close.
  f.leases.confirmClosed("thread", "other-turn");
  expect(f.owners()).toEqual(["generation"]);
  f.leases.confirmClosed("thread", "turn");
  expect(f.owners()).toEqual([]);
  expect(f.leases.folders.conflicts(output, "restore")).toEqual([]);
  // A turn nobody stopped is released by its terminal event, as before.
  f.leases.acquire("thread", "next", f.cwd);
  f.leases.markDispatched("next");
  expect(f.leases.bind("thread", "next", "turn-2")).toBe(true);
  f.leases.complete("thread", "turn-2");
  expect(f.owners()).toEqual([]);
  expect(f.leases.markStopAsked("next")).toBe(false);
});

// MurageCloud review of f2e5db5e98: a Stop that reached no live child of the
// turn (it raced the turn's own end, or interruptTurn rejected / found no
// running turn) leaves no proof. The adapter says so (turnChildTracked false)
// and the folder is released at the terminal event, never held on a close
// nobody will report. A Stop that reached a child still waits for its close.
const never = <T>() => new Promise<T>(() => {});
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
function stopHeld() {
  const f = fixture();
  f.leases.acquire("thread", "generation", f.cwd);
  f.leases.markDispatched("generation");
  f.leases.bind("thread", "generation", "turn");
  f.leases.markStopAsked("generation");
  f.leases.complete("thread", "turn");
  expect(f.owners()).toEqual(["generation"]);
  return f;
}
it("a Stop-held lease is released at the terminal event when the adapter holds no child of the turn", async () => {
  const f = stopHeld();
  f.leases.releaseStopHeld("thread", "turn", {
    awaitTurnTeardown: async () => ({ closeConfirmed: false, reason: "stop-failed" }),
    awaitTurnClose: () => never<void>(),
    turnChildTracked: () => false,
  });
  await flush();
  expect(f.owners()).toEqual([]);
});

it("a Stop-held lease whose child is tracked waits for its confirmed close, and is released by it", async () => {
  const f = stopHeld();
  let close!: () => void;
  const tracked: string[] = [];
  f.leases.releaseStopHeld("thread", "turn", {
    awaitTurnTeardown: async () => ({ closeConfirmed: false, reason: "timeout" }),
    awaitTurnClose: () => new Promise<void>(resolve => { close = resolve; }),
    turnChildTracked: (threadId, turnId) => { tracked.push(`${threadId}/${turnId}`); return true; },
  });
  await flush();
  expect(tracked).toEqual(["thread/turn"]);
  expect(f.owners()).toEqual(["generation"]);
  close();
  await flush();
  expect(f.owners()).toEqual([]);
});

it("a Stop-held lease is released by a confirmed teardown, and fails closed when the adapter cannot say", async () => {
  const confirmed = stopHeld();
  confirmed.leases.releaseStopHeld("thread", "turn", {
    awaitTurnTeardown: async () => ({ closeConfirmed: true }), awaitTurnClose: () => never<void>(), turnChildTracked: () => true,
  });
  await flush();
  expect(confirmed.owners()).toEqual([]);
  // An adapter with a teardown receipt but no turnChildTracked keeps the folder until its close.
  const silent = stopHeld();
  silent.leases.releaseStopHeld("thread", "turn", {
    awaitTurnTeardown: async () => ({ closeConfirmed: false, reason: "timeout" }), awaitTurnClose: () => never<void>(),
  });
  await flush();
  expect(silent.owners()).toEqual(["generation"]);
  // No teardown receipt at all: the terminal event is all there is, as before.
  const legacy = stopHeld();
  legacy.leases.releaseStopHeld("thread", "turn", undefined);
  expect(legacy.owners()).toEqual([]);
});

// arev-trainred-stopwrite-n2 H1: a bind that comes after the terminal event
// (late, or repeated by the production accept and dispatch paths) never
// frees a Stop-held writer on the tombstone alone; later generations naming
// the turn are still refused and released.
it("a repeated bind of a Stop-held generation after its terminal event keeps the folder until the close is confirmed", () => {
  const f = stopHeld();
  expect(f.leases.bind("thread", "generation", "turn")).toBe(false);
  expect(f.owners()).toEqual(["generation"]);
  expect(f.leases.heldByStop("thread", "turn")).toBe(true);
  const later = fixture().cwd;
  f.leases.acquire("thread", "later", later);
  expect(f.leases.bind("thread", "later", "turn")).toBe(false);
  expect(f.leases.folders.conflicts(later, "restore")).toEqual([]);
  expect(f.owners()).toEqual(["generation"]);
  f.leases.confirmClosed("thread", "turn");
  expect(f.owners()).toEqual([]);
});

it("a Stop asked before the bind, whose terminal event came first, is released on that engine's evidence at the late bind", async () => {
  const f = fixture();
  f.leases.acquire("thread", "generation", f.cwd);
  f.leases.markDispatched("generation");
  f.leases.markStopAsked("generation");
  let close!: () => void;
  const tracked: string[] = [];
  f.leases.complete("thread", "turn", {
    awaitTurnTeardown: async () => ({ closeConfirmed: false, reason: "timeout" }),
    awaitTurnClose: () => new Promise<void>(resolve => { close = resolve; }),
    turnChildTracked: (threadId, turnId) => { tracked.push(`${threadId}/${turnId}`); return true; },
  });
  expect(f.owners()).toEqual(["generation"]);
  expect(f.leases.bind("thread", "generation", "turn")).toBe(false);
  await flush();
  expect(tracked).toEqual(["thread/turn"]);
  expect(f.owners()).toEqual(["generation"]);
  expect(f.leases.bind("thread", "generation", "turn")).toBe(false);
  await flush();
  expect(tracked).toEqual(["thread/turn"]);
  close();
  await flush();
  expect(f.owners()).toEqual([]);
  // The engine says it held no child of the turn: released at the late bind.
  const none = fixture();
  none.leases.acquire("thread", "generation", none.cwd);
  none.leases.markDispatched("generation");
  none.leases.markStopAsked("generation");
  none.leases.complete("thread", "turn-2", {
    awaitTurnTeardown: async () => ({ closeConfirmed: false, reason: "stop-failed" }), awaitTurnClose: () => never<void>(), turnChildTracked: () => false,
  });
  expect(none.leases.bind("thread", "generation", "turn-2")).toBe(false);
  expect(none.owners()).toEqual([]);
});

it("marking a stop on an unknown or already released generation is a no-op", () => {
  const { cwd, leases } = fixture();
  expect(leases.markStopRequested("nobody")).toBe(false);
  leases.acquire("thread", "generation", cwd);
  leases.abandon("generation");
  expect(leases.markStopRequested("generation")).toBe(false);
});

it("a late writer holds its additional root through Stop until its terminal event", () => {
  const f = fixture(), late = fixture().cwd;
  f.leases.acquire("desk", "generation", f.cwd);
  f.leases.markDispatched("generation"); f.leases.bind("desk", "generation", "turn");
  f.leases.acquireAdditional("desk", "generation", late);
  f.leases.markStopRequested("generation"); f.leases.abandon("generation");
  expect(f.leases.folders.conflicts(late, "restore")).toHaveLength(1);
  f.leases.complete("desk", "turn");
  expect(f.leases.folders.conflicts(late, "restore")).toHaveLength(0);
});

it.each(["claim", "lease"])("rolls back every additional owner on repeated later-root %s contention", refusal => {
  const f = fixture(), first = fixture().cwd, blocked = fixture().cwd;
  f.leases.acquire("thread", "run", f.cwd); f.leases.markDispatched("run"); f.leases.bind("thread", "run", "turn");
  if (refusal === "lease") f.leases.folders.acquireRestore("blocker", blocked);
  const held = new Set<string>();
  for (let attempt = 0; attempt < 5; attempt++) {
    const releases = acquireProjectWriteRoots([first, blocked], root => {
      if (root === blocked && refusal === "claim") return null;
      held.add(root); return () => { held.delete(root); };
    }, root => f.leases.acquireAdditional("thread", "run", root).release);
    expect(releases).toBeNull();
    expect(held.size).toBe(0);
    expect(f.leases.folders.conflicts(first, "restore")).toHaveLength(0);
    expect((f.leases as any).owners.get("run").additionalOwnerIds).toHaveLength(0);
  }
  f.leases.folders.release("blocker");
  f.leases.acquireAdditional("thread", "run", first);
  f.leases.markStopRequested("run");
  expect(f.leases.folders.conflicts(first, "restore")).toHaveLength(1);
  f.leases.complete("thread", "turn");
  expect(f.leases.folders.conflicts(first, "restore")).toHaveLength(0);
});

it("a Stop-asked turn keeps its writer lease through its terminal event until the engine confirms the close", () => {
  const f = fixture();
  f.leases.acquire("thread", "run", f.cwd);
  f.leases.markDispatched("run"); f.leases.bind("thread", "run", "turn");
  f.leases.markStopAsked("run", "engine");
  // An unconfirmed Stop still settles the turn: that terminal is not a close receipt.
  expect(f.leases.complete("thread", "turn")).toEqual({ heldFor: "engine", generation: "run" });
  expect(f.owners()).toEqual(["run"]);
  expect(() => f.leases.folders.acquireRestore("editor", f.cwd)).toThrow("conflict");
  // A close receipt for another turn of the thread releases nothing.
  f.leases.confirmClosed("thread", "other-turn");
  expect(f.owners()).toEqual(["run"]);
  f.leases.confirmClosed("thread", "turn");
  expect(f.owners()).toEqual([]);
});

it("a turn no Stop was asked of still releases on its terminal event, and disposal releases a Stop-asked one", () => {
  const f = fixture(), other = fixture();
  f.leases.acquire("thread", "run", f.cwd);
  f.leases.markDispatched("run"); f.leases.bind("thread", "run", "turn");
  expect(f.leases.complete("thread", "turn")).toBeUndefined();
  expect(f.owners()).toEqual([]);
  other.leases.acquire("thread", "run", other.cwd);
  other.leases.markDispatched("run"); other.leases.bind("thread", "run", "turn");
  other.leases.markStopAsked("run", "engine");
  expect(other.leases.complete("thread", "turn")).toEqual({ heldFor: "engine", generation: "run" });
  other.leases.disposed(other.leases.generations());
  expect(other.owners()).toEqual([]);
});

it("a held Stop-asked turn still leaves its completion tombstone, and its own repeated bind does not release it", () => {
  const f = fixture(), later = fixture();
  f.leases.acquire("thread", "run", f.cwd);
  f.leases.markDispatched("run"); f.leases.bind("thread", "run", "turn");
  f.leases.markStopAsked("run", "engine");
  expect(f.leases.complete("thread", "turn")).toEqual({ heldFor: "engine", generation: "run" });
  // The dispatch's own answer binds the same turn again after its terminal event.
  expect(f.leases.bind("thread", "run", "turn")).toBe(true);
  expect(f.owners()).toEqual(["run"]);
  // The tombstone: a later generation naming the completed turn is refused and released.
  f.leases.acquire("thread", "later", later.cwd); f.leases.markDispatched("later");
  expect(f.leases.bind("thread", "later", "turn")).toBe(false);
  expect(f.leases.folders.conflicts(later.cwd, "restore")).toEqual([]);
  expect(f.owners()).toEqual(["run"]);
});

it("a held turn whose engine did not confirm its close refuses a writer as close-unconfirmed; a live writer is a plain conflict", async () => {
  const f = fixture();
  f.leases.acquire("thread", "run", f.cwd);
  f.leases.markDispatched("run"); f.leases.bind("thread", "run", "turn");
  expect(await f.leases.acquireRestoreWhenStopped("editor", f.cwd, { timeoutMs: 0 })).toEqual({ ok: false, reason: "conflict", code: "conflict" });
  f.leases.markStopAsked("run", "engine");
  f.leases.complete("thread", "turn");
  f.leases.markCloseUnconfirmed("thread", "turn");
  expect(await f.leases.acquireRestoreWhenStopped("editor", f.cwd, { timeoutMs: 0 })).toEqual({ ok: false, reason: "conflict", code: "conflict", closeUnconfirmed: true });
  expect(f.owners()).toEqual(["run"]);
  f.leases.confirmClosed("thread", "turn");
  expect(await f.leases.acquireRestoreWhenStopped("editor", f.cwd, { timeoutMs: 0 })).toMatchObject({ ok: true });
});

// Integration consumer: both provider hint contracts must agree on which exact close can release the folder.
it.each([false, true])("server Stop-held release reads the new child hint and retains an explicitly unknown old hint: %s", async unknown => {
  const f = fixture();
  f.leases.acquire("thread", "generation", f.cwd);
  f.leases.bind("thread", "generation", "turn");
  f.leases.markStopAsked("generation", "engine");
  const held = f.leases.complete("thread", "turn")!;
  let answered!: () => void;
  const stop = new Promise<void>(resolve => { answered = resolve; });
  const adapter = { turnChildTracked: vi.fn(() => false),
    ...(unknown ? { knowsTurnClose: () => undefined } : {}),
    awaitTurnTeardown: vi.fn(() => new Promise<void>(() => {})), awaitTurnClose: () => new Promise<void>(() => {}) };
  const release = wiring(["releaseStopAskedLeaseOnClose"], {
    registry: new Map([["engine", { adapter }]]), projectTurnLeases: f.leases,
    stopAskedInterrupts: new Map([["generation", stop]]),
  }).releaseStopAskedLeaseOnClose;
  release("thread", "turn", held);
  await Promise.resolve();
  expect(f.owners()).toEqual(["generation"]);
  answered();
  await Promise.resolve(); await Promise.resolve();
  expect(f.owners()).toEqual(unknown ? ["generation"] : []);
  expect(adapter.turnChildTracked).toHaveBeenCalledTimes(unknown ? 0 : 1);
});
