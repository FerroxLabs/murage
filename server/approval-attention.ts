// DESIGN-CARDRED / design1019-approval-attention: one attention state machine per approval card.
//
// Owners: design1019-approval-attention owns the specification; the int5-cardred3e continuation owns this module and its
// server bindings (server/index.ts). Decision records, Stop receipts and project terminal states keep their own owners;
// this module never decides an answer, a Stop or a board terminal state.
//
// An approval asks the owner only while its originating turn generation can still use the answer, and releases all of its
// attention when the card or the generation ends. Each admitted internal turn generation gets one scope. A scope is never
// reopened or reused: retirement flips `accepting` false first (the linearization point), releases every hold it owns, and
// only then drops its rows.
//
//   PENDING    registered before presentation; may own the request's execution wait, no owner attention
//   PRESENTED  card in chat, owner not asked yet (an enforced review may run)
//   WAITING    owner asked: request wait, activity and board holds raised, one notification
//   SETTLED    the card left open; terminal for owner attention, kept until its generation retires
//   (RETIRED)  no row: the generation's scope is closed and rejects every replay
//
// Every gate check and effect write happens in one synchronous call, so no await separates a check from its insert.

import { randomUUID } from "node:crypto";

export type AttentionKey =
  | { kind: "queue"; approvalId: string }
  | { kind: "engine"; approvalId: string }
  | { kind: "service"; service: "image" | "highlevel" | "publish"; requestId: string };

export type AttentionState = "PENDING" | "PRESENTED" | "WAITING" | "SETTLED";

export interface AttentionOpen {
  key: AttentionKey;
  threadId: string;
  /** The asking bot, captured from the admitted owner, actor or claim; never rediscovered after an await. */
  botId: string;
  requestId: string;
  messageId?: string;
  /** The project card run the request addresses, captured once at registration. */
  projectRequestId?: string;
  /** Question cards use the question notification. */
  notice?: { kind: "approval"; requestTurnId?: string } | { kind: "question"; subtitle: string };
  /** The record (engine) or the service's own request is still open. */
  isOpen(): boolean;
}

/** The board card run a captured project request addresses, read at the moment of the board write. */
export interface BoardRun {
  /** The request that owns the card's active run now. */
  activeRequestId: string | undefined;
  /** The card's state: only a card still doing may be parked. */
  state: string;
  waitingOn?: string;
}

export interface AttentionDeps {
  /** This generation still owns the thread's activity (its turn is the live one). */
  ownsActivity(threadId: string, generation: string): boolean;
  /** The bot's activity on this thread (its task's, or the bot's own when the thread has no task). */
  activity(botId: string, threadId: string): string | undefined;
  setActivity(botId: string, threadId: string, activity: "waiting-on-you" | "working"): void;
  boardRun(projectRequestId: string): BoardRun | undefined;
  parkBoard(projectRequestId: string): void;
  resumeBoard(projectRequestId: string): void;
  notify(open: AttentionOpen): void;
  /** The generation-owned execution wait on one request: watchdog/browser execution and the driver's human wait. */
  wait(threadId: string, generation: string, requestId: string, waiting: boolean): void;
  /** Owner-visible failure path for an effect that threw (notification, board, store). */
  report?(error: unknown, where: string): void;
}

/** One admitted generation's attention. Callers capture this object before their first await. */
export interface AttentionScope {
  readonly threadId: string;
  readonly generation: string;
  readonly accepting: boolean;
}

interface Entry {
  state: AttentionState;
  readonly uid: string;
  readonly open: AttentionOpen;
  heldActivity?: string;
  heldBoard?: string;
}

interface Scope extends AttentionScope {
  recoveryId?: string;
  accepting: boolean;
  retired: boolean;
  readonly cards: Map<string, Entry>;
  readonly requests: Map<string, Set<string>>;
  readonly waits: Set<string>;
}

export class AttentionCleanupPending extends Error {
  constructor(threadId: string) { super(`approval attention cleanup is still pending on ${threadId}`); this.name = "AttentionCleanupPending"; }
}

const keyOf = (key: AttentionKey): string =>
  key.kind === "service" ? `service:${key.service}:${key.requestId}` : `${key.kind}:${key.approvalId}`;

export type Transition = "moved" | "refused" | "settled" | "failed";

export function cardAttention(deps: AttentionDeps) {
  const live = new Map<string, Scope>();
  // A recovered proposal has no running turn. Several proposals may share a thread.
  const recovered = new Map<string, Map<string, Scope>>();
  const newScope = (threadId: string, generation: string): Scope => ({
    threadId, generation, accepting: true, retired: false, cards: new Map(), requests: new Map(), waits: new Set(),
  });
  /** Closed scopes whose cleanup threw: retried by the same retirement, never accepting again. */
  const cleanup = new Map<string, Set<Scope>>();
  const activityHolds = new Map<string, Set<string>>();
  const boardHolds = new Map<string, Set<string>>();
  let visited = 0;

  const asScope = (scope: AttentionScope | undefined): Scope | undefined => scope as Scope | undefined;
  /** Insert/promotion fence: a concrete scope that is the thread's current accepting scope. */
  const fenced = (scope: Scope | undefined): scope is Scope =>
    scope !== undefined && typeof scope.generation === "string" && scope.generation !== "" && scope.accepting && !scope.retired &&
    (scope.recoveryId ? recovered.get(scope.threadId)?.get(scope.recoveryId) === scope : live.get(scope.threadId) === scope);
  const fail = (error: unknown, where: string) => { try { deps.report?.(error, where); } catch { /* the failure path itself cannot reopen attention */ } };
  const hold = (holds: Map<string, Set<string>>, target: string, uid: string) => {
    const set = holds.get(target) ?? new Set<string>();
    set.add(uid); holds.set(target, set);
  };
  const unhold = (holds: Map<string, Set<string>>, target: string, uid: string): boolean => {
    const set = holds.get(target);
    if (!set) return true;
    set.delete(uid);
    if (set.size) return false;
    holds.delete(target);
    return true;
  };
  const unsettled = (scope: Scope, requestId: string): boolean => {
    for (const id of scope.requests.get(requestId) ?? []) {
      visited++;
      if (scope.cards.get(id)?.state !== "SETTLED") return true;
    }
    return false;
  };

  /** Release the card's owner holds. Each hold is released at most once; a throw leaves only that hold for a retry. */
  const releaseHolds = (scope: Scope, entry: Entry, resumeBoard = true): boolean => {
    let ok = true;
    if (entry.heldActivity !== undefined) {
      const target = entry.heldActivity;
      try {
        const last = unhold(activityHolds, target, entry.uid);
        entry.heldActivity = undefined;
        const { botId, threadId } = entry.open;
        if (last && deps.ownsActivity(threadId, scope.generation) && deps.activity(botId, threadId) === "waiting-on-you") deps.setActivity(botId, threadId, "working");
      } catch (error) { ok = false; fail(error, "activity"); }
    }
    if (entry.heldBoard !== undefined) {
      const project = entry.heldBoard;
      try {
        const set = boardHolds.get(project);
        const last = !set || (set.size === 1 && set.has(entry.uid));
        if (last && resumeBoard) {
          const run = deps.boardRun(project);
          if (run?.state === "waiting" && run.activeRequestId === project && run.waitingOn === "owner_approval") deps.resumeBoard(project);
        }
        unhold(boardHolds, project, entry.uid);
        entry.heldBoard = undefined;
      } catch (error) { ok = false; fail(error, "board"); }
    }
    return ok;
  };
  const releaseWait = (scope: Scope, requestId: string) => {
    if (!scope.waits.delete(requestId)) return;
    deps.wait(scope.threadId, scope.generation, requestId, false);
  };
  const settleEntry = (scope: Scope, entry: Entry, resumeBoard = true): boolean => {
    if (entry.state === "SETTLED") return true;
    entry.state = "SETTLED";
    let ok = true;
    try { ok = releaseHolds(scope, entry, resumeBoard); }
    finally { if (!unsettled(scope, entry.open.requestId)) releaseWait(scope, entry.open.requestId); }
    return ok;
  };

  const retire = (scopeIn: AttentionScope | undefined, _reason: string): boolean => {
    const scope = asScope(scopeIn);
    if (!scope) return true;
    // 1. The linearization point: no insert, promotion or review callback is accepted from here on.
    scope.accepting = false;
    if (scope.retired) return true;
    let ok = true;
    try {
      // 2. Release every owned hold of every entry, PENDING with an adopted wait included.
      for (const entry of scope.cards.values()) {
        visited++;
        entry.state = "SETTLED";
        // An abandoned image call cannot resume work. Its project-run owner records the terminal board state.
        const image = entry.open.key.kind === "service" && entry.open.key.service === "image";
        if (!releaseHolds(scope, entry, !image)) ok = false;
      }
    } finally {
      // Flags clear even when a store/board release threw.
      for (const requestId of [...scope.waits]) {
        try { releaseWait(scope, requestId); } catch (error) { ok = false; scope.waits.add(requestId); fail(error, "wait"); }
      }
    }
    const closed = cleanup.get(scope.threadId);
    if (!ok) {
      // A closed, retryable cleanup scope: never accepting, never dropped while effects remain.
      if (live.get(scope.threadId) === scope) live.delete(scope.threadId);
      const set = closed ?? new Set<Scope>(); set.add(scope); cleanup.set(scope.threadId, set);
      return false;
    }
    // 3. Only after successful cleanup: drop entries, markers and indexes (identity-checked).
    scope.cards.clear(); scope.requests.clear(); scope.waits.clear();
    scope.retired = true;
    if (scope.recoveryId) {
      const items = recovered.get(scope.threadId);
      if (items?.get(scope.recoveryId) === scope) items.delete(scope.recoveryId);
      if (items?.size === 0) recovered.delete(scope.threadId);
    }
    if (live.get(scope.threadId) === scope) live.delete(scope.threadId);
    if (closed) { closed.delete(scope); if (!closed.size) cleanup.delete(scope.threadId); }
    return true;
  };

  const api = {
    /** Revalidated queue items are presented without replaying a dead turn's holds or notification. */
    recoverCard(open: AttentionOpen, messageId: string): void {
      if (open.key.kind !== "queue" || !open.isOpen()) return;
      const id = open.key.approvalId;
      const items = recovered.get(open.threadId) ?? new Map<string, Scope>();
      if (items.has(id) || live.has(open.threadId)) return;
      const scope = newScope(open.threadId, randomUUID());
      scope.recoveryId = id;
      recovered.set(open.threadId, items);
      items.set(id, scope);
      if (api.register(scope, open) !== "moved" || api.present(scope, open.key, messageId) !== "moved") {
        retire(scope, "closed");
      }
    },
    closeRecovered(threadId: string, approvalId: string): void {
      retire(recovered.get(threadId)?.get(approvalId), "closed");
    },
    /** Admission: retire the thread's previous scope through the common retirement, then install a fresh one. */
    admit(threadId: string, generation: string): AttentionScope {
      if (!threadId || !generation) throw new Error("approval attention needs a concrete generation");
      for (const scope of recovered.get(threadId)?.values() ?? []) retire(scope, "replaced");
      const previous = live.get(threadId);
      if (previous && previous.generation === generation && previous.accepting) return previous;
      if (previous && !retire(previous, "replaced")) throw new AttentionCleanupPending(threadId);
      for (const pending of [...cleanup.get(threadId) ?? []]) if (!retire(pending, "replaced")) throw new AttentionCleanupPending(threadId);
      const scope = newScope(threadId, generation);
      live.set(threadId, scope);
      return scope;
    },
    /** The current accepting scope of exactly this generation, else undefined. Never matches by thread alone. */
    scopeFor(threadId: string, generation: string | undefined): AttentionScope | undefined {
      if (!generation) return undefined;
      const scope = live.get(threadId);
      return scope && scope.generation === generation && scope.accepting ? scope : undefined;
    },
    /** The thread's current accepting scope (diagnostics only: card paths always pass their captured scope). */
    current(threadId: string): AttentionScope | undefined {
      const scope = live.get(threadId);
      return scope?.accepting ? scope : undefined;
    },
    /** This generation's scope, accepting or closed with unfinished cleanup: the handle releases and retirement use. */
    scopeOf(threadId: string, generation: string | undefined): AttentionScope | undefined {
      if (!generation) return undefined;
      const scope = live.get(threadId);
      if (scope?.generation === generation) return scope;
      for (const closed of cleanup.get(threadId) ?? []) if (closed.generation === generation) return closed;
      return undefined;
    },
    /** The scope (live or closing) holding this request's execution wait or cards. */
    holderOf(threadId: string, requestId: string): AttentionScope | undefined {
      const scope = live.get(threadId);
      if (scope && (scope.waits.has(requestId) || scope.requests.has(requestId))) return scope;
      for (const closed of cleanup.get(threadId) ?? []) if (closed.waits.has(requestId) || closed.requests.has(requestId)) return closed;
      return undefined;
    },
    /** The scope (live or closing) holding this exact card. A card key names one approval, so no other generation matches. */
    holderOfCard(threadId: string, key: AttentionKey): AttentionScope | undefined {
      const id = keyOf(key);
      const scope = live.get(threadId);
      if (scope?.cards.has(id)) return scope;
      for (const closed of cleanup.get(threadId) ?? []) if (closed.cards.has(id)) return closed;
      return undefined;
    },
    /** request.opened: a generation/request-owned execution wait (watchdog, browser, driver), no owner attention. */
    acquireWait(scopeIn: AttentionScope | undefined, requestId: string): Transition {
      const scope = asScope(scopeIn);
      if (!fenced(scope)) return "refused";
      if (scope.recoveryId || scope.waits.has(requestId)) return "refused";
      scope.waits.add(requestId);
      deps.wait(scope.threadId, scope.generation, requestId, true);
      return "moved";
    },
    /** Automatic run/refuse resolution: release the request's wait unless a card of the request still needs it. */
    releaseWait(scopeIn: AttentionScope | undefined, requestId: string): void {
      const scope = asScope(scopeIn);
      if (scope && !unsettled(scope, requestId)) releaseWait(scope, requestId);
    },
    /** T0 absent -> PENDING, before presentation. */
    register(scopeIn: AttentionScope | undefined, open: AttentionOpen): Transition {
      const scope = asScope(scopeIn);
      if (!fenced(scope) || open.threadId !== scope.threadId) return "refused";
      if (scope.recoveryId && (open.key.kind !== "queue" || open.key.approvalId !== scope.recoveryId)) return "refused";
      const id = keyOf(open.key);
      if (scope.cards.has(id)) return "refused";
      scope.cards.set(id, { state: "PENDING", uid: `${scope.generation}\u0000${id}`, open });
      const ids = scope.requests.get(open.requestId) ?? new Set<string>();
      ids.add(id); scope.requests.set(open.requestId, ids);
      return "moved";
    },
    /** T1 PENDING -> PRESENTED, only for the registered entry of the captured scope (never an upsert). */
    present(scopeIn: AttentionScope | undefined, key: AttentionKey, messageId: string): Transition {
      const scope = asScope(scopeIn);
      if (!fenced(scope)) return "refused";
      const entry = scope.cards.get(keyOf(key));
      if (!entry || entry.state !== "PENDING") return "refused";
      if (!entry.open.isOpen()) { settleEntry(scope, entry); return "settled"; }
      entry.state = "PRESENTED";
      entry.open.messageId = messageId;
      return "moved";
    },
    /** T2 PRESENTED -> WAITING: request wait, activity and board holds, then one notification, last. */
    ask(scopeIn: AttentionScope | undefined, key: AttentionKey): Transition {
      const scope = asScope(scopeIn);
      if (!fenced(scope)) return "refused";
      const entry = scope.cards.get(keyOf(key));
      if (scope.recoveryId || !entry || entry.state !== "PRESENTED") return "refused";
      const ask = entry.open;
      if (!ask.isOpen()) { settleEntry(scope, entry); return "settled"; }
      entry.state = "WAITING";
      try {
        if (!scope.waits.has(ask.requestId)) { scope.waits.add(ask.requestId); deps.wait(scope.threadId, scope.generation, ask.requestId, true); }
        const target = `${ask.botId}\u0000${ask.threadId}`;
        hold(activityHolds, target, entry.uid); entry.heldActivity = target;
        deps.setActivity(ask.botId, ask.threadId, "waiting-on-you");
        const project = ask.projectRequestId;
        if (project) {
          hold(boardHolds, project, entry.uid); entry.heldBoard = project;
          const run = deps.boardRun(project);
          if (run && run.activeRequestId === project && run.state === "doing" && run.waitingOn === undefined) deps.parkBoard(project);
        }
      } catch (error) {
        // A failed acquisition takes the shared error/retirement path: partial holds released, callbacks fenced, no notification.
        fail(error, "acquire");
        retire(scope, "attention-error");
        return "failed";
      }
      try { deps.notify(ask); } catch (error) { fail(error, "notify"); }
      return "moved";
    },
    /** T3/T4/T5: settle one card (owner answer, review Allow, expiry, cancellation, supersede, failed presentation). */
    settle(scopeIn: AttentionScope | undefined, key: AttentionKey): Transition {
      const scope = asScope(scopeIn);
      const entry = scope?.cards.get(keyOf(key));
      if (!scope || !entry || entry.state === "SETTLED") return "refused";
      settleEntry(scope, entry);
      return "moved";
    },
    /** A request's resolution settles every card of that request in that generation only, then releases its wait. O(k). */
    settleRequest(scopeIn: AttentionScope | undefined, requestId: string, resumeBoard = true): void {
      const scope = asScope(scopeIn);
      if (!scope) return;
      for (const id of [...scope.requests.get(requestId) ?? []]) {
        visited++;
        const entry = scope.cards.get(id);
        if (entry && entry.state !== "SETTLED") settleEntry(scope, entry, resumeBoard);
      }
      releaseWait(scope, requestId);
    },
    state(scopeIn: AttentionScope | undefined, key: AttentionKey): AttentionState | undefined {
      return asScope(scopeIn)?.cards.get(keyOf(key))?.state;
    },
    /** T6/T7: the sole generation retirement. Idempotent; false while cleanup is unfinished (the scope stays closed). */
    retireTurn: retire,
    /** Every live and closing scope (bulk revocation, shutdown). O(G + C + R). */
    retireAll(reason: string): boolean {
      let ok = true;
      for (const items of recovered.values()) for (const scope of items.values()) retire(scope, reason);
      for (const scope of [...live.values()]) if (!retire(scope, reason)) ok = false;
      for (const set of [...cleanup.values()]) for (const scope of [...set]) if (!retire(scope, reason)) ok = false;
      return ok;
    },
    /** Retained state, for bounded-cost witnesses: a normally retired generation contributes zero. */
    stats(): { scopes: number; cards: number; requests: number; waits: number; holds: number; visited: number } {
      let scopes = 0, cards = 0, requests = 0, waits = 0;
      const all = [...live.values(), ...[...recovered.values()].flatMap(items => [...items.values()]), ...[...cleanup.values()].flatMap(set => [...set])];
      for (const scope of all) { scopes++; cards += scope.cards.size; requests += scope.requests.size; waits += scope.waits.size; }
      let holds = 0;
      for (const set of activityHolds.values()) holds += set.size;
      for (const set of boardHolds.values()) holds += set.size;
      return { scopes, cards, requests, waits, holds, visited };
    },
    /** T0 before the presentation await, then T1 on its return in the captured scope only. A throwing presentation settles
     * the PENDING entry (releasing its adopted wait) and rethrows to the existing failure path. */
    async presentCard(scope: AttentionScope | undefined, open: AttentionOpen, show: () => Promise<string | undefined>): Promise<Transition> {
      api.register(scope, open);
      let messageId: string | undefined;
      try { messageId = await show(); }
      catch (error) { api.settle(scope, open.key); throw error; }
      if (messageId === undefined) { api.settle(scope, open.key); return "settled"; }
      return api.present(scope, open.key, messageId);
    },
  };
  return api;
}

export type CardAttention = ReturnType<typeof cardAttention>;

/** The identity a service actor/claim captured when it was created, before the service's first await. */
export interface ServiceCapture {
  generation: string;
  scope?: AttentionScope;
}

export interface ServiceWaitingDeps {
  /** The bot that asked, from the actor/claim (a channel thread belongs to no single bot). */
  owner(threadId: string, botId: string | undefined): string | undefined;
  /** The service's own request is still open. */
  isOpen(threadId: string, requestId: string): boolean;
  /** The project card run the captured generation addresses, if any. */
  projectRun?(threadId: string, generation: string): string | undefined;
}

/** A service card (image, HighLevel, publish) shown or closed. The captured identity selects the scope; a late callback
 * never recaptures the thread's current turn. Terminal and fence checks run before either flag writer. */
export function serviceCardWaiting(attention: Pick<CardAttention, "scopeFor" | "scopeOf" | "register" | "present" | "ask" | "settleRequest" | "state">, service: "image" | "highlevel" | "publish", deps: ServiceWaitingDeps) {
  return (threadId: string, waiting: boolean, requestId: string, messageId?: string, botId?: string, captured?: ServiceCapture, resumeBoard = true): void => {
    const key: AttentionKey = { kind: "service", service, requestId };
    if (!waiting || !messageId) {
      // A close uses its captured request handle (live or closing scope of that generation); never a new owner.
      const handle = captured?.scope ?? attention.scopeOf(threadId, captured?.generation);
      attention.settleRequest(handle, requestId, resumeBoard);
      return;
    }
    const scope = captured?.scope ?? attention.scopeFor(threadId, captured?.generation);
    if (!scope || attention.scopeFor(threadId, scope.generation) !== scope) return;
    if (attention.state(scope, key) !== undefined) return;
    const owner = deps.owner(threadId, botId);
    if (!owner) return;
    const projectRequestId = deps.projectRun?.(threadId, scope.generation);
    if (attention.register(scope, { key, threadId, botId: owner, requestId, ...(projectRequestId ? { projectRequestId } : {}), isOpen: () => deps.isOpen(threadId, requestId) }) !== "moved") return;
    if (attention.present(scope, key, messageId) !== "moved") return;
    attention.ask(scope, key);
  };
}
