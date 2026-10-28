// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Sentinel producer hooks (GAP-SENTINEL-109 4.1, 4.2, 5 and 7): turn outcomes through the bus and the dispatch hooks
// (S06, S07, S08), deletion obligations (S04, S05), pending revocation figures for the sealed stats, and front-matter
// fallbacks (S09). Every hook is observe-only and O(1); raw thread, message, instance and file names never reach a
// counter, a fact or a human line.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDbStatsRow, type TurnWindowFact } from "../../shared/health-protocol.mjs";
import type { RuntimeEvent } from "../contracts.ts";
import { declaredName } from "../drivers/claude.ts";
import { EventBus } from "../harness/bus.ts";
import { ensureDirs } from "../config.ts";
import { clearResetWatch, noteContinuationReset } from "../memory/reset-watch.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { DELETION_RESEND_MS, DELETION_ZERO_RESENDS, deletionEngineKind, holderOfReason, observeDeletionAttempt, observeDeletionCompleted, observeDeletionEvent, observeDeletionJournal, resetDeletionObserverForTests } from "./deletion-observer.ts";
import { healthEngineKind } from "./engine-kind.ts";
import { observeIsolationScan } from "./isolation-observer.ts";
import {
  PENDING_REVOCATION_TIMES, noteRevocationJobCreated, noteRevocationJobEnded, noteRevocationQueueEmpty, pendingRevocationFigures, resetPendingRevocationsForTests,
  withPendingRevocations,
} from "./pending-revocations.ts";
import { observationRows } from "./stats-publisher.ts";
import { deriveStableToken } from "./counters.ts";
import { drainServerWindows, factsOf, freshServerCounters, total } from "./test-support.ts";
import { LEARNING_THREAD_PREFIX, resetTurnObserverForTests, turnAccepted, turnExhausted, turnObserverSize, turnRefused } from "./turn-observer.ts";
import { MEMORY_LEARNING_THREAD_PREFIX } from "../drivers/cli-memory-learning.ts";

let now = Date.parse("2026-10-27T10:00:00Z");
beforeEach(() => {
  ensureDirs();
  freshServerCounters();
  resetTurnObserverForTests(() => now);
  resetDeletionObserverForTests();
  resetPendingRevocationsForTests();
  clearResetWatch();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

const THREAD = "PRIVATE-THREAD-1";
const MESSAGE = "PRIVATE-MESSAGE-1";
const completed = (threadId = THREAD, over: Record<string, unknown> = {}) =>
  ({ eventId: "e", provider: "claudeAgent", providerInstanceId: "PRIVATE-INSTANCE", threadId, createdAt: "now", type: "turn.completed", ok: true, ...over }) as unknown as RuntimeEvent;
const turnFacts = (windows: ReturnType<typeof drainServerWindows>) => factsOf(windows, "turn-window") as TurnWindowFact[];
const privateFree = (value: unknown) => {
  const text = JSON.stringify([value, vi.mocked(console.info).mock.calls, vi.mocked(console.warn).mock.calls]);
  for (const secret of ["PRIVATE-THREAD", "PRIVATE-MESSAGE", "PRIVATE-INSTANCE", "PRIVATE-HOME", "PRIVATE-FILE"]) expect(text).not.toContain(secret);
};

describe("engine categories", () => {
  it.each([
    ["claudeAgent", "claude"], ["codex", "codex"], ["piAgent", "pi"], ["antigravityAgent", "antigravity"], ["opencodeGo", "opencode-go"],
    ["openai-compat", "openai-chat"], ["grok", "openai-chat"], ["hermesAgent", "acp"], ["fuigoAgent", "acp"], ["a-new-engine", "other"], ["", "other"],
  ])("%s reports as %s", (driver, kind) => expect(healthEngineKind(driver)).toBe(kind));
  it("hidden learning sessions use the learning driver's own thread prefix", () => expect(LEARNING_THREAD_PREFIX).toBe(MEMORY_LEARNING_THREAD_PREFIX));
});

describe("turn outcomes", () => {
  it("every engine's terminal turn on the bus is one completed or cancelled final; a failure, or a hidden learning session, is none", () => {
    const bus = new EventBus(() => undefined);
    bus.publish(completed(THREAD));
    bus.publish(completed("PRIVATE-THREAD-2", { provider: "codex", stopReason: "cancelled" }));
    bus.publish(completed("PRIVATE-THREAD-3", { provider: "piAgent", ok: false, stopReason: "PRIVATE-ERROR" }));
    bus.publish(completed(`${LEARNING_THREAD_PREFIX}x`));
    const windows = drainServerWindows();
    expect(turnFacts(windows)).toEqual([]); // plain ends travel as counter rows, keyed by the thread's scope token
    expect(total(windows, "dispatch-exhausted", "completed", { engineKind: "claude" })).toBe(1);
    const keyed = windows.flatMap(w => w.counters).filter(row => row.detector === "dispatch-exhausted" && row.code === "completed");
    expect(keyed).toEqual([expect.objectContaining({ engineKind: "claude", sourceKey: deriveStableToken("scope", THREAD) })]);
    expect(total(windows, "dispatch-exhausted", "cancelled", { engineKind: "codex" })).toBe(1);
    expect(turnObserverSize()).toBe(0);
    privateFree(windows);
  });

  it("refusals, the rebuild's duration and the recovery are one turn; its refused dispatch's own terminal event does not end it", () => {
    turnAccepted(THREAD, MESSAGE, "claudeAgent");
    turnRefused(THREAD, MESSAGE, "claudeAgent");
    new EventBus(() => undefined).publish(completed(THREAD)); // the refused dispatch settles: the turn waits for its rebuild
    now += 5_000;
    turnRefused(THREAD, MESSAGE, "claudeAgent"); // a second refusal during the same rebuild keeps the first refusal's start
    turnAccepted(THREAD, MESSAGE, "claudeAgent");
    new EventBus(() => undefined).publish(completed(THREAD));
    const windows = drainServerWindows();
    const facts = turnFacts(windows);
    expect(new Set(facts.map(fact => fact.turnToken)).size).toBe(1);
    expect(facts).toEqual([expect.objectContaining({ engineKind: "claude", refusalDelta: 2, rebuildMsDelta: 5_000, final: "completed" })]);
    expect(total(windows, "send-fence", "refusal")).toBe(2);
    expect(total(windows, "send-fence", "rebuild")).toBe(1);
    expect(total(windows, "send-fence", "recovered")).toBe(1);
    privateFree(windows);
  });

  it("an exhausted turn counts once however many refusals it logged, and a later terminal event does not end it again", () => {
    for (let i = 0; i < 4; i++) turnRefused(THREAD, MESSAGE, "codex");
    turnExhausted(THREAD, MESSAGE, "codex");
    new EventBus(() => undefined).publish(completed(THREAD, { provider: "codex", ok: false }));
    const windows = drainServerWindows();
    const finals = turnFacts(windows).filter(fact => fact.final !== null);
    expect(finals).toEqual([expect.objectContaining({ engineKind: "codex", final: "exhausted", refusalDelta: 4 })]);
    expect(total(windows, "dispatch-exhausted", "exhausted", { engineKind: "codex" })).toBe(1);
  });

  it("automatic continuation resets reach the turn's opaque scope with a closed reason; the reset watch keeps its own line", () => {
    new EventBus(() => undefined).publish({ ...completed("other-thread"), type: "turn.started" } as RuntimeEvent); // learns PRIVATE-INSTANCE is claude
    for (let i = 0; i < 4; i++) noteContinuationReset(THREAD, "PRIVATE-INSTANCE", i === 0 ? "steer-refused session-invalid" : "memory-changed (receipt-already-revoked)", now + i);
    const windows = drainServerWindows();
    const facts = turnFacts(windows);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ engineKind: "claude", resetDelta: 4, final: null });
    expect(total(windows, "resets", "send-fence", { engineKind: "claude" })).toBe(1);
    expect(total(windows, "resets", "history-rebuild", { engineKind: "claude" })).toBe(3);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("memory continuation reset loop"));
    expect(JSON.stringify(windows)).not.toContain("PRIVATE");
  });
});

describe("deletion obligations", () => {
  const entry = (createdAt: number, ...engines: string[]) => ({ createdAt, engineHomes: engines.map(engine => ({ engine, home: "/PRIVATE-HOME" })) });
  it("the persisted list gives pending count and oldest time per engine kind, once per change", () => {
    observeDeletionJournal([entry(now - 3_000, "claude"), entry(now - 1_000, "claude", "codex"), entry(now - 2_000)], now);
    observeDeletionJournal([entry(now - 3_000, "claude"), entry(now - 1_000, "claude", "codex"), entry(now - 2_000)], now); // unchanged: no fact
    const windows = drainServerWindows();
    const facts = factsOf(windows, "obligation");
    expect(facts.map(fact => [fact.engineKind, fact.pendingCount, fact.oldestPendingAt])).toEqual([["claude", 2, now - 3_000], ["codex", 1, now - 1_000], ["none", 1, now - 2_000]]);
    for (const fact of facts) expect(fact).toMatchObject({ code: "deletion", holderState: "unknown", failedAttemptsAfterClear: 0, completedDelta: 0 });
    observeDeletionJournal([entry(now - 1_000, "claude")], now);
    expect(factsOf(drainServerWindows(), "obligation").map(fact => [fact.engineKind, fact.pendingCount, fact.oldestPendingAt])).toEqual([["claude", 1, now - 1_000], ["codex", 0, null], ["none", 0, null]]);
  });

  it(`an unchanged summary goes out again every ${DELETION_RESEND_MS / 60_000} min while pending, and zero pending ${DELETION_ZERO_RESENDS} more times`, () => {
    const list = [entry(now - 5_000, "claude")];
    const claude = () => factsOf(drainServerWindows(), "obligation").filter(fact => fact.engineKind === "claude");
    observeDeletionJournal(list, now);
    expect(claude()).toHaveLength(1);
    observeDeletionJournal(list, now + DELETION_RESEND_MS - 1);
    expect(claude()).toHaveLength(0);
    observeDeletionJournal(list, now + DELETION_RESEND_MS);
    expect(claude().map(fact => fact.pendingCount)).toEqual([1]);
    const done = now + 2 * DELETION_RESEND_MS;
    observeDeletionJournal([], done);
    expect(claude().map(fact => fact.pendingCount)).toEqual([0]);
    const resent: number[] = [];
    for (let k = 1; k <= DELETION_ZERO_RESENDS + 2; k++) {
      observeDeletionJournal([], done + k * DELETION_RESEND_MS);
      resent.push(claude().length);
    }
    expect(resent).toEqual([...Array(DELETION_ZERO_RESENDS).fill(1), 0, 0]);
  });

  it("holder state per engine from the attempt's reasons; failed attempts after clearance count, a hold resets them", () => {
    observeDeletionJournal([entry(now - 60_000, "claude")], now);
    const key = "claude\0/PRIVATE-HOME";
    observeDeletionAttempt([key], { [key]: "engine-open" }, now);
    observeDeletionAttempt([key], { [key]: "EIO" }, now + 1_000);
    observeDeletionAttempt([key], { [key]: "EIO" }, now + 200_000);
    const facts = factsOf(drainServerWindows(), "obligation").filter(fact => fact.engineKind === "claude");
    expect(facts.map(fact => [fact.holderState, fact.holderClearAt ?? null, fact.failedAttemptsAfterClear])).toEqual([
      ["unknown", null, 0], ["held", null, 0], ["clear", now + 1_000, 1], ["clear", now + 1_000, 2],
    ]);
    observeDeletionAttempt([key], { [key]: "engine-unchecked" }, now + 300_000);
    expect(factsOf(drainServerWindows(), "obligation")).toEqual([expect.objectContaining({ holderState: "unknown", failedAttemptsAfterClear: 0 })]);
    expect(holderOfReason("engine-running")).toBe("held");
  });

  it("only a reason from past the holder check proves clear; an unchecked, helper or unknown reason is unknown", () => {
    for (const reason of ["engine-open", "held", "engine-running", "busy", "locked", "EBUSY", "locked by its engine (codex)"]) expect(holderOfReason(reason)).toBe("held");
    for (const reason of ["changed", "EIO", "EACCES", "ENOENT"]) expect(holderOfReason(reason)).toBe("clear");
    for (const reason of ["engine-unchecked", "helper-unloadable", "helper", "worker-unavailable", "aside", "unreadable", "other", "", undefined, "Eio"]) expect(holderOfReason(reason)).toBe("unknown");
    // A helper that will not load never accumulates clearance or failures after it.
    observeDeletionJournal([entry(now - 60_000, "claude")], now);
    const key = "claude\0/PRIVATE-HOME";
    observeDeletionAttempt([key], { [key]: "helper-unloadable" }, now + 1_000);
    observeDeletionAttempt([key], { [key]: "helper-unloadable" }, now + 200_000);
    const facts = factsOf(drainServerWindows(), "obligation").filter(fact => fact.engineKind === "claude");
    expect(facts.length).toBeGreaterThan(0);
    expect(facts.every(fact => fact.holderState === "unknown" && fact.failedAttemptsAfterClear === 0)).toBe(true);
  });

  it("completion: the final removal reports completedDelta and the exact human line, without any id or path", () => {
    const pending = entry(now - 42_000, "codex", "gemini");
    observeDeletionEvent("pending", pending);
    observeDeletionEvent("retry", pending);
    observeDeletionJournal([], now);
    observeDeletionCompleted(pending, now);
    const windows = drainServerWindows();
    expect(total(windows, "deletion", "pending", { engineKind: "codex" })).toBe(1);
    expect(total(windows, "deletion", "retry", { engineKind: "acp" })).toBe(1);
    expect(total(windows, "deletion", "completed", { engineKind: "codex" })).toBe(1);
    expect(factsOf(windows, "obligation")).toContainEqual(expect.objectContaining({ engineKind: "codex", pendingCount: 0, completedDelta: 1 }));
    const lines = vi.mocked(console.info).mock.calls.map(call => String(call[0]));
    expect(lines).toEqual(["deletion outcome result=completed engine=codex elapsedMs=42000", "deletion outcome result=completed engine=acp elapsedMs=42000"]);
    expect(deletionEngineKind("grok")).toBe("other");
    privateFree(windows);
  });
});

describe("pending revocation figures", () => {
  it("unknown (NULL, never zero) until the runner's next-job read finds the queue empty; then maintained oldest first", () => {
    noteRevocationJobCreated(now - 10);
    expect(pendingRevocationFigures()).toEqual({ pending_revocations: null, oldest_pending_at: null });
    noteRevocationQueueEmpty();
    expect(pendingRevocationFigures()).toEqual({ pending_revocations: 0, oldest_pending_at: null });
    noteRevocationJobCreated(now); noteRevocationJobCreated(now + 5); noteRevocationJobCreated(now + 9);
    expect(pendingRevocationFigures()).toEqual({ pending_revocations: 3, oldest_pending_at: now });
    noteRevocationJobEnded();
    expect(pendingRevocationFigures()).toEqual({ pending_revocations: 2, oldest_pending_at: now + 5 });
    noteRevocationJobEnded(); noteRevocationJobEnded(); noteRevocationJobEnded();
    expect(pendingRevocationFigures()).toEqual({ pending_revocations: 0, oldest_pending_at: null });
  });

  it(`keeps the exact count past ${PENDING_REVOCATION_TIMES} jobs; the oldest time stays the head's, then unknown`, () => {
    noteRevocationQueueEmpty();
    for (let i = 0; i <= PENDING_REVOCATION_TIMES; i++) noteRevocationJobCreated(now + i);
    expect(pendingRevocationFigures()).toEqual({ pending_revocations: PENDING_REVOCATION_TIMES + 1, oldest_pending_at: now });
    for (let i = 0; i < PENDING_REVOCATION_TIMES; i++) noteRevocationJobEnded();
    expect(pendingRevocationFigures()).toEqual({ pending_revocations: 1, oldest_pending_at: null });
  });

  it("fills the messages row of a stats observation only where the caller has no figure, and stays NULL when unknown", () => {
    const observation = { at: now, rows: [{ role: "messages" as const, page_size: 4096 }, { role: "memory" as const }] };
    const unknown = observationRows(withPendingRevocations(observation)).rows;
    expect(unknown[0]).toMatchObject({ pending_revocations: null, oldest_pending_at: null });
    noteRevocationQueueEmpty(); noteRevocationJobCreated(now - 7);
    const known = observationRows(withPendingRevocations(observation)).rows;
    expect(known[0]).toMatchObject({ role: "messages", pending_revocations: 1, oldest_pending_at: now - 7 });
    expect(known[1]).toMatchObject({ role: "memory", pending_revocations: null });
    for (const row of known) expect(parseDbStatsRow(row).ok).toBe(true);
    const own = observationRows(withPendingRevocations({ at: now, rows: [{ role: "messages", pending_revocations: 9, oldest_pending_at: now - 1 }] })).rows;
    expect(own[0]).toMatchObject({ pending_revocations: 9, oldest_pending_at: now - 1 });
  });
});

describe("front-matter fallback", () => {
  let dir = "";
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "murage-fm-")); });
  afterEach(() => removeTempDirSync(dir));
  const file = (name: string, text: string) => { const path = join(dir, name); writeFileSync(path, text); return path; };

  it("each fallback to the file name counts by fixed code; one launch's scan is one isolation fact with its count", () => {
    const names = observeIsolationScan("claude", () => [
      declaredName(file("PRIVATE-FILE-a.md", "no front matter here")),
      declaredName(file("PRIVATE-FILE-b.md", "---\nname: [unclosed\n---\n")),
      declaredName(file("PRIVATE-FILE-c.md", "---\ndescription: x\n---\n")),
      declaredName(file("PRIVATE-FILE-d.md", `---\n${"x: y\n".repeat(20_000)}`)),
      declaredName(join(dir, "PRIVATE-FILE-missing.md")),
      declaredName(file("PRIVATE-FILE-e.md", "---\nname: helper\n---\n")),
    ]);
    expect(names).toEqual([undefined, undefined, undefined, undefined, undefined, "helper"]); // the decision is unchanged
    const windows = drainServerWindows();
    for (const code of ["no-front-matter", "parse-error", "missing-name", "too-large", "unreadable"]) expect(total(windows, "isolation-noise", code, { engineKind: "claude" })).toBe(1);
    expect(total(windows, "isolation-noise", "scan-completed")).toBe(1);
    expect(factsOf(windows, "isolation")).toEqual([expect.objectContaining({ engineKind: "claude", completedScan: true, fallbackDelta: 5 })]);
    expect(JSON.stringify(windows)).not.toContain("PRIVATE"); // the existing isolation notices name files; health never does
  });

  it("every scan of one engine in this process reports under one launch token; another engine has its own", () => {
    observeIsolationScan("claude", () => undefined);
    observeIsolationScan("claude", () => undefined);
    observeIsolationScan("codex", () => undefined);
    const facts = factsOf(drainServerWindows(), "isolation");
    expect(facts).toHaveLength(3);
    expect(facts[0]!.launchToken).toBe(facts[1]!.launchToken);
    expect(facts[2]!.launchToken).not.toBe(facts[0]!.launchToken);
  });

  it("a scan that throws is reported as not completed and the error goes on unchanged", () => {
    expect(() => observeIsolationScan("claude", () => { throw new Error("scan failed"); })).toThrow("scan failed");
    expect(factsOf(drainServerWindows(), "isolation")).toEqual([expect.objectContaining({ completedScan: false, fallbackDelta: 0 })]);
  });
});
