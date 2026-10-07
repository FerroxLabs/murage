// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, readFileSync } from "node:fs";
import ts from "typescript";
import { createProjectGoal } from "./project-goals.ts";
import { continuationResults, listRoomRequests, cancelRoomRequest } from "./room-requests.ts";
import { continuationResultsPrompt } from "./project-prompt.ts";
import { DATA_DIR } from "./config.ts";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { initializeProjectTables } from "./project-tables.ts";
import { createProjectCard, enqueueCardRun, applyCardRunFinished, assignCardReview, applyReviewVerdict, latestReviewVerdict, reassignProjectCard, retryProjectCard, applyCardWaiting, acceptProjectCard } from "./project-cards.ts";
import { projectCardById, projectSettingsFor } from "./project-records.ts";
import { roomRequest, enterOwnerWait, reconcileRoomRequestsAtBoot, completeRequest, insertRoomRequest, type RoomRequest } from "./room-requests.ts";
import { requestReturnsTo } from "./partition-sources.ts";
import { requestSourceThread } from "./execution-audience.ts";
import { applyCardRunEffect, cardGenerationCurrent, leadNextStep, projectTableExists } from "./project-turn-engine.ts";
import { WriterRootClaims } from "./writer-roots.ts";
import { createWorkAdmission, type AdmissionInput } from "./work-admission.ts";
import { handleProjectRouteWithInterrupt, applyProjectChangeWithInterrupt } from "./project-routes.ts";
import { BUDGET_STOPPED, createProjectCardExecutor, STOPPED_BY_YOU } from "./project-card-executor.ts";

const cleanups: Array<() => void> = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(10000); });
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.useRealTimers(); });
function fixture() {
  mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(":memory:"); initializeProjectTables(db);
  for (const group of ["g", "h"]) db.prepare("INSERT INTO project_settings(group_id,mode,lead_bot_id,updated_at) VALUES(?,'ongoing','lead',1)").run(group);
  const rootReleases: string[] = [];
  const writers = new WriterRootClaims();
  const roots = new Set<string>(); let parallel = 3; let flag = true; let open = true; let ready = true;
  const context = (groupId = "g") => ({ groupId, isProject: true, closed: false, runState: "running" as const, mode: "ongoing" as const, leadBotId: "lead", boardOn: true, parallelCards: flag ? parallel : 1 });
  const admission = createWorkAdmission({ restoreReview: () => false, flags: () => ({ autonomy: true, budgets: true }), threadRunning: () => false,
    speakingInRoom: () => false, directThreads: () => 0, maxThreads: 3, installCardCap: 4, rootCounters: () => ({ wakes: 0, workMs: 0 }),
    askWouldDeadlock: () => false, reachable: () => true, dependencyOpen: () => false,
    claimWriterRoot: (root, owner, previous) => {
      const release = writers.claim(root, owner, previous); if (!release) return null;
      roots.add(root.canonicalPath);
      return () => { if (writers.holder(root) !== owner) return; release(); rootReleases.push(root.canonicalPath); roots.delete(root.canonicalPath); };
    }, now: Date.now });
  admission.setBudgetGate({ check: () => ({ ok: true }) });
  const members = ["lead", "a", "b", "c", "d", "e", "reviewer"];
  // Exercise the server's actual stopped-card effect, including its E2a override.
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const begin = source.indexOf("  cardEffect: (db, request) => {");
  const end = source.indexOf("\n  // lane R", begin);
  expect(begin).toBeGreaterThan(0); expect(end).toBeGreaterThan(begin);
  const effect = new Function("applyCardWaiting", "applyCardRunEffect", "store", "STOPPED_BY_YOU", "BUDGET_STOPPED", ts.transpileModule(`return ({${source.slice(begin, end)}}).cardEffect;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(applyCardWaiting, applyCardRunEffect, { group: () => ({ memberIds: members }) }, STOPPED_BY_YOU, BUDGET_STOPPED);
  const hooks = { cardGenerationCurrent, cardEffect: effect, returnThread: () => "room", restartCards: vi.fn() };
  const starts: Array<{ id: string; at: number; retry: boolean }> = [];
  const writer = new Map<string, string>();
  const executor = createProjectCardExecutor({ db: () => db, admission, now: Date.now, open: () => open, context: r => context(r.groupId), usable: () => true,
    desk: r => `${r.groupId}-${r.toBotId}`, writerRoot: r => writer.has(r.workItemId!) ? { canonicalPath: writer.get(r.workItemId!)!, dev: "1", ino: writer.get(r.workItemId!)! } : undefined,
    start: (r, _claim, retry) => starts.push({ id: r.id, at: Date.now(), retry: Boolean(retry) }), hooks, changed: vi.fn(), wake: () => { if (ready) executor.pump(); } });
  cleanups.push(() => { executor.stop?.(); for (const claim of admission.liveTurns({})) claim.release(); db.close(); });
  let serial = 0;
  function card(bot: string, groupId = "g", root?: string) {
    const made = createProjectCard(db, { groupId, title: `Card ${++serial}`, assigneeBotId: bot, actor: { kind: "owner", lineage: { origin: "desktop", rootThreadId: "room", audienceFingerprint: "owner" } }, memberIds: members, now: Date.now() + serial });
    if (!made.ok) throw new Error(made.reason);
    const queued = enqueueCardRun(db, { cardId: made.card.id, actor: { kind: "owner", lineage: { origin: "desktop", rootThreadId: "room", audienceFingerprint: "owner" } }, now: Date.now() + serial });
    if (!queued.ok) throw new Error(queued.reason);
    if (root) writer.set(made.card.id, root);
    return { id: made.card.id, requestId: queued.requestId };
  }
  return { db, admission, executor, starts, card, hooks, roots, rootReleases, context, writer, setFlag: (value: boolean) => { flag = value; }, setOpen: (value: boolean) => { open = value; }, setReady: (value: boolean) => { ready = value; }, setParallel: (n: number) => { parallel = n; } };
}
it("starts three overlapping cards two seconds apart, then admits the fourth on completion", () => {
  const f = fixture(); const cards = ["a", "b", "c", "d"].map(bot => f.card(bot));
  f.executor.pump(); for (let i = 0; i < 10; i++) f.executor.pump();
  expect(vi.getTimerCount()).toBe(1);
  vi.advanceTimersByTime(4000);
  expect(f.starts.map(s => s.at)).toEqual([10000, 12000, 14000]);
  expect(f.admission.liveTurns({ groupId: "g" })).toHaveLength(3);
  expect(roomRequest(f.db, cards[3].requestId)).toMatchObject({ state: "queued", refusal: "project_card_cap" });
  vi.advanceTimersByTime(2000); f.executor.finish(cards[0].requestId, { ok: true });
  expect(f.starts).toHaveLength(4);
});
it("caps the install at four across projects, and does not interrupt existing cards when serial is selected", () => {
  const f = fixture(); const cards = [f.card("a"), f.card("b"), f.card("c"), f.card("d", "h"), f.card("e", "h")];
  f.executor.pump(); vi.advanceTimersByTime(8000);
  expect(f.starts).toHaveLength(4); expect(roomRequest(f.db, cards[4].requestId)?.refusal).toBe("install_card_cap");
  f.setParallel(1); f.executor.pump(); expect(f.admission.liveTurns({ groupId: "g" })).toHaveLength(3);
  f.executor.finish(cards[0].requestId, { ok: true }); expect(f.starts).toHaveLength(4);
  f.executor.finish(cards[3].requestId, { ok: true }); expect(f.starts).toHaveLength(5);
});
it("serializes writers on one root while other roots and research overlap", () => {
  const f = fixture(); f.setParallel(5);
  const a = f.card("a", "g", "/one"), b = f.card("b", "g", "/one"); f.card("c", "g", "/two"); f.card("d");
  f.executor.pump(); vi.advanceTimersByTime(6000);
  expect(f.starts).toHaveLength(3); expect(roomRequest(f.db, b.requestId)?.refusal).toBe("writer_root_busy");
  f.executor.finish(a.requestId, { ok: true }); expect(f.starts).toHaveLength(4); expect(f.roots.has("/one")).toBe(true);
});
it("keeps owner waits claimed while a lead wake and a review are admitted without card slots", () => {
  const f = fixture(); const cards = ["lead", "b", "c"].map(bot => f.card(bot)); f.executor.pump(); vi.advanceTimersByTime(4000);
  for (const card of cards) enterOwnerWait(f.db, card.requestId, Date.now());
  const extra = f.card("d"); f.executor.pump(); expect(roomRequest(f.db, extra.requestId)?.refusal).toBe("project_card_cap");
  const input: AdmissionInput = { kind: "wake", priority: "coordinator", botId: "lead", threadId: "room-lead", project: f.context(), ownerOrigin: false, audience: { ownerAudience: true, fingerprint: "owner" }, now: Date.now() };
  expect(f.admission.admit(input).admit).toBe(true);
  expect(f.admission.admit({ ...input, kind: "review", botId: "reviewer", threadId: "review-desk" }).admit).toBe(true);
  expect(f.admission.liveTurns({}).filter(c => c.kind === "card_run")).toHaveLength(3);
  expect(f.admission.admit({ ...input, kind: "review", threadId: "another-desk" })).toMatchObject({ admit: false, reason: "bot_card_in_project" });
  expect(f.admission.admit({ ...input, kind: "lead_turn", threadId: "third" }).admit).toBe(false);
  expect(f.admission.admit({ ...input, kind: "owner_direct", priority: "owner", ownerOrigin: true, threadId: "owner" }).admit).toBe(true);
});
it("admits a newer queued review before a card for the same freed bot", () => {
  const f = fixture(), a = f.card("a"); f.executor.pump();
  applyCardRunFinished(f.db, { cardId: a.id, requestId: a.requestId, reviewApplies: true, now: Date.now() });
  f.executor.finish(a.requestId, { ok: true });
  const busy = f.card("b"); vi.advanceTimersByTime(2000); f.executor.pump();
  const queued = f.card("b");
  const review = assignCardReview(f.db, { cardId: a.id, reviewerBotId: "b", leadBotId: "lead", memberIds: ["lead", "a", "b"], now: Date.now() + 100 });
  if (!review.ok) throw new Error(review.reason);
  f.executor.pump(); f.executor.finish(busy.requestId, { ok: true });
  expect(roomRequest(f.db, review.requestId)?.state).toBe("running"); expect(roomRequest(f.db, queued.requestId)?.state).toBe("queued");
});
it("retries only a rate-limited start, preserves identity, and keeps its writer reservation", () => {
  const f = fixture(), a = f.card("a", "g", "/one"); f.executor.pump();
  const before = projectCardById(f.db, a.id)!;
  expect(f.executor.retryStart(a.requestId, new Error("429 too many requests"), false)).toBe(true);
  expect(f.roots.size).toBe(1); expect(roomRequest(f.db, a.requestId)).toMatchObject({ state: "queued", refusal: "stagger" });
  expect(projectCardById(f.db, a.id)).toMatchObject({ state: "doing", generation: before.generation, attempt: before.attempt });
  vi.advanceTimersByTime(4999); expect(f.starts).toHaveLength(1);
  vi.advanceTimersByTime(1); expect(f.starts).toHaveLength(2); expect(f.starts[1].retry).toBe(true); expect(f.roots.size).toBe(1);
  expect(projectCardById(f.db, a.id)).toMatchObject({ generation: before.generation, attempt: before.attempt });
  expect(f.executor.retryStart(a.requestId, new Error("429"), true)).toBe(false);
  f.executor.finish(a.requestId, { ok: false }); expect(projectCardById(f.db, a.id)?.failures).toBe(1);
});
it("bounds backoff to four retries and cancels its single timer on shutdown", () => {
  const f = fixture(), a = f.card("a"); f.executor.pump();
  for (const delay of [5000, 15000, 45000, 120000]) {
    expect(f.executor.retryStart(a.requestId, new Error("rate limit"), false)).toBe(true);
    f.executor.pump(); expect(vi.getTimerCount()).toBe(1); vi.advanceTimersByTime(delay);
  }
  expect(f.starts).toHaveLength(5); expect(f.executor.retryStart(a.requestId, new Error("429"), false)).toBe(false);
  f.executor.finish(a.requestId, { ok: false }); f.card("b"); f.executor.pump(); expect(vi.getTimerCount()).toBe(1);
  f.executor.stop?.(); expect(vi.getTimerCount()).toBe(0); vi.advanceTimersByTime(10000); expect(f.starts).toHaveLength(5);
});
it.each(["stop", "reassign", "restart"])("never replays a rate-limited start after %s during backoff", action => {
  const f = fixture(), a = f.card("a"); f.executor.pump(); expect(f.executor.retryStart(a.requestId, new Error("429"), false)).toBe(true);
  if (action === "stop") completeRequest(f.db, a.requestId, { state: "cancelled", now: Date.now() }, f.hooks);
  if (action === "reassign") expect(reassignProjectCard(f.db, { cardId: a.id, assigneeBotId: "b", actor: { kind: "owner", lineage: { origin: "desktop", rootThreadId: "room", audienceFingerprint: "owner" } }, memberIds: ["a", "b"], now: Date.now() }).ok).toBe(true);
  if (action === "restart") {
    expect(reconcileRoomRequestsAtBoot(f.db, Date.now(), f.hooks).unknown).toBe(1);
    expect(projectCardById(f.db, a.id)).toMatchObject({ state: "waiting", waitingOn: { kind: "restart" } });
  }
  vi.advanceTimersByTime(200000); expect(f.starts.filter(s => s.id === a.requestId)).toHaveLength(1);
});
it("reconciles several live cards once per project and never replays them", () => {
  const f = fixture(); for (const bot of ["a", "b", "c"]) f.card(bot); f.card("d", "h");
  f.executor.pump(); vi.advanceTimersByTime(6000);
  expect(reconcileRoomRequestsAtBoot(f.db, Date.now(), f.hooks).unknown).toBe(4);
  expect(f.hooks.restartCards).toHaveBeenCalledTimes(2);
  expect(f.hooks.restartCards.mock.calls.find(c => c[0] === "g")![1]).toHaveLength(3);
  expect(reconcileRoomRequestsAtBoot(f.db, Date.now(), f.hooks).unknown).toBe(0);
  f.executor.pump(); expect(f.starts).toHaveLength(4);
});
it("bot Stop cancels only its starts in backoff", () => {
  const f = fixture(), a = f.card("a"), b = f.card("b"); f.executor.pump(); vi.advanceTimersByTime(2000);
  f.executor.retryStart(a.requestId, new Error("429"), false); f.executor.retryStart(b.requestId, new Error("429"), false);
  expect(f.executor.cancelBackoffs({ botId: "a" })).toBe(1);
  vi.advanceTimersByTime(5000);
  expect(f.starts.filter(s => s.id === a.requestId)).toHaveLength(1);
  expect(f.starts.filter(s => s.id === b.requestId)).toHaveLength(2);
  expect(roomRequest(f.db, a.requestId)?.state).toBe("failed");
});
it("raising the project cap starts eligible work and never consumes the reserved owner slot", () => {
  const f = fixture(); f.setParallel(1); f.card("a"); f.card("b"); f.executor.pump(); vi.advanceTimersByTime(2000);
  expect(f.starts).toHaveLength(1); f.setParallel(2); f.executor.pump(); expect(f.starts).toHaveLength(2);
  const input: AdmissionInput = { kind: "card_run", priority: "work", botId: "a", threadId: "another-project", project: f.context("h"), ownerOrigin: false, audience: { ownerAudience: true, fingerprint: "owner" }, now: Date.now() + 2000 };
  expect(f.admission.admit(input).admit).toBe(true);
  expect(f.admission.admit({ ...input, kind: "wake", priority: "coordinator", threadId: "lead-room" }).admit).toBe(true);
  expect(f.admission.admit({ ...input, kind: "review", threadId: "fourth", project: f.context("third") })).toMatchObject({ admit: false, reason: "bot_thread_ceiling" });
  expect(f.admission.admit({ ...input, kind: "owner_direct", priority: "owner", ownerOrigin: true, threadId: "owner" }).admit).toBe(true);
  expect(f.admission.admit({ ...input, kind: "owner_direct", priority: "owner", ownerOrigin: true, threadId: "second-owner" })).toMatchObject({ admit: false, reason: "bot_thread_ceiling" });
});

it("serial mode drains already-live cards before admitting exactly one queued card", () => {
  const f = fixture(); const cards = ["a", "b", "c", "d", "e"].map(bot => f.card(bot));
  f.executor.pump(); vi.advanceTimersByTime(4000); expect(f.starts).toHaveLength(3);
  f.setParallel(1); f.executor.pump(); vi.advanceTimersByTime(2000);
  for (const card of cards.slice(0, 2)) { f.executor.finish(card.requestId, { ok: true }); expect(f.starts).toHaveLength(3); }
  f.executor.finish(cards[2].requestId, { ok: true }); expect(f.starts).toHaveLength(4);
  vi.advanceTimersByTime(2000); expect(f.admission.liveTurns({ groupId: "g" })).toHaveLength(1);
  f.executor.finish(cards[3].requestId, { ok: true }); expect(f.starts).toHaveLength(5);
});

it("reserves bot, project, install and writer slots throughout start backoff", () => {
  const f = fixture(); f.setParallel(3);
  const a = f.card("a", "g", "/one"); f.executor.pump(); vi.advanceTimersByTime(2000);
  f.executor.retryStart(a.requestId, new Error("429"), false);
  const sameBot = f.card("a"), writer = f.card("b", "h", "/one");
  f.card("c"); f.card("d"); f.card("e", "h"); const fifth = f.card("reviewer", "h");
  f.executor.pump(); vi.advanceTimersByTime(4000);
  expect(roomRequest(f.db, sameBot.requestId)?.state).toBe("queued");
  expect(roomRequest(f.db, writer.requestId)?.refusal).toBe("writer_root_busy");
  expect(f.admission.liveTurns({})).toHaveLength(4);
  expect(roomRequest(f.db, fifth.requestId)?.refusal).toBe("install_card_cap");
  expect(f.roots.has("/one")).toBe(true);
  vi.advanceTimersByTime(2000);
  expect(f.starts.filter(s => s.id === a.requestId)).toHaveLength(2);
  expect(f.admission.liveTurns({})).toHaveLength(4);
});
it.each(["interrupt", "reassign", "take_over"])("route %s cancels backoff without touching another desk run", async action => {
  const f = fixture(), a = f.card("a", "g", "/one"); f.executor.pump();
  f.executor.retryStart(a.requestId, new Error("429"), false);
  const interrupt = vi.fn();
  const current = projectCardById(f.db, a.id)!;
  const result = await handleProjectRouteWithInterrupt(f.db, { method: "PATCH", path: `/api/groups/g/board/cards/${a.id}`, query: new URLSearchParams(), origin: "desktop",
    group: { id: "g", threadId: "room", memberIds: ["lead", "a", "b"] }, now: Date.now(), body: { action, expectedRevision: current.revision, assigneeBotId: "b" } }, async target => {
    expect(target).toMatchObject({ requestId: a.requestId, backoff: true });
    // Same boundary used by the server callback; backoff has no engine turn.
    if (target.backoff) { const prepared = f.executor.prepareBackoffCancellation(target.requestId!); f.executor.pump(); return prepared; }
    else interrupt(target);
  });
  expect(result?.status).toBe(200); expect(interrupt).not.toHaveBeenCalled();
  expect(f.executor.cancelBackoff(a.requestId)).toBe(false); expect(f.rootReleases).toEqual(["/one"]);
  expect(f.admission.liveTurns({})).toHaveLength(0); expect(f.roots.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  vi.advanceTimersByTime(200000); expect(f.starts).toHaveLength(1);
  if (action === "take_over") expect(projectCardById(f.db, a.id)).toMatchObject({ state: "doing", ownerTookOver: true, assigneeBotId: null, requestId: null });
  else expect(projectCardById(f.db, a.id)?.state).not.toBe("doing");
});
it.each(["open", "ready"])("rearms one backoff timer while %s is unavailable", gate => {
  const f = fixture(), a = f.card("a"); f.executor.pump(); f.executor.retryStart(a.requestId, new Error("429"), false);
  if (gate === "open") f.setOpen(false); else f.setReady(false);
  vi.advanceTimersByTime(5000); expect(f.starts).toHaveLength(1); expect(vi.getTimerCount()).toBe(1);
  vi.advanceTimersByTime(3000); expect(f.starts).toHaveLength(1); expect(vi.getTimerCount()).toBe(1);
  f.setOpen(true); f.setReady(true); vi.advanceTimersByTime(1000); expect(f.starts).toHaveLength(2);
  f.executor.stop(); expect(vi.getTimerCount()).toBe(0);
});
it("rearms a stagger when the dispatcher is unavailable", () => {
  const f = fixture(); f.card("a"); f.card("b"); f.executor.pump(); f.setReady(false);
  vi.advanceTimersByTime(2000); expect(vi.getTimerCount()).toBe(1);
  f.setReady(true); vi.advanceTimersByTime(1000); expect(f.starts).toHaveLength(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("Stop fences a late 429 while the dispatch request is still running", () => {
  const f = fixture(), a = f.card("a"); f.executor.pump();
  f.executor.requestStop(a.requestId);
  expect(roomRequest(f.db, a.requestId)?.state).toBe("running");
  expect(f.executor.retryStart(a.requestId, new Error("429"), false)).toBe(false);
  vi.advanceTimersByTime(10000); expect(f.starts).toHaveLength(1);
  f.executor.finish(a.requestId, { ok: false, note: "Stopped by you" });
  expect(f.admission.liveTurns({})).toHaveLength(0);
});

it("a card its budget stopped says so, on the request and the card, not \"Stopped by you\"", () => {
  const f = fixture(), a = f.card("a"); f.executor.pump();
  f.executor.requestStop(a.requestId, BUDGET_STOPPED);
  f.executor.finish(a.requestId, { ok: false });
  expect(roomRequest(f.db, a.requestId)).toMatchObject({ state: "failed", outcomeNote: BUDGET_STOPPED });
  expect(projectCardById(f.db, a.id)).toMatchObject({ state: "waiting", waitingOn: { kind: "stopped" }, reason: BUDGET_STOPPED });
  // (the owner's own Stop keeps "Stopped by you": the desk Stop cases below)
  expect(BUDGET_STOPPED).not.toBe(STOPPED_BY_YOU);
});

it("desk Stop during backoff cancels the timer and releases its reservation", () => {
  const f = fixture(), a = f.card("a", "g", "/one"); f.executor.pump();
  f.executor.retryStart(a.requestId, new Error("429"), false);
  f.executor.requestStop(a.requestId);
  expect(roomRequest(f.db, a.requestId)).toMatchObject({ state: "failed", outcomeNote: "Stopped by you" });
  expect(f.admission.liveTurns({})).toHaveLength(0); expect(f.roots.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  vi.advanceTimersByTime(10000); expect(f.starts).toHaveLength(1);
});


it.each(["cap reduction", "flag off"])("drains two reserved backoffs after %s before admitting new work", mode => {
  const f = fixture(), a = f.card("a"), b = f.card("b");
  f.executor.pump(); vi.advanceTimersByTime(2000);
  for (const card of [a, b]) expect(f.executor.retryStart(card.requestId, new Error("429"), false)).toBe(true);
  if (mode === "flag off") f.setFlag(false); else f.setParallel(1);
  const c = f.card("c"); f.executor.pump();
  vi.advanceTimersByTime(7000);
  expect(f.starts.map(s => s.id)).toEqual([a.requestId, b.requestId, a.requestId, b.requestId]);
  expect(f.starts[3].at - f.starts[2].at).toBeGreaterThanOrEqual(2000);
  expect(roomRequest(f.db, c.requestId)?.refusal).toBe("project_card_cap");
  f.executor.finish(a.requestId, { ok: true }); expect(f.starts).toHaveLength(4);
  vi.advanceTimersByTime(2000); f.executor.finish(b.requestId, { ok: true });
  expect(f.starts.at(-1)?.id).toBe(c.requestId);
});
it("retains the reservation when a changed writer root is busy", () => {
  const f = fixture(), a = f.card("a", "g", "/one"); f.card("b", "h", "/two");
  f.executor.pump(); vi.advanceTimersByTime(2000);
  f.executor.retryStart(a.requestId, new Error("429"), false); f.writer.set(a.id, "/two");
  vi.advanceTimersByTime(5000);
  expect(roomRequest(f.db, a.requestId)?.refusal).toBe("writer_root_busy");
  expect(f.admission.liveTurns({ botId: "a" })).toHaveLength(1);
  expect(f.roots.has("/one")).toBe(true);
  const other = f.card("a"); f.executor.pump();
  expect(roomRequest(f.db, other.requestId)?.state).toBe("queued");
  expect(f.starts.filter(s => s.id === other.requestId)).toHaveLength(0);
});
it.each(["interrupt throws", "final conflict"])("restores a prepared backoff when %s", async failure => {
  const f = fixture(), a = f.card("a", "g", "/one"), b = f.card("b");
  f.executor.pump(); vi.advanceTimersByTime(2000); f.executor.retryStart(a.requestId, new Error("429"), false);
  let calls = 0;
  const apply = () => {
    if (++calls === 2 && failure === "final conflict") return { status: 409 };
    for (const card of [a, b]) f.db.prepare("UPDATE room_requests SET state='cancelled' WHERE id=?").run(card.requestId);
    return { status: 200 };
  };
  const change = applyProjectChangeWithInterrupt(f.db, apply, async target => {
    if (target.backoff) {
      const prepared = f.executor.prepareBackoffCancellation(target.requestId!);
      vi.advanceTimersByTime(6000); f.executor.pump();
      expect(f.starts.filter(s => s.id === a.requestId)).toHaveLength(1);
      return prepared;
    }
    if (failure === "interrupt throws") throw new Error("unconfirmed stop");
  }, { stopping: true });
  if (failure === "interrupt throws") await expect(change).rejects.toThrow("unconfirmed stop");
  else expect(await change).toEqual({ status: 409 });
  expect(roomRequest(f.db, a.requestId)?.state).toBe("queued");
  vi.advanceTimersByTime(2000); f.executor.pump();
  expect(f.starts.filter(s => s.id === a.requestId)).toHaveLength(2);
  expect(f.roots.has("/one")).toBe(true);
});


it.each(["Stop goal", "End project"])("%s aborts backoff cancellation if the next live engine cannot stop", async action => {
  const f = fixture(), a = f.card("a", "g", "/one"), b = f.card("b");
  const made = createProjectGoal(f.db, { groupId: "g", title: "Finish both", now: Date.now() });
  if (!made.ok) throw new Error(made.reason);
  f.db.prepare("UPDATE project_goals SET state='working' WHERE id=?").run(made.goal.id);
  for (const card of [a, b]) {
    f.db.prepare("UPDATE project_work_items SET goal_id=? WHERE id=?").run(made.goal.id, card.id);
    f.db.prepare("UPDATE room_requests SET project_goal_id=? WHERE id=?").run(made.goal.id, card.requestId);
  }
  f.executor.pump(); vi.advanceTimersByTime(2000); f.executor.retryStart(a.requestId, new Error("429"), false);
  const targets: string[] = [];
  await expect(handleProjectRouteWithInterrupt(f.db, { method: "PATCH",
    path: action === "End project" ? "/api/groups/g" : `/api/groups/g/project/goals/${made.goal.id}`,
    body: action === "End project" ? { channelProject: null } : { action: "stop", expectedRevision: made.goal.revision },
    query: new URLSearchParams(), origin: "desktop", group: { id: "g", threadId: "room", memberIds: ["lead", "a", "b"] }, now: Date.now(),
  }, async target => {
    targets.push(target.requestId!);
    if (target.backoff) return f.executor.prepareBackoffCancellation(target.requestId!);
    throw new Error("unconfirmed stop");
  })).rejects.toThrow("unconfirmed stop");
  expect(targets).toEqual([a.requestId, b.requestId]);
  expect(f.admission.liveTurns({})).toHaveLength(2);
  vi.advanceTimersByTime(5000);
  expect(f.starts.filter(s => s.id === a.requestId)).toHaveLength(2);
});

// Execute the server's Stop wiring against the real executor and request store.
// Only the engine interrupt and unrelated room/browser services are stand-ins.
function serverStop(name: string, deps: Record<string, unknown>) {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const begin = source.indexOf(`async function ${name}(`), end = source.indexOf("\n/**", begin);
  expect(begin).toBeGreaterThan(0); expect(end).toBeGreaterThan(begin);
  const code = ts.transpileModule(source.slice(begin, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(deps), code + `return ${name};`)(...Object.values(deps));
}
it.each(["Stop all", "bot Stop"])("%s wiring drains live and backoff cards without replay or double release", async action => {
  const f = fixture(), a = f.card("a", "g", "/one"), b = f.card(action === "bot Stop" ? "a" : "b", action === "bot Stop" ? "h" : "g", "/two");
  f.executor.pump(); vi.advanceTimersByTime(2000); f.executor.retryStart(a.requestId, new Error("429"), false);
  const interrupt = vi.fn(async (_botId: string, thread: string) => {
    const claim = f.admission.liveTurns({}).find(c => c.threadId === thread)!;
    expect(claim.requestId).toBe(b.requestId);
    f.executor.requestStop(claim.requestId!);
    f.executor.finish(claim.requestId!, { ok: false, note: "Stopped by you" });
  });
  const deps = { projectCardExecutor: f.executor, workAdmission: f.admission,
    store: { bot: () => ({ modelSelection: { instanceId: "fake" } }), groupByThread: () => undefined },
    directRuns: { forBot: () => [{ threadId: "h-a" }] }, routines: { activeBotRunForThread: () => undefined },
    interruptDirectThread: interrupt, groupSpeakers: new Map(), groupTurnOperations: new Map(),
    database: () => f.db, listRoomRequests, cancelRoomRequest, roomCompletionHooks: f.hooks,
    dropDelegationsOf: vi.fn(), projectContextFor: () => ({}), projectPartFlags: () => ({}), roomRequestsChanged: vi.fn(),
    projectHooks: { setRunState: () => f.setOpen(false) },
  };
  if (action === "bot Stop") expect(await serverStop("stopBotEverywhere", deps)("a")).toEqual({ stopped: 2, unconfirmed: 0 });
  else await serverStop("stopProjectEverything", deps)({ id: "g" });
  expect(interrupt).toHaveBeenCalledTimes(1);
  for (const card of [a, b]) expect(roomRequest(f.db, card.requestId)?.state).toBe("failed");
  expect(f.admission.liveTurns({})).toHaveLength(0); expect(f.rootReleases.sort()).toEqual(["/one", "/two"]);
  vi.advanceTimersByTime(200000); f.executor.pump();
  expect(f.starts).toHaveLength(2); expect(vi.getTimerCount()).toBe(0);
  f.executor.finish(a.requestId, { ok: false }); f.executor.finish(b.requestId, { ok: false });
  expect(f.rootReleases).toHaveLength(2);
});
it("shutdown and boot reconciliation park a mixed live/backoff pair with no timer or automatic rerun", () => {
  const f = fixture(), a = f.card("a"), b = f.card("b");
  f.executor.pump(); vi.advanceTimersByTime(2000); f.executor.retryStart(a.requestId, new Error("429"), false);
  expect(vi.getTimerCount()).toBe(1); f.executor.stop(); expect(vi.getTimerCount()).toBe(0);
  // A process restart has no old in-memory admission claims.
  for (const claim of f.admission.liveTurns({})) claim.release();
  expect(reconcileRoomRequestsAtBoot(f.db, Date.now(), f.hooks).unknown).toBe(2);
  for (const card of [a, b]) {
    expect(roomRequest(f.db, card.requestId)?.state).toBe("unknown");
    expect(projectCardById(f.db, card.id)).toMatchObject({ state: "waiting", waitingOn: { kind: "restart" } });
  }
  const start = vi.fn();
  const rebooted = createProjectCardExecutor({ db: () => f.db, admission: f.admission, now: Date.now, open: () => true,
    context: r => f.context(r.groupId), usable: () => true, desk: r => `${r.groupId}-${r.toBotId}`, writerRoot: () => undefined,
    start, hooks: f.hooks, changed: vi.fn() });
  cleanups.unshift(() => rebooted.stop());
  rebooted.pump(); vi.advanceTimersByTime(200000); rebooted.pump();
  expect(start).not.toHaveBeenCalled(); expect(f.starts).toHaveLength(2); expect(vi.getTimerCount()).toBe(0);
  expect(reconcileRoomRequestsAtBoot(f.db, Date.now(), f.hooks).unknown).toBe(0);
});

// RUN 4: exercise lifecycle boundaries omitted by the earlier isolated tests.
it("bot Stop does not create lead work from either stopped card", async () => {
  const f = fixture(), live = f.card("a"), backoff = f.card("a", "h");
  f.executor.pump(); vi.advanceTimersByTime(2000);
  f.executor.retryStart(backoff.requestId, new Error("429"), false);
  const deps = { projectCardExecutor: f.executor, workAdmission: f.admission,
    store: { bot: () => ({ modelSelection: { instanceId: "fake" } }), groupByThread: () => undefined },
    directRuns: { forBot: () => [{ threadId: "g-a" }] }, routines: { activeBotRunForThread: () => undefined },
    interruptDirectThread: async () => { f.executor.requestStop(live.requestId); f.executor.finish(live.requestId, { ok: false }); }, groupSpeakers: new Map() };
  await serverStop("stopBotEverywhere", deps)("a");
  expect(f.db.prepare("SELECT id FROM room_requests WHERE verb='wake'").all()).toEqual([]);
  vi.advanceTimersByTime(10000); expect(f.starts).toHaveLength(2);
});
it("shutdown terminal callbacks leave both cards for boot reconciliation", () => {
  const f = fixture(), live = f.card("a"), backoff = f.card("b");
  f.executor.pump(); vi.advanceTimersByTime(2000);
  f.executor.retryStart(backoff.requestId, new Error("429"), false);
  f.executor.stop();
  // registry.disposeAll closes the live engine after executor.stop at shutdown.
  f.executor.finish(live.requestId, { ok: false });
  expect(roomRequest(f.db, live.requestId)?.state).toBe("running");
  expect(reconcileRoomRequestsAtBoot(f.db, Date.now(), f.hooks).unknown).toBe(2);
  for (const card of [live, backoff]) expect(projectCardById(f.db, card.id)?.waitingOn?.kind).toBe("restart");
  expect(f.hooks.restartCards).toHaveBeenCalledExactlyOnceWith("g", [live.id, backoff.id]);
  expect(f.db.prepare("SELECT id FROM room_requests WHERE verb='wake'").all()).toEqual([]);
});
it("End project holds every backoff before awaiting the first live engine", async () => {
  const f = fixture(), live = f.card("a"), backoff = f.card("b", "g", "/one");
  f.executor.pump(); vi.advanceTimersByTime(2000); f.executor.retryStart(backoff.requestId, new Error("429"), false);
  const interrupt = Object.assign(async (target: { requestId?: string | null }) => {
    if (target.requestId === live.requestId) {
      vi.advanceTimersByTime(6000);
      expect(f.starts.filter(s => s.id === backoff.requestId)).toHaveLength(1);
      f.executor.requestStop(live.requestId); f.executor.finish(live.requestId, { ok: false });
    }
  }, { prepare: (target: { requestId?: string | null }) => f.executor.prepareBackoffCancellation(target.requestId!) });
  expect((await handleProjectRouteWithInterrupt(f.db, { method: "PATCH", path: "/api/groups/g", body: { channelProject: null },
    query: new URLSearchParams(), origin: "desktop", group: { id: "g", threadId: "room", memberIds: ["a", "b"] }, now: Date.now() }, interrupt))?.status).toBe(200);
  expect(f.admission.liveTurns({})).toHaveLength(0); expect(f.roots.size).toBe(0);
});
it("overlapping routes independently hold a backoff when the first route aborts", async () => {
  const f = fixture(), backoff = f.card("a", "g", "/one"), live = f.card("b");
  f.executor.pump(); vi.advanceTimersByTime(2000); f.executor.retryStart(backoff.requestId, new Error("429"), false);
  const apply = () => { for (const card of [backoff, live]) f.db.prepare("UPDATE room_requests SET state='cancelled' WHERE id=?").run(card.requestId); return { status: 200 }; };
  let rejectFirst!: (error: Error) => void, resolveSecond!: () => void;
  const firstGate = new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
  const secondGate = new Promise<void>(resolve => { resolveSecond = resolve; });
  const callback = (gate: Promise<void>) => Object.assign(async (target: { requestId?: string | null; backoff?: boolean }) => {
    if (target.backoff) return f.executor.prepareBackoffCancellation(target.requestId!);
    await gate;
  }, { prepare: (target: { requestId?: string | null }) => f.executor.prepareBackoffCancellation(target.requestId!) });
  const first = applyProjectChangeWithInterrupt(f.db, apply, callback(firstGate), { stopping: true });
  const rejected = expect(first).rejects.toThrow("unconfirmed");
  const second = applyProjectChangeWithInterrupt(f.db, apply, callback(secondGate), { stopping: true });
  await Promise.resolve(); await Promise.resolve();
  rejectFirst(new Error("unconfirmed")); await rejected;
  vi.advanceTimersByTime(6000);
  const startsWhileHeld = f.starts.filter(s => s.id === backoff.requestId).length;
  resolveSecond(); expect(await second).toEqual({ status: 200 });
  expect(startsWhileHeld).toBe(1);
  expect(f.roots.size).toBe(0);
});
it("terminal-row backoff cleanup cannot release an active retry's slot or writer", () => {
  const f = fixture(), card = f.card("a", "g", "/one");
  f.executor.pump(); f.executor.retryStart(card.requestId, new Error("429"), false); vi.advanceTimersByTime(5000);
  expect(f.starts).toHaveLength(2);
  f.db.prepare("UPDATE room_requests SET state='cancelled' WHERE id=?").run(card.requestId);
  f.executor.pump();
  expect(f.admission.liveTurns({})).toHaveLength(1); expect(f.roots.has("/one")).toBe(true);
  expect(f.executor.cancelBackoff(card.requestId)).toBe(false);
  f.executor.finish(card.requestId, { ok: false });
  expect(f.admission.liveTurns({})).toHaveLength(0); expect(f.roots.size).toBe(0);
});

// RUN 5: a stopped continuation must settle the waiting assignment, without a lead wake.
it.each(["desk Stop", "bot Stop"])("%s parks an asked card continuation and survives restart before Retry", async action => {
  const f = fixture(), card = f.card("a"); f.executor.pump();
  const ask = insertRoomRequest(f.db, { groupId: "g", verb: "ask", fromKind: "bot", toBotId: "b", parentId: card.requestId, admissionKey: "run5-ask", now: Date.now() }).request;
  f.executor.finish(card.requestId, { ok: true });
  expect(roomRequest(f.db, card.requestId)?.state).toBe("waiting_bot");
  const answered = completeRequest(f.db, ask.id, { state: "done", now: Date.now() }, f.hooks);
  const wake = answered.wakes[0];
  expect(wake.admissionKey).toBe(`wake:${card.requestId}`);
  vi.advanceTimersByTime(2000); f.executor.pump();
  expect(roomRequest(f.db, wake.id)?.state).toBe("running");
  expect(projectCardById(f.db, card.id)?.state).toBe("doing");
  const interrupt = async () => { f.executor.requestStop(wake.id); f.executor.finish(wake.id, { ok: true }); };
  if (action === "desk Stop") await interrupt();
  else await serverStop("stopBotEverywhere", { projectCardExecutor: f.executor, workAdmission: f.admission,
    store: { bot: () => ({ modelSelection: { instanceId: "fake" } }), groupByThread: () => undefined },
    directRuns: { forBot: () => [{ threadId: "g-a" }] }, routines: { activeBotRunForThread: () => undefined },
    interruptDirectThread: interrupt, groupSpeakers: new Map() })("a");
  expect(roomRequest(f.db, card.requestId)).toMatchObject({ state: "failed", outcomeNote: "Stopped by you" });
  expect(roomRequest(f.db, wake.id)).toMatchObject({ state: "failed", outcomeNote: "Stopped by you" });
  expect(projectCardById(f.db, card.id)).toMatchObject({ state: "waiting", waitingOn: { kind: "stopped" }, requestId: null, failures: 0 });
  expect(f.admission.liveTurns({})).toHaveLength(0);
  expect(f.db.prepare("SELECT id FROM room_requests WHERE verb='wake' AND to_bot_id='lead'").all()).toEqual([]);
  f.executor.stop();
  expect(reconcileRoomRequestsAtBoot(f.db, Date.now(), f.hooks).unknown).toBe(0);
  const start = vi.fn();
  const rebooted = createProjectCardExecutor({ db: () => f.db, admission: f.admission, now: Date.now, open: () => true,
    context: r => f.context(r.groupId), usable: () => true, desk: r => `${r.groupId}-${r.toBotId}`, writerRoot: () => undefined,
    start, hooks: f.hooks, changed: vi.fn() });
  cleanups.unshift(() => rebooted.stop());
  rebooted.pump(); vi.advanceTimersByTime(10000); expect(start).not.toHaveBeenCalled();
  expect(projectCardById(f.db, card.id)).toMatchObject({ state: "waiting", waitingOn: { kind: "stopped" } });
  const retry = retryProjectCard(f.db, { cardId: card.id, actor: { kind: "owner", lineage: { origin: "desktop", rootThreadId: "room", audienceFingerprint: "owner" } }, memberIds: ["a", "lead"], now: Date.now() });
  expect(retry.ok).toBe(true); rebooted.pump(); expect(start).toHaveBeenCalledTimes(1);
});

it.each(["finish", "pump"].flatMap(action => ["live", "stopping", "held backoff"].map(state => ({ action, state }))))("$action releases a deleted $state request's claim and writer so another card can run", ({ action, state }) => {
  const f = fixture(); f.setParallel(1);
  const old = f.card("a", "g", "/one"); f.executor.pump();
  expect(f.admission.liveTurns({})).toHaveLength(1);
  if (state === "stopping") f.executor.requestStop(old.requestId);
  if (state === "held backoff") expect(f.executor.retryStart(old.requestId, new Error("429"), false)).toBe(true);
  const held = f.executor.prepareBackoffCancellation(old.requestId);
  f.db.prepare("DELETE FROM room_requests WHERE id=?").run(old.requestId);
  if (action === "finish") f.executor.finish(old.requestId, { ok: false }); else f.executor.pump();
  expect(f.admission.liveTurns({})).toHaveLength(0); expect(f.roots.size).toBe(0);
  expect(f.rootReleases).toEqual(["/one"]);
  expect(f.executor.cancelBackoff(old.requestId)).toBe(false);
  expect(f.executor.prepareBackoffCancellation(old.requestId)).toBeUndefined();
  held?.abort(); expect(vi.getTimerCount()).toBe(0);
  const next = f.card("a", "g", "/one"); vi.advanceTimersByTime(2000); f.executor.pump();
  expect(roomRequest(f.db, next.requestId)?.state).toBe("running");
  f.executor.finish(old.requestId, { ok: false });
  expect(f.admission.liveTurns({})).toHaveLength(1); expect(f.rootReleases).toHaveLength(1);
});

it("a stopped continuation cannot park a reassigned card or wake the lead", () => {
  const f = fixture(), card = f.card("a"); f.executor.pump();
  const ask = insertRoomRequest(f.db, { groupId: "g", verb: "ask", fromKind: "bot", toBotId: "b", parentId: card.requestId, admissionKey: "fenced-ask", now: Date.now() }).request;
  f.executor.finish(card.requestId, { ok: true });
  const wake = completeRequest(f.db, ask.id, { state: "done", now: Date.now() }, f.hooks).wakes[0];
  vi.advanceTimersByTime(2000); f.executor.pump();
  expect(roomRequest(f.db, wake.id)?.state).toBe("running");
  f.executor.requestStop(wake.id);
  expect(reassignProjectCard(f.db, { cardId: card.id, assigneeBotId: "c", actor: { kind: "owner", lineage: { origin: "desktop", rootThreadId: "room", audienceFingerprint: "owner" } }, memberIds: ["a", "b", "c"], now: Date.now() }).ok).toBe(true);
  const reassigned = projectCardById(f.db, card.id);
  const cancelledWake = roomRequest(f.db, wake.id);
  expect(cancelledWake).toMatchObject({ state: "cancelled", outcomeNote: "reassigned" });
  f.executor.finish(wake.id, { ok: true });
  expect(projectCardById(f.db, card.id)).toEqual(reassigned);
  expect(roomRequest(f.db, wake.id)).toEqual(cancelledWake);
  expect(f.admission.liveTurns({})).toHaveLength(0);
  expect(f.db.prepare("SELECT id FROM room_requests WHERE verb='wake' AND to_bot_id='lead'").all()).toEqual([]);
});

// RUN 6: Stop must deliver a review result, including through a waiting parent.
it.each([
  { action: "desk Stop", continued: false, verdict: "pass" as const },
  { action: "desk Stop", continued: false, verdict: "changes" as const },
  { action: "bot Stop", continued: true, verdict: "pass" as const },
  { action: "bot Stop", continued: true, verdict: "changes" as const },
  { action: "desk Stop", continued: false, verdict: null },
])("$action returns review verdict $verdict exactly once (continued: $continued)", async ({ action, continued, verdict }) => {
  const f = fixture(), card = f.card("a"); f.executor.pump();
  applyCardRunFinished(f.db, { cardId: card.id, requestId: card.requestId, reviewApplies: true, now: Date.now() });
  f.executor.finish(card.requestId, { ok: true });
  // Consume the assignment result so absorption cannot hide a duplicate review return.
  for (const wake of listRoomRequests(f.db, { groupId: "g", open: true }).filter(r => r.verb === "wake")) {
    completeRequest(f.db, wake.id, { state: "done", now: Date.now() }, f.hooks);
  }
  const review = assignCardReview(f.db, { cardId: card.id, reviewerBotId: "reviewer", leadBotId: "lead", memberIds: ["lead", "a", "reviewer"], now: Date.now() });
  if (!review.ok) throw new Error(review.reason);
  f.executor.pump();
  expect(roomRequest(f.db, review.requestId)?.state).toBe("running");
  let stoppedId = review.requestId;
  if (continued) {
    const ask = insertRoomRequest(f.db, { groupId: "g", verb: "ask", fromKind: "bot", toBotId: "b", parentId: review.requestId, admissionKey: "run6-review-ask", now: Date.now() }).request;
    f.executor.finish(review.requestId, { ok: true });
    expect(roomRequest(f.db, review.requestId)?.state).toBe("waiting_bot");
    stoppedId = completeRequest(f.db, ask.id, { state: "done", now: Date.now() }, f.hooks).wakes[0].id;
    f.executor.pump();
    expect(roomRequest(f.db, stoppedId)?.state).toBe("running");
  }
  if (verdict) expect(applyReviewVerdict(f.db, { cardId: card.id, requestId: review.requestId, reviewerBotId: "reviewer", verdict, now: Date.now() })).toEqual({ ok: true });
  const interrupt = async () => { f.executor.requestStop(stoppedId); f.executor.finish(stoppedId, { ok: true }); };
  if (action === "desk Stop") await interrupt();
  else await serverStop("stopBotEverywhere", { projectCardExecutor: f.executor, workAdmission: f.admission,
    store: { bot: () => ({ modelSelection: { instanceId: "fake" } }), groupByThread: () => undefined },
    directRuns: { forBot: () => [{ threadId: "g-reviewer" }] }, routines: { activeBotRunForThread: () => undefined },
    interruptDirectThread: interrupt, groupSpeakers: new Map() })("reviewer");
  // lane review: a stopped review gives no verdict (not "changes")
  const expected = verdict ?? null;
  expect(roomRequest(f.db, review.requestId)?.outcomeNote).toBe(expected);
  expect(latestReviewVerdict(f.db, card.id, projectCardById(f.db, card.id)!.generation)).toBe(expected);
  expect(projectCardById(f.db, card.id)?.state).toBe("review");
  const returns = () => listRoomRequests(f.db, { groupId: "g", open: true }).filter(r => r.verb === "wake" && r.toBotId === "lead");
  expect(returns()).toHaveLength(1);
  expect(JSON.parse(returns()[0].payloadText!)).toEqual([expect.objectContaining({ requestId: review.requestId, ...(expected ? { note: expected } : {}) })]);
  const returned = returns();
  f.executor.finish(stoppedId, { ok: false, stopped: true });
  f.executor.finish(review.requestId, { ok: false, stopped: true });
  expect(returns()).toEqual(returned);
  expect(roomRequest(f.db, review.requestId)?.outcomeNote).toBe(expected);
  expect(f.admission.liveTurns({})).toHaveLength(0);
});

// RUN 7: Exercise the actual lead wake builder, including desk message lookup.
function leadPrompt(f: ReturnType<typeof fixture>, wake: NonNullable<ReturnType<typeof roomRequest>>, text: string) {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const begin = source.indexOf("function wakeContinuationPrompt("), end = source.indexOf("\n/**", begin);
  expect(begin).toBeGreaterThan(0); expect(end).toBeGreaterThan(begin);
  // Lane X re-reads each result against the thread it returns to (partition-sources.ts). This fixture has no
  // roster to authorize against, so the thread binding runs for real on f.db and the roster check is left open.
  const deps = { isProjectCloseRequest: () => false, isGoalCloseRequest: () => false, wakeRedirectText: () => null, wakeGoalAction: () => null, database: () => f.db,
    roomRequest, projectCardById, continuationResults, continuationResultsPrompt, roomRequestStillOwnerAudience: () => true,
    projectTableExists, projectSettingsFor, leadNextStep,
    requestSourceThread: (id: string) => requestSourceThread(id, f.db),
    continuationResultsForThread: (db: DatabaseSync, request: RoomRequest, threadId: string) => continuationResults(request).filter(result => requestReturnsTo(db, result.requestId, threadId)),
    store: { bot: () => ({ name: "Ivy" }), group: () => ({ memberIds: ["lead", "a", "reviewer"] }), messagesFor: (thread: string) => thread === "g-reviewer" ? [{ id: "review-text", text }] : [] } };
  const code = ts.transpileModule(source.slice(begin, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(deps), code + "return wakeContinuationPrompt;")(...Object.values(deps))(wake, "room") as string;
}
it.each([
  { continued: false, stopped: true, verdict: "pass" as const },
  { continued: true, stopped: true, verdict: "changes" as const },
  { continued: false, stopped: false, verdict: "pass" as const },
])("lead prompt preserves $verdict (continued: $continued, stopped: $stopped)", ({ continued, stopped, verdict }) => {
  const f = fixture(), card = f.card("a"); f.executor.pump();
  applyCardRunFinished(f.db, { cardId: card.id, requestId: card.requestId, reviewApplies: true, now: Date.now() });
  f.executor.finish(card.requestId, { ok: true });
  for (const wake of listRoomRequests(f.db, { groupId: "g", open: true }).filter(r => r.verb === "wake")) completeRequest(f.db, wake.id, { state: "done", now: Date.now() }, f.hooks);
  const review = assignCardReview(f.db, { cardId: card.id, reviewerBotId: "reviewer", leadBotId: "lead", memberIds: ["lead", "a", "reviewer"], now: Date.now() });
  if (!review.ok) throw new Error(review.reason);
  f.executor.pump(); let id = review.requestId;
  if (continued) {
    const ask = insertRoomRequest(f.db, { groupId: "g", verb: "ask", fromKind: "bot", toBotId: "b", parentId: id, admissionKey: "run7-ask", now: Date.now() }).request;
    f.executor.finish(id, { ok: true });
    id = completeRequest(f.db, ask.id, { state: "done", now: Date.now() }, f.hooks).wakes[0].id;
    f.executor.pump();
  }
  expect(applyReviewVerdict(f.db, { cardId: card.id, requestId: review.requestId, reviewerBotId: "reviewer", verdict, now: Date.now() })).toEqual({ ok: true });
  if (stopped) f.executor.requestStop(id);
  f.executor.finish(id, { ok: true, resultMessageId: "review-text" });
  const wake = listRoomRequests(f.db, { groupId: "g", open: true }).find(r => r.verb === "wake" && r.toBotId === "lead")!;
  const prompt = leadPrompt(f, wake, "Checked the acceptance criteria.");
  const number = projectCardById(f.db, card.id)!.number;
  expect(prompt).toContain(verdict === "pass" ? `- "Ivy" reviewed card ${number}: pass.` : `- "Ivy" reviewed card ${number} and asked for changes.`);
  expect(prompt).toContain('<result from="Ivy">\nChecked the acceptance criteria.\n</result>');
  expect(prompt.includes('"Ivy" stopped after giving the verdict.')).toBe(stopped);
  expect(prompt).not.toContain("could not finish");
});
it("lead prompt keeps assignment failure wording even when its note looks like a verdict", () => {
  const f = fixture(), card = f.card("a"); f.executor.pump();
  f.executor.finish(card.requestId, { ok: false, note: "pass" });
  const wake = listRoomRequests(f.db, { groupId: "g", open: true }).find(r => r.verb === "wake" && r.toBotId === "lead")!;
  expect(leadPrompt(f, wake, "")).toContain('- "Ivy" could not finish ("pass").');
});

// PF3: real Stop-all wiring, executor and database; only provider interruption
// is simulated. Record the verdict through the same card mutation as the tool.
it.each(["pass", "changes"] as const)("Stop all preserves a recorded %s verdict and marks an ordinary live run stopped", async verdict => {
  const f = fixture(), reviewed = f.card("a"); f.executor.pump();
  applyCardRunFinished(f.db, { cardId: reviewed.id, requestId: reviewed.requestId, reviewApplies: true, now: Date.now() });
  f.executor.finish(reviewed.requestId, { ok: true });
  const review = assignCardReview(f.db, { cardId: reviewed.id, reviewerBotId: "reviewer", leadBotId: "lead", memberIds: ["lead", "a", "reviewer"], now: Date.now() });
  if (!review.ok) throw new Error(review.reason);
  f.executor.pump();
  expect(roomRequest(f.db, review.requestId)?.state).toBe("running");
  expect(applyReviewVerdict(f.db, { cardId: reviewed.id, requestId: review.requestId, reviewerBotId: "reviewer", verdict, now: Date.now() })).toEqual({ ok: true });
  const ordinary = f.card("b"); vi.advanceTimersByTime(2000); f.executor.pump();
  expect(roomRequest(f.db, ordinary.requestId)?.state).toBe("running");
  await serverStop("stopProjectEverything", {
    projectCardExecutor: f.executor, workAdmission: f.admission, database: () => f.db,
    listRoomRequests, cancelRoomRequest, roomCompletionHooks: f.hooks,
    groupTurnOperations: new Map(), groupSpeakers: new Map(), dropDelegationsOf: vi.fn(),
    projectContextFor: () => ({}), projectPartFlags: () => ({}), roomRequestsChanged: vi.fn(),
    projectHooks: { setRunState: () => f.setOpen(false) },
    interruptDirectThread: async (_botId: string, threadId: string) => {
      const claim = f.admission.liveTurns({}).find(row => row.threadId === threadId)!;
      f.executor.requestStop(claim.requestId!);
      f.executor.finish(claim.requestId!, { ok: false, note: "Stopped by you" });
    },
  })({ id: "g" });
  expect(roomRequest(f.db, ordinary.requestId)).toMatchObject({ state: "failed", outcomeNote: "Stopped by you" });
  expect(roomRequest(f.db, review.requestId)).toMatchObject({ state: "failed", outcomeNote: verdict });
  const card = projectCardById(f.db, reviewed.id)!;
  expect(latestReviewVerdict(f.db, card.id, card.generation)).toBe(verdict);
  expect(latestReviewVerdict(f.db, ordinary.id, card.generation)).toBeNull();
  expect(latestReviewVerdict(f.db, card.id, card.generation + 1)).toBeNull();
  expect(acceptProjectCard(f.db, { cardId: card.id, actor: { kind: "lead", botId: "lead" }, now: Date.now() }).ok).toBe(verdict === "pass");
});
it.each(["cancel", "interrupt", "reassign"] as const)("%s preserves a recorded review verdict", action => {
  const f = fixture(), reviewed = f.card("a"); f.executor.pump();
  applyCardRunFinished(f.db, { cardId: reviewed.id, requestId: reviewed.requestId, reviewApplies: true, now: Date.now() });
  f.executor.finish(reviewed.requestId, { ok: true });
  const review = assignCardReview(f.db, { cardId: reviewed.id, reviewerBotId: "reviewer", leadBotId: "lead", memberIds: ["lead", "a", "reviewer"], now: Date.now() });
  if (!review.ok) throw new Error(review.reason);
  f.executor.pump();
  expect(applyReviewVerdict(f.db, { cardId: reviewed.id, requestId: review.requestId, reviewerBotId: "reviewer", verdict: "pass", now: Date.now() })).toEqual({ ok: true });
  if (action === "cancel") {
    insertRoomRequest(f.db, { groupId: "g", verb: "ask", fromKind: "bot", toBotId: "b", parentId: review.requestId, admissionKey: "review-ask", now: Date.now() });
    f.executor.finish(review.requestId, { ok: true });
    expect(roomRequest(f.db, review.requestId)?.state).toBe("waiting_bot");
    expect(cancelRoomRequest(f.db, review.requestId, { now: Date.now(), note: "Stopped by you" }, f.hooks)).not.toBeNull();
  } else if (action === "interrupt") completeRequest(f.db, review.requestId, { state: "failed", now: Date.now(), outcomeNote: "Stopped by you" }, f.hooks);
  else expect(reassignProjectCard(f.db, { cardId: reviewed.id, assigneeBotId: "b", actor: { kind: "owner", lineage: { origin: "desktop", rootThreadId: "room", audienceFingerprint: "owner" } }, memberIds: ["a", "b"], now: Date.now() }).ok).toBe(true);
  expect(roomRequest(f.db, review.requestId)?.outcomeNote).toBe("pass");
});
