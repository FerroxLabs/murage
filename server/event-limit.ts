// What happens when a run started by an event (a channel message, a webhook,
// a routine) reaches the number of hand-offs or new bots it may do on its own.
// The old answer was a flat refusal the bot could only relay as a dead end.
// Now: Full access bots start with a higher cap; everyone else gets a card for
// the owner with Allow (another batch) and Not now. There is no "always allow":
// the limit is per run, so every run starts from the same guard. A run whose
// connection was turned off is still refused, in plain words.
import { createHash } from "node:crypto";
import { requestEventLimitApproval, type ApprovalBus, type PeerApprovalOutcome } from "./peer-approval.ts";
import { EVENT_EXTENSION, EVENT_FULL_ACCESS_LIMIT, EVENT_MAX_LIMIT, type RoutineManager } from "./routines.ts";
import type { BotRecord } from "./store.ts";

/** Who the action is for, not when it was asked: the same hand-off or create, asked again anywhere in the run
 * (another turn, a resumed turn, a restart), is the same action and is charged once. A hand-off (an ask or a
 * delegate) is `["handoff", fromBotId, toBotId, message]`; a create is `["create", sectionKey, lowercase name]`. */
export function eventActionId(kind: "create" | "handoff", identity: readonly unknown[]): string {
  return `${kind}:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}

/** What a hand-off came to, whichever route wrote it (ask, delegate, shared ask) and whichever route reads it: one type, one decoder.
 * `answer:<channel>:<message>[:<request>]` (the request is absent on a receipt written before it was bound), `delegation:<task>` (waiting in line),
 * `timeout:<task>` (a synchronous ask that ran past its wait), `ended:<stopped|failed|error|interrupted>` (it ended without an answer) and
 * `noanswer:<checking|withheld>` (the asking bot's final answer was that line: replayed as the line, the originals never read again).
 * Anything else is not a hand-off outcome. */
export type HandoffEndReason = "stopped" | "failed" | "error" | "interrupted";
export type HandoffOutcome =
  | { kind: "queued"; taskId: string }
  | { kind: "timeout"; taskId: string }
  | { kind: "answer"; threadId: string; messageId: string; requestId?: string }
  | { kind: "no_answer"; why: "checking" | "withheld" }
  | { kind: "ended"; reason: HandoffEndReason };
export function decodeHandoffReceipt(receipt: string): HandoffOutcome | undefined {
  if (receipt.startsWith("delegation:") && receipt.length > "delegation:".length) return { kind: "queued", taskId: receipt.slice("delegation:".length) };
  if (receipt.startsWith("timeout:") && receipt.length > "timeout:".length) return { kind: "timeout", taskId: receipt.slice("timeout:".length) };
  const ended = /^ended:(stopped|failed|error|interrupted)$/.exec(receipt);
  if (ended) return { kind: "ended", reason: ended[1] as HandoffEndReason };
  const none = /^noanswer:(checking|withheld)$/.exec(receipt);
  if (none) return { kind: "no_answer", why: none[1] as "checking" | "withheld" };
  const answer = /^answer:([^:]+):([^:]+)(?::([^:]+))?$/.exec(receipt);
  return answer ? { kind: "answer", threadId: answer[1], messageId: answer[2], ...(answer[3] ? { requestId: answer[3] } : {}) } : undefined;
}

/** The event receipt of a hand-off whose answer to the asking bot was the no-answer (checking) or withheld line (NOHOLD-DELEGATION.md). */
export function noAnswerReceipt(why: "checking" | "withheld"): string { return `noanswer:${why}`; }

export interface EventLimitContext {
  routines: Pick<RoutineManager, "admitEventActionDetailed" | "raiseEventLimit" | "extendEventBudget" | "declineEventKind" | "eventKindDeclined">;
  bus: ApprovalBus;
  eventId: string;
  kind: "create" | "handoff";
  admissionId: string;
  from: BotRecord;
  fromThreadId: string;
  /** The bot being handed to, or the new bot's name. */
  targetName?: string;
  /** Does the owner's Full access already cover this run's origin? */
  fullAccess: () => boolean;
  /** Throws when the turn that asked is no longer running. */
  stillActive: () => void;
}

/** One owner card per run and kind at a time: a second hand-off that hits the
 * same limit while the card is open waits on it. An answer of Allow raises the
 * run's limit once, here, so each waiting call then re-checks and goes through. */
const openCards = new Map<string, Promise<PeerApprovalOutcome>>();

function ownerCard(ctx: EventLimitContext, done: number, limit: number): Promise<PeerApprovalOutcome> {
  const key = `${ctx.eventId}:${ctx.kind}`;
  const open = openCards.get(key);
  if (open) return open;
  const allowMore = Math.max(1, Math.min(EVENT_EXTENSION, EVENT_MAX_LIMIT - limit));
  const asked = requestEventLimitApproval(ctx.bus, ctx.from, ctx.kind, done, ctx.eventId, ctx.fromThreadId, ctx.targetName, allowMore, limit + EVENT_EXTENSION >= EVENT_MAX_LIMIT)
    // The owner's answer is saved here, before any waiter checks whether its turn is still running,
    // so a "Not now" that arrives after the turn ended still holds.
    .then(outcome => {
      if (outcome === "allow") ctx.routines.extendEventBudget(ctx.eventId, ctx.kind);
      else if (outcome === "deny") ctx.routines.declineEventKind(ctx.eventId, ctx.kind);
      return outcome;
    })
    .finally(() => { openCards.delete(key); });
  openCards.set(key, asked);
  return asked;
}

function refuse(text: string): never {
  throw Object.assign(new Error(text), { status: 409 });
}

/** Resolves when this hand-off or create may go ahead; throws, with words the
 * bot can pass on, when it may not. */
export async function admitEventWithOwner(ctx: EventLimitContext): Promise<void> {
  const doing = ctx.kind === "handoff" ? "hand work on" : "add bots";
  const notNow = ctx.kind === "handoff"
    ? "The owner said not now to more hand-offs in this run. Nothing more was handed off. Tell them, and finish what you can yourself."
    : "The owner said not now to more new bots in this run. No bot was added. Tell them, and finish what you can yourself.";
  for (let round = 0; round < 3; round++) {
    // The owner's Not now comes before any admission: capacity freed by a refund can never let a new action through.
    // Only a receipt already in the ledger is replayed, and that never reaches here.
    if (ctx.routines.eventKindDeclined(ctx.eventId, ctx.kind)) refuse(notNow);
    const verdict = ctx.routines.admitEventActionDetailed(ctx.eventId, ctx.admissionId, ctx.kind);
    if (verdict.ok) return;
    if (verdict.reason === "closed") {
      refuse(verdict.closedReason === "stopped" ? `This run was stopped, so I can't ${doing} from it.`
        : verdict.closedReason === "watch" ? `This check only looks for changes, so I can't ${doing} from it.`
          : `The connection that started this run was turned off, so I can't ${doing} from it.`);
    }
    if (verdict.reason === "unavailable") refuse(`I can't ${doing} from this run. Tell the owner and ask them to start it again.`);
    // At the most a run can ever do, a card could only promise what it can't give.
    if (verdict.limit >= EVENT_MAX_LIMIT) {
      refuse(`This run has already ${ctx.kind === "handoff" ? "handed off" : "added"} as many ${ctx.kind === "handoff" ? "tasks" : "bots"} as one run can. Tell the owner, and ask them to start a new run for the rest.`);
    }
    // Full access is the owner's own standing trust: raise the cap before asking.
    if (verdict.limit < EVENT_FULL_ACCESS_LIMIT && ctx.fullAccess()) {
      ctx.routines.raiseEventLimit(ctx.eventId, ctx.kind, EVENT_FULL_ACCESS_LIMIT);
      continue;
    }
    const outcome = await ownerCard(ctx, verdict.used, verdict.limit);
    ctx.stillActive();
    if (outcome === "allow") continue;
    const done = ctx.kind === "handoff" ? "handed off" : "created";
    refuse(outcome === "deny" ? notNow
      : outcome === "expired" ? `The owner hasn't answered yet, so nothing was ${done}. Tell them it is waiting for their OK.`
        : `The request was cancelled before the owner answered, so nothing was ${done}.`);
  }
  refuse(`I can't ${ctx.kind === "handoff" ? "hand work on" : "add bots"} from this run right now. Tell the owner.`);
}

/** The route-level view of one event action. */
export interface EventActionSpec<R> {
  routines: (EventLimitContext["routines"] & Pick<RoutineManager, "eventAdmissionReceipt" | "recordEventAdmissionReceipt" | "releaseEventAdmission" | "eventAdmissionExists">) | undefined;
  bus: ApprovalBus;
  /** Absent outside an event run: the step then runs directly. */
  eventId: string | undefined;
  kind: "create" | "handoff";
  identity: readonly unknown[];
  from: BotRecord;
  fromThreadId: string;
  targetName?: string;
  fullAccess: () => boolean;
  stillActive: () => void;
  /** After the charge (and any owner card): returns the refusal when the action can no longer go ahead, else undefined.
   * A refusal gives the charge back, because nothing ran. Runs outside event runs too. */
  revalidate: () => R | undefined | Promise<R | undefined>;
  /** What a stored receipt answers, or undefined when it can no longer be read (the action then counts as ended). `joined` is true for a call that
   * was running at the same time as the first: it reads the first's outcome from the ledger, an ended one included, and is not charged. */
  replay: (receipt: string, joined: boolean) => R | undefined;
  /** A charge with no receipt that nothing in this process is running (the server stopped between the charge and the
   * receipt): a create keeps that charge and checks its name again; a hand-off asks again as a new, charged attempt.
   * Accepted: a hand-off interrupted by a crash is charged twice. */
  orphan: "reuse" | "next";
}
export interface EventActionHandle {
  /** Charge the run (may show the owner a card), then revalidate. Throws the plain refusal when the action may not go ahead. */
  charge: () => Promise<void>;
  /** Remember what the action produced, in the tick the work commits: `delegation:<id>`, `answer:<thread>:<message>`, `bot:<id>`, `ended:<stopped|failed|error>`. */
  record: (receipt: string) => void;
  /** The charge was spent but the work never started (it was refused before dispatch): give the charge back. */
  unrun: () => void;
}

class EarlyResult {
  readonly result: unknown;
  constructor(result: unknown) { this.result = result; }
}
/** The actions running now. Only completion is shared, never a value: a caller that finds its twin running waits for it to finish, then reads
 * the outcome from the ledger and presents it in its own route's shape, exactly as a call made later would. */
const inflight = new Map<string, Promise<void>>();

/** The one function the ask, delegate and create routes do event work through.
 * Identity, counting and execution live here: a repeated or concurrent identical
 * action is answered from the run's ledger (same result, no charge, no card, no
 * work), and an action is charged once and runs once. */
export async function runEventAction<R>(spec: EventActionSpec<R>, step: (handle: EventActionHandle) => Promise<R>): Promise<R> {
  const { routines, eventId } = spec;
  if (!routines || !eventId) {
    return step({
      charge: async () => {
        spec.stillActive();
        const early = await spec.revalidate();
        if (early !== undefined) throw new EarlyResult(early);
      },
      record: () => {},
      unrun: () => {},
    }).catch(error => { if (error instanceof EarlyResult) return error.result as R; throw error; });
  }
  const base = eventActionId(spec.kind, spec.identity);
  let attempt = 1;
  let id = base;
  let reuse = false;
  for (;;) {
    id = attempt === 1 ? base : `${base}#${attempt}`;
    const flying = inflight.get(`${eventId}:${id}`);
    if (flying) {
      await flying;
      // no receipt: the first was refused and its charge given back, so this call runs its own attempt (below)
      const outcome = routines.eventAdmissionReceipt(eventId, id);
      const joined = outcome === undefined ? undefined : spec.replay(outcome, true);
      if (joined !== undefined) return joined;
      continue;
    }
    if (!routines.eventAdmissionExists(eventId, id)) break;
    const receipt = routines.eventAdmissionReceipt(eventId, id);
    if (receipt === undefined) {
      if (spec.orphan === "reuse") { reuse = true; break; }
    } else if (!receipt.startsWith("ended:")) {
      const replayed = spec.replay(receipt, false);
      if (replayed !== undefined) return replayed;
    }
    attempt++;
  }
  const actionId = id;
  const flightKey = `${eventId}:${actionId}`;
  const run = (async (): Promise<R> => {
    let charged = false;
    let recorded = false;
    try {
      return await step({
        charge: async () => {
          spec.stillActive();
          await admitEventWithOwner({ routines, bus: spec.bus, eventId, kind: spec.kind, admissionId: actionId, from: spec.from, fromThreadId: spec.fromThreadId,
            ...(spec.targetName ? { targetName: spec.targetName } : {}), fullAccess: spec.fullAccess, stillActive: spec.stillActive });
          charged = true;
          let early: R | undefined;
          try { early = await spec.revalidate(); } catch (error) {
            if (!reuse) routines.releaseEventAdmission(eventId, actionId);
            charged = false;
            throw error;
          }
          if (early !== undefined) {
            if (!reuse) routines.releaseEventAdmission(eventId, actionId);
            charged = false;
            throw new EarlyResult(early);
          }
        },
        record: receipt => { recorded = true; routines.recordEventAdmissionReceipt(eventId, actionId, receipt); },
        unrun: () => { if (charged && !recorded && !reuse) { routines.releaseEventAdmission(eventId, actionId); charged = false; } },
      });
    } catch (error) {
      if (error instanceof EarlyResult) return error.result as R;
      throw error;
    } finally {
      // Charged but nothing recorded: the action may have run, so asking again is a new, charged attempt.
      if (charged && !recorded) routines.recordEventAdmissionReceipt(eventId, actionId, "ended:error");
      inflight.delete(flightKey);
    }
  })();
  // the twins wait for the work to finish, whatever came of it
  inflight.set(flightKey, run.then(() => undefined, () => undefined));
  return run;
}
