// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.18 TURNSTART r14/r15/r15.1: the ONE test seam the r14/r15 tests read (testing/turnstart-r14-surface.ts is the contract). Test-only: no
// production code calls anything here (lineage-warm.ts only re-exports lineageWarmTestSurface). It builds fixtures in the test DB, drives
// the warmer on a fake clock, and runs one plain turn the way the turn runs it from IX:12707 on (catch-up, the IX:13283 compare and record,
// E2 -> recall -> E1 on the turn's own inputs, a cold legacy answer, the bot reply).
// Module cycle: lineage-warm.ts re-exports this file and this file imports lineage-warm.ts; nothing here touches LW at load time.
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { installWriteRevisionTriggers } from "../app-write-revision.ts";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import type { Message } from "../store.ts";
import { continuationMemoryRevoked, filterDirectReplay, resetSessionHolds, setSessionHoldsMaxForTest } from "./disclosures.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { accessStamp, compareLineageFootprint, externalUpdatesKey, footprintHash, lineageFootprintCounters, noteLineageFootprint,
  resetLineageFootprintCountersForTest, type LineageFootprint, type UserKind } from "./lineage-footprint.ts";
import * as LW from "./lineage-warm.ts";
import { ensureScope, memoryAccess, reconcileMemoryRoster, type MemoryAccess, type MemoryRoster } from "./policy.ts";
import { catchUpRecentMemory } from "./recent.ts";
import { LARGE_ROOT_SET, forceProofRestartForTest, forgetKeptLineageForTest, lineageBuilderKeysForTest, onProducerBranchForTest, outputRootsFor, prepareLineageCache, recordSessionRoots,
  setEdgeBoundForTest, setReplayNodeBudgetForTest, setVerdictLimitForTest } from "./replay-lineage.ts";
import { setMemoryMode } from "./repository.ts";
import { setMaxHandlesForTest } from "./root-set-handles.ts";
import { chainStore } from "./schema.ts";
import { resumeCursorOf } from "./session-incarnation.ts";
import { stampFreshSession } from "./testing/writetime-fixture.ts";
import { owner, verdictStore as store, type MapName } from "./verdict-store.ts";

const SEP = "\u001f";
const DRIVER = "engine";
const BOT = "bot";

// ---- statements at the SQL layer (judgeStatements: statements run inside warm steps) ----
const tally = { statements: 0, judge: 0 };
let inStep = false;
let tallyInstalled = false;
/** Installed on the first surface call (tests only), never at module load: production loads this file through the lineage-warm.ts re-export and must not wrap statements. */
function installStatementTally(): void {
  if (tallyInstalled) return;
  tallyInstalled = true;
  const realPrepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
    const statement = realPrepare.call(this, sql);
    const own = statement as unknown as Record<string, (...args: unknown[]) => unknown>;
    for (const name of ["get", "all", "run", "iterate"] as const) {
      const real = own[name]!.bind(statement);
      own[name] = (...args) => { tally.statements++; if (inStep) tally.judge++; return real(...args); };
    }
    return statement;
  } as typeof realPrepare;
}

// ---- the environment (module-wide: one test DB at a time) ----
interface TaskRow { cursor: { instance: string; session: string; incarnation: number } | null; externalUpdates: string[] }
const env = {
  now: 1_000_000,
  roster: { bots: [{ id: BOT, threadId: "", tasks: [] as Array<{ threadId: string }> }], groups: [] } as MemoryRoster,
  threads: [] as string[],
  n: 0,
  taskRows: new Map<string, TaskRow>(),
  maxBytes: new Map<string, number>(),
  uncertain: new Set<string>(),
  nonOwner: new Set<string>(),
  freshSession: new Set<string>(),
  loseAfterDispatch: new Set<string>(),
  lastSent: new Map<string, string>(),
  pendingCapture: new Set<string>(),
  throwLines: 0,
  renewals: 0,
  held: 0,
  warmStepsBetweenSendAndDispatch: 0,
  storeLog: [] as Array<{ map: MapName | "gen"; key?: string; why: string }>,
  testMint: null as ((botId: string, threadId: string) => unknown) | null,
};

function access(thread: string, notOwnerAudience = false): MemoryAccess {
  const registry = new InternalCapabilities(); registry.begin(BOT, thread, "g");
  const claim = registry.resolve(`Bearer ${registry.mint({ botId: BOT, threadId: thread, generation: "g", depth: 0, kind: "memory", skillAuthoring: false,
    ...(notOwnerAudience ? { notOwnerAudience: true as const } : {}) })}`)!;
  return memoryAccess(registry, claim, () => env.roster);
}
/** The surface's mint: the owner's access for its own chat; a non-owner fixture thread is read by a non-owner audience (SHARED, DI:550). */
function surfaceMint(_botId: string, thread: string): MemoryAccess | null { return access(thread, env.nonOwner.has(thread)); }
const mint = (botId: string, thread: string): MemoryAccess | null => (env.testMint ? env.testMint(botId, thread) as MemoryAccess | null : surfaceMint(botId, thread));

/** The default line index: the test DB's message rows of the thread, text rows newest first (activeTextLines' shape). */
const dbLines = {
  activeTextLines(threadId: string, limit: number): { messages: Message[]; hasMore: boolean; exact: boolean } {
    if (env.throwLines > 0) { env.throwLines--; throw new Error("fixture: the line index threw (feed-throws)"); }
    const rows = database().prepare("SELECT id, role, kind, text, at, json FROM messages WHERE thread_id=? AND kind='text' ORDER BY rowid DESC LIMIT ?").all(threadId, limit + 1);
    const messages = rows.slice(0, limit).reverse().map(row => {
      let extra: Record<string, unknown> = {};
      try { extra = JSON.parse(String(row.json ?? "{}")) as Record<string, unknown>; } catch { extra = {}; }
      return { ...extra, id: String(row.id), role: String(row.role), kind: String(row.kind), text: String(row.text ?? ""), at: Number(row.at ?? 0) } as unknown as Message;
    });
    // the uncertain-branch fixture: the walk could not say which rows are on the branch (MDB:392), so the read is not exact
    return { messages, hasMore: rows.length > limit, exact: !env.uncertain.has(threadId) };
  },
};
/** The default task row: the surface's own for its fixtures, else the thread's newest retained session in the test DB. */
function dbTask(threadId: string): LW.LineageTaskRow | null {
  const own = env.taskRows.get(threadId);
  if (own) {
    return own.cursor ? { resumeCursors: { [own.cursor.instance]: own.cursor.session }, resumeIncarnations: { [own.cursor.instance]: own.cursor.incarnation }, externalUpdates: own.externalUpdates }
      : { externalUpdates: own.externalUpdates };
  }
  const row = database().prepare("SELECT driver_instance AS d, native_session AS s FROM memory_disclosures WHERE thread_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(threadId);
  return row ? { resumeCursors: { [String(row.d)]: String(row.s) }, resumeIncarnations: { [String(row.d)]: 1 } } : { };
}
function cursorOf(thread: string): LineageFootprint["cursor"] {
  const task = dbTask(thread);
  const entry = Object.entries(task?.resumeCursors ?? {})[0];
  if (!entry) return null;
  const [instanceId, raw] = entry;
  const incarnation = task?.resumeIncarnations?.[instanceId];
  return resumeCursorOf(thread, instanceId, String(raw), incarnation);
}
function turnFootprint(thread: string, over?: Partial<LineageFootprint>): LineageFootprint {
  const who = mint(BOT, thread);
  const task = dbTask(thread);
  const f: LineageFootprint = {
    botId: BOT, threadId: thread, accessStamp: who ? accessStamp(who) : "none", userKind: "APPENDED", exclude: [], projectCardRun: false,
    routeHasTools: false, externalUpdates: externalUpdatesKey(task?.externalUpdates), maxBytes: env.maxBytes.get(thread) ?? -1, cursor: cursorOf(thread),
  };
  return { ...f, ...over, exclude: [...(over?.exclude ?? f.exclude)] };
}
function installSources(given?: { mint?: (botId: string, threadId: string) => unknown; lines?: unknown; task?: unknown }): void {
  env.testMint = given?.mint ?? null;
  LW.setLineageConfirmSourcesForTest({
    mint: (botId, thread) => mint(botId, thread),
    lines: () => (given?.lines as LW.LineageConfirmSources["lines"] extends () => infer R ? R : never) ?? dbLines,
    task: given?.task ? given.task as LW.LineageConfirmSources["task"] : dbTask,
    prepared: () => true,
  });
  LW.setLineageDefaultFootprintForTest(thread => turnFootprint(thread));
}

function reset(): void {
  LW.resetLineageWarmForTest(); forceProofRestartForTest(null);
  closeDatabase(); forgetKeptLineageForTest(); store.resetForTest();
  removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  env.now = 1_000_000; env.threads = []; env.n = 0; env.taskRows.clear(); env.maxBytes.clear(); env.uncertain.clear(); env.nonOwner.clear();
  env.freshSession.clear(); env.loseAfterDispatch.clear(); env.lastSent.clear(); env.pendingCapture.clear(); env.throwLines = 0; env.renewals = 0; env.held = 0; env.warmStepsBetweenSendAndDispatch = 0;
  env.storeLog = []; env.roster = { bots: [{ id: BOT, threadId: "", tasks: [] }], groups: [] };
  // limits are the test's (a test may set them before its first fixture; afterEach restores them): applied as they stand
  limits({});
  store.setPinBudgets(null);
  setMemoryMode("active"); resetSessionHolds(); resetLineageFootprintCountersForTest();
  LW.setLineageWarmClockForTest(() => env.now);
  onProducerBranchForTest(LW.lineageNoteProducerBranch);
  store.onStoreLog(entry => { env.storeLog.push(entry.map === "gen" ? { map: "gen", why: String(entry.why) } : { map: entry.map, key: entry.key, why: String(entry.why) }); });
  installSources();
}

// ---- rows ----
const memKey = (thread: string, id: string) => `${thread}\u0000${id}`;
function message(thread: string, id: string, role = "bot", text = `line ${id}`, json: Record<string, unknown> = {}): void {
  const db = database();
  if (role === "bot") {
    const scope = ensureScope("conversation", thread);
    db.prepare("INSERT INTO memory_sources VALUES(?,?,?,?,NULL,1,'hash','text','bot:bot','settled',NULL,'active')").run(`message:${thread}:${id}`, scope, thread, id);
  }
  db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)").run(thread, id, env.now, role, "text", text, JSON.stringify(json));
}
/** Replies p0..p{n-1}, the newest pointing at a chain of sets (one root per reply, plus `foreign` keys on the newest). */
function chain(thread: string, prefix: string, n: number, foreign: string[] = []): void {
  const write = chainStore(database());
  let parent: string | null = null;
  for (let index = 0; index < n; index++) {
    message(thread, `${prefix}${index}`);
    parent = write(parent, index, index === n - 1 ? [memKey(thread, `${prefix}${index}`), ...foreign] : [memKey(thread, `${prefix}${index}`)]);
    // a long chain (>= EACH_FROM replies): every reply names its own set, so the window judges one root set per reply (a large trace)
    if (n >= EACH_FROM || index === n - 1) database().prepare("INSERT INTO memory_output_roots(thread_id,message_id,set_id) VALUES(?,?,?)").run(thread, `${prefix}${index}`, parent);
  }
}
const EACH_FROM = 20;
/** A thread id outside the roster (its writes move no access stamp). */
const OUTSIDE = "outside";
function sessionOf(thread: string, nativeSession: string, listing: string[]): void {
  const db = database();
  db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,?,?,'[]','[]',?,(SELECT policy_revision FROM memory_meta),(SELECT deletion_epoch FROM memory_meta),0,'delivered',9)")
    .run(`rc-${thread}-${nativeSession}`, thread, DRIVER, nativeSession, JSON.stringify(listing));
  recordSessionRoots(thread, DRIVER, nativeSession, outputRootsFor(LineageAllowance.tool(1_000_000_000), []));
  stampFreshSession(db, thread, DRIVER, nativeSession);
}
function newThread(): string {
  const thread = `t${++env.n}`;
  env.threads.push(thread);
  const bot = env.roster.bots[0]!;
  if (!bot.threadId) bot.threadId = thread; else bot.tasks!.push({ threadId: thread });
  reconcileMemoryRoster(env.roster);
  env.taskRows.set(thread, { cursor: null, externalUpdates: [] });
  return thread;
}
function tx(body: () => void): void { const db = database(); db.exec("BEGIN"); try { body(); db.exec("COMMIT"); } catch (error) { db.exec("ROLLBACK"); throw error; } }
interface PlainOptions { lines?: number; plain?: number; cursorless?: boolean; text?: string; foreign?: string[]; rootless?: boolean }
function plainThread(o: PlainOptions = {}): string {
  const thread = newThread();
  tx(() => {
    for (let index = 0; index < (o.plain ?? 0); index++) message(thread, `${thread}p${index}`, "bot", o.text ?? `line ${thread}p${index}`);
    const lines = o.lines ?? 3;
    if (o.rootless) for (let index = 0; index < lines; index++) message(thread, `${thread}r${index}`);
    else chain(thread, `${thread}r`, lines, o.foreign);
    if (!o.cursorless) {
      const session = `S-${thread}`;
      sessionOf(thread, session, [`${thread}r${lines - 1}`]);
      env.taskRows.set(thread, { cursor: { instance: DRIVER, session, incarnation: 1 }, externalUpdates: [] });
    }
  });
  return thread;
}

// ---- limits ----
let current: Partial<LW_Limits> = {};
type LW_Limits = { verdictLimit: number; edgeBound: number; judgeBudget: number; sessionHoldsMax: number; maxHandles: number; threadForgetsMax: number; cEdges: boolean; cGroup: boolean; budgets: boolean };
function limits(next: Partial<LW_Limits> | null): void {
  current = next === null ? {} : { ...current, ...next };
  for (const [key, value] of Object.entries(next ?? {})) if (value === undefined) delete (current as Record<string, unknown>)[key];
  setVerdictLimitForTest(current.verdictLimit ?? null);
  setEdgeBoundForTest(current.edgeBound ?? null);
  setReplayNodeBudgetForTest(current.judgeBudget ?? null);
  setSessionHoldsMaxForTest(current.sessionHoldsMax ?? null);
  setMaxHandlesForTest(current.maxHandles ?? null);
  // TCFO r3: no cross-call forget cache, so threadForgetsMax has nothing to bound (kept in the limits shape for the gate op)
  store.setAdmissionChecks(current.cEdges === undefined && current.cGroup === undefined ? null : { cEdges: current.cEdges, cGroup: current.cGroup });
}

// ---- the clock rule ----
const STEP_CAP = 200_000;
function advance(ms: number): void {
  const end = env.now + ms;
  let steps = 0;
  for (;;) {
    const due = LW.lineageWarmNextDueMs();
    if (due === null || env.now + due > end) break;
    env.now += Math.max(1, due);
    if (env.held > 0) env.warmStepsBetweenSendAndDispatch++;
    inStep = true;
    try { LW.lineageWarmStep(25); } finally { inStep = false; }
    if (++steps > STEP_CAP) throw new Error(`advance(${ms}): the warmer did not settle within ${STEP_CAP} scheduled steps`);
  }
  env.now = Math.max(env.now, end);
}

/** One scheduled warmer step (the same scheduling as advance); false when none is due. T10(r): lets a test look between steps. */
function stepOnce(): boolean {
  const due = LW.lineageWarmNextDueMs();
  if (due === null) return false;
  env.now += Math.max(1, due);
  if (env.held > 0) env.warmStepsBetweenSendAndDispatch++;
  inStep = true;
  try { LW.lineageWarmStep(25); } finally { inStep = false; }
  return true;
}

// ---- the turn ----
type Verdict = "match" | "miss:changed" | "miss:kind" | "miss:floor" | "miss:not-covered";
const verdictOf = (v: string): Verdict => v === "match" ? "match" : v === "APPENDED-changed" ? "miss:changed" : v === "floor" ? "miss:floor" : v === "not-covered" ? "miss:not-covered" : "miss:kind";
function send(thread: string, _kind: UserKind = "APPENDED", options?: { replyTo?: string }): string {
  const db = database();
  const head = db.prepare("SELECT id FROM messages WHERE thread_id=? ORDER BY rowid DESC LIMIT 1").get(thread);
  const id = `${thread}u${env.now}-${env.lastSent.size}-${Math.floor(Math.random() * 1e9)}`;
  message(thread, id, "user", `user line ${id}`, { ...(head ? { parentId: String(head.id) } : {}), ...(options?.replyTo ? { replyTo: options.replyTo } : {}) });
  env.lastSent.set(thread, id);
  env.held++;
  LW.bumpLineageWarm(thread);
  return id;
}
type DispatchOptions = { recallNodes?: number; over?: Partial<LineageFootprint>; tracedNote?: boolean; workerBehind?: boolean; epochOnlyWrite?: boolean;
  otherThreadWrites?: number; secondRow?: boolean; resumeFlip?: boolean; pendingRows?: string[] };
function dispatch(thread: string, options: DispatchOptions = {}) {
  const db = database();
  let userId = env.lastSent.get(thread) ?? send(thread);
  const who = mint(BOT, thread);
  try {
    // IX:12707 catch-up: the previous bot reply is captured here unless the worker already did (the surface's worker runs in advance())
    if (who && (options.workerBehind || env.pendingCapture.has(thread))) { try { catchUpRecentMemory(who); } catch { /* capture is not the subject */ } }
    env.pendingCapture.delete(thread);
    if (options.otherThreadWrites) {
      const other = OUTSIDE;
      for (let index = 0; index < options.otherThreadWrites; index++) message(other, `${other}w${env.now}-${index}-${Math.floor(Math.random() * 1e9)}`, "user");
    }
    if (options.secondRow) {
      // a second row of t lands before U: U is re-appended after it (a new rowid), replying to the second row
      const u = db.prepare("SELECT text, json FROM messages WHERE thread_id=? AND id=?").get(thread, userId)!;
      db.prepare("DELETE FROM messages WHERE thread_id=? AND id=?").run(thread, userId);
      const second = `${thread}s${env.now}`;
      message(thread, second, "bot", `second ${second}`, JSON.parse(String(u.json)) as Record<string, unknown>);
      message(thread, userId, "user", String(u.text), { parentId: second });
    }
    // IX:12708 the early E2 reads the lineage: what committed until now is applied (drained) there, before the compare
    prepareLineageCache();
    if (options.epochOnlyWrite) {
      // after the early E2 (IX:12708), before the compare: an unrelated message row deleted (epoch only, no dirty row)
      const other = OUTSIDE;
      message(other, `${other}e${env.now}`, "user");
      db.prepare("DELETE FROM messages WHERE rowid=(SELECT max(rowid) FROM messages WHERE thread_id=?)").run(other);
    }
    if (options.tracedNote) {
      const traced = new Set(LW.lineageTraceKeysForTest(thread));
      let note: string | null = null;
      for (const [dep, dependents] of store.dependentEntries()) if ([...dependents].some(k => traced.has(k)) && /^[ms]\u001f/.test(dep)) { note = dep; break; }
      note ??= `m${SEP}${thread}${SEP}${LW.lineageWarmRecordForTest(thread)?.anchor?.id ?? "x"}`;
      db.prepare("INSERT INTO temp.lineage_dirty(k) VALUES(?)").run(note);
    }
    // L2 S1 tests (surface extension, not in the L4 contract): these raw lineage_dirty rows pending at the compare
    for (const row of options.pendingRows ?? []) db.prepare("INSERT INTO temp.lineage_dirty(k) VALUES(?)").run(row);
    let over = { ...options.over };
    if (options.resumeFlip) { const cursor = cursorOf(thread); over = { ...over, cursor: cursor ? null : resumeCursorOf(thread, DRIVER, `flip-${thread}`, 1) }; }
    const f = turnFootprint(thread, over);
    if (f.userKind !== "APPENDED") f.userMessageId = userId;
    const seq = Number(db.prepare("SELECT rowid AS r FROM messages WHERE thread_id=? AND id=?").get(thread, userId)?.r ?? 0);
    const before = LW.lineageWarmRecordForTest(thread);
    const verdict = verdictOf(compareLineageFootprint(thread, f, { id: userId, seq }, false));
    const confirmWindows = verdict === "match" ? (before?.windows ?? null) : null;
    noteLineageFootprint(thread, f);
    const probe = LW.lineageRealEntryForTest(thread, f, options.recallNodes ?? 0, userId);
    const strip = (w: LW.LineageWindowTrace): LW.LineageWindowTrace => ({ ...w, loaded: w.loaded.filter(id => id !== userId), skip: w.skip.filter(id => id !== userId) });
    const turnWindows = (probe?.windows ?? []).map(strip);
    // the cold legacy answer on the same inputs: nothing kept (verdicts and holds forgotten), an unlimited tool allowance
    forgetKeptLineageForTest(); resetSessionHolds();
    let legacy = { revoked: false, withheld: [] as string[] };
    if (who) {
      const inputs = LW.lineageReplayInputs(thread, f, 0, [userId]);
      const revoked = f.cursor ? continuationMemoryRevoked(LineageAllowance.tool(1_000_000_000), thread, f.cursor.instanceId, f.cursor.nativeSession, who) : false;
      const result = inputs ? filterDirectReplay(LineageAllowance.tool(1_000_000_000), thread, inputs.messages, who, inputs.skip, { maxBytes: f.maxBytes >= 0 ? f.maxBytes : undefined, minLines: f.minLines }) : { withheld: new Set<string>() };
      legacy = { revoked, withheld: [...result.withheld] };
    }
    // the bot reply (captured later: by the worker in advance(), or by the next turn's catch-up)
    message(thread, `${thread}b${env.now}-${Math.floor(Math.random() * 1e9)}`, "bot", `reply to ${userId}`, { parentId: userId });
    env.pendingCapture.add(thread);
    if (env.loseAfterDispatch.delete(thread)) {
      // a [t,m] key of the window (the per-message verdict keys are JSON [thread, messageId])
      const keys = [...store.verdictKeys()];
      const traced = LW.lineageTraceKeysForTest(thread).filter(k => store.peekVerdict(k) !== undefined);
      const key = traced.find(k => k.startsWith(`[${JSON.stringify(thread)},`)) ?? traced[0]
        ?? keys.find(k => k.startsWith(`[${JSON.stringify(thread)},`)) ?? keys.find(k => k.includes(thread) && !/^[QS]\u001f/.test(k));
      if (key) store.loseVerdict(key, "evict");
    }
    // IX:13285-13292 renew(): a turn whose E2 answers revoked resets its session; the task row then names a fresh native session, which the
    // next confirm (task-row cursor) and the next turn's F resume. The surface models it so a revoke is followed by a renewal, as in the app.
    // MUTANT:no-renew-on-send
    const renew = legacy.revoked && f.cursor !== null;
    // MUTANT:rewarm-broken-healthy
    if (renew && f.cursor) {
      const session = `S-${thread}-renew${env.now}-${++env.renewals}`;
      tx(() => sessionOf(thread, session, []));
      env.taskRows.set(thread, { cursor: { instance: f.cursor.instanceId, session, incarnation: 1 }, externalUpdates: env.taskRows.get(thread)?.externalUpdates ?? [] });
    }
    if (env.freshSession.has(thread) && !env.taskRows.get(thread)?.cursor) {
      const session = `S-${thread}`;
      tx(() => sessionOf(thread, session, []));
      env.taskRows.set(thread, { cursor: { instance: DRIVER, session, incarnation: 1 }, externalUpdates: [] });
    }
    const counts = probe ?? { misses: 0, listings: 0, remember: 0, holdWrites: 0, handleMisses: 0, memoMisses: 0, merges: 0, deferred: 0, unfinished: 0, hit: true, nodes: 0, clean: false, revoked: false, withheld: [] };
    return {
      verdict,
      counts: { misses: counts.misses, listings: counts.listings, remember: counts.remember, holdWrites: counts.holdWrites, handleMisses: counts.handleMisses,
        memoMisses: counts.memoMisses, merges: counts.merges, deferred: counts.deferred, unfinished: counts.unfinished, hit: counts.hit, nodes: counts.nodes,
        clean: counts.clean, revoked: counts.revoked, withheld: [...counts.withheld] },
      legacy, turnWindows, confirmWindows,
    };
  } finally {
    env.lastSent.delete(thread);
    env.held = Math.max(0, env.held - 1);
    void userId;
    userId = "";
  }
}

// ---- fixtures ----
const GATE_OPS = ["send-owner", "send-nonowner", "send-kind", "receipt-update", "append-merge-then-read", "db-write", "foreign-commit", "evict", "half-drop",
  "hold-evict", "hold-scope", "authority-move", "handle-capacity", "struct-unrelated", "struct-members-update", "chains-clear", "forgets-evict",
  "footprint-model", "footprint-exclude", "footprint-session", "audience-change", "root-set-x", "proof-restart", "supersede", "session-sound-cap",
  "group-store-cap", "lost-tail", "lost-middle", "restart", "seal-then-evict", "seal-then-key", "clear-then-hot", "feed-throws", "ttl-age",
  "copy-window", "recall-over-reserve", "room-30k"] as const;
function rand(seed: number): () => number { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function loseTraceKey(thread: string, at: "tail" | "middle" | "any", r: () => number): void {
  const keys = LW.lineageTraceKeysForTest(thread).filter(key => store.peekVerdict(key) !== undefined);
  if (!keys.length) return;
  const key = at === "tail" ? keys.at(-1)! : at === "middle" ? keys[Math.floor(keys.length / 2)]! : keys[Math.floor(r() * keys.length)]!;
  store.loseVerdict(key, "evict");
}
function gateOp(op: number, seed: number): void {
  const r = rand(seed), db = database();
  const threads = env.threads.filter(t => !env.nonOwner.has(t));
  const t = threads[Math.floor(r() * threads.length)] ?? env.threads[0]!;
  const name = op === -1 ? "clear" : GATE_OPS[op];
  switch (name) {
    case "clear": case "clear-then-hot": store.clearLineage("test-gate"); if (name === "clear-then-hot") { send(t); dispatch(t); } return;
    case "restart": LW.resetLineageWarmForTest(); forgetKeptLineageForTest(); resetSessionHolds(); LW.setLineageWarmClockForTest(() => env.now); return;
    case "ttl-age": env.now += LW.RECORD_TTL_MS + 1; return;
    case "seal-then-evict": case "seal-then-key": case "proof-restart": loseTraceKey(t, "any", r); return;
    case "lost-tail": loseTraceKey(t, "tail", r); return;
    case "lost-middle": loseTraceKey(t, "middle", r); return;
    case "feed-throws": env.throwLines = 1; return;
    case "supersede": { const keys = LW.lineageTraceKeysForTest(t); if (keys.length >= 2) store.supersede(keys[0]!, keys[1]!); return; }
    case "session-sound-cap": store.clearSessions("evict"); return;
    case "group-store-cap": store.evictOldestGroup(); return;
    case "copy-window": { const holder = env.threads[3] ?? t; send(holder); dispatch(holder); return; }
    case "audience-change": db.prepare("UPDATE memory_meta SET policy_revision=policy_revision+1").run(); return;
    case "root-set-x": {
      const set = db.prepare("SELECT set_id, root_message_id FROM memory_root_set_members WHERE set_id IN (SELECT set_id FROM memory_output_roots WHERE thread_id=?) LIMIT 1").get(t);
      if (set) db.prepare("DELETE FROM memory_root_set_members WHERE set_id=? AND root_message_id=?").run(set.set_id, set.root_message_id);
      return;
    }
    case "receipt-update": db.prepare("UPDATE memory_disclosures SET state=state WHERE thread_id=?").run(t); return;
    case "foreign-commit": {
      const file = String(db.prepare("SELECT file FROM pragma_database_list WHERE name='main'").get()?.file ?? "");
      if (!file) return;
      const other = new DatabaseSync(file);
      try {
        // a writer of messages.db like any other: its counted write moves the write revision (R2-06)
        installWriteRevisionTriggers(other);
        other.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)").run("foreign", `f${seed}`, env.now, "user", "text", "foreign", "{}");
      } finally { other.close(); }
      return;
    }
    case "chains-clear": store.bumpHandleEpoch("test-gate"); return;
    case "hold-scope": resetSessionHolds(); return;
    case "struct-members-update": db.prepare("UPDATE memory_root_set_members SET root_message_id=root_message_id WHERE set_id IN (SELECT set_id FROM memory_output_roots WHERE thread_id=?)").run(t); return;
    default: return;
  }
}
function fixture(kind: string, options: Record<string, number> = {}, fresh: boolean): string[] {
  if (fresh) reset();
  switch (kind) {
    case "plain": {
      const t = plainThread({ lines: options.lines ?? 3, cursorless: options.cursorless === 1 });
      if (options.demoted) {
        store.setPinBudgets({ verdicts: 0, sessionSound: 0, threadGroupStore: 0, sessionHolds: 0 });
        // a second retained session of t, so a turn that resumes "other" passes and keeps a hold of its own (T10(n4))
        tx(() => sessionOf(t, "other", [`${t}r2`]));
      }
      return [t];
    }
    case "room-switch": case "room-30k": {
      // room-30k (Astra 4023216b1 H1) IS this room at full scale: R = 30,000 receipts, P = 500 x 6 = 3,000 output pairs; both assert it below.
      // L1's recipe (flagfold F2, RL producers): R receipts > THREAD_RECEIPT_LIMIT (2048) on T and 2048 < P <= PAIR_LIMIT (20,000) output pairs
      // of the window, with roomLeast x16 < R <= roomMost x16 (ROWS_PER_NODE). The least-room pass (3000 - RECALL_RESERVE 1500 nodes, at most
      // 24,000 rows) cannot read the thread's receipts whole and lists the pairs; the most-room pass (3000 nodes) reads its groups.
      // R = 30,000 receipts in a native session of their own (not the cursor's: E2 reads the cursor's), `listed` of them naming every window line.
      const t = plainThread({ lines: 6 });
      // MUTANT:room-30k-receipts
      const receipts = options.receipts ?? 30_000;
      // MUTANT:room-30k-pairs
      const listed = options.listed ?? 500;
      const db = database();
      const lines = Array.from({ length: 6 }, (_, index) => `${t}r${index}`);
      tx(() => {
        const receipt = db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES(?,?,?,?,'[]','[]',?,(SELECT policy_revision FROM memory_meta),(SELECT deletion_epoch FROM memory_meta),0,'delivered',9)");
        const output = db.prepare("INSERT OR IGNORE INTO memory_disclosure_outputs(bundle_id,thread_id,message_id) VALUES(?,?,?)");
        for (let index = 0; index < receipts; index++) {
          const bundle = `rs-${t}-${index}`, names = index < listed ? lines : [];
          receipt.run(bundle, t, DRIVER, `bulk-${t}`, JSON.stringify(names));
          for (const id of names) output.run(bundle, t, id);
        }
      });
      // the fixture's own cardinality: a room of fewer receipts or pairs is not the room the tests name
      const built = Number(db.prepare("SELECT count(*) AS n FROM memory_disclosures WHERE thread_id=? AND native_session=?").get(t, `bulk-${t}`)!.n);
      const pairs = Number(db.prepare("SELECT count(*) AS n FROM memory_disclosure_outputs WHERE thread_id=? AND bundle_id LIKE ?").get(t, `rs-${t}-%`)!.n);
      if (built !== receipts || pairs !== listed * lines.length) throw new Error(`lineage-warm-surface: ${kind} built ${built} receipts / ${pairs} pairs, not ${receipts} / ${listed * lines.length}`);
      if (kind === "room-30k" && (built !== 30_000 || pairs !== 3_000)) throw new Error(`lineage-warm-surface: room-30k must be 30,000 receipts / 3,000 pairs (got ${built} / ${pairs})`);
      return [t];
    }
    case "proof-restarts": {
      // F6: every proof step of this thread's root sets restarts its proof at the step's end (RL:2925, as an unclean step does), so the
      // record spends its activation budget and must stop there (L1's forceProofRestartForTest)
      // The proof scheduler owns only a LARGE set (RL:1351: over LARGE_ROOT_SET roots and more unproven than TURN_JUDGE_MAX): the newest of 24
      // replies rests on LARGE_ROOT_SET + 1 roots of the thread's own older lines, at full scale (never a lowered threshold), so the
      // confirm defers it (DEFERRED-ONLY) and proof slices run; each restarts at its step's end until the activations are spent.
      const t = newThread(), lines = 24;
      const roots = Array.from({ length: LARGE_ROOT_SET + 1 }, (_, index) => `${t}b${index}`);
      tx(() => {
        for (const id of roots) message(t, id);
        chain(t, `${t}r`, lines, roots.map(id => memKey(t, id)));
        const session = `S-${t}`;
        sessionOf(t, session, [`${t}r${lines - 1}`]);
        env.taskRows.set(t, { cursor: { instance: DRIVER, session, incarnation: 1 }, externalUpdates: [] });
      });
      forceProofRestartForTest(setId => Boolean(database().prepare("SELECT 1 FROM memory_output_roots WHERE thread_id=? AND set_id=? LIMIT 1").get(t, setId)));
      return [t];
    }
    case "merge-foreign": {
      // L2c-3 merges-allowed: the newest reply of t rests on one root set of `own` (default 3999) of t's own lines plus two lines of a foreign
      // thread x (one receipt lists both, so x's receipt groups are read: RL producers "groups"). The set is judged in the turn (<= TURN_JUDGE_MAX
      // unproven, no deferral) and, consulting more than 4000 keys, is never kept (RL:1383 basis, noteUnkept only): every confirm judges it
      // again and reads x's KEPT groups (RL currentThreadGroups). A fresh receipt of x then brings those up to date in place: a merge.
      const x = newThread(), xs = [`${x}x0`, `${x}x1`];
      tx(() => { for (const id of xs) message(x, id); sessionOf(x, `S-${x}`, xs); });
      const t = newThread(), lines = 3;
      const roots = Array.from({ length: options.own ?? 3999 }, (_, index) => `${t}b${index}`);
      tx(() => {
        for (const id of roots) message(t, id);
        chain(t, `${t}r`, lines, [...roots.map(id => memKey(t, id)), ...xs.map(id => memKey(x, id))]);
        const session = `S-${t}`;
        sessionOf(t, session, [`${t}r${lines - 1}`]);
        env.taskRows.set(t, { cursor: { instance: DRIVER, session, incarnation: 1 }, externalUpdates: [] });
      });
      return [t, x];
    }
    case "seven-foreign-unkept": {
      // T14(c) C-GROUP tripped (Astra 4023216b1 M1): 7 records, each the merge-foreign shape at full scale: the newest reply rests on ONE root set
      // of 3999 of its own lines plus two lines of each of 8 foreign threads of its own (one receipt per foreign thread lists both). Consulting
      // more than 4000 keys, the set is never kept (RL:1383 basis), so every clean confirm re-judges its roots and its trace names the 8 foreign
      // threads' groups and none of its own (t's own lines take the PAIRS branch, pairs <= pairCap, RL producers ~856-861; each x takes
      // the groups branch; measured): 7 x 8 = 56 distinct entries against GROUP_PIN_MAX 48 (6 x 8 = 48 fits, the 7th trips).
      return Array.from({ length: 7 }, () => {
        const foreign: string[] = [];
        for (let index = 0; index < 8; index++) {
          const x = newThread(), ids = [`${x}x0`, `${x}x1`];
          tx(() => { for (const id of ids) message(x, id); sessionOf(x, `S-${x}`, ids); });
          foreign.push(...ids.map(id => memKey(x, id)));
        }
        const t = newThread(), lines = 3;
        // MUTANT:group-roots-kept
        const roots = Array.from({ length: 3999 }, (_, index) => `${t}b${index}`);
        tx(() => {
          for (const id of roots) message(t, id);
          chain(t, `${t}r`, lines, [...roots.map(id => memKey(t, id)), ...foreign]);
          const session = `S-${t}`;
          sessionOf(t, session, [`${t}r${lines - 1}`]);
          env.taskRows.set(t, { cursor: { instance: DRIVER, session, incarnation: 1 }, externalUpdates: [] });
        });
        return t;
      });
    }
    case "rootless":
      return [plainThread({ lines: 6, rootless: true })];
    case "endless-unclean": return [plainThread({ lines: 20 })];
    case "lost-window-key": {
      if (options.thread !== undefined) { const t = env.threads[options.thread]; if (t) loseTraceKey(t, "any", rand(1)); return t ? [t] : []; }
      // the turn keeps its window's verdicts; one [t,m] key of the window is then lost, so the first confirm re-judges (remembers) it.
      // T10(q): warmed once here, so the record has a trace: the key lost is one the confirm reads (a fresh thread's store after the legacy
      // pass holds only its g/a/R keys, none of which the first confirm re-reads, and that confirm was clean in one round)
      const t = plainThread({ lines: 4 }); send(t); dispatch(t); advance(2_000); env.loseAfterDispatch.add(t); return [t];
    }
    case "edges-over": return [plainThread({ lines: options.deps ?? 600 })];
    case "two-alternating": return [plainThread(), plainThread()];
    case "seven-foreign": {
      // T14(c) C-GROUP: 7 records, each naming its own thread and 8 foreign threads of its own: 63 group entries against GROUP_PIN_MAX 48.
      // A foreign thread's receipt groups are judged (RL producers "groups": more pairs than receipts) only when its roots are checked
      // together, so each holds two lines named by the record and one receipt listing both (sharing 8 foreign threads gave 15 distinct
      // entries; a lone line per thread took the "pairs" branch and judged no group at all).
      const own = options.foreign ?? 8;
      return Array.from({ length: 7 }, () => {
        const foreign: string[] = [];
        for (let index = 0; index < own; index++) {
          const x = newThread(), ids = [`${x}x0`, `${x}x1`];
          tx(() => { for (const id of ids) message(x, id); sessionOf(x, `S-${x}`, ids); });
          foreign.push(...ids.map(id => memKey(x, id)));
        }
        return plainThread({ foreign });
      });
    }
    case "recency-admitted": {
      // 20 replies (EACH_FROM): every reply names its own set, so each trace pins 21 verdict keys and the 24-key verdict budget holds one
      // record: admission must demote. The candidate (threads[0]) is warm and admitted before the others are sent, so the first more
      // recently sent record that does not fit demotes it (a candidate confirmed last could only be refused, never demoted).
      const threads = Array.from({ length: 7 }, () => plainThread({ lines: options.lines ?? 20 }));
      // 48 pins in all across the four maps (T14(c) sums traceSize over admitted records)
      store.setPinBudgets({ verdicts: 24, sessionSound: 8, threadGroupStore: 8, sessionHolds: 8 });
      send(threads[0]!); dispatch(threads[0]!); advance(2_000);
      return threads;
    }
    case "spend": { const t = plainThread(); LW.setLineageE1NodesForTest(t, options.confirmNodes ?? 1500); return [t]; }
    case "window-boundary": return [plainThread({ plain: 77, lines: 3 })];
    case "byte-bound": { const t = plainThread({ plain: 120, lines: 3, text: "x".repeat(1000) }); env.maxBytes.set(t, 40_000); return [t]; }
    case "reply-withheld": { const t = plainThread({ plain: 120, lines: 3 }); return [t, `${t}p0`]; }
    case "tail-reply-widened": return [plainThread({ plain: 100, lines: 3 })];
    case "fresh-session": { const t = plainThread({ cursorless: true }); env.freshSession.add(t); return [t]; }
    case "stale-receipt": {
      // L2 S2 tests (surface extension): the production revoke, an audience change. The policy revision moves, so thread #thread's session
      // receipts were made under an older one and its E2 answers revoked (memory-changed, DI:222). (An inserted receipt with an older
      // revision is no production state, and the session's hold answered not-revoked before any receipt was read: DI:157.)
      const t = env.threads[options.thread ?? 0]!, cursor = env.taskRows.get(t)?.cursor;
      if (!cursor) throw new Error(`stale-receipt: ${t} has no session`);
      database().prepare("UPDATE memory_meta SET policy_revision=policy_revision+1").run();
      return [t];
    }
    case "uncertain-branch": { const t = plainThread(); env.uncertain.add(t); return [t]; }
    case "gate": {
      if (options.op !== undefined) { gateOp(options.op, options.seed ?? 0); return [...env.threads]; }
      const owner = plainThread({ lines: 4 }), other = plainThread({ lines: 3 }), third = plainThread({ lines: 5 }), copy = plainThread({ lines: 4 }), rootless = plainThread({ lines: 3, rootless: true });
      env.nonOwner.add(other);
      return [owner, other, third, copy, rootless];
    }
    default: throw new Error(`lineage-warm-surface: no fixture "${kind}"`);
  }
}

/** The r14/r15 test surface (testing/turnstart-r14-surface.ts). Each surface's FIRST fixture() starts a fresh test DB; useSources never does. */
export function lineageWarmTestSurface() {
  installStatementTally();
  let started = false;
  return {
    setLimits(next: Partial<LW_Limits> | null): void { limits(next); },
    record(thread: string) {
      const rec = LW.lineageWarmRecordForTest(thread);
      if (!rec) return null;
      return { outcome: rec.outcome, reason: rec.reason, confirmRounds: rec.confirmRounds, recoverSlices: rec.recoverSlices, admitted: rec.admitted,
        traceSize: rec.traceSize, closureEdges: rec.closureEdges, usedHandles: rec.usedHandles, footprintHash: rec.footprintHash, confirmedAt: rec.confirmedAt,
        anchor: rec.anchor, activations: rec.activations, lastConfirm: rec.lastConfirm };
    },
    counters() {
      const fp = lineageFootprintCounters(), lw = LW.lineageWarmCounters(), st = store.counters();
      const forced = store.clearLog().filter(entry => !String(entry.why).startsWith("test")).length;
      return {
        footprintMatch: fp.footprintMatch, footprintMiss: fp.footprintMiss, footprintMissByKind: { ...fp.footprintMissByKind, ...lw.coveredMissByClause } as Record<string, number>,
        warmAllowanceHit: fp.warmAllowanceHit, warmerCausedClears: st.warmerCausedClears, judgeStatements: tally.judge, forcedClears: forced,
        pinnedGroupDeletes: st.pinnedGroupDeletes, pinnedEvictions: lw.pinnedEvictions + st.pinnedEvictions, confirmsPerStepMax: lw.confirmsPerStepMax,
        confirmsPerRecordPerStepMax: lw.confirmsPerRecordPerStepMax, handleEpoch: store.handleEpoch(), warmStepsBetweenSendAndDispatch: env.warmStepsBetweenSendAndDispatch,
        ownerHoldLoss: st.ownerHoldLoss, unknownOwners: st.unknownOwners, storeClears: st.clears, confirmPassClears: st.confirmPassClears,
      };
    },
    demotions: (): string[] => LW.lineageDemotionsForTest(),
    traceGroups: (thread: string): string[] => LW.lineageTraceGroupsForTest(thread),
    pinnedGroups: (): number => store.pinnedCount("threadGroupStore"),
    storeLog(resetLog?: boolean) { const log = [...env.storeLog]; if (resetLog) env.storeLog = []; return log as Array<{ map: "verdicts" | "sessionSound" | "threadGroupStore" | "sessionHolds" | "gen"; key?: string; why: string }>; },
    footprintHash: (f: LineageFootprint): string => footprintHash(f),
    turnFootprint: (thread: string, over?: Partial<LineageFootprint>) => turnFootprint(thread, over),
    fixture(kind: string, options?: Record<string, number>): string[] { const fresh = !started; started = true; return fixture(kind, options, fresh); },
    send: (thread: string, kind?: UserKind, options?: { replyTo?: string }): string => send(thread, kind, options),
    dispatch: (thread: string, options?: DispatchOptions) => dispatch(thread, options),
    advance: (ms: number): void => advance(ms),
    stepOnce: (): boolean => stepOnce(),
    /** T12 revoked arm (S2): an independent cold E2 on the task row's cursor (a fresh unlimited allowance, never the warmer's record), and the
     * policy revision the cursor's receipts were made under next to the current one (the production cause: an audience change). */
    coldE2(thread: string): { revoked: boolean; why: string | null; session: string | null; receiptRevision: number | null; policyRevision: number } {
      const db = database(), who = mint(BOT, thread), c = cursorOf(thread);
      const policyRevision = Number(db.prepare("SELECT policy_revision AS p FROM memory_meta").get()?.p ?? -1);
      if (!who || !c) return { revoked: false, why: "no cursor", session: null, receiptRevision: null, policyRevision };
      const why: { reason?: string } = {};
      const revoked = continuationMemoryRevoked(LineageAllowance.tool(1_000_000_000), thread, c.instanceId, c.nativeSession, who, why);
      const row = db.prepare("SELECT min(policy_revision) AS lo FROM memory_disclosures WHERE thread_id=? AND driver_instance=? AND native_session=?").get(thread, c.instanceId, c.nativeSession);
      return { revoked, why: why.reason ?? null, session: c.nativeSession, receiptRevision: row?.lo === null || row?.lo === undefined ? null : Number(row.lo), policyRevision };
    },
    store() {
      const built = lineageBuilderKeysForTest();
      return {
        supersede(oldKey: string, newKey: string): boolean {
          // the builder keys are built, not kept: seed the two named keys a test passes (never an absent one)
          for (const key of [oldKey, newKey]) if (built.keys.some(k => k.key === key) && !store.peekVerdict(key)) store.setVerdict(key, { withheld: false, unproven: false, deps: new Set() });
          const had = store.peekVerdict(oldKey) !== undefined && store.peekVerdict(newKey) !== undefined;
          const logged = env.storeLog.length;
          store.supersede(oldKey, newKey);
          // superseded: old removed WITHOUT a loss (a refusal that drops old is logged as a loss, and is not a supersede)
          const lost = env.storeLog.slice(logged).some(entry => entry.key === oldKey);
          return had && !lost && store.peekVerdict(oldKey) === undefined && store.peekVerdict(newKey) !== undefined;
        },
        proofLossOf: (bucket: number): number => store.proofLossOf(bucket),
        proofBucket: (id: string): number => { const who = owner("verdicts", id); return who.kind === "PROOF" ? who.bucket : -1; },
        owner: (map: MapName, key: string): string => owner(map, key).kind,
        builderKeys: () => built.keys.map(k => ({ site: k.site, map: k.map, key: k.key, expect: k.expected.kind })),
        awaitedKey: (): string => built.awaitedKey,
      };
    },
    useSources(given: { mint?: (botId: string, threadId: string) => unknown; lines?: unknown; task?: unknown } | null): void {
      if (given === null) { env.testMint = null; LW.setLineageConfirmSourcesForTest(null); LW.setLineageDefaultFootprintForTest(null); return; }
      installSources(given);
    },
  };
}
