// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// q1022-idlerest (HIDDEN-COST-fable H15, H16; MAIN-RULING 2026-11-25T15:34:47Z pip-reflect.ts:439-446 + :1629-1633).
// W-REFLECT-UNSUPPORTED-IDLE: a bot whose route cannot reflect re-read every thread's whole history every 5 min (SUPPORT_RECHECK_MS) only to
// learn again that the route is unsupported. Now the recheck resolves the route first: an unchanged unsupported route reads no thread and
// waits twice as long each time (5 min to 24 h); a changed route reads the threads again.
// W-REFLECT-UNSTABLE-GIVEUP: a thread whose run ends refused as unstable was retried after every 2 h cooldown forever, each run spending
// its paid calls. After UNSTABLE_RUNS_GIVE_UP such runs the thread is given up until a newer turn arrives.
// Both drive the real idle-lane entry (index.ts onContinuity: pipReflectPendingSliced, then runPipReflect) on a real store; the engine is a
// stub route (no process, no network) and the paid call is a stubbed fetch under the real http text-only turn.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as reaper from "./pip-reaper.ts";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { httpTextOnlyTurn } from "../drivers/http-text-only.ts";
import { setMemoryCaptureRoster } from "./capture-scope.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { setMemoryMode } from "./repository.ts";
import { COOLDOWN_MS, pipReflectPendingSliced, readReflectState, resetPipPendingScans, runPipReflect, type ReflectBot, type ReflectDeps } from "./pip-reflect.ts";
import { captureStoredMessage } from "./testing/captured-message.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { memoryOwnerRoute } from "./settings.ts";

vi.mock("../procs.ts", async original => ({ ...await original<typeof import("../procs.ts")>(), spawnCli: vi.fn(), awaitCliTreeStopped: vi.fn(async () => true) }));
const T0 = 1_760_000_000_000, MIN = 60_000, HOUR = 60 * MIN, THREAD = "private";
let clock = T0;
const restore: Array<() => void> = [];
const roster = { bots: [{ id: "moss", threadId: THREAD, tasks: [] as Array<{ threadId: string }> }], groups: [] as never[] };
beforeEach(() => {
  vi.spyOn(reaper, "registerChild").mockImplementation(async pid => ({ pid: pid!, startTime: "fixture", registeredAt: Date.now() }));
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); resetPipPendingScans();
  reconcileMemoryRoster(roster as never); setMemoryMode("active"); setMemoryCaptureRoster(() => roster as never);
  clock = T0 + 24 * HOUR;
});
afterEach(() => { for (const undo of restore.splice(0)) undo(); vi.restoreAllMocks(); vi.useRealTimers(); setMemoryCaptureRoster(null); });

const owner = (id: string, at: number) => ({ id, at, role: "user", kind: "text", text: `Please keep it short (${id}).`, origin: "desktop" }) as never;
const reply = (id: string, at: number) => ({ id, at, role: "bot", kind: "text", text: "Sure.", turnTerminal: true, from: { botId: "moss" } }) as never;
const completeJobs = () => database().exec("UPDATE memory_jobs SET status='complete',cursor=100 WHERE status<>'complete'");
function capturePairs(pairs: number, from: number, thread = THREAD) {
  const db = database();
  for (let n = 0; n < pairs; n++) {
    const name = `${from}-${String(n).padStart(4, "0")}`;
    captureStoredMessage(db, thread, owner(`o-${thread}-${name}`, from + n * MIN));
    captureStoredMessage(db, thread, reply(`b-${thread}-${name}`, from + n * MIN + 1_000));
  }
  completeJobs();
}
/** Every execution of the thread page statement (pip-admission.ts threadSourcePageSql) on the connection. */
function countPages(db: DatabaseSync) {
  const real = db.prepare, wrapped = new WeakSet<object>();
  let runs = 0;
  db.prepare = function (this: DatabaseSync, sql: string, ...rest: unknown[]): StatementSync {
    const statement = (real as (...args: unknown[]) => StatementSync).call(this, sql, ...rest);
    if (!sql.startsWith("SELECT s.rowid AS pos,s.id,s.revision,s.message_id,s.thread_id,s.speaker,s.outcome,v.payload FROM memory_sources s") || wrapped.has(statement)) return statement;
    wrapped.add(statement);
    const all = statement.all as (...args: unknown[]) => unknown[];
    (statement as unknown as Record<string, unknown>).all = (...args: unknown[]) => { runs++; return all.apply(statement, args); };
    return statement;
  } as typeof db.prepare;
  restore.push(() => { db.prepare = real; });
  return { runs: () => runs };
}
/** One sweep of the idle lane, as index.ts onContinuity runs it. */
async function sweep(deps: ReflectDeps) {
  const signal = new AbortController().signal;
  const botId = await pipReflectPendingSliced(deps, undefined, signal);
  return botId ? await runPipReflect(deps, botId, signal) : { status: "nothing-pending" as const };
}
const bot = { id: "moss", name: "Moss", threadIds: [THREAD], continuity: true, options: { reflect: true as const } };

it("W-REFLECT-UNSUPPORTED-IDLE: an unchanged unsupported route reads 0 thread pages per 5 min and backs its recheck off; a changed route reads again", async () => {
  capturePairs(100, T0);
  let fingerprint = "fp-held", resolves = 0;
  const deps = { now: () => clock, bootEpoch: { pid: 1, startedAt: 1 }, tmpBase: "/tmp", memoryMode: () => "active", bots: () => [bot],
    resolveRoute: async () => { resolves++; return { fingerprint, engine: "Stub", kind: "cli", model: "m", unsupported: { reason: "no-text-only-turn" } }; } } as unknown as ReflectDeps;
  const pages = countPages(database());
  expect(await sweep(deps)).toMatchObject({ status: "refused", reason: "unsupported" });
  const first = pages.runs(), firstResolves = resolves;
  expect(first).toBeGreaterThan(0);
  // two idle hours, one sweep a minute: every 5-min window reads no thread page
  const perWindow: number[] = [];
  for (let window = 0; window < 24; window++) {
    const before = pages.runs();
    for (let minute = 0; minute < 5; minute++) { clock += MIN; await sweep(deps); }
    perWindow.push(pages.runs() - before);
  }
  expect(perWindow, "thread pages read per 5-min window").toEqual(Array(24).fill(0));
  // the route itself is rechecked on a doubling wait: 5, 10, 20, 40 min... so at most 5 rechecks in two hours (unfixed: 24)
  expect(resolves - firstResolves).toBeLessThanOrEqual(5);
  expect(resolves - firstResolves).toBeGreaterThan(0);
  // a changed route is a new fingerprint: the next recheck reads the threads again for it
  fingerprint = "fp-new";
  clock += 25 * HOUR;
  expect(await sweep(deps)).toMatchObject({ status: "refused", reason: "unsupported" });
  expect(pages.runs()).toBeGreaterThan(first);
  expect(readReflectState(database(), "moss").lastFingerprint).toBe("fp-new");
}, 120_000);

const answer = (content: unknown) => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 100, completion_tokens: 50 } }), { status: 200, headers: { "content-type": "application/json" } });
const failures = {
  // the model answers content that never validates: refused as bad output, the run's paid call spent
  "bad-output": () => answer({ nope: 1 }),
  // the answer validates but names a sentence no admitted source has: each attempt is asked again, the third ends refused as unstable
  "unstable": () => answer({ proposals: [{ act: "PREFER", spans: [{ sourceId: "no-such-source", start: 0, end: 4 }] }], stance: [], episode: null }),
} as const;
it.each(Object.keys(failures) as Array<keyof typeof failures>)("W-REFLECT-UNSTABLE-GIVEUP (%s): a thread whose runs fail three times spends no more paid calls on the same history; a newer turn is tried again", async kind => {
  vi.useFakeTimers({ toFake: ["Date"] });
  capturePairs(3, T0);
  const fetchImpl = vi.fn(async () => failures[kind]()) as unknown as typeof fetch;
  const deps: ReflectDeps = {
    now: () => clock, bootEpoch: { pid: 1, startedAt: 1 }, tmpBase: join(DATA_DIR, "pip-tmp"), bots: () => [bot], memoryMode: () => "active",
    resolveRoute: async () => ({ fingerprint: "fp-http", engine: "Stub http", kind: "http", model: "m", textOnlyTurn: (input: Parameters<typeof httpTextOnlyTurn>[0]) => httpTextOnlyTurn(input, { baseUrl: "http://127.0.0.1:9/v1", apiKey: "k", buildBody: (model, messages) => ({ model, messages }), fetchImpl }) }),
  } as unknown as ReflectDeps;
  const calls = () => vi.mocked(fetchImpl).mock.calls.length;
  const perRound: number[] = [], states: string[] = [];
  // twelve rounds, each past the 2 h cooldown (one day); the process clock follows (the per-minute call pace reads it)
  for (let round = 0; round < 12; round++) {
    clock += COOLDOWN_MS + MIN; vi.setSystemTime(clock);
    const before = calls();
    for (let pass = 0; pass < 8; pass++) await sweep(deps);
    perRound.push(calls() - before);
    { const st = readReflectState(database(), "moss"); states.push(JSON.stringify({ r: st.refusals[0]?.state, t: st.threads[THREAD], run: st.run && Object.values(st.run.families).map(f => [f.state, f.reason, Boolean(f.transport)]) })); }
  }
  expect(perRound.slice(0, 3).every(n => n > 0), `paid calls per round: ${JSON.stringify(perRound)} ${JSON.stringify(states)}`).toBe(true);
  expect(perRound.slice(3), `paid calls per round after three failed runs: ${JSON.stringify(perRound)} ${JSON.stringify(states)}`).toEqual(Array(9).fill(0));
  // a newer owner turn, answered and settled, makes the thread a candidate again
  capturePairs(1, clock - 30 * MIN);
  clock += COOLDOWN_MS + MIN; vi.setSystemTime(clock);
  const round = async () => { clock += COOLDOWN_MS + MIN; vi.setSystemTime(clock); const at = calls(); for (let pass = 0; pass < 8; pass++) await sweep(deps); return calls() - at; };
  const before = calls();
  for (let pass = 0; pass < 8; pass++) await sweep(deps);
  expect(calls()).toBeGreaterThan(before);
  // self-review H2: the thread fails on until it is given up again; the owner's Try again (the settings route) tries it again at once
  const again: number[] = [];
  for (let n = 0; n < 6 && again.at(-1) !== 0; n++) again.push(await round());
  expect(again.at(-1), `paid calls per round until given up again: ${JSON.stringify(again)}`).toBe(0);
  expect(await memoryOwnerRoute("/api/memory/action", { action: "pip-reflect-retry", botId: "moss" }, ownerMemoryTicket(), roster as never)).toEqual({ ok: true });
  expect(await round(), "paid calls in the round after Try again").toBeGreaterThan(0);
}, 120_000);

// self-review H1: routes are per thread. A bot held unsupported on its own thread whose task thread runs a supported route: the recheck reads
// the threads (the task thread resolves elsewhere) and the task thread is reflected. Unfixed, only the held thread's route was resolved.
it("W-REFLECT-UNSUPPORTED-OTHER-ROUTE: a held route on one thread does not stop a task thread on a supported route", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const TASK = "task-1";
  roster.bots[0]!.tasks.push({ threadId: TASK });
  restore.push(() => { roster.bots[0]!.tasks.length = 0; });
  reconcileMemoryRoster(roster as never);
  capturePairs(3, T0);
  const fetchImpl = vi.fn(async () => answer({ proposals: [], stance: [], episode: null })) as unknown as typeof fetch;
  const two = { ...bot, threadIds: [THREAD, TASK] };
  const deps: ReflectDeps = {
    now: () => clock, bootEpoch: { pid: 1, startedAt: 1 }, tmpBase: join(DATA_DIR, "pip-tmp"), bots: () => [two], memoryMode: () => "active",
    resolveRoute: async (_bot: unknown, threadId: string) => threadId === TASK
      ? { fingerprint: "fp-http", engine: "Stub http", kind: "http", model: "m", textOnlyTurn: (input: Parameters<typeof httpTextOnlyTurn>[0]) => httpTextOnlyTurn(input, { baseUrl: "http://127.0.0.1:9/v1", apiKey: "k", buildBody: (model, messages) => ({ model, messages }), fetchImpl }) }
      : { fingerprint: "fp-held", engine: "Stub", kind: "cli", model: "m", unsupported: { reason: "no-text-only-turn" } },
  } as unknown as ReflectDeps;
  vi.setSystemTime(clock);
  expect(await sweep(deps)).toMatchObject({ status: "refused", reason: "unsupported" });
  expect(readReflectState(database(), "moss").support["fp-held"]).toMatchObject({ status: "unsupported", thread: THREAD });
  // the task thread gets turns of its own; an hour of idle sweeps, one a minute
  capturePairs(3, clock - 2 * HOUR, TASK);
  for (let minute = 0; minute < 60 && vi.mocked(fetchImpl).mock.calls.length === 0; minute++) { clock += MIN; vi.setSystemTime(clock); await sweep(deps); }
  expect(vi.mocked(fetchImpl).mock.calls.length, "paid calls for the task thread on its supported route").toBeGreaterThan(0);
}, 120_000);

// self-review r4 H1: the blocked start of a held thread re-arms its recheck but does not double it; only a recheck that finds every thread on
// the held route doubles it. Unfixed, three quiet hours of a held main thread pushed the bot's recheck past two hours, so a task thread on a
// supported route waited that long for its first run.
it("W-REFLECT-UNSUPPORTED-QUIET-TASK: after three quiet hours of a held main thread, a task thread's new turns on a supported route run within the 5 min recheck", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const TASK = "task-1";
  roster.bots[0]!.tasks.push({ threadId: TASK });
  restore.push(() => { roster.bots[0]!.tasks.length = 0; });
  reconcileMemoryRoster(roster as never);
  capturePairs(3, T0);
  const fetchImpl = vi.fn(async () => answer({ proposals: [], stance: [], episode: null })) as unknown as typeof fetch;
  const two = { ...bot, threadIds: [THREAD, TASK] };
  const deps: ReflectDeps = {
    now: () => clock, bootEpoch: { pid: 1, startedAt: 1 }, tmpBase: join(DATA_DIR, "pip-tmp"), bots: () => [two], memoryMode: () => "active",
    resolveRoute: async (_bot: unknown, threadId: string) => threadId === TASK
      ? { fingerprint: "fp-http", engine: "Stub http", kind: "http", model: "m", textOnlyTurn: (input: Parameters<typeof httpTextOnlyTurn>[0]) => httpTextOnlyTurn(input, { baseUrl: "http://127.0.0.1:9/v1", apiKey: "k", buildBody: (model, messages) => ({ model, messages }), fetchImpl }) }
      : { fingerprint: "fp-held", engine: "Stub", kind: "cli", model: "m", unsupported: { reason: "no-text-only-turn" } },
  } as unknown as ReflectDeps;
  vi.setSystemTime(clock);
  expect(await sweep(deps)).toMatchObject({ status: "refused", reason: "unsupported" });
  // three quiet hours on the task thread, one sweep a minute
  for (let minute = 0; minute < 180; minute++) { clock += MIN; vi.setSystemTime(clock); await sweep(deps); }
  expect(vi.mocked(fetchImpl).mock.calls.length).toBe(0);
  capturePairs(3, clock - 2 * HOUR, TASK);
  const sweeps: number[] = [];
  for (let minute = 0; minute < 6; minute++) { clock += MIN; vi.setSystemTime(clock); await sweep(deps); sweeps.push(vi.mocked(fetchImpl).mock.calls.length); }
  expect(sweeps.at(-1), `paid calls for the task thread within six minutes of its turns: ${JSON.stringify(sweeps)}`).toBeGreaterThan(0);
}, 120_000);

// Astra precheck (r4) High: after hours of an all-unsupported bot (its recheck doubled), a task added on a supported route waits only the
// 5 min recheck, not the doubled wait: the doubled wait holds only for the thread list it was found on.
it("W-REFLECT-UNSUPPORTED-NEW-TASK: a task thread added on a supported route after three backed-off hours runs within the 5 min recheck", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const TASK = "task-1";
  capturePairs(3, T0);
  const fetchImpl = vi.fn(async () => answer({ proposals: [], stance: [], episode: null })) as unknown as typeof fetch;
  let current = { ...bot, threadIds: [THREAD] as string[] };
  const deps: ReflectDeps = {
    now: () => clock, bootEpoch: { pid: 1, startedAt: 1 }, tmpBase: join(DATA_DIR, "pip-tmp"), bots: () => [current], memoryMode: () => "active",
    resolveRoute: async (_bot: unknown, threadId: string) => threadId === TASK
      ? { fingerprint: "fp-http", engine: "Stub http", kind: "http", model: "m", textOnlyTurn: (input: Parameters<typeof httpTextOnlyTurn>[0]) => httpTextOnlyTurn(input, { baseUrl: "http://127.0.0.1:9/v1", apiKey: "k", buildBody: (model, messages) => ({ model, messages }), fetchImpl }) }
      : { fingerprint: "fp-held", engine: "Stub", kind: "cli", model: "m", unsupported: { reason: "no-text-only-turn" } },
  } as unknown as ReflectDeps;
  vi.setSystemTime(clock);
  expect(await sweep(deps)).toMatchObject({ status: "refused", reason: "unsupported" });
  for (let minute = 0; minute < 180; minute++) { clock += MIN; vi.setSystemTime(clock); await sweep(deps); }
  expect(readReflectState(database(), "moss").support["fp-held"]?.rechecks ?? 0, "the recheck backed off").toBeGreaterThanOrEqual(4);
  // the owner adds a task on a supported route; it has turns of its own
  roster.bots[0]!.tasks.push({ threadId: TASK });
  restore.push(() => { roster.bots[0]!.tasks.length = 0; });
  reconcileMemoryRoster(roster as never);
  current = { ...bot, threadIds: [THREAD, TASK] };
  capturePairs(3, clock - 2 * HOUR, TASK);
  const sweeps: number[] = [];
  for (let minute = 0; minute < 6; minute++) { clock += MIN; vi.setSystemTime(clock); await sweep(deps); sweeps.push(vi.mocked(fetchImpl).mock.calls.length); }
  expect(sweeps.at(-1), `paid calls for the new task within six minutes of its turns: ${JSON.stringify(sweeps)}`).toBeGreaterThan(0);
}, 120_000);

// OPUS da966621a1 H2 / 085fb239ee H1, ASTRA 085fb239ee: an owner who moved a backed-off bot to a supported engine (same thread list) waited the
// doubled recheck, up to 24 h, because the gate read the old fingerprint's entry before any route was resolved. The doubled wait now holds only
// for the route choice it was found on (ReflectBot.routeStamp: each thread's model selection and the reflect model).
it("W-REFLECT-REROUTE: an owner who moves a backed-off bot to a supported engine gets a run within the 5 min recheck", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  capturePairs(3, T0);
  const fetchImpl = vi.fn(async () => answer({ proposals: [], stance: [], episode: null })) as unknown as typeof fetch;
  // the server's store as index.ts hands it to pipReflectDeps.bots (reflectBotsOf(store)); the owner's engine is the bot's model selection
  const storeBot = { id: "moss", name: "Moss", continuity: true, continuityOptions: { reflect: true }, continuityGeneration: 0, modelSelection: { instanceId: "stub-cli", model: "m" } };
  const store = { bots: [storeBot], threadIdsForBot: () => [THREAD], projectBotForTask: () => null };
  // read through the module namespace: on the pre-fix sha (no reflectBotsOf) this is index.ts's mapping there, verbatim, so the base run
  // reaches the behavioural assertion
  const host: Record<string, unknown> = await import("./pip-reflect-host.ts");
  const botsOf = (host.reflectBotsOf as ((s: typeof store) => () => ReflectBot[]) | undefined)
    ?? ((s: typeof store) => () => s.bots.map(b => ({ id: b.id, name: b.name, threadIds: s.threadIdsForBot(), continuity: b.continuity === true, options: b.continuityOptions, settingsGeneration: b.continuityGeneration })));
  const deps: ReflectDeps = {
    now: () => clock, bootEpoch: { pid: 1, startedAt: 1 }, tmpBase: join(DATA_DIR, "pip-tmp"), memoryMode: () => "active",
    bots: botsOf(store),
    resolveRoute: async () => storeBot.modelSelection.instanceId === "stub-http"
      ? { fingerprint: "fp-http", engine: "Stub http", kind: "http", model: "m", textOnlyTurn: (input: Parameters<typeof httpTextOnlyTurn>[0]) => httpTextOnlyTurn(input, { baseUrl: "http://127.0.0.1:9/v1", apiKey: "k", buildBody: (model, messages) => ({ model, messages }), fetchImpl }) }
      : { fingerprint: "fp-held", engine: "Stub", kind: "cli", model: "m", unsupported: { reason: "no-text-only-turn" } },
  } as unknown as ReflectDeps;
  vi.setSystemTime(clock);
  expect(await sweep(deps)).toMatchObject({ status: "refused", reason: "unsupported" });
  for (let minute = 0; minute < 180; minute++) { clock += MIN; vi.setSystemTime(clock); await sweep(deps); }
  expect(readReflectState(database(), "moss").support["fp-held"]?.rechecks ?? 0, "the recheck backed off").toBeGreaterThanOrEqual(4);
  expect(vi.mocked(fetchImpl).mock.calls.length).toBe(0);
  // the owner moves the bot to a supported engine; its thread list is unchanged
  storeBot.modelSelection = { instanceId: "stub-http", model: "m" };
  const sweeps: number[] = [];
  for (let minute = 0; minute < 6; minute++) { clock += MIN; vi.setSystemTime(clock); await sweep(deps); sweeps.push(vi.mocked(fetchImpl).mock.calls.length); }
  expect(sweeps.at(-1), `paid calls within six minutes of the reroute: ${JSON.stringify(sweeps)}`).toBeGreaterThan(0);
}, 120_000);

it("reflectRouteStamp moves with any thread's model selection or the reflect model, and with nothing else", async () => {
  const { reflectRouteStamp } = await import("./pip-reflect-host.ts");
  const sel: Record<string, { instanceId: string; model: string; connectionId?: string }> = { a: { instanceId: "i1", model: "m1" }, b: { instanceId: "i1", model: "m1" } };
  const of = (t: string) => sel[t];
  const base = reflectRouteStamp({ threadIds: ["a", "b"], options: {} as never }, of);
  expect(reflectRouteStamp({ threadIds: ["a", "b"], options: {} as never }, of)).toBe(base);
  sel.b = { instanceId: "i2", model: "m1" };
  expect(reflectRouteStamp({ threadIds: ["a", "b"], options: {} as never }, of)).not.toBe(base);
  sel.b = { instanceId: "i1", model: "m1" };
  expect(reflectRouteStamp({ threadIds: ["a", "b"], options: { reflectModel: "m9" } as never }, of)).not.toBe(base);
  sel.a = { instanceId: "i1", model: "m1", connectionId: "c1" };
  expect(reflectRouteStamp({ threadIds: ["a", "b"], options: {} as never }, of)).not.toBe(base);
});
