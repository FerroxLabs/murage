// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure helpers for rig.mjs (which runs its scenarios at import, so cannot be unit tested): the terms version the
// server env declares, the fake engine env, the pooled/cold option, the recall success share, and reading one turn
// out of the server log (its own trace, its own memory line, its sent bundle, its resets, a re-dispatch).

/** The version shared/terms.ts asks for, read from its source so the next terms bump cannot silently break the rig. */
export function termsVersionFrom(source) {
  return /export const TERMS_VERSION\s*=\s*["']([^"']+)["']/.exec(source ?? "")?.[1] ?? null;
}

/** The base run's pool: MURAGE_ACP_POOL=1 only when asked for (per-turn engines are the shipped default); recorded as
 * `acpPool` in the results. The warm-session rows run with the pool on and the cold-start row with it off, whatever
 * this says (rig.mjs withPool), and each scenario records the one it ran with. */
export function acpPool(env) { return env.MURAGE_ACP_POOL === "1" || env.SCALE_ACP_POOL === "1"; }

/** The extra server env: the terms declaration, the fake engine's instant MCP list, the pool switch. */
export function rigServerEnv(env, termsVersion) {
  return {
    ...(termsVersion ? { MURAGE_TERMS_ACCEPTED: termsVersion } : {}),
    FAKE_ACP_MCP_LIST: "all:ready",
    ...(acpPool(env) ? { MURAGE_ACP_POOL: "1" } : {}),
  };
}

/** Share of turns whose recall returned hits (a recall that was attempted and came back empty is not a success). */
export function recallSuccess(turns) {
  if (!turns.some(t => t.recallHits !== undefined)) return null;
  return turns.filter(t => t.outcome === "turn.completed" && Number(t.recallHits) > 0).length / turns.length;
}

// ---- turn attribution (RC1-FULL-TURN row 1(c), RC1-FULL-SEARCH row 1b)
// Trace lines carry a turn id but no thread id, the `[memory] turn` line carries neither, and an engine's terminal
// event can land after the next turn was sent. So the rig keys each wait by the engine turn it started (SSE) and by the
// request id it sent, reads only the traces that started after its own send, and follows a server re-dispatch.

/** Whether one event-stream event belongs to this wait: "started" binds the wait to the event's engine turn id, "ended"
 * ends it. An event of an engine turn that was already seen before the send (a late close of the previous turn) never
 * matches, and neither does one that names no turn. */
export function matchTurnEvent(ev, wait) {
  if (!ev || ev.threadId !== wait.threadId || !ev.turnId || wait.before.has(ev.turnId)) return null;
  if (ev.type === "turn.started") return wait.turnId === undefined ? "started" : null;
  if (ev.type !== "turn.completed" && ev.type !== "turn.failed") return null;
  return wait.turnId === undefined || wait.turnId === ev.turnId ? "ended" : null;
}

const detail = (line, key) => new RegExp(`\\b${key}=([\\w:.\\-/]+)`).exec(line)?.[1];
/** `key=value` pairs of one `[memory] turn` line. */
export function memoryTurnFields(line) {
  const body = /\[memory\] turn (.*)$/.exec(line)?.[1] ?? "";
  return Object.fromEntries([...body.matchAll(/(\w+)=([^\s]+)/g)].map(m => [m[1], m[2]]));
}

/** Every turn trace in a piece of server log, keyed by trace id, with `order` listing them by their first line.
 * A trace's `mem` is the `[memory] turn` line written immediately before its `dispatch.send` (both are written in one
 * synchronous step, index.ts pre.finish then trace.mark), so it is that turn's own line and never another turn's. */
export function parseTurnLog(text) {
  const byId = {}, order = [];
  let prevMem = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let mem = null;
    if (line.includes("[turn-trace]")) {
      const id = /\bid=(\w+)/.exec(line)?.[1], p = /\bphase=([\w.\-/]+)/.exec(line)?.[1];
      if (id && p) {
        const at = Number(/ at=(\d+)/.exec(line)?.[1]), ms = detail(line, "ms");
        let ph = byId[id];
        if (!ph) { ph = byId[id] = { id, bundles: [] }; order.push(id); }
        if (ph[p] === undefined) ph[p] = ms !== undefined ? { at, ms: Number(ms) } : at;
        const hits = detail(line, "hits");
        if (p === "memory.bundle") ph.bundles.push({ ms: ms === undefined ? undefined : Number(ms), hits: hits === undefined ? undefined : Number(hits), overlapped: /\boverlapped=true\b/.test(line), outcome: detail(line, "outcome") });
        if (p === "memory.assemble" && hits !== undefined) ph.assembleHits = Number(hits);
        if (p === "engine.acquire" && ph.engineCold === undefined) { ph.engineCold = /\bcold=true\b/.test(line); ph.pooling = /\bpooling=true\b/.test(line); }
        if (p === "dispatch.send") {
          const r = detail(line, "recallHits");
          if (r !== undefined && ph.dispatchRecallHits === undefined) ph.dispatchRecallHits = Number(r);
          if (prevMem && !ph.mem) ph.mem = prevMem;
        }
        if (p === "turn.done" && ph.outcome === undefined) ph.outcome = detail(line, "outcome");
      }
    } else if (line.includes("[memory] turn ")) mem = memoryTurnFields(line);
    prevMem = mem;
  }
  return { byId, order };
}
export const atOf = (ph, k) => (typeof ph?.[k] === "object" ? ph[k].at : ph?.[k]);

/** Hits in the bundle the turn actually sent. `dispatch.send recallHits=` when the tree writes it; otherwise derived:
 * a recall dropped at the wait (`recallMode=skipped:*`) sent no excerpts unless a reset rebuilt it, and a bundle built on
 * the resumed path (not overlapped) is the one sent. Never the max over every bundle line (a discarded one counted). */
export function sentRecall(ph, rebuiltAfterReset) {
  if (!ph) return { hits: undefined, source: "none" };
  if (ph.dispatchRecallHits !== undefined) return { hits: ph.dispatchRecallHits, source: "dispatch" };
  const mode = ph.mem?.recallMode;
  if (mode === undefined) return { hits: undefined, source: "none" };
  const ok = ph.bundles.filter(b => b.outcome === "ok" && b.hits !== undefined);
  const early = ok.find(b => b.overlapped), direct = ok.filter(b => !b.overlapped).at(-1);
  if (String(mode).startsWith("skipped")) {
    if (!rebuiltAfterReset) return { hits: 0, source: "skipped" };
    return { hits: Math.max(0, (ph.assembleHits ?? 0) - (early?.hits ?? 0)), source: "rebuilt" };
  }
  if (direct) return { hits: direct.hits, source: "bundle" };
  if (early) return { hits: early.hits, source: "early-bundle" };
  return ph.assembleHits !== undefined ? { hits: ph.assembleHits, source: "assemble" } : { hits: undefined, source: "none" };
}

/** Real session resets on one thread: `memory continuation reset thread=<id> …` lines, not the `reset loop` summaries. */
export function resetLines(text, threadId) {
  return [...text.matchAll(/memory continuation reset thread=([\w-]+)[^\n]*/g)].filter(m => threadId === undefined || m[1] === threadId).map(m => m[0]);
}

/** Traces that started in this log and have not ended (a late re-dispatch, an earlier turn's tail). */
export function openTraces(text) {
  const { byId, order } = parseTurnLog(text);
  return order.filter(id => byId[id].received !== undefined && byId[id]["turn.done"] === undefined);
}

/** One turn read from the log written since its own send. `exclude` holds trace ids other waits already own (a trace
 * names no thread). The turn's trace is the first one that started after the send; when the server re-dispatched it
 * (`… on thread <id>; re-preparing once`), the next trace is the re-dispatch, and its sent bundle is the one scored. */
export function turnFromLog(text, threadId, exclude = new Set()) {
  const { byId, order } = parseTurnLog(text);
  const started = order.filter(id => byId[id].received !== undefined && !exclude.has(id));
  const own = byId[started[0]];
  const esc = threadId.replace(/[^\w-]/g, "");
  const redispatched = new RegExp(`on thread ${esc}; re-preparing once`).test(text);
  const redispatchFailed = new RegExp(`late re-dispatch failed on thread ${esc}:`).test(text);
  const follow = redispatched ? byId[started[1]] : undefined;
  const final = follow ?? own;
  const resets = resetLines(text, threadId);
  const recall = sentRecall(final, resets.length > 0);
  const ownDone = own?.["turn.done"] !== undefined;
  const done = ownDone && (!redispatched || redispatchFailed || follow?.["turn.done"] !== undefined);
  const resumed = own?.mem?.resumed === undefined ? undefined : own.mem.resumed === "true";
  return {
    traceId: own?.id, redispatchTraceId: follow?.id, redispatched, done,
    foreignTraces: Math.max(0, started.length - 1 - (follow ? 1 : 0)),
    outcome: final?.outcome,
    // prep is the trace's dispatch.send and nothing else: memory's own `pre=` is a different measure
    prep: atOf(own, "dispatch.send"),
    engineStarted: atOf(own, "engine.submit"),
    firstText: atOf(own, "engine.first-text") ?? atOf(own, "engine.first-token") ?? atOf(own, "ttft"),
    engineCold: own?.engineCold, pooling: own?.pooling,
    resumed, resets: resets.length, resetReasons: resets.slice(0, 2).map(l => l.slice(0, 160)),
    recallMs: final?.["memory.bundle"]?.ms ?? (final?.mem?.recall !== undefined ? Number(final.mem.recall) : undefined),
    recallMode: final?.mem?.recallMode, recallHits: recall.hits, recallHitsSource: recall.source,
  };
}

/** Slope turns that truly resumed the session: the engine resumed it (`resumed=true` on the turn's own line) and no
 * reset happened in the turn. The first turn may open the session, so the share counts turns 2 onward. */
export const trulyResumed = t => t.resumed === true && t.resets === 0;
export function resumedShare(turns) {
  const rest = turns.slice(1);
  return rest.length ? rest.filter(trulyResumed).length / rest.length : null;
}
export const MIN_RESUMED_SHARE = 0.9;

/** The revocation index state an action ran in: both reads ready → "ready", both not → "building", else "flipped". */
export function indexState(before, after) {
  if (before === null || before === undefined || after === null || after === undefined) return "unknown";
  if (Boolean(before) !== Boolean(after)) return "flipped";
  return before ? "ready" : "building";
}

// ---- network waterfall (pw.mjs)
/** Waterfall rows: path only (no origin), times in ms from t0, ordered by start; a request still open has end null. */
export function waterfallRows(rows, t0, origin) {
  const base = String(origin ?? "").replace(/\/+$/, "");
  return rows.map(r => ({
    url: base && r.url.startsWith(base) ? r.url.slice(base.length) || "/" : r.url,
    method: r.method, type: r.type, start: Math.round(r.start - t0), end: r.end === undefined ? null : Math.round(r.end - t0),
    ms: r.end === undefined ? null : Math.round(r.end - r.start), status: r.status ?? null, bytes: r.bytes ?? null, ...(r.failed ? { failed: r.failed } : {}),
  })).sort((a, b) => a.start - b.start);
}

// ---- the turn trace (MURAGE_TURN_TRACE=1 lines the server writes)

/** The trace lines of a log by turn id: each phase's time since the turn was received (`at`), and for a span its duration (`ms`). */
export function parseTrace(text) {
  const byId = {};
  for (const l of text.split("\n")) {
    if (!l.includes("[turn-trace]")) continue;
    const id = /id=(\w+)/.exec(l)?.[1], p = /phase=([\w.\-/]+)/.exec(l)?.[1], at = Number(/ at=(\d+)/.exec(l)?.[1]), ms = /\bms=(\d+)/.exec(l)?.[1];
    if (!id || !p) continue;
    const ph = (byId[id] ??= {});
    if (ph[p] === undefined) ph[p] = ms !== undefined ? { at, ms: Number(ms) } : at;
    // The recall results of THIS turn: counted by the server on the bundle it accepted for the dispatch (the line of the dispatch itself),
    // never taken from the process-wide counters of the recall spans, which another turn's recall can move.
    if (p === "dispatch.send") { const h = /\brecallHits=(\d+)/.exec(l)?.[1]; if (h !== undefined) ph.hits = Number(h); }
    if (p === "turn.done") ph.outcome = /outcome=([\w-]+)/.exec(l)?.[1];
  }
  return byId;
}
/** The clocks of one turn, each at the event it names: `prep` is the time to the dispatch call, `engineStarted` the time (since the
 * message was received) at which the engine adapter was handed the turn, `firstText` the first text from the engine. */
export function turnClocks(ph) {
  return {
    prep: atOf(ph, "dispatch.send") ?? atOf(ph, "prompt.sent"),
    engineStarted: atOf(ph, "engine.submit"),
    firstText: atOf(ph, "engine.first-text") ?? atOf(ph, "engine.first-token") ?? atOf(ph, "ttft"),
  };
}

// ---- the post-upgrade check (/api/health `upgrade`, shared/upgrade-contract.mjs version 2)

const STAGES = ["starting", "background", "blocked", "idle", "unknown"];
const TRI = [true, false, "unknown"];
/** What one /api/health reading says about the upgrade: { kind, percent, stage, phase, reason? }.
 *  kind "running": the after-start check is working (stage "background", complete is not true);
 *  kind "finished": the contract says so explicitly (complete === true);
 *  kind "failed": the contract reports a blocked upgrade;
 *  kind "waiting": the server is still starting (stage "starting");
 *  kind "unknown": no reading, an older server, or a reading that is not the contract's shape. Never a success. */
export function upgradeStatus(health) {
  const u = health?.upgrade;
  if (u === null || typeof u !== "object" || Array.isArray(u)) return { kind: "unknown", reason: health ? "no upgrade field" : "no reading" };
  if (u.v !== 2) return { kind: "unknown", reason: u.v === undefined ? "legacy" : "contract version" };
  if (!STAGES.includes(u.stage) || !TRI.includes(u.complete) || !(u.overall === "unknown" || (typeof u.overall === "number" && u.overall >= 0 && u.overall <= 1))) return { kind: "unknown", reason: "malformed" };
  if (u.blocked !== null && u.blocked !== undefined || u.stage === "blocked") return { kind: "failed", stage: u.stage, phase: u.phase, reason: `blocked ${u.blocked?.code ?? ""}`.trim() };
  const percent = typeof u.overall === "number" ? Math.round(u.overall * 1000) / 10 : null;
  // What counts as movement: the overall fraction, the phase, the counted step's done figure, or the time the server last saw the work
  // move (progressAt). A phase whose step is not counted still moves progressAt, so a long uncounted phase is not read as frozen.
  const done = u.step !== null && typeof u.step === "object" && typeof u.step.done === "number" ? u.step.done : null;
  const progress = JSON.stringify([percent, u.phase ?? null, done, typeof u.progressAt === "number" ? u.progressAt : null]);
  if (u.complete === true) return { kind: "finished", percent, progress, stage: u.stage, phase: u.phase };
  if (u.stage === "background") return { kind: "running", percent, progress, stage: u.stage, phase: u.phase };
  if (u.stage === "starting") return { kind: "waiting", percent, progress, stage: u.stage, phase: u.phase };
  return { kind: "unknown", stage: u.stage, phase: u.phase, reason: "not running and not complete" };
}

/** The longest time the check's progress stayed the same, measured by reading it on its own clock (independent of any message). The
 * progress is a percent, or the `progress` marker of upgradeStatus (percent, phase, step done, progressAt): any change is movement. */
export function progressClock(startProgress, startAt) {
  let last = startProgress, since = startAt, longest = 0;
  const gaps = [];
  return {
    /** A reading at `at` ms (a clock the caller keeps). A reading with no progress does not move the clock. */
    read(progress, at) {
      longest = Math.max(longest, at - since);
      if (progress !== null && progress !== undefined && progress !== last) { gaps.push(Math.round(at - since)); last = progress; since = at; }
    },
    finish(at) { longest = Math.max(longest, at - since); gaps.push(Math.round(at - since)); return { gaps, longest: Math.round(longest) }; },
  };
}

/** The scenario's numbers into what the gate reads. `finishedFlag` is 1 only when the contract reported completion; `samplesFlag` is 1
 * only when every message got all three clocks and completed (a missing timing is a failure, not a smaller sample). */
export function upgradeChatResult({ finished, failedReason, sends, pollFailures, pollCount }) {
  const complete = sends.filter(t => t.outcome === "turn.completed" && Number.isFinite(t.acceptedMs) && Number.isFinite(t.engineStarted) && Number.isFinite(t.firstText));
  return {
    finishedFlag: finished ? 1 : 0,
    failedSends: sends.length - sends.filter(t => t.outcome === "turn.completed").length,
    samplesFlag: sends.length > 0 && complete.length === sends.length ? 1 : 0,
    pollFailures, pollCount, ...failedReason ? { failedReason } : {},
  };
}
