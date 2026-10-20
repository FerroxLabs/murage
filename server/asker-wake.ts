// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from "node:crypto";
import { coordinationTraceSchema, type CoordinationTrace } from "./coordination-budget.ts";
import type { HeldContinuation } from "./external-context-delivery.ts";
import { ROUTINE_PERMISSION_MODES, type RoutinePeerSource, type RoutinePermissionMode } from "./routine-permissions.ts";

// Lane 0163-delegate-wake. In a room, a teammate's late reply to an ask_bot
// wakes the asker through the durable request tree. A direct (1:1) chat has
// no request tree, so the asker used to stall after its first step: the reply
// landed in its thread and nothing started a turn. This is the bookkeeping for
// the direct-chat half: remember WHO asked (and under which allowance), keep
// the reply as ONE durable record until the asker's engine has it, and hand
// back exactly one wake for it.
//
// Design: lanes/release103/DELEGATE-WAKE-DESIGN.md. Every owed wake is one
// record with one state (owed, claimed, started; done and cancelled remove
// it), kept on the asker's task record and written after every transition.
// A record has at most one carrier at a time: nothing (owed), the in-memory
// claim between claim() and admission, the held continuation `wake:<id>`
// (an engine without tools), or the dispatched turn (started). The sweeps
// claim only owed records; admission re-checks the record (check) in the same
// tick it admits; the submission fence marks it started before the prompt
// goes out; acceptance ends it (done). Stop removes it wherever it is.
//
// Nothing here starts a turn or grants anything. The wake carries the asker's
// OWN coordination trace, so the shared per-root handoff allowance
// (coordination-budget.ts) keeps counting across wakes: a lead that keeps
// asking and being woken runs into the same cap as one that never slept.

/** What the asker was when it asked: everything the wake must not widen. */
export interface AskerWakeIntent {
  botId: string;
  threadId: string;
  /** the asker's comms depth, so a woken specialist is no deeper or shallower */
  depth: number;
  /** the asker's own trace (path ends at the asker); absent means no wake can delegate. A depth-0 asker always has one. */
  coordination?: CoordinationTrace;
  /** the asking turn answered to words nobody proved were the owner's */
  notOwnerAudience: boolean;
  /** the asking turn was already running unattended */
  unattended: boolean;
  /** the asking turn was a routine run. Once that run has ended a new turn in
   * its thread would read as the owner's own (Full access "owner" origin, the
   * bot's level instead of the routine's), so its wake runs unattended. */
  routineRun?: boolean;
  /** the automation budget the asking turn ran under; the wake spends the same one */
  eventId?: string;
  /** the routine ceiling the asking turn ran under, taken when it asked. The wake runs under this one, never under
   * whatever the thread's live record says by then (an owner turn in between clears that record). */
  routineAuthority?: RoutinePeerSource;
  /** the asking bot's own level when it asked (its task's flags). The wake runs at the lower of this and the level then: a bot
   * raised to Full access after the ask does not wake into it. */
  askingMode?: RoutinePermissionMode;
}

export interface AskerWakeResult {
  taskId: string;
  toBotId: string;
  toBotName: string;
  ok: boolean;
  /** the reply message in the asker's thread, so a wake can tell it was already delivered */
  messageId?: string;
}

export type AskerWakeState = "owed" | "claimed" | "started";

/** One owed wake: the replies one turn will carry, under the authority they were asked with. */
export interface AskerWakeRecord {
  id: string;
  state: AskerWakeState;
  /** claimed by (or started from) the held continuation `wake:<id>`: an engine without tools holds it until one with tools accepts it */
  held?: true;
  intent: AskerWakeIntent;
  results: AskerWakeResult[];
  /** attempts spent: starts given back, held replays begun, claims lost to a crash. MAX_ASKER_WAKE_ATTEMPTS ends the wake. */
  attempts: number;
  claimedAt?: number;
}

const sameAuthority = (a: AskerWakeIntent, b: AskerWakeIntent): boolean =>
  a.botId === b.botId && Boolean(a.routineRun) === Boolean(b.routineRun) && a.depth === b.depth && a.notOwnerAudience === b.notOwnerAudience && a.unattended === b.unattended
  && a.eventId === b.eventId && a.coordination?.rootId === b.coordination?.rootId
  && a.routineAuthority?.permissionMode === b.routineAuthority?.permissionMode && a.routineAuthority?.triggerSource === b.routineAuthority?.triggerSource
  && a.askingMode === b.askingMode
  && JSON.stringify(a.coordination?.path) === JSON.stringify(b.coordination?.path);

export const MAX_ASKER_INTENTS = 256;
export const MAX_ASKER_RESULTS = 16;
export const MAX_ASKER_WAKE_ATTEMPTS = 6;
/** Records one thread may hold at once (owed, claimed and started together). The oldest owed goes first. */
export const MAX_ASKER_WAKES = 16;
/** Done ids kept per thread so a rebuild of an accepted wake turn (memory redispatch) is told apart from a cancelled one. */
const MAX_DONE_IDS = 8;

/** The held continuation that carries a wake whose engine had no tools. */
export const heldWakeId = (id: string): string => `wake:${id}`;

/** What one asker thread owes, as kept on its task record so a restart keeps it (the store's durable task, beside its held continuations). */
export interface AskerWakeSnapshot {
  intents: Array<{ taskId: string; intent: AskerWakeIntent }>;
  wakes: AskerWakeRecord[];
}
/** Called with a thread's whole state after every change to it; undefined when it owes nothing. */
export type AskerWakePersist = (botId: string, threadId: string, snapshot: AskerWakeSnapshot | undefined) => void;

const MAX_RESTORED_TEXT = 256;
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= MAX_RESTORED_TEXT;
function restoredIntent(value: unknown, threadId: string): AskerWakeIntent | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (!text(v.botId) || v.threadId !== threadId || !Number.isInteger(v.depth) || (v.depth as number) < 0
    || typeof v.notOwnerAudience !== "boolean" || typeof v.unattended !== "boolean") return undefined;
  const intent: AskerWakeIntent = { botId: v.botId, threadId, depth: v.depth as number, notOwnerAudience: v.notOwnerAudience, unattended: v.unattended };
  if (v.routineRun !== undefined) { if (v.routineRun !== true) return undefined; intent.routineRun = true; }
  if (v.eventId !== undefined) { if (!text(v.eventId)) return undefined; intent.eventId = v.eventId; }
  if (v.coordination !== undefined) {
    const trace = coordinationTraceSchema.safeParse(v.coordination);
    if (!trace.success) return undefined;
    intent.coordination = trace.data;
  }
  // An owner turn (depth 0) always asked under a root allowance (coordinationBudget.begin). A record without one is not the asking
  // turn's, and admission would mint a fresh root for it: refused whole, never widened.
  if (intent.depth === 0 && !intent.coordination) return undefined;
  if (v.routineAuthority !== undefined) {
    const r = v.routineAuthority as Record<string, unknown> | null;
    // a ceiling that does not read back exactly is not a ceiling: the whole record is refused rather than woken without one
    if (!r || !ROUTINE_PERMISSION_MODES.includes(r.permissionMode as never) || (r.triggerSource !== "manual" && r.triggerSource !== "schedule")) return undefined;
    intent.routineAuthority = { permissionMode: r.permissionMode as RoutinePeerSource["permissionMode"], triggerSource: r.triggerSource };
  }
  if (v.askingMode !== undefined) {
    if (!ROUTINE_PERMISSION_MODES.includes(v.askingMode as never)) return undefined;
    intent.askingMode = v.askingMode as RoutinePermissionMode;
  }
  return intent;
}
function restoredResult(value: unknown): AskerWakeResult | undefined {
  if (!value || typeof value !== "object") return undefined;
  const r = value as Record<string, unknown>;
  if (!text(r.taskId) || !text(r.toBotId) || typeof r.toBotName !== "string" || typeof r.ok !== "boolean" || (r.messageId !== undefined && !text(r.messageId))) return undefined;
  return { taskId: r.taskId, toBotId: r.toBotId, toBotName: r.toBotName.slice(0, MAX_RESTORED_TEXT), ok: r.ok, ...(r.messageId ? { messageId: r.messageId } : {}) };
}
function restoredRecord(value: unknown, threadId: string): AskerWakeRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (!text(v.id) || (v.state !== "owed" && v.state !== "claimed" && v.state !== "started") || (v.held !== undefined && v.held !== true)) return undefined;
  const intent = restoredIntent(v.intent, threadId);
  // every field exactly as written, or the whole record is refused: no repaired counter (fresh attempts), no truncated reply list
  if (!intent || !Array.isArray(v.results) || !v.results.length || v.results.length > MAX_ASKER_RESULTS) return undefined;
  const results: AskerWakeResult[] = [];
  for (const item of v.results) { const r = restoredResult(item); if (!r) return undefined; results.push(r); }
  if (!Number.isInteger(v.attempts) || (v.attempts as number) < 0 || (v.attempts as number) > MAX_ASKER_WAKE_ATTEMPTS) return undefined;
  if (v.claimedAt !== undefined && typeof v.claimedAt !== "number") return undefined;
  return { id: v.id, state: v.state, ...(v.held === true ? { held: true as const } : {}), intent, results, attempts: v.attempts as number, ...(typeof v.claimedAt === "number" ? { claimedAt: v.claimedAt } : {}) };
}

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export class AskerWakes {
  private readonly intents = new Map<string, AskerWakeIntent>();
  /** every live record, by thread, oldest first */
  private readonly wakes = new Map<string, AskerWakeRecord[]>();
  /** records that reached their engine, by thread, with the replies they carried: the one rebuild of such a turn (memory redispatch)
   * passes check() and start() while those replies' authors are still allowed; Stop clears them */
  private readonly doneIds = new Map<string, { botId: string; done: Array<{ id: string; results: AskerWakeResult[] }> }>();
  private doneRecord(id: string): { id: string; results: AskerWakeResult[] } | undefined {
    for (const entry of this.doneIds.values()) { const found = entry.done.find((d) => d.id === id); if (found) return found; }
    return undefined;
  }
  /** The bot each thread with kept state belongs to, so a thread emptied by a transition can still be cleared on disk. */
  private readonly owners = new Map<string, string>();

  private readonly persist?: AskerWakePersist;
  constructor(persist?: AskerWakePersist) { this.persist = persist; }

  private records(threadId: string): AskerWakeRecord[] { return this.wakes.get(threadId) ?? []; }
  private record(id: string): { threadId: string; record: AskerWakeRecord } | undefined {
    for (const [threadId, records] of this.wakes) { const record = records.find((r) => r.id === id); if (record) return { threadId, record }; }
    return undefined;
  }
  private remove(threadId: string, id: string): AskerWakeRecord | undefined {
    const records = this.records(threadId);
    const index = records.findIndex((r) => r.id === id);
    if (index < 0) return undefined;
    const [gone] = records.splice(index, 1);
    if (!records.length) this.wakes.delete(threadId);
    return gone;
  }

  /** The whole durable state of one asker thread, or undefined when it owes nothing. Claimed and started records are kept too. */
  snapshot(threadId: string): AskerWakeSnapshot | undefined {
    const intents = [...this.intents].filter(([, intent]) => intent.threadId === threadId).map(([taskId, intent]) => ({ taskId, intent }));
    const wakes = this.records(threadId);
    if (!intents.length && !wakes.length) return undefined;
    return { intents, wakes: copy(wakes) };
  }

  /** Write one thread's state out. The bot is the one that asked; a thread with nothing left is cleared. False when the write failed:
   * the transitions that must be durable before they count (claim, start, replayHeld) refuse on false and undo themselves. */
  flush(threadId: string, botId?: string): boolean {
    if (!this.persist) return true;
    const snapshot = this.snapshot(threadId);
    const owner = botId ?? this.owners.get(threadId) ?? this.unwritten.get(threadId) ?? snapshot?.intents[0]?.intent.botId ?? snapshot?.wakes[0]?.intent.botId;
    if (!owner) return true;
    if (snapshot) this.owners.set(threadId, owner); else this.owners.delete(threadId);
    try { this.persist(owner, threadId, snapshot); this.unwritten.delete(threadId); return true; }
    catch (error) {
      // the disk refused the write: what memory says and what disk says differ until a later write lands (retryWrites, and every later
      // change to this thread). A cancellation that stays unwritten through a crash is the one case a restart cannot tell (known limits).
      this.unwritten.set(threadId, owner);
      console.error("asker wakes: could not keep a thread's owed wakes", error);
      return false;
    }
  }

  /** Threads whose last write failed, by owner; written again by retryWrites (the sweeps) and by any later change to the thread. */
  private readonly unwritten = new Map<string, string>();
  /** Write every thread whose last write failed, again. True when nothing is left unwritten. */
  retryWrites(): boolean {
    for (const [threadId, owner] of [...this.unwritten]) this.flush(threadId, owner);
    return this.unwritten.size === 0;
  }

  /** A thread's kept state after a restart, reconciled to one carrier per record (design section 4). `heldIds` are the thread's held
   * continuation ids. Each record is checked whole; one that does not read back is dropped, never widened. */
  restore(threadId: string, snapshot: AskerWakeSnapshot, heldIds: ReadonlySet<string>, botId?: string): void {
    if (!snapshot || typeof snapshot !== "object") return;
    if (Array.isArray(snapshot.intents)) for (const item of snapshot.intents.slice(0, MAX_ASKER_INTENTS)) {
      const intent = text(item?.taskId) ? restoredIntent(item.intent, threadId) : undefined;
      if (intent) this.intents.set(item.taskId, intent);
    }
    while (this.intents.size > MAX_ASKER_INTENTS) this.intents.delete(this.intents.keys().next().value as string);
    const records: AskerWakeRecord[] = [];
    if (Array.isArray(snapshot.wakes)) for (const item of snapshot.wakes.slice(0, MAX_ASKER_WAKES)) {
      const record = restoredRecord(item, threadId);
      if (!record || records.some((r) => r.id === record.id)) continue;
      // started: the prompt may have reached the engine (the fence is written before the call, the accounting after acceptance).
      // Never run again by itself, as a submitted hand-off is not; the reply stays owed to the asker's next turn as external context.
      if (record.state === "started") continue;
      if (record.state === "claimed") {
        if (record.held) {
          // the held item is the carrier; without it, the item went with Stop or with acceptance and nothing is owed
          if (!heldIds.has(heldWakeId(record.id)) || record.attempts >= MAX_ASKER_WAKE_ATTEMPTS) continue;
        } else {
          // the claim lived in memory and died with the process before the prompt went out: owed again, its attempt lost
          record.attempts += 1;
          if (record.attempts >= MAX_ASKER_WAKE_ATTEMPTS) continue;
          record.state = "owed";
          delete record.claimedAt;
        }
      }
      records.push(record);
    }
    if (records.length) this.wakes.set(threadId, records);
    const owner = this.snapshot(threadId)?.intents[0]?.intent.botId ?? records[0]?.intent.botId ?? botId;
    if (owner) this.owners.set(threadId, owner);
    // what the reconciliation dropped leaves the disk now, not at the next change
    this.flush(threadId, owner);
  }

  /** An ask handed over to a delegation, by task id. Bounded; the oldest goes first. */
  /** Whether this task still owes its asker a wake it has not delivered (its intent is registered). */
  intends(taskId: string): boolean { return this.intents.has(taskId); }

  /** Whether a thread's kept state is on disk (its last write landed, or it has nothing to write). */
  durable(threadId: string): boolean { return !this.unwritten.has(threadId); }

  /** True once the intent is on disk (one retry): a hand-off is acknowledged only then (NOHOLD-DELEGATION.md, the asker's one wake). */
  register(taskId: string, intent: AskerWakeIntent): boolean {
    const previous = this.intents.get(taskId);
    this.intents.delete(taskId);
    this.intents.set(taskId, intent);
    const evicted: AskerWakeIntent[] = [];
    while (this.intents.size > MAX_ASKER_INTENTS) {
      const oldest = this.intents.keys().next().value as string;
      evicted.push(this.intents.get(oldest)!);
      this.intents.delete(oldest);
    }
    const kept = this.flush(intent.threadId, intent.botId) || this.flush(intent.threadId, intent.botId);
    for (const gone of [previous, ...evicted]) if (gone && gone.threadId !== intent.threadId) this.flush(gone.threadId, gone.botId);
    return kept;
  }

  /** The teammate's turn ended. True when this task owes its asker a wake. The reply joins the thread's newest owed record asked
   * under the same authority while that one has room; otherwise it opens a record of its own. A claimed or started record never
   * gains a reply: what is in flight stays what it was. */
  deliver(taskId: string, result: Omit<AskerWakeResult, "taskId">): boolean {
    const intent = this.intents.get(taskId);
    if (!intent) return false;
    const records = this.records(intent.threadId);
    // idempotent by task and by line: the same return delivered twice (the finalizer and the receipt's recovery, a replayed commit) is one wake
    if (records.some((r) => r.results.some((kept) => kept.taskId === taskId || (result.messageId !== undefined && kept.messageId === result.messageId)))) { this.intents.delete(taskId); return false; }
    this.intents.delete(taskId);
    const open = [...records].reverse().find((r) => r.state === "owed" && r.results.length < MAX_ASKER_RESULTS && sameAuthority(r.intent, intent));
    if (open) open.results.push({ ...result, taskId });
    else {
      // overflow: a thread holds at most MAX_ASKER_WAKES records. Nothing kept is dropped for a newcomer; the newcomer wakes nobody
      // by itself (its reply is in the thread and still owed to the asker's next turn as external context).
      if (records.length >= MAX_ASKER_WAKES) { console.warn(`asker wakes: thread ${intent.threadId} already holds ${MAX_ASKER_WAKES} wakes; the reply to ${taskId} waits for the next turn`); return false; }
      records.push({ id: randomUUID(), state: "owed", intent, results: [{ ...result, taskId }], attempts: 0 });
      this.wakes.set(intent.threadId, records);
    }
    this.flush(intent.threadId, intent.botId);
    return true;
  }

  /** The asker read the receipt itself (check/wait_delegation): no wake is owed for it. A wake already in flight keeps its line. */
  consume(taskId: string): void {
    const intent = this.intents.get(taskId);
    const touched = new Map<string, string>();
    if (intent) { this.intents.delete(taskId); touched.set(intent.threadId, intent.botId); }
    for (const [threadId, records] of this.wakes) {
      for (const record of [...records]) {
        if (record.state !== "owed" || !record.results.some((r) => r.taskId === taskId)) continue;
        record.results = record.results.filter((r) => r.taskId !== taskId);
        if (!record.results.length) this.remove(threadId, record.id);
        touched.set(threadId, record.intent.botId);
      }
    }
    for (const [threadId, botId] of touched) this.flush(threadId, botId);
  }

  /** Whether the thread has a wake nobody has claimed. */
  has(threadId: string): boolean { return this.records(threadId).some((r) => r.state === "owed"); }
  threads(): string[] { return [...this.wakes].filter(([, records]) => records.some((r) => r.state === "owed")).map(([threadId]) => threadId); }

  /** Take the oldest owed wake to start it: it is claimed, by this caller alone, and kept that way on disk before anything
   * awaits. A copy comes back; the record itself is reached by id from here on. */
  claim(threadId: string): AskerWakeRecord | undefined {
    const record = this.records(threadId).find((r) => r.state === "owed");
    if (!record) return undefined;
    record.state = "claimed";
    record.claimedAt = Date.now();
    // the claim counts only once it is on disk: a failed write undoes it, and the sweep tries again later
    if (!this.flush(threadId, record.intent.botId)) { record.state = "owed"; delete record.claimedAt; return undefined; }
    return copy(record);
  }

  /** Whether a wake may still be started: it exists and is claimed or started (not done, not cancelled). */
  startable(id: string): boolean { return this.record(id) !== undefined; }
  /** The record's state, or undefined once it is done or cancelled. */
  stateOf(id: string): AskerWakeState | undefined { return this.record(id)?.record.state; }
  /** Whether the held continuation `wake:<id>` is the record's carrier (claimed + held). */
  isHeld(id: string): boolean { const found = this.record(id); return found?.record.state === "claimed" && found.record.held === true; }

  /** The re-check at admission, the last thing before a turn is admitted. A claimed or started record passes while at least one
   * of its replies is still owed to the engine and allowed (`allowed`: the reply still in the thread's external updates, its author
   * still a bot the asker may hear from); with none left it is cancelled (nothing to wake for). A done id passes while one of the
   * replies it carried is still `authorized` (its author, as the asker may hear from it now; the reply itself was carried already):
   * that is the rebuild of a turn the engine already accepted (memory redispatch), the same turn, not a second wake. Anything else
   * (never claimed, Stop, a failed turn, a deleted bot or conversation, attempts exhausted) refuses. */
  check(id: string, allowed: (result: AskerWakeResult) => boolean, authorized: (result: AskerWakeResult) => boolean = () => true): boolean {
    const found = this.record(id);
    if (!found) { const done = this.doneRecord(id); return done !== undefined && done.results.some(authorized); }
    if (found.record.state === "owed") return false;
    if (found.record.results.some(allowed)) return true;
    this.cancel(id);
    return false;
  }

  /** The submission fence, and the compare-and-set that decides it: the prompt is about to go out. In this one synchronous step the
   * record is re-checked by identity (it exists, by id), cancellation (Stop, a failed turn, a deleted bot or conversation, attempts
   * exhausted all removed it) and authority (`allowed`, as at admission: the reply still owed, its author still a bot the asker may
   * hear from) and, if it is claimed or started, marked started and WRITTEN before true comes back, so a restart never runs the
   * wake again by itself; a write that fails undoes the mark and refuses. A done id (an engine that accepted before the fence, or
   * the rebuild of an accepted turn) passes without a change. Anything else refuses the submission. */
  start(id: string, allowed: (result: AskerWakeResult) => boolean = () => true, authorized: (result: AskerWakeResult) => boolean = () => true): boolean {
    const found = this.record(id);
    // accepted before the fence (Codex), or the rebuild of an accepted turn: the authority of what it carried is asked again now
    if (!found) { const done = this.doneRecord(id); return done !== undefined && done.results.some(authorized); }
    if (found.record.state === "owed") return false;
    if (!found.record.results.some(allowed)) { this.cancel(id); return false; }
    if (found.record.state === "started") return true;
    found.record.state = "started";
    if (!this.flush(found.threadId, found.record.intent.botId)) { found.record.state = "claimed"; return false; }
    return true;
  }

  /** The engine had no tools: the held continuation `wake:<id>` carries the wake until an engine with tools accepts it. Only a
   * claimed record is held (the hold is decided before the fence). */
  hold(id: string): void {
    const found = this.record(id);
    if (!found || found.record.state !== "claimed") return;
    found.record.held = true;
    this.flush(found.threadId, found.record.intent.botId);
  }

  /** The drain is about to replay a held wake: one attempt is spent, on disk, before it begins, so a replay that never comes back
   * (a crash in setup) has paid for itself. False when the wake is gone, not held, or at the cap (then it is ended, and the item goes). */
  replayHeld(id: string): boolean {
    const found = this.record(id);
    if (!found || !found.record.held || found.record.state !== "claimed") return false;
    if (found.record.attempts >= MAX_ASKER_WAKE_ATTEMPTS) { this.cancel(id); return false; }
    found.record.attempts += 1;
    // paid on disk, or not begun: a replay whose payment did not land could otherwise loop for free across crashes
    if (!this.flush(found.threadId, found.record.intent.botId)) { found.record.attempts -= 1; return false; }
    return true;
  }

  /** The engine accepted the turn that carries this wake: nothing is owed. The id is remembered so a rebuild of that turn passes
   * check() and start(). Reached from claimed (an engine that hands its turn id back before the fence) or started. */
  done(id: string): void {
    const found = this.record(id);
    if (!found || found.record.state === "owed") return;
    this.remove(found.threadId, id);
    const entry = this.doneIds.get(found.threadId) ?? { botId: found.record.intent.botId, done: [] };
    entry.done.push({ id, results: copy(found.record.results) });
    while (entry.done.length > MAX_DONE_IDS) entry.done.shift();
    this.doneIds.set(found.threadId, entry);
    this.flush(found.threadId, found.record.intent.botId);
  }

  /** A start that could not go ahead (busy, at its thread limit): owed again, a bounded number of times. False when it gave up (and ended). */
  requeue(id: string): boolean {
    const found = this.record(id);
    if (!found || found.record.state === "owed") return false;
    found.record.attempts += 1;
    if (found.record.attempts >= MAX_ASKER_WAKE_ATTEMPTS) { this.cancel(id); return false; }
    found.record.state = "owed";
    delete found.record.held;
    delete found.record.claimedAt;
    this.flush(found.threadId, found.record.intent.botId);
    return true;
  }

  /** This wake is over: a start that failed, nothing left owed, attempts exhausted. */
  cancel(id: string): void {
    const found = this.record(id);
    if (!found) return;
    this.remove(found.threadId, id);
    this.flush(found.threadId, found.record.intent.botId);
  }

  /** A turn on this thread ended without success: whoever stopped it does not expect a restart, and asks it still has out are
   * forgotten too, or their late replies would restart it. The done ids stay: the one rebuild that follows such an ending, the late
   * memory refusal's, is the rebuild they exist for. Only Stop (drop, dropBot) clears them. */
  failed(threadId: string, botId?: string): void {
    const owner = botId ?? this.owners.get(threadId) ?? this.snapshot(threadId)?.intents[0]?.intent.botId ?? this.records(threadId)[0]?.intent.botId;
    this.wakes.delete(threadId);
    for (const [taskId, intent] of this.intents) if (intent.threadId === threadId) this.intents.delete(taskId);
    if (owner) this.flush(threadId, owner);
  }

  /** Stop in this conversation: nothing it is owed, nothing in flight and no rebuild restarts it. */
  drop(threadId: string, botId?: string): void {
    this.failed(threadId, botId);
    this.doneIds.delete(threadId);
  }

  /** Stop everything for this bot, or the bot is gone: nothing it asked for restarts it. */
  dropBot(botId: string): void {
    const touched = new Set<string>();
    for (const [taskId, intent] of this.intents) if (intent.botId === botId) { this.intents.delete(taskId); touched.add(intent.threadId); }
    for (const [threadId, records] of this.wakes) {
      const kept = records.filter((r) => r.intent.botId !== botId);
      if (kept.length === records.length) continue;
      if (kept.length) this.wakes.set(threadId, kept); else this.wakes.delete(threadId);
      touched.add(threadId);
    }
    for (const [threadId, entry] of this.doneIds) if (entry.botId === botId) this.doneIds.delete(threadId);
    for (const threadId of touched) this.flush(threadId, botId);
  }
}

/** The held continuations a wake left (a wake that reached an engine with no tools is held, marked askerWake): what Stop removes. */
export function askerWakeHeldIds(items: readonly HeldContinuation[] | undefined): string[] {
  return (items ?? []).filter((item) => item.options?.askerWake === true).map((item) => item.id);
}

/** What the woken turn runs as: the asking turn's own standing and nothing
 * above it. A wake has no origin of its own, so anything the asking turn was
 * NOT (owner audience, attended) has to be said here or the turn would read
 * as the owner's. */
export function askerWakeTurnOptions(intent: AskerWakeIntent): {
  askerWake: true; commsDepth?: number; coordination?: CoordinationTrace; notOwnerAudience?: true; chainNotOwner?: true; unattended?: true; eventId?: string;
  routineAuthority?: RoutinePeerSource; askerWakeCeiling?: RoutinePermissionMode;
} {
  return {
    // marks the turn as a wake: it never reads the thread's live routine record, and Stop finds it if it is held
    askerWake: true,
    ...(intent.askingMode ? { askerWakeCeiling: intent.askingMode } : {}),
    ...(intent.depth > 0 ? { commsDepth: intent.depth } : {}),
    ...(intent.coordination ? { coordination: intent.coordination } : {}),
    ...(intent.notOwnerAudience ? { notOwnerAudience: true as const, chainNotOwner: true as const } : {}),
    ...(intent.unattended || intent.routineRun ? { unattended: true as const } : {}),
    ...(intent.eventId ? { eventId: intent.eventId } : {}),
    ...(intent.routineAuthority ? { routineAuthority: { ...intent.routineAuthority } } : {}),
  };
}

/** The one control-plane line that resumes the asker. It names the task and the
 * teammate and points at the message already in the conversation; it never
 * repeats the reply, so a reply the reader may not see stays withheld. */
export function askerWakePrompt(results: readonly AskerWakeResult[]): string {
  const lines = results.map((r) => r.ok
    ? `- @${r.toBotName} replied to the task you handed off (task id ${r.taskId}).`
    : `- @${r.toBotName} did not finish the task you handed off (task id ${r.taskId}).`);
  return [
    "[Murage: while you were away, the teammate you asked finished.",
    ...lines,
    "Their reply is the latest message in this conversation. Carry on with the work you were doing, using it. Do not ask the same teammate again for what they just answered.]",
  ].join("\n");
}
