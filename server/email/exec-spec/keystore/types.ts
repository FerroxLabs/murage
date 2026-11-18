// Types of the executable spec harness. The state type is the one in invariants.current.ts (type-only import, erased at
// runtime); this file extends it with what review finding 10 says it cannot model: the supervisor's queued saves and built
// acks, and the home's not-yet-executed effects. If the revised invariants file renames a type, fix it HERE only.
import type {
  Action as SpecAction, Evidence, Flux, FluxKey, Home, Idem, KeyId, BotId, HomeId, OpId, Time, Response, CallKind, Cause, Actor,
  Operation, Transport, World as SpecWorld, AuthorityEvent, Intent, SaveJob, Supervisor, ListedKey,
} from "./invariants.current.ts";
export type { Evidence, Flux, FluxKey, Home, Idem, KeyId, BotId, HomeId, OpId, Time, Response, CallKind, Cause, Actor, Operation, Transport, SpecWorld, AuthorityEvent, Intent, SaveJob, Supervisor, ListedKey };

export type HomeAction =
  | { a: "call"; bot: BotId; kind: CallKind; keyId?: KeyId; idem?: Idem; opId?: OpId; actor: Actor; cause?: Cause; /** r3.2g harness stamp: the instant the home DECIDED the call (= intent.at in the product, binding-service.ts:507); set by the scheduler, never by the reducer */ at?: Time }
  | { a: "save"; bots: Record<BotId, KeyId>; owner: KeyId | null; retired: KeyId[]; prev: KeyId[] }
  | { a: "alert"; bot: BotId; code: string };

/** A home with its effect outbox. `outbox` is child memory: a crash between a durable commit and the effect (the POST, the
 *  save) loses the effect, which is exactly the crash-after-write case. The supervisor is the spec's (alive, queue, builtAcks). */
export type HomeX = Home & { outbox: HomeAction[]; nextSaveId: number };
/** Transport request plus the fault bookkeeping. What the request IS (home, bot, kind, key, idem) lives in `World.ops[opId]`;
 *  retries of one logical operation (same home, bot and Idempotency-Key) share one Operation. */
export type ReqX = Transport & { dupLeft: number; answered: boolean; timedOut: boolean; dropped: boolean };
export interface FluxX extends Flux { seq: Record<BotId, number>; incomplete: Record<Idem, KeyId>; reaperStopped?: boolean }
export interface Budget { calls: number; dups: number; lost: number; crashes: number; clock: number; owner: number; fence: number; ownerDeletes: number; fluxFaults: number; flag: number; uses: number }
export interface WorldX extends Omit<SpecWorld, "homes" | "flux" | "requests"> {
  flux: FluxX;
  homes: Record<HomeId, HomeX>;
  requests: ReqX[];
  nextReq: number;
  budget: Budget;
  /** checker bookkeeping: key Flux revoked while in the home's save pipeline (not yet durable); becomes `unobserved` on landing */
  pipeDead?: Record<HomeId, Record<BotId, KeyId>>;
}

/** Events the reducer sees. `now` is stamped by the harness. */
export type HomeEvent = { now: Time } & (
  | { t: "boot"; proof: Evidence | null; proofValid: boolean }
  | { t: "drive"; bot: BotId }
  | { t: "response"; reqId: number; opId: OpId; bot: BotId; kind: CallKind; keyId?: KeyId; idem?: Idem; resp: Response; duplicate: boolean }
  | { t: "lost"; reqId: number; opId: OpId; bot: BotId; kind: CallKind; keyId?: KeyId; idem?: Idem }
  | { t: "ack"; ev: Evidence }
  | { t: "clock" }
  | { t: "owner"; bot: BotId; press: "reconnect" | "take" | "remove" }
  | { t: "fence"; on: boolean }
  | { t: "rejected"; bot: BotId; code: 401 | 404 }
  | { t: "use"; bot: BotId; keyId?: KeyId }
  /** r3.2h (G1): the scheduler dropped this rotate/mint call from the outbox because it expired there (binding-service.ts:521 / :165) */
  | { t: "expired"; bot: BotId; kind: "rotate" | "mint"; idem?: Idem }
);
export type NoNow<T> = T extends unknown ? Omit<T, "now"> : never;
export const EVENT_TYPES = ["boot", "drive", "response", "lost", "ack", "clock", "owner", "fence", "rejected", "use", "expired"] as const;
/** `keyRepair` (optional): the production pure read of the owner-visible repair flag from DURABLE data and the clock; the harness
 *  applies it to every home after EVERY step (reducer step or not), exactly as the production binding view reads durable state. */
export type Reducer = ((h: Home, ev: HomeEvent) => { actions: HomeAction[]; state: Home }) & { keyRepair?: (h: Home, bot: BotId, now: Time) => boolean };

export type Move =
  | { k: "drive"; home: HomeId; bot: BotId }
  | { k: "exec"; home: HomeId }
  | { k: "apply"; reqId: number; outcome: ApplyOutcome }
  | { k: "dropReq"; reqId: number }
  | { k: "deliver"; reqId: number; idx: number; dup: boolean }
  | { k: "lose"; reqId: number; idx: number }
  | { k: "timeout"; reqId: number }
  | { k: "supStep"; home: HomeId }
  | { k: "ackDeliver"; home: HomeId; idx: number; dup: boolean }
  | { k: "ackLose"; home: HomeId; idx: number }
  | { k: "crash"; home: HomeId; mode: "child" | "supervisor" | "power" }
  | { k: "boot"; home: HomeId }
  | { k: "clock"; to: Time }
  | { k: "fence"; home: HomeId; on: boolean }
  | { k: "owner"; home: HomeId; bot: BotId; press: "reconnect" | "take" | "remove" }
  | { k: "ownerFluxDelete"; key: KeyId }
  | { k: "usageSync"; key: KeyId }
  | { k: "flag"; on: boolean }
  | { k: "use"; home: HomeId; bot: BotId };
export const MOVE_KINDS: Move["k"][] = ["drive", "exec", "apply", "dropReq", "deliver", "lose", "timeout", "supStep", "ackDeliver", "ackLose", "crash", "boot", "clock", "fence", "owner", "ownerFluxDelete", "usageSync", "flag", "use"];
/** Moves the adversary (faults and owner/environment choices) makes; everything else is the system making progress. */
export const FAULT_MOVES = new Set<Move["k"]>(["dropReq", "lose", "ackLose", "crash", "ownerFluxDelete", "flag", "fence", "clock", "owner"]);
export type ApplyOutcome = "normal" | "e500_applied" | "e500_applied_nohold" | "e500_dropped" | "incomplete503" | "bad400";

/** The scheduler step handed to predicates: the spec's Action, plus `env` for environment moves the spec has no kind for.
 *  A step whose reducer changed durable state is reported as kind "commit" (what = move:event). */
export type StepAction = SpecAction | { kind: "env"; what: string; detail?: unknown };
