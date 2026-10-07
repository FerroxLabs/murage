import { threadHumanPrincipal } from "./human-principals.ts";
import { isSharedWorkRow, drainSharedWork } from "./shared-work.ts";
import { roomRequestByKey, isTerminalRoomRequestState } from "./room-requests.ts";
import { database } from "./database.ts";
import { defaultThreadId, audienceTask, authorizeWork, issueWorkAudience, issueExecutionAudience, validExecutionAudience } from "./execution-audience.ts";
import type { ExecutionAudience } from "./work-admission.ts";
// Async peer handoff (delegate_bot).
//
// A bot that finishes one task can hand the NEXT task to a peer without
// blocking its own turn — the source bot's turn.completed fires after it
// settles, and the queued delegation runs then. The peer gets a fresh
// depth-1 turn (depth cap still blocks A→B→C chains, see index.ts).
//
// Visiblity rides on the same comms-visibility helpers ask_bot uses
// (channel mirror + 1:1 chips) so a delegated exchange looks like an
// exchanged one. The optional approval gate (A2) is checked at drain
// time, never at queue time, because the user might have just turned
// approvePeerComms on between queueing and draining.

import { DELEGATION_OUTCOMES } from "../shared/record-values.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { hostStoppedDisplayName } from "../shared/host-stop.ts";
import { folderTrustDisplayName } from "../shared/folder-trust.ts";
import { writeFileAtomic } from "./atomic.ts";
import { coordinationTraceSchema, MAX_HANDOFFS_PER_TURN, type CoordinationTrace } from "./coordination-budget.ts";
import { getOrCreateChannel, mirrorExchange, type CommsBus } from "./comms-visibility.ts";
import { DATA_DIR } from "./config.ts";
import { newId } from "./contracts.ts";
import { peerApprovalFailure, requestPeerApproval, type ApprovalBus } from "./peer-approval.ts";
import { ROUTINE_PERMISSION_MODES, type RoutinePeerSource } from "./routine-permissions.ts";

import type { BotRecord, GroupRecord } from "./store.ts";

/** Every row a handoff leaves in its source conversation names who handed
 * off when that conversation is a room. Several bots delegate in a room, and
 * a failure row without `from` rendered unattributed, so nobody could tell
 * whose handoff failed (0.1.60 low). A bot's own thread is the sender's, so
 * its rows stay as they were. */
function appendDelegationRow(
  bus: CommsBus,
  threadId: string,
  senderId: string | undefined,
  message: Parameters<CommsBus["store"]["appendMessage"]>[1],
): ReturnType<CommsBus["store"]["appendMessage"]> {
  const sender = senderId && bus.store.groupByThread(threadId) ? bus.store.bot(senderId) : undefined;
  return bus.store.appendMessage(threadId, sender ? { ...message, from: { botId: sender.id, name: sender.name, color: sender.color } } : message);
}

export interface DelegationItem {
  executionAudience?: ExecutionAudience;
  toBotId: string;
  message: string;
  reason?: string;
  /** The user already approved this exact peer message while it was still
   * an ask_bot request. If that peer became busy before dispatch, the
   * fallback handoff must not ask them to approve the same action twice. */
  approvalAlreadyGranted?: boolean;
  /** Queued from a Full access turn the owner started, so the contact card
   * is skipped at drain time — if the sender's conversation is still on
   * Full access then. Never set for a webhook, channel or routine turn. */
  fullAccessWaived?: boolean;
  /** Queued by a turn that was not owner audience (owner-audience.ts): the
   *  peer's turn is not either, after a restart too. */
  notOwnerAudience?: boolean;
  /** Queued by an unattended turn (no one proved the owner was there): the
   *  peer's turn runs unattended too, after a restart too, so Full access
   *  keeps the owner's cards for it. */
  unattended?: boolean;
  /** The effective parent routine ceiling, captured before its turn ends. */
  routineAuthority?: RoutinePeerSource;
  /** Trusted originating event identity. Survives handoff/retry/restart so
   * the harness can retain the event's budget and provenance boundary. */
  eventId?: string;
  /** Source depth; the child runs at depth+1. Tools stay available while
   * the server enforces depth, lineage and root allowances at admission. */
  depth: number;
  /** Durable server-issued ancestry, never model-supplied. */
  coordination?: CoordinationTrace;
}

interface PendingDelegationItem extends DelegationItem {
  /** Stable acknowledgement key for crash-safe removal from the queue —
   * and the task id the delegating bot uses with check/wait_delegation. */
  id: string;
  /** Who queued this handoff. A 1:1 source thread identifies its owner, so
   * the drain used to recover the sender with botByThread alone — which is
   * null for a ROOM thread, and the whole queue was then deleted with no
   * receipt and no turn. Persisted so that survives a restart too. */
  fromBotId?: string;
  /** Busy-target retries so far. The item stays queued (not canceled) while
   * the target is busy, and is retried when any of the target's turns
   * settles — up to MAX_BUSY_ATTEMPTS. */
  attempts: number;
  /** True after this item observed the target's current busy period. Other
   * queue activity must not count that same period again; the target's idle
   * transition clears this marker before the next retry. */
  waitingOnBusy?: boolean;
  /** When this item last parked. The fallback timer retries a parked item
   * that no idle transition has woken for BUSY_RETRY_FALLBACK_MS. */
  waitingSince?: number;
  /** The newest "waiting" line on the source thread, which carries the Stop
   * control while the item waits. Cleared once the item leaves the queue. */
  waitMessageId?: string;
}

/** Declared in shared/record-values.ts, which the backup reads too. */
export type DelegationOutcome = typeof DELEGATION_OUTCOMES[number];

/** The durable terminal record of one handoff: what the delegating bot reads
 * back with check_delegation / wait_delegation. Bounded and pruned — this is
 * a receipt drawer, not a transcript. */
export interface DelegationReceipt {
  id: string;
  sourceThreadId: string;
  toBotId: string;
  toBotName: string;
  status: DelegationOutcome;
  /** the peer's reply on success; the failure name otherwise (bounded) */
  result?: string;
  /** Where the reply came from, so reading it back follows the original:
   * withheld when it is (server/memory/replay-lineage.ts). */
  copyOf?: { threadId: string; messageIds: string[] };
  /** The delegated turn itself read memory as a non-owner audience. */
  notOwnerAudience?: true;
  /** Written by a build whose results carry their origin (copyOf when there
   * is text). Without it the result cannot be checked and is withheld. */
  lineage?: boolean;
  finishedAt: number;
}

export type QueueResult = "ok" | "no_target" | "self" | "too_deep" | "too_many";

/** What queueDelegation hands back: the verdict, and on success the task id
 * the delegating bot can later read back with check/wait_delegation. */
export interface QueuedDelegation {
  result: QueueResult;
  id?: string;
}

/** Per source-thread queue. Persisted to delegations.json on every change
 * and reloaded at boot: a handoff queued right before a restart runs after
 * it. (Provider PERMISSIONS still die with the process — nobody can answer
 * for an unattended bot — but queued work is not a permission; the target
 * and approvePeerComms are re-checked at drain time as always.) */
const pendingDelegations = new Map<string, PendingDelegationItem[]>();
const drainingThreads = new Set<string>();
/** Threads whose drain was requested WHILE a drain was already running.
 * Dropping such a request loses real work: the waiting-on retry fires the
 * moment a busy target settles, and that can land mid-drain. */
const queuedRedrains = new Set<string>();
const DELEGATIONS_FILE = join(DATA_DIR, "delegations.json");
const RECEIPTS_FILE = join(DATA_DIR, "delegation-receipts.json");
const MAX_RECEIPTS = 100;
const RECEIPT_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const RESULT_MAX_CHARS = 4_000;
export const MAX_BUSY_ATTEMPTS = 3;
/** How long a parked handoff waits for its wake-up before the fallback timer
 * retries it anyway. The wake-up is the target going idle, and some of those
 * transitions happen while the target still cannot take the handoff (a room
 * that holds its members until its whole turn ends); nothing fires after
 * that, so without this the handoff waited until a restart (0.1.60 L4-1).
 * A retry the timer finds still busy spends an attempt, so a teammate who
 * stays busy ends in the usual "canceled" line rather than an endless wait. */
export const BUSY_RETRY_FALLBACK_MS = 5 * 60_000;

/** Must this handoff wait for the target?
 *
 * NOT `target.busy`, which is the union over every one of the bot's threads
 * (Store.refreshBotActivity): a bot running a scheduled routine in a detached
 * task thread reads busy even though the thread a handoff would run on is
 * idle and two of its three thread slots are free. Admission said no while
 * dispatch would have said yes, and after MAX_BUSY_ATTEMPTS the handoff was
 * not parked but CANCELLED — "stayed busy through 3 retries" — over capacity
 * the teammate had the whole time.
 *
 * So ask the harness the same question the dispatch asks. Without the hook
 * (an embedder with no thread bookkeeping, and every test that fakes this
 * bus) this is the bot-wide flag exactly as before, which is stricter, never
 * looser: this change can only ever let a handoff through sooner. */
function mustWaitFor(bus: CommsBus, target: BotRecord, sourceThreadId: string): boolean {
  if (bus.canStartHandoff) return !bus.canStartHandoff(target.id, sourceThreadId);
  return Boolean(target.busy);
}
const validEventId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);

let receipts: DelegationReceipt[] = [];

function saveReceipts(): void {
  try {
    writeFileAtomic(RECEIPTS_FILE, JSON.stringify(receipts, null, 2), { mode: 0o600 });
  } catch (error) {
    console.error("delegations: could not persist receipts", error);
  }
}

/** One listener told of every terminal outcome after it is recorded: the
 * turn engine completes the handoff's `ask` request with it (lane E1), so a
 * handoff the ledger ends without a turn (cancelled, refused, target gone)
 * still reaches the bot waiting on it. */
let receiptListener: ((receipt: DelegationReceipt) => void) | undefined;
export function onDelegationReceipt(listener: ((receipt: DelegationReceipt) => void) | undefined): void {
  receiptListener = listener;
}

/** Record one terminal outcome. Newest first; pruned by count and age so the
 * drawer can never grow without bound. */
export function recordDelegationReceipt(receipt: Omit<DelegationReceipt, "finishedAt"> & { finishedAt?: number }): void {
  const now = Date.now();
  const bounded: DelegationReceipt = {
    id: receipt.id,
    sourceThreadId: receipt.sourceThreadId,
    toBotId: receipt.toBotId,
    toBotName: receipt.toBotName,
    status: receipt.status,
    finishedAt: receipt.finishedAt ?? now,
  };
  if (receipt.result !== undefined) bounded.result = receipt.result.slice(0, RESULT_MAX_CHARS);
  // one past the check's width budget, so a longer link reads as unestablished
  if (receipt.copyOf) bounded.copyOf = { threadId: receipt.copyOf.threadId, messageIds: receipt.copyOf.messageIds.slice(0, 65) };
  if (receipt.notOwnerAudience === true) bounded.notOwnerAudience = true;
  if (receipt.lineage === true) bounded.lineage = true;
  receipts = [bounded, ...receipts.filter((existing) => existing.id !== bounded.id)]
    .filter((existing) => now - existing.finishedAt <= RECEIPT_MAX_AGE_MS)
    .slice(0, MAX_RECEIPTS);
  saveReceipts();
  try { receiptListener?.(bounded); } catch (error) { console.error("delegations: receipt listener failed", error); }
}

/** A deleted conversation takes its handoffs with it: queued ones and the
 * results peers sent back to it. */
export function forgetDelegationsForThreads(threadIds: readonly string[]): void {
  const gone = new Set(threadIds);
  let pendingChanged = false;
  for (const threadId of gone) if (pendingDelegations.delete(threadId)) pendingChanged = true;
  if (pendingChanged) savePending();
  const kept = receipts.filter((receipt) => !gone.has(receipt.sourceThreadId));
  if (kept.length !== receipts.length) {
    receipts = kept;
    saveReceipts();
  }
}

export function findDelegationReceipt(id: string): DelegationReceipt | null {
  return receipts.find((receipt) => receipt.id === id) ?? null;
}

/** A still-queued task's routing info, or null once it dispatched/settled. */
export function pendingDelegationInfo(id: string): { sourceThreadId: string; toBotId: string; attempts: number } | null {
  for (const [sourceThreadId, items] of pendingDelegations) {
    const item = items.find((candidate) => candidate.id === id);
    if (item) return { sourceThreadId, toBotId: item.toBotId, attempts: item.attempts };
  }
  return null;
}

export function hasPendingBotDelegations(bot: BotRecord): boolean {
  const threads = new Set([bot.threadId, ...(bot.tasks ?? []).map(task => task.threadId)]);
  return [...pendingDelegations].some(([threadId, items]) => items.some(item =>
    item.toBotId === bot.id || item.fromBotId === bot.id || !item.fromBotId && threads.has(threadId)));
}

/** Source threads currently waiting for this busy bot — the set its idle
 * transition re-drains. Fresh items are excluded: they run when their SOURCE
 * turn settles, and draining them early would start the peer too soon. */
export function threadsWaitingOn(toBotId: string): string[] {
  return [...pendingDelegations.entries()]
    .filter(([, items]) => items.some((item) => item.toBotId === toBotId && item.waitingOnBusy === true))
    .map(([threadId]) => threadId);
}

/** Mark a target's observed busy period as finished and return the source
 * threads that should be retried. This makes retries count distinct busy
 * periods, not unrelated drain requests on the same source thread.
 *
 * `admit`, when given, limits the release to the source threads whose
 * handoff could start right now. A bot still busy in one thread can free a
 * slot another handoff could use (upstream #1678), but releasing every
 * waiting handoff then would spend a busy retry on each one whose own
 * thread is still taken, and MAX_BUSY_ATTEMPTS would cancel it while the
 * teammate was only ever busy on something else. */
export function releaseDelegationsWaitingOn(toBotId: string, admit?: (sourceThreadId: string) => boolean): string[] {
  const threads = threadsWaitingOn(toBotId).filter((threadId) => !admit || admit(threadId));
  if (!threads.length) return threads;
  for (const threadId of threads) {
    for (const item of pendingDelegations.get(threadId) ?? []) {
      if (item.toBotId === toBotId) delete item.waitingOnBusy;
    }
  }
  savePending();
  return threads;
}

/** Release every parked handoff that should be retried now, whoever it
 * waits on, and return the source threads to drain.
 *
 * Two reasons release an item. Its target can take it right now: the idle
 * transition that should have woken it already passed while the target was
 * still held (a room keeps its members until the whole room turn ends, and
 * nothing fires after that). Or it has waited BUSY_RETRY_FALLBACK_MS with
 * no wake-up at all: the drain then re-checks, and a target still busy
 * costs an attempt, so the wait ends in the usual "canceled" line. The
 * server calls this when a room turn ends and on a timer. */
export function releaseParkedDelegations(
  canStart: (toBotId: string, sourceThreadId: string) => boolean,
  now = Date.now(),
  fallbackMs = BUSY_RETRY_FALLBACK_MS,
): string[] {
  const threads: string[] = [];
  for (const [threadId, items] of pendingDelegations) {
    if (drainingThreads.has(threadId)) continue;
    let released = false;
    for (const item of items) {
      if (!item.waitingOnBusy) continue;
      const due = now - (item.waitingSince ?? now) >= fallbackMs;
      let ready = false;
      try { ready = canStart(item.toBotId, threadId); } catch { ready = false; }
      if (!ready && !due) continue;
      delete item.waitingOnBusy;
      released = true;
    }
    if (released) threads.push(threadId);
  }
  if (threads.length) savePending();
  return threads;
}

/** Is any queued handoff actually in progress? A parked one is not: it only
 * waits for a busy teammate, it is on disk, and nothing can dispatch it
 * while a backup holds admission. Counting it as running work refused every
 * backup, with nothing for the person to finish or stop (0.1.60 L4-1). A
 * fresh item still counts: its source turn is settling and it runs next. */
export function hasActiveDelegationWork(): boolean {
  for (const [threadId, items] of pendingDelegations) {
    if (drainingThreads.has(threadId) || items.some((item) => !item.waitingOnBusy)) return true;
  }
  return false;
}

/** The person's Stop on a waiting line: drop that one parked handoff, with
 * a receipt the delegating bot can read and a line where the wait was
 * shown. False when it is not waiting any more (it ran, gave up, or is
 * being dispatched right now). */
export function stopWaitingDelegation(bus: CommsBus, id: string): boolean {
  for (const [threadId, items] of pendingDelegations) {
    const item = items.find((candidate) => candidate.id === id);
    if (!item) continue;
    if (!item.waitingOnBusy || drainingThreads.has(threadId)) return false;
    const target = bus.store.bot(item.toBotId);
    const name = target?.name ?? item.toBotId;
    acknowledgeDelegation(threadId, id, bus);
    recordDelegationReceipt({
      id,
      sourceThreadId: threadId,
      toBotId: item.toBotId,
      toBotName: name,
      status: "cancelled",
      result: "the owner stopped this handoff while it was waiting",
    });
    appendDelegationRow(bus, threadId, item.fromBotId, {
      role: "bot",
      kind: "activity",
      tool: { name: `Delegation to @${name} stopped by you`, ok: false },
    });
    return true;
  }
  return false;
}

/** Drop a queued handoff that has not started, whatever it waits on (lane
 * E1: its room request was cancelled, or the owner stopped the project).
 * False once it is draining or gone. */
export function dropQueuedDelegation(bus: CommsBus, id: string, reason: string): boolean {
  for (const [threadId, items] of pendingDelegations) {
    const item = items.find((candidate) => candidate.id === id);
    if (!item) continue;
    if (drainingThreads.has(threadId)) return false;
    const name = bus.store.bot(item.toBotId)?.name ?? item.toBotId;
    acknowledgeDelegation(threadId, id, bus);
    recordDelegationReceipt({ id, sourceThreadId: threadId, toBotId: item.toBotId, toBotName: name, status: "cancelled", result: reason });
    appendDelegationRow(bus, threadId, item.fromBotId, { role: "bot", kind: "activity", tool: { name: `Delegation to @${name} was cancelled`, ok: false } });
    return true;
  }
  return false;
}

/** Take the Stop control off an item's waiting line. Never throws: the line
 * is only a view of the queue, and the thread may be gone. */
function clearWaitLine(bus: CommsBus | undefined, threadId: string, item: PendingDelegationItem): void {
  const messageId = item.waitMessageId;
  if (!messageId) return;
  delete item.waitMessageId;
  if (!bus) return;
  try { bus.store.patchMessage(threadId, messageId, { delegationWait: undefined }); } catch { /* the thread is gone */ }
}

/** Park an item on a busy target and show the waiting line with Stop. */
function parkWaiting(bus: CommsBus, sourceThreadId: string, item: PendingDelegationItem, targetName: string): void {
  item.waitingSince = Date.now();
  clearWaitLine(bus, sourceThreadId, item);
  const line = appendDelegationRow(bus, sourceThreadId, item.fromBotId, {
    role: "bot",
    kind: "activity",
    tool: { name: `Delegation to @${targetName} waiting: they're busy (retry ${item.attempts}/${MAX_BUSY_ATTEMPTS} when they finish)` },
    delegationWait: { id: item.id },
  });
  item.waitMessageId = line.id;
  savePending();
}

function savePending(strict = false): void {
  try {
    writeFileAtomic(DELEGATIONS_FILE, JSON.stringify(Object.fromEntries(pendingDelegations), null, 2), { mode: 0o600 });
  } catch (error) {
    if (strict) throw new Error("DELEGATION_PERSISTENCE_FAILED: the handoff was not accepted");
    console.error("delegations: could not persist queue", error);
  }
}

/** Load what a previous process left queued. Missing or corrupt → empty. */
export function _loadPending(): void {
  pendingDelegations.clear();
  try {
    const raw = JSON.parse(readFileSync(DELEGATIONS_FILE, "utf8")) as Record<string, unknown>;
    for (const [threadId, list] of Object.entries(raw)) {
      if (!Array.isArray(list)) continue;
      const items = list.flatMap((value): PendingDelegationItem[] => {
        if (!value || typeof value !== "object") return [];
        const item = value as Partial<PendingDelegationItem>;
        if (
          typeof item.toBotId !== "string" ||
          typeof item.message !== "string" ||
          !Number.isFinite(item.depth)
        ) return [];
        // A malformed present marker must never become an unmarked turn.
        if (Object.hasOwn(item, "eventId") && !validEventId(item.eventId)) return [];
        if (Object.hasOwn(item, "executionAudience") && !validExecutionAudience(item.executionAudience)) return [];
        if (item.routineAuthority !== undefined && (!item.routineAuthority ||
          !ROUTINE_PERMISSION_MODES.includes(item.routineAuthority.permissionMode) ||
          !["manual", "schedule"].includes(item.routineAuthority.triggerSource))) return [];
        if (item.coordination !== undefined && !coordinationTraceSchema.safeParse(item.coordination).success) return [];
        const loaded: PendingDelegationItem = {
          id: typeof item.id === "string" && item.id ? item.id : newId(),
          toBotId: item.toBotId,
          message: item.message,
          ...(typeof item.reason === "string" ? { reason: item.reason } : {}),
          depth: Math.max(0, Math.trunc(item.depth!)),
          attempts: Number.isFinite(item.attempts) ? Math.max(0, Math.trunc(item.attempts!)) : 0,
          ...(typeof item.fromBotId === "string" && item.fromBotId ? { fromBotId: item.fromBotId } : {}),
          ...(item.eventId !== undefined ? { eventId: item.eventId } : {}),
          ...(item.executionAudience ? { executionAudience: item.executionAudience } : {}),
          ...(item.coordination ? { coordination: coordinationTraceSchema.parse(item.coordination) } : {}),
        };
        if (item.approvalAlreadyGranted === true) loaded.approvalAlreadyGranted = true;
        if (item.fullAccessWaived === true) loaded.fullAccessWaived = true;
        // fails closed: anything but an explicit false-by-absence keeps the mark
        if (Object.hasOwn(item, "notOwnerAudience")) loaded.notOwnerAudience = item.notOwnerAudience !== false;
        if (Object.hasOwn(item, "unattended")) loaded.unattended = item.unattended !== false;
        if (item.routineAuthority) loaded.routineAuthority = { ...item.routineAuthority };
        if (item.waitingOnBusy === true) {
          loaded.waitingOnBusy = true;
          // A queue written before this field existed restarts its clock.
          loaded.waitingSince = Number.isFinite(item.waitingSince) ? item.waitingSince! : Date.now();
        }
        if (typeof item.waitMessageId === "string" && item.waitMessageId) loaded.waitMessageId = item.waitMessageId;
        return [loaded];
      });
      if (items.length) pendingDelegations.set(threadId, items);
    }
  } catch {
    /* fresh install, or unreadable — start empty */
  }
  receipts = [];
  try {
    const rawReceipts = JSON.parse(readFileSync(RECEIPTS_FILE, "utf8"));
    if (Array.isArray(rawReceipts)) {
      const now = Date.now();
      const loaded: DelegationReceipt[] = [];
      for (const value of rawReceipts) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        // SAFETY: the Partial view only names candidate fields; every one is
        // narrowed below before a receipt is constructed from the narrowed
        // locals, so nothing unvalidated survives into `receipts`.
        const candidate = value as Partial<DelegationReceipt>;
        const { id, sourceThreadId, toBotId, toBotName, status, result, finishedAt, copyOf } = candidate;
        if (typeof id !== "string" || !id) continue;
        if (typeof sourceThreadId !== "string" || typeof toBotId !== "string") continue;
        if (typeof toBotName !== "string" || typeof status !== "string") continue;
        if (!Number.isFinite(finishedAt) || now - finishedAt! > RECEIPT_MAX_AGE_MS) continue;
        const receipt: DelegationReceipt = { id, sourceThreadId, toBotId, toBotName, status, finishedAt: finishedAt! };
        if (typeof result === "string") receipt.result = result;
        if (copyOf && typeof copyOf === "object" && typeof copyOf.threadId === "string" && Array.isArray(copyOf.messageIds) && copyOf.messageIds.every((m) => typeof m === "string")) {
          receipt.copyOf = { threadId: copyOf.threadId, messageIds: copyOf.messageIds.slice(0, 65) };
        }
        if (candidate.notOwnerAudience === true) receipt.notOwnerAudience = true;
        if (candidate.lineage === true) receipt.lineage = true;
        loaded.push(receipt);
      }
      receipts = loaded.slice(0, MAX_RECEIPTS);
    }
  } catch {
    /* no receipts yet */
  }
}

/** Source threads with something queued — what a boot drain iterates. */
export function pendingThreads(): string[] {
  return [...pendingDelegations.keys()];
}

/** Read-only metadata for the local Team Map. Task prompts stay private;
 * the UI only needs to know who handed work to whom and the optional label. */
export function pendingDelegationSnapshot(options: { activeOnly?: boolean } = {}): Array<{
  sourceThreadId: string;
  toBotId: string;
  reason?: string;
}> {
  return [...pendingDelegations.entries()].flatMap(([sourceThreadId, items]) =>
    items
      .filter((item) => !options.activeOnly || drainingThreads.has(sourceThreadId) || !item.waitingOnBusy)
      .map((item) => ({
      sourceThreadId,
      toBotId: item.toBotId,
      ...(item.reason ? { reason: item.reason } : {}),
    })),
  );
}

/** How many handoffs one turn may queue. Small on purpose: this is the only
 * thing standing between a confused bot and a fan-out of real turns. */
const MAX_QUEUED_PER_THREAD = MAX_HANDOFFS_PER_TURN;

/** Validate and enqueue a delegation. Pushes a "Delegated to @B: reason"
 * chip to the source thread so the user can see what was queued. */
export function queueDelegation(
  bus: CommsBus,
  from: BotRecord,
  item: DelegationItem,
  maxDepth: number,
  sourceThreadId = defaultThreadId(from),
): QueuedDelegation {
  if (item.eventId !== undefined && !validEventId(item.eventId)) throw new Error("Invalid delegation event identity");
  if (item.toBotId === from.id) return { result: "self" };
  if (item.depth >= maxDepth) return { result: "too_deep" };
  const target = bus.store.bot(item.toBotId);
  if (!target) return { result: "no_target" };
  const previous = pendingDelegations.get(sourceThreadId);
  const list = [...(previous ?? [])];
  // Async handoff removes the backpressure that ask_bot got for free by
  // making the caller wait. Without a cap, one turn can queue unboundedly
  // and fan out into as many real turns on the next settle.
  if (list.length >= MAX_QUEUED_PER_THREAD) return { result: "too_many" };
  const id = newId();
  const executionAudience = issueWorkAudience(from.id, item.toBotId, sourceThreadId, item.executionAudience ?? issueExecutionAudience(from.id, sourceThreadId, id), id, item.notOwnerAudience !== true);
  if (executionAudience && !validExecutionAudience(executionAudience)) throw new Error("Invalid execution audience");
  bus.prepareDelegation?.(from.id, target.id, sourceThreadId, item.message, id);
  list.push({ ...item, ...(executionAudience ? { executionAudience } : {}), id, attempts: 0, fromBotId: from.id });
  pendingDelegations.set(sourceThreadId, list);
  try { savePending(true); } catch (error) {
    if (previous) pendingDelegations.set(sourceThreadId, previous);
    else pendingDelegations.delete(sourceThreadId);
    throw error;
  }
  const label = `Delegated to @${target.name}${item.reason ? `: ${item.reason}` : ""}`;
  appendDelegationRow(bus, sourceThreadId, from.id, {
    role: "bot",
    kind: "activity",
    tool: { name: label },
    // A room is several bots in one thread: name who delegated.
    ...(bus.store.groupByThread(sourceThreadId) ? { from: { botId: from.id, name: from.name, color: from.color } } : {}),
  });
  return { result: "ok", id };
}

/** Drain queued delegations for a source thread (called on its
 * turn.completed). Each item is processed independently: a deny, a busy
 * target, or an error in one does not stop the rest. The actual start
 * of the target turn is delegated to `runTarget` so delegations.ts
 * stays free of harness-level concerns (commsDepth is the only thing
 * the caller needs). */
export function drainDelegations(
  bus: CommsBus,
  approvalBus: ApprovalBus,
  threadId: string,
  runTarget: (
    toBotId: string,
    message: string,
    commsDepth: number,
    sourceThreadId: string,
    channel: GroupRecord | undefined,
    taskId: string,
    fromBotId: string,
    eventId?: string,
    coordination?: CoordinationTrace,
    notOwnerAudience?: boolean,
    unattended?: boolean,
    executionAudience?: ExecutionAudience,
    routineAuthority?: RoutinePeerSource,
  ) => void | Promise<void>,
): void {
  if (drainingThreads.has(threadId)) {
    queuedRedrains.add(threadId);
    return;
  }
  const list = pendingDelegations.get(threadId);
  if (!list?.length) return;
  // A room thread has many speakers and no owning bot, so botByThread alone
  // resolved nothing and this function deleted the whole queue — a handoff
  // launched from a room vanished with no turn and no receipt. The queueing
  // bot names itself on the item; botByThread stays the fallback for queues
  // written before that field existed.
  const threadOwner = bus.store.botByThread(threadId);
  const senderFor = (item: PendingDelegationItem): BotRecord | null =>
    (item.fromBotId ? bus.store.bot(item.fromBotId) : null) ?? threadOwner;
  const snapshot = [...list];
  if (!snapshot.some((item) => senderFor(item))) {
    pendingDelegations.delete(threadId);
    savePending();
    return;
  }
  drainingThreads.add(threadId);
  void (async () => {
    for (const item of snapshot) {
      // A discard during an earlier item's approval already receipted this
      // one; the snapshot is stale by that much.
      if (!(pendingDelegations.get(threadId) ?? []).some((p) => p.id === item.id)) continue;
      const from = senderFor(item);
      if (!from) {
        // The sender was deleted while this item waited. Nothing to run and
        // nobody to tell; drop it rather than retrying forever.
        acknowledgeDelegation(threadId, item.id, bus);
        continue;
      }
      let outcome: "settled" | "requeued" = "settled";
      try {
        outcome = await processOne(bus, approvalBus, from, threadId, item, runTarget);
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        recordDelegationReceipt({
          id: item.id,
          sourceThreadId: threadId,
          toBotId: item.toBotId,
          toBotName: bus.store.bot(item.toBotId)?.name ?? item.toBotId,
          status: "error",
          result: why.slice(0, 200),
        });
        try {
          appendDelegationRow(bus, threadId, item.fromBotId ?? from.id, {
            role: "bot",
            kind: "activity",
            tool: { name: `error: delegation failed: ${why.slice(0, 120)}`, ok: false },
          });
        } catch (reportError) {
          console.error("delegation failed and could not be reported", reportError);
        }
      } finally {
        // A requeued item (busy target, retries left) stays for the drain
        // that the target's own settling turn will trigger.
        if (outcome !== "requeued") acknowledgeDelegation(threadId, item.id, bus);
      }
    }
  })().finally(() => {
    drainingThreads.delete(threadId);
    // A later turn may have queued and settled while this thread was
    // waiting for approval. Only items OUTSIDE our snapshot warrant a fresh
    // drain — re-draining a just-requeued item would burn its bounded busy
    // retries in milliseconds instead of once per target settle.
    const redrainRequested = queuedRedrains.delete(threadId);
    const snapshotIds = new Set(snapshot.map((item) => item.id));
    const hasNewItems = pendingDelegations.get(threadId)?.some((item) => !snapshotIds.has(item.id)) ?? false;
    if (redrainRequested || hasNewItems) {
      drainDelegations(bus, approvalBus, threadId, runTarget);
    }
  });
}

/** Remove one terminal handoff only after approval/dispatch has settled. */
function acknowledgeDelegation(threadId: string, itemId: string, bus?: CommsBus): void {
  const current = pendingDelegations.get(threadId);
  if (!current) return;
  const leaving = current.find((item) => item.id === itemId);
  if (leaving) clearWaitLine(bus, threadId, leaving);
  const remaining = current.filter((item) => item.id !== itemId);
  if (remaining.length) pendingDelegations.set(threadId, remaining);
  else pendingDelegations.delete(threadId);
  savePending();
}

/** Drop queued handoffs without running them, telling the user they were
 * dropped. Used when the queueing turn failed or was interrupted.
 *
 * `fromBotId` scopes the discard to one sender, and on a room thread that is
 * the only correct behaviour: a room queue holds items from every bot that
 * has spoken there, so a thread-wide discard means Nia hitting Stop silently
 * cancels the handoff Ember queued minutes ago, with a receipt blaming "the
 * delegating turn did not finish" about a turn that finished fine. A bot's
 * own thread has exactly one sender, so passing its id there is a no-op that
 * keeps the two call sites honest about which turn they are cancelling.
 * Omitting it keeps the old thread-wide behaviour for callers that mean it. */
export function discardDelegations(bus: CommsBus, threadId: string, fromBotId?: string): void {
  const all = pendingDelegations.get(threadId);
  if (!all?.length) return;
  const owns = (item: PendingDelegationItem) => {
    // An item that has already outlived a turn — retried, or parked waiting
    // for a busy target — cannot belong to the turn that just failed, so no
    // interruption may drop it. This is what protects a room: Ember queues a
    // handoff, Rex is busy, it parks; Nia speaks in the same room and hits
    // Stop, and Ember's handoff is not collateral.
    if (item.attempts > 0 || item.waitingOnBusy) return false;
    // An item queued before `fromBotId` existed names nobody; on a
    // single-sender thread it is still this sender's, so it is dropped.
    return !fromBotId || !item.fromBotId || item.fromBotId === fromBotId;
  };
  const list = all.filter(owns);
  if (!list.length) return;
  const kept = all.filter((item) => !owns(item));
  if (kept.length) pendingDelegations.set(threadId, kept);
  else pendingDelegations.delete(threadId);
  savePending();
  for (const item of list) {
    recordDelegationReceipt({
      id: item.id,
      sourceThreadId: threadId,
      toBotId: item.toBotId,
      toBotName: bus.store.bot(item.toBotId)?.name ?? item.toBotId,
      status: "dropped",
      result: "the delegating turn did not finish",
    });
  }
  // The chip lands in the source conversation, which is a bot's own thread
  // OR a room it spoke in — botByThread alone silenced the room case.
  if (!bus.store.botByThread(threadId) && !bus.store.groupByThread(threadId)) return;
  appendDelegationRow(bus, threadId, fromBotId ?? list[0]?.fromBotId, {
    role: "bot",
    kind: "activity",
    tool: { name: `${list.length} queued delegation${list.length > 1 ? "s" : ""} dropped: the turn did not finish`, ok: false },
  });
}

async function processOne(
  bus: CommsBus,
  approvalBus: ApprovalBus,
  from: BotRecord,
  sourceThreadId: string,
  item: PendingDelegationItem,
  runTarget: (
    toBotId: string,
    message: string,
    commsDepth: number,
    sourceThreadId: string,
    channel: GroupRecord | undefined,
    taskId: string,
    fromBotId: string,
    eventId?: string,
    coordination?: CoordinationTrace,
    notOwnerAudience?: boolean,
    unattended?: boolean,
    executionAudience?: ExecutionAudience,
    routineAuthority?: RoutinePeerSource,
  ) => void | Promise<void>,
): Promise<"settled" | "requeued"> {
  let sender = from;
  let target = bus.store.bot(item.toBotId);
  if (!target) {
    recordDelegationReceipt({
      id: item.id,
      sourceThreadId,
      toBotId: item.toBotId,
      toBotName: item.toBotId,
      status: "error",
      result: "no such bot",
    });
    appendDelegationRow(bus, sourceThreadId, sender.id, {
      role: "bot",
      kind: "activity",
      tool: { name: `error: delegation to ${item.toBotId} failed: no such bot`, ok: false },
    });
    return "settled";
  }
  const shared = roomRequestByKey(database(), `ask:delegation:${item.id}`);
  if (shared && isSharedWorkRow(shared, bus.store)) {
    if (isTerminalRoomRequestState(shared.state)) return "settled";
    drainSharedWork(target.id); return "requeued";
  }
  if (dropIfUnreachable(bus, sender, target, sourceThreadId, item)) {
    return "settled";
  }
  if (mustWaitFor(bus, target, sourceThreadId)) {
    if (item.waitingOnBusy) return "requeued";
    item.attempts += 1;
    item.waitingOnBusy = true;
    if (item.attempts < MAX_BUSY_ATTEMPTS) {
      parkWaiting(bus, sourceThreadId, item, target.name);
      return "requeued";
    }
    recordDelegationReceipt({
      id: item.id,
      sourceThreadId,
      toBotId: target.id,
      toBotName: target.name,
      status: "busy_gave_up",
      result: `@${target.name} stayed busy through ${MAX_BUSY_ATTEMPTS} retries`,
    });
    appendDelegationRow(bus, sourceThreadId, sender.id, {
      role: "bot",
      kind: "activity",
      tool: { name: `Delegation to @${target.name} canceled: still busy after ${MAX_BUSY_ATTEMPTS} retries`, ok: false },
    });
    return "settled";
  }
  if (item.waitingOnBusy) {
    delete item.waitingOnBusy;
    savePending();
  }
  const fullAccessWaived = item.fullAccessWaived === true && approvalBus.fullAccessStanding?.(sender.id, sourceThreadId, item.routineAuthority) === true;
  if (sender.approvePeerComms && !item.approvalAlreadyGranted && !fullAccessWaived) {
    const verdict = await requestPeerApproval(
      approvalBus,
      sender,
      target,
      item.message,
      "delegate_bot",
      sourceThreadId,
      undefined,
      item.routineAuthority,
    );
    if (verdict !== "allow") {
      // Only the user's own no is "denied"; an expired or cancelled card
      // says so (upstream #1526).
      const denied = verdict === "deny";
      const failure = peerApprovalFailure(verdict);
      recordDelegationReceipt({
        id: item.id,
        sourceThreadId,
        toBotId: target.id,
        toBotName: target.name,
        status: denied ? "denied" : verdict,
        result: denied ? "the user denied this handoff" : failure.error,
      });
      appendDelegationRow(bus, sourceThreadId, sender.id, {
        role: "bot",
        kind: "activity",
        tool: { name: denied ? `Delegation to @${target.name} denied by user` : `Delegation to @${target.name}: ${failure.error}`, ok: false },
      });
      return "settled";
    }
    // The approval could have been sitting for up to 15 minutes. Everything
    // checked above is a stale snapshot now: re-read both bots and re-check
    // busy, or an allow can start a second turn on a bot that is mid-turn —
    // and mirror a "Messaged @X" chip for an exchange that never happens.
    // Including whether this item still exists. The drain iterates a
    // snapshot taken before the approval, so a discard that arrived while
    // the card sat there has already written this item a "dropped" receipt;
    // dispatching now would run a handoff the user was told was cancelled.
    if (!(pendingDelegations.get(sourceThreadId) ?? []).some((p) => p.id === item.id)) {
      return "settled";
    }
    const current = bus.store.bot(item.toBotId);
    const currentSender = bus.store.bot(from.id);
    if (!current || !currentSender || !sourceStillOwned(bus, currentSender.id, sourceThreadId)) {
      // This used to `return "settled"` with no receipt at all: a handoff
      // approved by the user then vanished, and check_delegation answered
      // "unknown task id" forever. It is also the gate that a room-sourced
      // handoff failed unconditionally, because taskByThread never matches
      // a group thread.
      recordDelegationReceipt({
        id: item.id,
        sourceThreadId,
        toBotId: item.toBotId,
        toBotName: current?.name ?? item.toBotId,
        status: "dropped",
        result: current && currentSender
          ? "the source conversation is no longer available"
          : "one of the bots no longer exists",
      });
      return "settled";
    }
    if (dropIfUnreachable(bus, currentSender, current, sourceThreadId, item)) {
      return "settled";
    }
    if (mustWaitFor(bus, current, sourceThreadId)) {
      if (item.waitingOnBusy) return "requeued";
      item.attempts += 1;
      item.waitingOnBusy = true;
      if (item.attempts < MAX_BUSY_ATTEMPTS) {
        parkWaiting(bus, sourceThreadId, item, current.name);
        return "requeued";
      }
      recordDelegationReceipt({
        id: item.id,
        sourceThreadId,
        toBotId: current.id,
        toBotName: current.name,
        status: "busy_gave_up",
        result: `@${current.name} stayed busy through ${MAX_BUSY_ATTEMPTS} retries`,
      });
      appendDelegationRow(bus, sourceThreadId, sender.id, {
        role: "bot",
        kind: "activity",
        tool: { name: `Delegation to @${current.name} canceled: still busy after ${MAX_BUSY_ATTEMPTS} retries`, ok: false },
      });
      return "settled";
    }
    sender = currentSender;
    target = current;
  }
  // Capacity waits are not failed attempts against a busy teammate. The
  // server redrains pending queues when an active handoff releases its slot.
  if (bus.canDispatch && !bus.canDispatch()) return "requeued";
  const channel = getOrCreateChannel(bus.store, sender, target,sourceThreadId,item.executionAudience);
  mirrorExchange(bus, sender, target, item.message, channel, sourceThreadId, item.executionAudience);
  const reasonLine = item.reason ? `\n\n[Reason: ${item.reason}]` : "";
  const prefixed = `[Delegated by @${sender.name}, another bot in this Murage workspace. Do the work and reply directly.]\n\n${item.message}${reasonLine}`;
  await runTarget(item.toBotId, prefixed, item.depth + 1, sourceThreadId, channel, item.id, sender.id, item.eventId, item.coordination, item.notOwnerAudience === true, item.unattended === true, item.executionAudience, ...(item.routineAuthority ? [item.routineAuthority] as const : [] as const));
  return "settled";
}

/** The source conversation still belongs to the sender: its own task thread,
 * or a room it is still a member of. Mirrors index.ts's `connectorThread`;
 * without the group arm a room-sourced handoff can never clear this check. */
function sourceStillOwned(bus: CommsBus, botId: string, threadId: string): boolean {
  if (bus.store.taskByThread(botId, threadId)) return true;
  const group = bus.store.groupByThread(threadId);
  return Boolean(group?.memberIds.includes(botId));
}

/** The roster is an execution boundary, not just sidebar styling. A queued
 * handoff may wait through a turn, a busy target, or human approval, so the
 * permission granted when it was queued must be checked again at the final
 * dispatch edge. The chip text still says "sections" because that is what
 * separates two ordinary bots; the only extra edges canReach adds are
 * workspace-chief ⇄ section lead. */
function dropIfUnreachable(
  bus: CommsBus,
  sender: BotRecord,
  target: BotRecord,
  sourceThreadId: string,
  item: PendingDelegationItem,
): boolean {
  // the same reach the handoff was queued under (message-allow.ts)
  // project reach only for a handoff the owner's audience queued
  const row = roomRequestByKey(database(), `ask:delegation:${item.id}`);
  const targetThread = row ? row.targetThreadId ?? audienceTask(bus.store, target, threadHumanPrincipal(sourceThreadId), item.executionAudience ?? null)?.threadId : undefined;
  const allowed = row && targetThread
    ? authorizeWork({ edge: "dispatch", requestId: row.id, targetBotId: target.id, targetThreadId: targetThread, tag: item.executionAudience ?? null, kind: "delegation" })
    : authorizeWork({ edge: "peer", requesterBotId: sender.id, requesterThreadId: sourceThreadId, targetBotId: target.id, verb: "delegate", tag: item.executionAudience ?? null, ownerAudience: !item.notOwnerAudience, unattended: item.unattended === true });
  if (allowed.ok || allowed.retry === "queue") return false;
  const result = `@${sender.name} and @${target.name} now belong to different sections`;
  recordDelegationReceipt({
    id: item.id,
    sourceThreadId,
    toBotId: target.id,
    toBotName: target.name,
    status: "dropped",
    result,
  });
  appendDelegationRow(bus, sourceThreadId, item.fromBotId, {
    role: "bot",
    kind: "activity",
    tool: { name: `Delegation to @${target.name} canceled: bots now belong to different sections`, ok: false },
  });
  return true;
}

/** Re-check every queued handoff against the roster as it is now.
 *
 * The dispatch edge already re-checks (dropIfUnreachable above), but only
 * when the source turn settles or a busy target frees up, which can be long
 * after the owner moved a bot out of a team. Called right after an owner's
 * team change so a handoff the change made unreachable is dropped at once,
 * with the same receipt and chip as the dispatch-time drop. Items whose
 * sender or target no longer exist are left for the drain, which already
 * reports those. Returns how many were dropped. */
export function dropUnreachableDelegations(bus: CommsBus): number {
  let dropped = 0;
  for (const [threadId, items] of pendingDelegations) {
    const owner = bus.store.botByThread(threadId);
    const remaining = items.filter((item) => {
      const sender = (item.fromBotId ? bus.store.bot(item.fromBotId) : null) ?? owner;
      const target = bus.store.bot(item.toBotId);
      if (!sender || !target) return true;
      if (!dropIfUnreachable(bus, sender, target, threadId, item)) return true;
      clearWaitLine(bus, threadId, item);
      dropped += 1;
      return false;
    });
    if (remaining.length === items.length) continue;
    if (remaining.length) pendingDelegations.set(threadId, remaining);
    else pendingDelegations.delete(threadId);
  }
  if (dropped) savePending();
  return dropped;
}

/** Test helper: how many items remain queued for a thread. */
export function _pendingCount(threadId: string): number {
  return pendingDelegations.get(threadId)?.length ?? 0;
}

/** Test helper: forget the in-memory queue (a simulated restart). */
export function _resetPending(): void {
  pendingDelegations.clear();
  drainingThreads.clear();
  queuedRedrains.clear();
  receipts = [];
}

// ── live status for a running delegated turn ──────────────────────────
// check_delegation used to say only queued/running/finished. A chief that
// coordinates specialists needs to see whether a long-running peer is
// actually progressing, so the harness summarizes what the peer's thread
// has done since the delegated turn started.

export interface DelegatedActivityMessage {
  at: number;
  kind: string;
  text?: string;
  tool?: { name?: string } | null;
}

export function formatDelegationElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.round(elapsedMs / 1_000));
  if (totalSeconds < 90) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

/** Recent, bounded activity from the peer's thread since the delegated
 * turn started — newest last. Empty means the peer has produced nothing
 * visible since dispatch, which reads as "maybe stuck" to the caller. */
export function summarizeDelegatedActivity(
  messages: readonly DelegatedActivityMessage[],
  startedAtMs: number,
  limit = 5,
  /** false: tool lines only, no excerpt of what the peer wrote */
  withText = true,
): string[] {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.at < startedAtMs) continue;
    if (message.kind === "activity") {
      const name = (message.tool?.name ?? "").trim();
      // a host stop is not a tool run: the caller sees the stop as the
      // transcript spells it, not the raw "stopped:" prefix (STOP2)
      const stopped = hostStoppedDisplayName(name) ?? folderTrustDisplayName(name);
      if (stopped) lines.push(stopped);
      else if (name) lines.push(`tool: ${name}`);
      continue;
    }
    if (withText && message.kind === "text" && message.text?.trim()) {
      const text = message.text.trim().replace(/\s+/g, " ");
      lines.push(`text: ${text.slice(0, 140)}${text.length > 140 ? "…" : ""}`);
    }
  }
  return lines.slice(-limit);
}
