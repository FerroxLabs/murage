// CLOUD-EMAIL-KEYSTORE-1019: executable spec, step 1: INVARIANTS AS CODE, revision r2.
// r1 2026-11-10T20:23Z. r2 2026-11-10T20:42Z (Opus designer): answers Astra acct6 (10 H + 2 M) and Fable (3 H + 6 M +
// lows) on r1, encodes the BINDING RULINGS block (kept verbatim at the end), adds witnesses (end of file).
// Pure TypeScript, no I/O, no imports. The checker runs WITNESSES first: every must-reject must fail its invariant,
// every must-accept must pass it, else the checker itself is wrong and the run stops.
//
// ── Invariant → finding map (r2) ─────────────────────────────────────────────────────────────────
// I1  durable honoured key OR repair OR death not yet observable  MurageMain; Astra r1 #4, Fable r1 F1 (knowledge form)
// I1b repair stays on until a replacement is durable and honoured  Astra r3.2 H1
// I1c observed repair flag == spec V(durable, now) (honest repair)  Fable r1 F5
// I1d an observed rejection commits durable repair in the same step  Fable r1 F1, R1; Astra r3.2 #8
// I2  no DELETE of own Protected / disk / mounted-candidate ids      rule (i); Fable r1 F13 (candidateToken in A)
// I2b DELETE only of a durably tombstoned id; never adopt a tombstoned id; no DELETE of a key a send holds  Astra r1 #6
// I3  unproven/fenced: no Flux write, no commit/save/ack that drops an id  rule (ii); Astra r1 #5, Fable r1 F8
// I3b no durable rollback: a disk slot only moves forward to its intent's own successor  Astra r1 #5, #10
// I4  durable matching successor: no mint/rotate, never demoted       rule (iii)
// I5  retire old only on exact, validated, not-known-dead successor   rule (iv); Astra r1 #7
// I5b evidence never moves backward; boot evidence = newest synced disk  Astra r3.2 H2; Fable r1 F11
// I6  no automatic kill/shorten of a key another live home uses, unless issued for this home  Fable r3.2 H1; F10
// I6b NO PING-PONG: a cross-home kill needs a take authority scoped to (home, bot, target, operation) created by a
//     fresh owner press; retries of that one operation are covered          Fable r3.2 H2; Astra r1 #2, #3; Fable r1 F2
// I6c an observed foreign live key commits twin_key_live; no automatic mint/rotate/DELETE for that bot until an owner
//     press (a taken-over home never auto-mints; derived from what it observed)  Fable r3.2 H2; Astra r1 #3; R1
// I6d the take disowns first: target out of disk, D, Active and Proof before any take call; take never DELETEs  R2
// I7  idempotency per logical operation: key committed first, stable payload, one unresolved rotate/mint per bot
//     (any kind), DELETE only on a delivered definitive outcome of a named operation   B2; Astra r1 #8, Fable r1 F4
// I7b deadline by predecessor key, home-knowledge only, 10-min margin, never cleared or moved later  Q5; Astra r1 #11, Fable r1 F3
// I7c a 400 is held and alerted, never retried                        B2; Astra r1 #12
// I8  prune DELETEs only safe retired ids; supervisor drops only confirmed ids   Astra r3.1 H2
// I9  liveness with checker-derived enabledness, future-only waits, prune/strays done  Astra r1 #1, Fable r1 F6
// I9b honest repair: one owner Reconnect from a recoverable repair reaches LV  Astra r1 #1, Fable r1 F5/F6
// I10 no leak at quiescence, removed bindings included; issuance attributed to the operation  Astra r1 #9, Fable r1 F9
// I11 reconcile never prunes an unknown LIVE key; usage clause gated on a measured lag bound  Q4 ruling; FluxMain usage
// I12 an intent/binding never closes while one of its operations is unknown inside the 201 hold  Astra r1 #9
//
// ── Fault model ──────────────────────────────────────────────────────────────────────────────────
// F1 Crash at every durable write and sub-point: DB cursor commit; supervisor job {written, renamed, synced, reread,
//    ack built}; proof rewrite; prune write; casBinding; clearCursor; disown. Modes: CHILD (child memory lost;
//    supervisor queue and built acks SURVIVE and may complete after the child restarts), SUPERVISOR (both memories lost;
//    a renamed file survives), POWER (also loses written/renamed-unsynced files).
// F2 Network: per transport request, an answer may be lost before or after Flux applies the call, duplicated (≤ 2),
//    or delivered after a later request of the same operation. Acks may be lost, delayed or duplicated.
// F3 Flux (FluxMain, #276 at e28f8f3c + M6 answer + usage note):
//    - Only a 201 is held (24 h per Idempotency-Key); the hold survives a DELETE of the held key. Every 409 is
//      re-evaluated per call, except idempotency_mismatch while a hold for that key exists.
//    - rotate(K1): 201 {K2, old_key_expires_at}; 409 rotation_pending {successor} while an ACTIVE successor row exists;
//      after that successor is DELETEd and before K1's deadline, a NEW key gives a fresh 201 {K3}; past it 409 key_revoked.
//    - K1's deadline is CAS'd once, min(existing, now + 24 h); never moved, never restarted, never extended.
//    - 503 rotation_incomplete {successor}: same key until 201. 500 (with or without body): unknown. 400: home bug.
//    - mint: 409 bot_key_exists {key_id} while a live key exists (re-evaluated). 404 key_not_found exact; other 404 = off.
//    - DELETE idempotent. GET list: {key_id, status, created_at, last_used_at|null, used, install_id?}.
//    - USAGE LAG: a use sets `lastUsedAt` at once but `lastUsedVisibleAt` only after a nondeterministic delay
//      0..SYNC_LAG (checker choice); the list shows the VISIBLE value. install_id is a label, never authority.
// F4 Clock jumps: deadlineAt − 2 h, each stored home deadline, each Flux deadline, each 201 hold `until`, +1 ms,
//    created_at + 24 h + SYNC_LAG. Fencing on/off at any step.
// F5 Owner: Reconnect, "Use email on this home" (take), Remove. Exogenous: the owner DELETEs any key in the Flux UI
//    (`flux_owner_delete`) at any step (Q3 ruling). Bots send email (`use`): answered 401 iff the key is not honoured.
// F6 Start states: one seed per r3.2 §2.1 row with its intent open (AR, RS, PS, VA, SV, SD, RT, DR×{AR,RC,close,TW},
//    RC, RM, EX, HD, RP, UP, FN, TW, TW-with-intent, RN, PP, PX); two-home seeds: twin holds the source's key; source
//    rotated since the backup; after a take; each home with an unknown live key in the other's view (I11); single
//    home with its own leaked key in the mint log past the hold.
// F7 FINITE DOMAINS: homes {S, T}; bots {b1} (b2 added in the multi-bot run); key ids from a pool of 8 per bot;
//    ≤ 3 logical operations per bot; ≤ 2 transport requests per operation; ≤ 2 deliveries per answer; ≤ 2 queued
//    supervisor jobs; time abstracted to the ordered set of F4 boundaries (region abstraction).
// Hash (Fable F7, Astra #12): canonical World WITHOUT `trace`, `alerts`, reqIds and opIds (renamed by first use),
//    with `now` replaced by its region. Memory, supervisor queue, operations and transport ARE in the hash.
// Depths are BOUNDED CHECKS, not exhaustiveness proofs: CI depth 14 from every F6 seed; nightly 28 from LV and 22 from
//    each two-home seed; liveness continuation bound 48. Coverage of every table cell and origin branch is a separate
//    gate (conformance step), not claimed here.

// ───────────────────────────────────────── Constants ─────────────────────────────────────────────

export const H24 = 24 * 3600_000;
export const MARGIN = 10 * 60_000; // Q5 ruling
/** Flux usage-sync lag bound. null = not yet measured: the I11 usage clause is then DISABLED. */
export const SYNC_LAG: number | null = null;

// ───────────────────────────────────────── State ─────────────────────────────────────────────────

export type KeyId = string;
export type BotId = string;
export type HomeId = string;
export type Idem = string;
export type OpId = string;
export type Time = number;

export type FluxKeyStatus = "live" | "successor_pending" | "revoked" | "expired_by_deadline";
export interface FluxKey {
  id: KeyId;
  bot: BotId;
  status: FluxKeyStatus;
  deadlineAt?: Time;
  successor?: KeyId;
  replaces?: KeyId; // lineage only; NEVER ownership (I11)
  issuedFor: { home: HomeId; opId: OpId }; // attributed at issuance, even if the 201 is lost (Astra #9)
  createdAt: Time;
  lastUsedAt: Time | null; // truth
  lastUsedVisibleAt: Time | null; // what the list shows (lags, F3)
  installId?: string; // label only
}
export interface FluxHold { idem: Idem; bodyHash: string; keyId: KeyId; until: Time }
export interface Flux { keys: Record<KeyId, FluxKey>; holds: Record<Idem, FluxHold>; flagOn: boolean; now: Time }

export type Origin = "rotate" | "recover" | "reconnect" | "take";
export type Step = "rotate" | "save" | "retire_old" | "drain" | "recover" | "expired" | "held" | "repair";

export interface Intent {
  origin: Origin;
  step: Step;
  next?: "AR" | "RC" | "close" | "TW";
  oldKeyId: KeyId | null;
  newKeyId?: KeyId;
  validated?: KeyId; // r2: the successor that passed `val` (committed with `inst`)
  rotateIdem?: Idem;
  mintIdem?: Idem;
  sends: number;
  deadlineAt?: Time; // mirror of durable.deadlines[oldKeyId]
  strays: KeyId[];
  disowned?: KeyId; // take only
  heldCode?: string; // r2: e.g. "invalid_request" (I7c)
}

export interface Evidence { gen: number; bots: Record<BotId, KeyId>; owner?: KeyId }
export interface DiskImage { gen: number; bots: Record<BotId, KeyId>; owner: KeyId | null; retired: KeyId[]; prev: KeyId[] }
export type BindingState = "active" | "restored_unverified" | "removing" | "removed";

export interface HomeDurable {
  disk: DiskImage; // authenticated reread after a SYNCED write
  proof: Evidence | null;
  bindings: Record<BotId, { state: BindingState; emailKeyRef: KeyId | null }>;
  intents: Record<BotId, Intent>;
  prune?: { candidates: KeyId[]; confirmed: KeyId[]; sentRev?: number };
  fenced: boolean;
  // r2 additions (all durable, DB):
  tombstones: KeyId[]; // DELETE reservations; permanent; committed before the DELETE call
  deadlines: Record<KeyId, Time>; // home deadline per predecessor key; survives intent close
  mintLog: { keyId: KeyId; bot: BotId; opId: OpId; wasDurable: boolean }[]; // written in the commit recording a 201
  observedDead: Record<BotId, KeyId>; // durable repair marker from an observed 401/404/key_revoked
  twinKeyLive: Record<BotId, KeyId>; // durable marker: a foreign live key was observed for this bot
  takeAuth: Record<BotId, { target: KeyId; opId: OpId }>; // created only by an owner take press
}

/** r2: supervisor process state. Survives a CHILD crash (F1). */
export interface SaveJob { gen: number; image: DiskImage; phase: "queued" | "written" | "renamed" | "synced" | "reread" }
export interface Supervisor { alive: boolean; queue: SaveJob[]; builtAcks: Evidence[] }

export interface HomeMemory {
  running: boolean;
  evidence: Evidence | null; // newest valid evidence since boot; null = UNPROVEN
  D: Record<BotId, KeyId | undefined>;
  botKey: Record<BotId, KeyId | undefined>;
  candidateToken: Record<BotId, KeyId | undefined>;
  rejected: Record<BotId, boolean>;
  sendsInFlight: Record<BotId, KeyId[]>; // r2: email sends holding a key's token (replaces saverInFlight)
  lastRefusal: string | null;
}

export interface Home {
  id: HomeId;
  destroyed: boolean;
  durable: HomeDurable;
  supervisor: Supervisor;
  memory: HomeMemory;
  /** OBSERVED flag: the harness fills it by calling the production `bindings.keyRepair(bot)` after every step. */
  repairVisible: Record<BotId, boolean>;
}

export type CallKind = "rotate" | "mint" | "delete" | "list";
export interface ListedKey { keyId: KeyId; status: FluxKeyStatus; createdAt: Time; lastUsedAt: Time | null; used: boolean }
export type Response =
  | { code: 201; keyId: KeyId; oldKeyExpiresAt?: Time }
  | { code: 200; list?: ListedKey[] }
  | { code: 204 }
  | { code: 401 }
  | { code: 409; error: "rotation_pending" | "key_revoked" | "idempotency_mismatch" | "bot_key_exists"; keyId?: KeyId }
  | { code: 404; error: "key_not_found" | "other" }
  | { code: 503; error: "rotation_incomplete"; keyId: KeyId }
  | { code: 500 }
  | { code: 400; error: "invalid_request" }
  | { code: "lost" };
export type Code = Response["code"];
const UNKNOWN_CODES: Code[] = ["lost", 500, 503];
export const definitive = (r: Response) => !UNKNOWN_CODES.includes(r.code);

/** r2: a LOGICAL operation (one Idempotency-Key, retries included). Outcome is what the HOME has received. */
export interface Operation {
  opId: OpId;
  home: HomeId;
  bot: BotId;
  kind: CallKind;
  keyId?: KeyId;
  idem?: Idem;
  bodyHash: string;
  firstSentAt: Time;
  outcome: "unknown" | "known";
  delivered: Response[]; // every answer the home received, in order (Fable F4: kept, not popped)
}
/** r2: transport only. */
export interface Transport { reqId: number; opId: OpId; appliedAtFlux: boolean; inbound: Response[] }

export type Actor = "auto" | "owner_reconnect" | "owner_take" | "reconcile";
export type Cause =
  | { by: "retire" }
  | { by: "stray"; opId: OpId } // the operation whose DELIVERED definitive answer justified it
  | { by: "prune" }
  | { by: "reconcile"; listOpId: OpId }
  | { by: "remove" };
export interface Call { home: HomeId; bot: BotId; kind: CallKind; keyId?: KeyId; idem?: Idem; bodyHash: string; opId: OpId; actor: Actor; cause?: Cause }

export type AuthorityEvent =
  | ({ t: "call" } & Call)
  | { t: "answer"; opId: OpId; resp: Response }
  | { t: "owner"; home: HomeId; bot: BotId; press: "reconnect" | "take" | "remove" }
  | { t: "flux_owner_delete"; keyId: KeyId }
  | { t: "crash"; home: HomeId; mode: "child" | "supervisor" | "power" }
  | { t: "boot"; home: HomeId };

export interface World {
  now: Time;
  flux: Flux;
  homes: Record<HomeId, Home>;
  ops: Record<OpId, Operation>;
  requests: Transport[];
  /** Checker bookkeeping (omniscient): bots whose durable key died by an event the home has not yet observed. */
  unobserved: Record<HomeId, Record<BotId, KeyId>>;
  alerts: { home: HomeId; bot: BotId; code: string }[];
  trace: AuthorityEvent[]; // NOT hashed
}

export type Action =
  | { kind: "call"; call: Call }
  | { kind: "answer"; opId: OpId; resp: Response; duplicate: boolean }
  | { kind: "commit"; home: HomeId; what: string }
  | { kind: "save"; home: HomeId; phase: SaveJob["phase"] | "ack" }
  | { kind: "ack"; home: HomeId; ev: Evidence | null }
  | { kind: "crash"; home: HomeId; mode: "child" | "supervisor" | "power" }
  | { kind: "boot"; home: HomeId }
  | { kind: "clock"; to: Time }
  | { kind: "fence"; home: HomeId; on: boolean }
  | { kind: "owner"; home: HomeId; bot: BotId; press: "reconnect" | "take" | "remove" }
  | { kind: "use"; home: HomeId; bot: BotId; resp: 200 | 401 }
  | { kind: "flux_owner_delete"; keyId: KeyId }
  | { kind: "usage_sync"; keyId: KeyId }
  | { kind: "drive"; home: HomeId; bot: BotId };

// ───────────────────────────────────────── Derived sets ──────────────────────────────────────────

const vals = <T>(r: Record<string, T>): T[] => Object.keys(r).map((k) => r[k]);
const defined = <T>(x: T | undefined | null): x is T => x !== undefined && x !== null;
const callOf = (a: Action): Call | null => (a.kind === "call" ? a.call : null);
const killsOrShortens = (c: Call) => c.kind === "delete" || c.kind === "rotate";

export function honours(f: Flux, k: KeyId | undefined | null): boolean {
  if (!defined(k)) return false;
  const key = f.keys[k];
  if (!key) return false;
  if (key.status === "successor_pending") return true;
  return key.status === "live" && (key.deadlineAt === undefined || f.now < key.deadlineAt);
}
export const durableKey = (h: Home, b: BotId): KeyId | undefined => h.durable.disk.bots[b];
export const unproven = (h: Home) => h.memory.evidence === null;
export const liveBinding = (h: Home, b: BotId) => {
  const s = h.durable.bindings[b]?.state;
  return s === "active" || s === "restored_unverified";
};

/** A: D, memory key and candidate token of every bot, the owner key. */
export function activeSet(h: Home): Set<KeyId> {
  const s = new Set<KeyId>();
  for (const b of Object.keys(h.durable.bindings)) {
    for (const k of [h.memory.D[b], h.memory.botKey[b], h.memory.candidateToken[b]]) if (defined(k)) s.add(k);
  }
  if (defined(h.durable.disk.owner)) s.add(h.durable.disk.owner);
  if (defined(h.memory.evidence?.owner)) s.add(h.memory.evidence!.owner!);
  return s;
}
/** P: newKeyId of each intent; oldKeyId unless retiring with an exact durable successor. */
export function pendingSet(h: Home): Set<KeyId> {
  const s = new Set<KeyId>();
  for (const b of Object.keys(h.durable.intents)) {
    const i = h.durable.intents[b];
    if (defined(i.newKeyId)) s.add(i.newKeyId);
    const exact = defined(i.newKeyId) && h.memory.D[b] === i.newKeyId && durableKey(h, b) === i.newKeyId;
    const retiring = i.step === "retire_old" || (i.step === "drain" && i.next === "close");
    if (defined(i.oldKeyId) && !(retiring && exact)) s.add(i.oldKeyId);
  }
  return s;
}
/** Q: ids in the NEWEST evidence only. */
export function proofSet(h: Home): Set<KeyId> {
  const ev = h.memory.evidence ?? h.durable.proof;
  return new Set(ev ? vals(ev.bots) : []);
}
export const protectedSet = (h: Home) => new Set([...activeSet(h), ...pendingSet(h), ...proofSet(h)]);
const allStrays = (h: Home) => new Set(vals(h.durable.intents).flatMap((i) => i.strays));
/** Every id this home knows as its own or as handled (knowledge, not omniscience). */
export function ownKnown(h: Home): Set<KeyId> {
  const d = h.durable;
  return new Set<KeyId>([
    ...vals(d.disk.bots), ...d.disk.retired, ...d.disk.prev, ...(defined(d.disk.owner) ? [d.disk.owner] : []),
    ...d.tombstones, ...d.mintLog.map((m) => m.keyId),
    ...vals(d.intents).flatMap((i) => [i.oldKeyId, i.newKeyId, ...i.strays].filter(defined)),
  ]);
}
/** Keys another non-destroyed home has anywhere it could use them (Fable F10). */
export function usedByOtherHome(w: World, self: HomeId, k: KeyId): boolean {
  return vals(w.homes).some((o) => o.id !== self && !o.destroyed && (
    vals(o.durable.disk.bots).includes(k) || vals(o.memory.botKey).includes(k) ||
    vals(o.memory.candidateToken).includes(k) ||
    vals(o.durable.intents).some((i) => i.newKeyId === k) ||
    o.supervisor.queue.some((j) => vals(j.image.bots).includes(k))));
}
const issuedFor = (w: World, k: KeyId) => w.flux.keys[k]?.issuedFor.home;

/** Every id durably held by a home (disk image, intents, strays, owner, prev, retired, tombstones). */
function durableIds(h: Home): Set<KeyId> {
  return new Set<KeyId>([...ownKnown(h)]);
}

/** Spec V(bot): owner-visible repair, a FUNCTION of durable state and the clock (r3.2 §1.1 + r2 markers). */
export function specV(h: Home, b: BotId, now: Time): boolean {
  if (!liveBinding(h, b)) return false;
  const d = h.durable, i = d.intents[b], k = durableKey(h, b);
  if (d.bindings[b].state === "restored_unverified") return true;
  if (!defined(k)) return true;
  if (d.observedDead[b] === k) return true;
  if (defined(d.twinKeyLive[b])) return true;
  if (!i) return false;
  if (i.step === "recover" || i.step === "expired" || i.step === "repair") return true;
  if (i.step === "held" && defined(i.deadlineAt) && now >= i.deadlineAt) return true;
  if (i.origin !== "rotate" && k !== i.newKeyId) return true; // recovery/reconnect/take: until the successor is durable
  return defined(i.deadlineAt) && now >= i.deadlineAt && k !== i.newKeyId;
}

/** Does this delivered answer reveal that the home's durable key for b is dead? */
function revealsDead(h: Home, w: World, a: Action): { bot: BotId; key: KeyId } | null {
  if (a.kind === "use" && a.resp === 401) {
    const k = h.memory.botKey[a.bot]; return defined(k) && k === durableKey(h, a.bot) ? { bot: a.bot, key: k } : null;
  }
  if (a.kind !== "answer") return null;
  const op = w.ops[a.opId];
  if (!op || op.home !== h.id || op.kind !== "rotate" || op.keyId !== durableKey(h, op.bot)) return null;
  const r = a.resp;
  const dead = (r.code === 404 && r.error === "key_not_found") || (r.code === 409 && r.error === "key_revoked");
  return dead && defined(op.keyId) ? { bot: op.bot, key: op.keyId } : null;
}
/** Does this delivered answer name a live key for b that this home does not know as its own? */
function revealsForeign(h: Home, w: World, a: Action): { bot: BotId; key: KeyId } | null {
  if (a.kind !== "answer") return null;
  const op = w.ops[a.opId];
  if (!op || op.home !== h.id) return null;
  const r = a.resp;
  const k = (r.code === 409 && (r.error === "bot_key_exists" || r.error === "rotation_pending")) || r.code === 503
    ? (r as { keyId?: KeyId }).keyId : undefined;
  return defined(k) && !ownKnown(h).has(k) ? { bot: op.bot, key: k } : null;
}

// ───────────────────────────────────────── Invariants ────────────────────────────────────────────
export type StepInvariant = (prev: World, action: Action, next: World) => boolean;
const homesOf = (w: World) => vals(w.homes).filter((h) => !h.destroyed);
const liveBots = (h: Home) => Object.keys(h.durable.bindings).filter((b) => liveBinding(h, b));

/** I1. Every live-bound bot of every non-destroyed home has a durable key Flux honours, or shows repair, or its key
 *  died by an event this home has not yet been able to observe (another home's take, an owner delete in the Flux UI,
 *  a Flux deadline the home never stored). The exemption ends at the home's first answer for that bot (I1d). */
export const I1_durableHonouredOrRepair: StepInvariant = (_p, _a, next) =>
  homesOf(next).every((h) => liveBots(h).every((b) =>
    honours(next.flux, durableKey(h, b)) || h.repairVisible[b] === true ||
    next.unobserved[h.id]?.[b] === durableKey(h, b)));

/** I1b. Once repair shows, it stays through every step until the durable key is honoured again. */
export const I1b_repairPersists: StepInvariant = (prev, _a, next) =>
  homesOf(prev).every((ph) => {
    const nh = next.homes[ph.id];
    if (!nh || nh.destroyed) return true;
    return Object.keys(ph.repairVisible).every((b) => !ph.repairVisible[b] || nh.repairVisible[b] === true ||
      !liveBinding(nh, b) || honours(next.flux, durableKey(nh, b)));
  });

/** I1c. Honest repair: the owner sees repair EXACTLY when spec V holds. A reducer that shows repair while the key
 *  works (or hides it while it does not) fails. Running or not, since keyRepair reads durable data only. */
export const I1c_repairHonest: StepInvariant = (_p, _a, next) =>
  homesOf(next).every((h) => liveBots(h).every((b) => (h.repairVisible[b] === true) === specV(h, b, next.now)));

/** I1d. When a home receives an answer showing its durable key is dead (a send's 401, rotate 404 key_not_found or
 *  409 key_revoked on it), the same step commits durable repair (observedDead), unless the slot has already moved
 *  to an honoured key. Memory health alone is lost at the next crash. */
export const I1d_detectionCommitsRepair: StepInvariant = (prev, a, next) =>
  homesOf(prev).every((h) => {
    const r = revealsDead(h, prev, a);
    if (!r) return true;
    const n = next.homes[h.id];
    return n.durable.observedDead[r.bot] === r.key || honours(next.flux, durableKey(n, r.bot));
  });

/** I2. A home never DELETEs an id in its own Protected set (A includes a mounted candidate token) or on its disk. */
export const I2_neverKillProtected: StepInvariant = (prev, a) => {
  const c = callOf(a);
  if (!c || c.kind !== "delete" || !defined(c.keyId)) return true;
  const h = prev.homes[c.home];
  return !protectedSet(h).has(c.keyId) && !vals(h.durable.disk.bots).includes(c.keyId);
};

/** I2b. Deletion reservations. A DELETE is sent only for an id already durably tombstoned; a tombstoned id is never
 *  adopted (memory key, candidate token, intent successor, disk slot, queued image); no DELETE of a key an email
 *  send is still using (G3). A delayed DELETE can then never kill a key the home has since installed. */
export const I2b_deleteReservation: StepInvariant = (prev, a, next) => {
  const c = callOf(a);
  if (c && c.kind === "delete" && defined(c.keyId)) {
    const h = prev.homes[c.home];
    if (!h.durable.tombstones.includes(c.keyId)) return false;
    if (vals(h.memory.sendsInFlight).some((ks) => ks.includes(c.keyId!))) return false;
  }
  return homesOf(next).every((h) => {
    const t = new Set(h.durable.tombstones);
    const adopted = [
      ...vals(h.memory.botKey), ...vals(h.memory.candidateToken), ...vals(h.durable.disk.bots),
      ...vals(h.durable.intents).map((i) => i.newKeyId), ...h.supervisor.queue.flatMap((j) => vals(j.image.bots)),
    ].filter(defined);
    return adopted.every((k) => !t.has(k)) && prev.homes[h.id]?.durable.tombstones.every((k) => t.has(k)) !== false;
  });
};

/** I3. Unproven or fenced: no Flux write, and no commit, save phase or ack that drops an id from durable state. */
export const I3_noDestructionUnproven: StepInvariant = (prev, a, next) =>
  homesOf(prev).every((h) => {
    if (!(unproven(h) || h.durable.fenced)) return true;
    const c = callOf(a);
    if (c && c.home === h.id && c.kind !== "list") return false;
    const local = (a.kind === "commit" || a.kind === "save" || a.kind === "ack") && a.home === h.id;
    if (!local) return true;
    const after = durableIds(next.homes[h.id]);
    return [...durableIds(h)].every((k) => after.has(k));
  });

/** I3b. No durable rollback. A disk slot changes only to the open intent's own validated successor, with a higher
 *  generation, or is cleared only by a take's disown or a removal. A stale queued save cannot bring back K1. */
export const I3b_noDurableRollback: StepInvariant = (prev, _a, next) =>
  homesOf(prev).every((ph) => {
    const nh = next.homes[ph.id];
    if (!nh) return true;
    const pd = ph.durable.disk, nd = nh.durable.disk;
    if (nd.gen < pd.gen) return false;
    return Object.keys({ ...pd.bots, ...nd.bots }).every((b) => {
      if (pd.bots[b] === nd.bots[b]) return true;
      const i = ph.durable.intents[b];
      if (!defined(nd.bots[b]))
        return (i?.origin === "take" && i.disowned === pd.bots[b]) || nh.durable.bindings[b]?.state === "removed";
      return nd.gen > pd.gen && !!i && i.newKeyId === nd.bots[b] && i.validated === nd.bots[b];
    });
  });

/** I4. With an open intent whose successor is durable, no mint or rotate for that bot, no DELETE of the successor,
 *  and the successor is never demoted while it is durable. */
export const I4_durableSuccessorResumes: StepInvariant = (prev, a, next) =>
  homesOf(prev).every((h) => Object.keys(h.durable.intents).every((b) => {
    const i = h.durable.intents[b];
    if (!defined(i.newKeyId) || durableKey(h, b) !== i.newKeyId) return true;
    const c = callOf(a);
    if (c && c.home === h.id && c.bot === b && (c.kind === "mint" || c.kind === "rotate")) return false;
    if (c && c.home === h.id && c.kind === "delete" && c.keyId === i.newKeyId) return false;
    const n = next.homes[h.id].durable.intents[b];
    return !n || n.newKeyId === i.newKeyId;
  }));

/** I5. An intent's old key is DELETEd only when its successor is exact (disk = D = newKeyId ≠ old), validated, and
 *  not known dead or contested (no observedDead / twin marker / memory rejection on it). */
export const I5_retireOnExactSuccessor: StepInvariant = (prev, a) => {
  const c = callOf(a);
  if (!c || c.kind !== "delete") return true;
  const h = prev.homes[c.home], d = h.durable;
  return Object.keys(d.intents).every((b) => {
    const i = d.intents[b];
    if (i.oldKeyId !== c.keyId) return true;
    return defined(i.newKeyId) && i.newKeyId !== i.oldKeyId && durableKey(h, b) === i.newKeyId &&
      h.memory.D[b] === i.newKeyId && i.validated === i.newKeyId && d.observedDead[b] !== i.newKeyId &&
      !defined(d.twinKeyLive[b]) && h.memory.rejected[b] !== true;
  });
};

/** I5b. Evidence never moves backward within a run; after boot, evidence (if any) reflects the newest synced disk. */
export const I5b_evidenceMonotone: StepInvariant = (prev, a, next) =>
  homesOf(next).every((nh) => {
    const ph = prev.homes[nh.id];
    if (!ph) return true;
    if (a.kind === "boot" && a.home === nh.id) return nh.memory.evidence === null || nh.memory.evidence.gen === nh.durable.disk.gen;
    if (a.kind === "crash" && a.home === nh.id) return true;
    return (nh.memory.evidence?.gen ?? -1) >= (ph.memory.evidence?.gen ?? -1);
  });

/** I6. No AUTOMATIC (or reconcile) call kills or shortens a key another live home may use, unless Flux issued that
 *  key for the calling home. Protects the twin's working email (Fable r3.2 H1). */
export const I6_noAutoKillOfOtherHomesKey: StepInvariant = (prev, a) => {
  const c = callOf(a);
  if (!c || !killsOrShortens(c) || !defined(c.keyId) || c.actor === "owner_take") return true;
  return !usedByOtherHome(prev, c.home, c.keyId) || issuedFor(prev, c.keyId) === c.home;
};

/** I6b. NO PING-PONG. A call that kills or shortens a key another home uses and that was not issued for the caller
 *  must be a ROTATE by actor owner_take, inside the one operation named by takeAuth[bot] with target = that key.
 *  takeAuth is created or changed only in the step of an owner take press for that (home, bot), with an opId never
 *  used before. One press, one operation (its retries included); a second kill needs a second press. */
export const I6b_noPingPong: StepInvariant = (prev, a, next) => {
  const c = callOf(a);
  if (c && killsOrShortens(c) && defined(c.keyId) && usedByOtherHome(prev, c.home, c.keyId) &&
      issuedFor(prev, c.keyId) !== c.home) {
    const auth = prev.homes[c.home].durable.takeAuth[c.bot];
    if (c.actor !== "owner_take" || c.kind !== "rotate" || !auth || auth.target !== c.keyId || auth.opId !== c.opId) return false;
  }
  return homesOf(next).every((nh) => {
    const pa = prev.homes[nh.id]?.durable.takeAuth ?? {};
    return Object.keys({ ...pa, ...nh.durable.takeAuth }).every((b) => {
      const p = pa[b], n = nh.durable.takeAuth[b];
      if (JSON.stringify(p) === JSON.stringify(n) || !n) return true;
      return a.kind === "owner" && a.press === "take" && a.home === nh.id && a.bot === b && !prev.ops[n.opId];
    });
  });
};

/** I6c. Twin detection. An answer naming a live key for the bot that this home does not know as its own commits the
 *  twin_key_live marker in the same step. While the marker is set: no automatic or reconcile mint, rotate or DELETE
 *  for that bot. Only an owner press clears it. A taken-over home therefore lands in repair and never auto-mints. */
export const I6c_twinMarker: StepInvariant = (prev, a, next) => {
  for (const h of homesOf(prev)) {
    const f = revealsForeign(h, prev, a);
    if (f && next.homes[h.id].durable.twinKeyLive[f.bot] !== f.key) return false;
  }
  const c = callOf(a);
  if (c && c.kind !== "list" && (c.actor === "auto" || c.actor === "reconcile") && defined(prev.homes[c.home].durable.twinKeyLive[c.bot])) return false;
  return homesOf(prev).every((ph) => Object.keys(ph.durable.twinKeyLive).every((b) =>
    defined(next.homes[ph.id]?.durable.twinKeyLive[b]) || (a.kind === "owner" && a.home === ph.id && a.bot === b)));
};

/** I6d. The take disowns first. Every owner_take call runs under an intent of origin take whose oldKeyId = disowned =
 *  takeAuth.target, and that target is already out of disk.bots, D, memory key and the newest evidence. A take never
 *  DELETEs (Q2 ruling: rotate; the target dies at Flux's deadline; the take intent closes from SD, never RT). */
export const I6d_takeDisownsFirst: StepInvariant = (prev, a) => {
  const c = callOf(a);
  if (!c) return true;
  const h = prev.homes[c.home], i = h.durable.intents[c.bot], auth = h.durable.takeAuth[c.bot];
  if (i?.origin === "take" && c.kind === "delete" && c.keyId === i.disowned) return false;
  if (c.actor !== "owner_take") return true;
  if (c.kind === "delete" || !i || i.origin !== "take" || !auth || i.disowned !== auth.target || i.oldKeyId !== auth.target) return false;
  const x = auth.target;
  return !vals(h.durable.disk.bots).includes(x) && h.memory.D[c.bot] !== x && h.memory.botKey[c.bot] !== x && !proofSet(h).has(x);
};

/** I7. Idempotency per logical operation. Rotate/mint calls carry the idem already committed in the intent and the
 *  operation's stable payload; a NEW rotate/mint operation for a bot is not started while another rotate/mint
 *  operation of that bot is unknown and inside its 24 h hold; a DELETE caused by a stray names an operation whose
 *  outcome the home has received and whose last delivered answer is definitive. */
export const I7_idempotency: StepInvariant = (prev, a) => {
  const c = callOf(a);
  if (!c) return true;
  if (c.kind === "delete") {
    if (c.cause?.by !== "stray") return true;
    const op = prev.ops[c.cause.opId];
    const last = op?.delivered[op.delivered.length - 1];
    return !!op && op.home === c.home && op.outcome === "known" && !!last && definitive(last);
  }
  if (c.kind === "list") return true;
  const i = prev.homes[c.home].durable.intents[c.bot];
  const stored = c.kind === "rotate" ? i?.rotateIdem : i?.mintIdem;
  if (!defined(c.idem) || stored !== c.idem) return false;
  const existing = prev.ops[c.opId];
  if (existing) return existing.idem === c.idem && existing.bodyHash === c.bodyHash && existing.keyId === c.keyId && existing.kind === c.kind;
  return !vals(prev.ops).some((o) => o.home === c.home && o.bot === c.bot && (o.kind === "rotate" || o.kind === "mint") &&
    o.outcome === "unknown" && prev.now < o.firstSentAt + H24);
};

/** I7b. Deadline by predecessor key, from home knowledge only. Before the first rotate of K, deadlines[K] is set and
 *  ≤ now + 24 h − 10 min; after a delivered 201 with old_key_expires_at E, deadlines[K] ≤ E − 10 min; a stored
 *  deadline is never removed or moved later; the intent's deadlineAt mirrors it. */
export const I7b_deadlineConservative: StepInvariant = (prev, a, next) => {
  const c = callOf(a);
  if (c && c.kind === "rotate" && defined(c.keyId) && !prev.ops[c.opId]) {
    const dl = prev.homes[c.home].durable.deadlines[c.keyId];
    if (!defined(dl) || dl > prev.now + H24 - MARGIN) return false;
  }
  if (a.kind === "answer" && a.resp.code === 201 && defined(a.resp.oldKeyExpiresAt)) {
    const op = prev.ops[a.opId];
    if (op?.kind === "rotate" && defined(op.keyId)) {
      const dl = next.homes[op.home].durable.deadlines[op.keyId];
      if (!defined(dl) || dl > a.resp.oldKeyExpiresAt - MARGIN) return false;
    }
  }
  return homesOf(prev).every((ph) => {
    const nh = next.homes[ph.id];
    if (!nh) return true;
    const ok = Object.keys(ph.durable.deadlines).every((k) => defined(nh.durable.deadlines[k]) && nh.durable.deadlines[k] <= ph.durable.deadlines[k]);
    const mirror = vals(nh.durable.intents).every((i) => !defined(i.oldKeyId) || !defined(i.deadlineAt) || i.deadlineAt === nh.durable.deadlines[i.oldKeyId]);
    return ok && mirror;
  });
};

/** I7c. A 400 invalid_request is a home bug: the same step holds the intent (heldCode) and raises an ops alert, and
 *  that operation is never sent again. */
export const I7c_badRequestHeld: StepInvariant = (prev, a, next) => {
  if (a.kind === "answer" && a.resp.code === 400) {
    const op = prev.ops[a.opId];
    if (!op) return true;
    const i = next.homes[op.home].durable.intents[op.bot];
    return i?.step === "held" && i.heldCode === "invalid_request" &&
      next.alerts.some((x) => x.home === op.home && x.bot === op.bot && x.code === "invalid_request");
  }
  const c = callOf(a);
  return !c || !prev.ops[c.opId]?.delivered.some((r) => r.code === 400);
};

/** I8. Prune DELETEs only ids in `retired` outside Protected, strays and prev; the supervisor drops from `retired`
 *  only ids whose DELETE was confirmed. */
export const I8_pruneOnlySafeRetired: StepInvariant = (prev, a, next) => {
  const c = callOf(a);
  if (c && c.kind === "delete" && c.cause?.by === "prune") {
    const h = prev.homes[c.home];
    if (!defined(c.keyId) || !h.durable.disk.retired.includes(c.keyId)) return false;
    if (protectedSet(h).has(c.keyId) || allStrays(h).has(c.keyId) || h.durable.disk.prev.includes(c.keyId)) return false;
  }
  return homesOf(prev).every((h) => {
    const n = next.homes[h.id];
    if (!n) return true;
    return h.durable.disk.retired.filter((k) => !n.durable.disk.retired.includes(k))
      .every((k) => (h.durable.prune?.confirmed ?? []).includes(k));
  });
};

/** I11. Reconcile (periodic, ruling Q4). It never DELETEs an unknown live key: it may DELETE a key only if the list
 *  it acted on showed it revoked or expired, OR all of: (1) last_used_at null, (2) created more than 24 h + SYNC_LAG
 *  ago (clause DISABLED while SYNC_LAG is null; null alone never proves "unused"), (3) this home's durable mint log
 *  names it, and it was never durable here (a copy may live in a backup), (4) it is outside Protected, Pending,
 *  strays, prev and the twin marker. `replaces` and install_id never count as ownership. */
export const I11_reconcileNeverPrunesUnknownLive: StepInvariant = (prev, a) => {
  const c = callOf(a);
  if (!c) return true;
  if (c.actor === "reconcile" && c.kind !== "list" && c.kind !== "delete") return false; // reconcile only lists and DELETEs
  if (c.kind !== "delete" || (c.actor !== "reconcile" && c.cause?.by !== "reconcile")) return true;
  if (c.cause?.by !== "reconcile" || !defined(c.keyId)) return false;
  const h = prev.homes[c.home], d = h.durable, k = c.keyId;
  const listOp = prev.ops[c.cause.listOpId];
  const last = listOp?.delivered[listOp.delivered.length - 1];
  const row = last && last.code === 200 ? last.list?.find((r) => r.keyId === k) : undefined;
  if (!listOp || listOp.home !== c.home || listOp.kind !== "list" || !row) return false;
  if (protectedSet(h).has(k) || allStrays(h).has(k) || d.disk.prev.includes(k) || vals(d.twinKeyLive).includes(k)) return false;
  if (row.status === "revoked" || row.status === "expired_by_deadline") return true;
  if (SYNC_LAG === null) return false;
  const entry = d.mintLog.find((m) => m.keyId === k && m.bot === c.bot);
  return row.lastUsedAt === null && !row.used && prev.now > row.createdAt + H24 + SYNC_LAG && !!entry && !entry.wasDurable;
};

/** I12. Cleanup survives closure and removal. A commit never clears a bot's intent (nor marks the binding removed
 *  without a drain intent) while an operation of that bot is unknown and still inside its 24 h hold: the home must
 *  replay it, learn the key and DELETE it. */
export const I12_noCloseOverUnknown: StepInvariant = (prev, a, next) => {
  if (a.kind !== "commit" && a.kind !== "owner") return true;
  const h = prev.homes[a.home], n = next.homes[a.home];
  return Object.keys(h.durable.bindings).every((b) => {
    const open = vals(prev.ops).some((o) => o.home === h.id && o.bot === b && (o.kind === "rotate" || o.kind === "mint") &&
      o.outcome === "unknown" && prev.now < o.firstSentAt + H24);
    if (!open) return true;
    return defined(n.durable.intents[b]);
  });
};

// ─────────────── Liveness and leaks (checker-evaluated on continuations / quiescent states) ───────────────

/** Enabledness is DERIVED by the checker from the reducer: it runs `drive` on a copy; any call or commit ⇒ auto ≥ 1;
 *  nothing now but a call/commit after a clock jump to a stored future deadline ⇒ onlyClockUntil. Never self-reported. */
export interface Enabled { auto: number; onlyClockUntil?: Time; ownerReconnectHelps: boolean }

/** Quiescent: no transport in flight, no unknown operation inside its hold, no supervisor job, no prune cursor, no
 *  undrained strays, and per live-bound bot one of: (q1) LV, honoured durable key, no intent; (q2) owner-waiting:
 *  spec V holds and no automatic action is enabled; (q3) Flux-waiting: an intent whose only enabled step is a clock
 *  jump to a FUTURE stored deadline, with the durable key honoured. */
export function isQuiescent(w: World, enabled: (h: Home, b: BotId) => Enabled): boolean {
  if (w.requests.some((r) => r.inbound.length > 0 || !r.appliedAtFlux)) return false;
  if (vals(w.ops).some((o) => o.outcome === "unknown" && w.now < o.firstSentAt + H24 && !w.homes[o.home].destroyed)) return false;
  return homesOf(w).filter((h) => h.memory.running).every((h) =>
    h.supervisor.queue.length === 0 && !h.durable.prune && vals(h.durable.intents).every((i) => i.strays.length === 0) &&
    liveBots(h).every((b) => {
      const e = enabled(h, b), i = h.durable.intents[b], k = durableKey(h, b);
      const q1 = !i && h.durable.bindings[b].state === "active" && h.memory.D[b] === k && honours(w.flux, k) && !specV(h, b, w.now) && e.auto === 0;
      const q2 = specV(h, b, w.now) && e.auto === 0;
      const q3 = !!i && e.auto === 0 && defined(e.onlyClockUntil) && e.onlyClockUntil > w.now && honours(w.flux, k);
      return q1 || q2 || q3;
    }));
}

/** I9. Liveness on FAULT-FREE, FAIR continuations: no crash, no lost/500/503 answer, acks delivered, every enabled
 *  drive eventually run, `use` performed for every mounted bot, clock jumps only to the next stored boundary, no
 *  owner press. Quiescence must be reached within `bound` steps. */
export function I9_liveness(continuation: World[], bound: number, quiescent: (w: World) => boolean): boolean {
  const idx = continuation.findIndex(quiescent);
  return idx >= 0 && idx <= bound;
}

/** I9b. Honest repair. From a q2 state whose repair is owner-recoverable (not restored_unverified, no twin marker,
 *  inbox listed), a fault-free continuation that starts with ONE owner Reconnect press reaches q1 within `bound`.
 *  (For a twin marker the owner path is the take; checked the same way with one take press.) */
export function I9b_reconnectRecovers(afterPress: World[], bound: number, isQ1: (w: World) => boolean): boolean {
  const idx = afterPress.findIndex(isQ1);
  return idx >= 0 && idx <= bound;
}

/** I10. No leak at quiescence. For every bot of every home, active or REMOVED, no key Flux honours that was issued
 *  for this home's operations is left other than the durable key (or a key another home uses). Severity: "fail" if
 *  the home received the 201 (the key is in its mint log); "warn" if the issuing operation's outcome was never known
 *  (lost past the hold: reconcile's job, I11). An open repair intent does not excuse it. */
export function I10_noLeakAtQuiescence(w: World): "ok" | "warn" | "fail" {
  let worst: "ok" | "warn" | "fail" = "ok";
  for (const h of homesOf(w)) for (const b of Object.keys(h.durable.bindings)) {
    const st = h.durable.bindings[b].state;
    for (const k of vals(w.flux.keys)) {
      if (k.bot !== b || k.issuedFor.home !== h.id || !honours(w.flux, k.id)) continue;
      if ((st === "active" || st === "restored_unverified") && k.id === durableKey(h, b)) continue;
      if (usedByOtherHome(w, h.id, k.id)) continue;
      if (h.durable.mintLog.some((m) => m.keyId === k.id)) return "fail";
      worst = "warn";
    }
  }
  return worst;
}

export const STEP_INVARIANTS: Record<string, StepInvariant> = {
  I1_durableHonouredOrRepair, I1b_repairPersists, I1c_repairHonest, I1d_detectionCommitsRepair,
  I2_neverKillProtected, I2b_deleteReservation, I3_noDestructionUnproven, I3b_noDurableRollback,
  I4_durableSuccessorResumes, I5_retireOnExactSuccessor, I5b_evidenceMonotone,
  I6_noAutoKillOfOtherHomesKey, I6b_noPingPong, I6c_twinMarker, I6d_takeDisownsFirst,
  I7_idempotency, I7b_deadlineConservative, I7c_badRequestHeld, I8_pruneOnlySafeRetired,
  I11_reconcileNeverPrunesUnknownLive, I12_noCloseOverUnknown,
};

// ───────────────────────────────────────── Witnesses ─────────────────────────────────────────────
// Pure data built by small helpers. `reject` = the invariant MUST return false; `accept` = MUST return true.
// Findings that said "the spec forbids correct behaviour" (Astra #2, #4; Fable F1, F2, F3) are must-ACCEPT witnesses,
// each paired with a must-reject neighbour.

const T0 = 1_000_000_000;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
function mkHome(id: HomeId, key: KeyId, state: BindingState = "active"): Home {
  const ev: Evidence = { gen: 1, bots: { b1: key }, owner: "O" + id };
  return {
    id, destroyed: false, repairVisible: { b1: state === "restored_unverified" },
    durable: {
      disk: { gen: 1, bots: { b1: key }, owner: "O" + id, retired: [], prev: [] }, proof: ev,
      bindings: { b1: { state, emailKeyRef: key } }, intents: {}, fenced: false,
      tombstones: [], deadlines: {}, mintLog: [], observedDead: {}, twinKeyLive: {}, takeAuth: {},
    },
    supervisor: { alive: true, queue: [], builtAcks: [] },
    memory: { running: true, evidence: ev, D: { b1: key }, botKey: { b1: key }, candidateToken: {}, rejected: {}, sendsInFlight: {}, lastRefusal: null },
  };
}
function fkey(id: KeyId, home: HomeId, status: FluxKeyStatus = "live"): FluxKey {
  return { id, bot: "b1", status, issuedFor: { home, opId: "op-" + id }, createdAt: T0 - H24 * 3, lastUsedAt: null, lastUsedVisibleAt: null };
}
/** Single home S on K1. */
function baseS(): World {
  return { now: T0, flux: { keys: { K1: fkey("K1", "S") }, holds: {}, flagOn: true, now: T0 }, homes: { S: mkHome("S", "K1") },
    ops: {}, requests: [], unobserved: {}, alerts: [], trace: [] };
}
/** Source S on K1, restored twin T holding the same K1 (issued for S). */
function baseTwin(): World {
  const w = baseS(); w.homes.T = mkHome("T", "K1", "restored_unverified"); return w;
}
const op = (o: Partial<Operation> & { opId: OpId; home: HomeId; kind: CallKind }): Operation =>
  ({ bot: "b1", bodyHash: "h", firstSentAt: T0, outcome: "unknown", delivered: [], ...o });
const call = (c: Partial<Call> & { home: HomeId; kind: CallKind; opId: OpId }): Action =>
  ({ kind: "call", call: { bot: "b1", bodyHash: "h", actor: "auto", ...c } });
const intent = (i: Partial<Intent>): Intent => ({ origin: "rotate", step: "rotate", oldKeyId: "K1", sends: 0, strays: [], ...i });

export type StepWitness = { id: string; inv: string; expect: "reject" | "accept"; finding: string; prev: World; action: Action; next: World };
function W(id: string, inv: string, expect: "reject" | "accept", finding: string, prev: World, action: Action, mutate: (n: World) => void = () => {}): StepWitness {
  const next = clone(prev); mutate(next); return { id, inv, expect, finding, prev, action, next };
}
/** Successor K2 durable at S, intent at retire_old. */
function retiring(): World {
  const w = baseS(), h = w.homes.S;
  w.flux.keys.K2 = fkey("K2", "S", "successor_pending");
  h.durable.disk = { ...h.durable.disk, gen: 2, bots: { b1: "K2" } };
  h.memory.evidence = { gen: 2, bots: { b1: "K2" }, owner: "OS" };
  h.memory.D.b1 = "K2"; h.memory.botKey.b1 = "K2";
  h.durable.intents.b1 = intent({ step: "retire_old", newKeyId: "K2", validated: "K2", sends: 1, deadlineAt: T0 + H24 - MARGIN });
  h.durable.deadlines.K1 = T0 + H24 - MARGIN; h.durable.tombstones = ["K1"];
  return w;
}

export const STEP_WITNESSES: StepWitness[] = [
  // I1 (Astra #4, Fable F1): victim before observation passes; observed-but-hidden fails.
  W("I1-acc-victim-unobserved", "I1_durableHonouredOrRepair", "accept", "Astra#4 Fable F1", baseS(), { kind: "flux_owner_delete", keyId: "K1" },
    (n) => { n.flux.keys.K1.status = "revoked"; n.unobserved = { S: { b1: "K1" } }; }),
  W("I1-rej-dead-no-repair", "I1_durableHonouredOrRepair", "reject", "MurageMain invariant", baseS(), { kind: "drive", home: "S", bot: "b1" },
    (n) => { n.flux.keys.K1.status = "revoked"; }),
  // I1b (Astra r3.2 H1): fix → DR drops the flag while K1 is still dead.
  W("I1b-rej-drain-hides", "I1b_repairPersists", "reject", "Astra r3.2 H1", (() => { const w = baseS(); w.flux.keys.K1.status = "revoked"; w.homes.S.repairVisible.b1 = true; return w; })(),
    { kind: "owner", home: "S", bot: "b1", press: "reconnect" }, (n) => { n.homes.S.repairVisible.b1 = false; n.homes.S.durable.intents.b1 = intent({ step: "drain", next: "RC", origin: "recover" }); }),
  W("I1b-acc-replaced", "I1b_repairPersists", "accept", "Astra r3.2 H1", (() => { const w = baseS(); w.homes.S.repairVisible.b1 = true; return w; })(),
    { kind: "commit", home: "S", what: "cas" }, (n) => { n.homes.S.repairVisible.b1 = false; }),
  // I1c (Fable F5): repair shown on a healthy LV bot.
  W("I1c-rej-false-repair", "I1c_repairHonest", "reject", "Fable F5", baseS(), { kind: "drive", home: "S", bot: "b1" }, (n) => { n.homes.S.repairVisible.b1 = true; }),
  W("I1c-acc-lv", "I1c_repairHonest", "accept", "Fable F5", baseS(), { kind: "drive", home: "S", bot: "b1" }),
  // I1d (Fable F1/R1, Astra #4): a send's 401 with no durable marker.
  W("I1d-rej-401-memory-only", "I1d_detectionCommitsRepair", "reject", "Fable F1 Astra#4", (() => { const w = baseS(); w.flux.keys.K1.status = "revoked"; return w; })(),
    { kind: "use", home: "S", bot: "b1", resp: 401 }, (n) => { n.homes.S.memory.rejected.b1 = true; }),
  W("I1d-acc-401-marker", "I1d_detectionCommitsRepair", "accept", "Fable F1", (() => { const w = baseS(); w.flux.keys.K1.status = "revoked"; return w; })(),
    { kind: "use", home: "S", bot: "b1", resp: 401 }, (n) => { n.homes.S.durable.observedDead.b1 = "K1"; n.homes.S.repairVisible.b1 = true; }),
  // I2
  W("I2-rej-delete-durable", "I2_neverKillProtected", "reject", "rule (i)", baseS(), call({ home: "S", kind: "delete", keyId: "K1", opId: "d1", cause: { by: "retire" } })),
  W("I2-acc-retire-after-successor", "I2_neverKillProtected", "accept", "rule (i)", retiring(), call({ home: "S", kind: "delete", keyId: "K1", opId: "d1", cause: { by: "retire" } })),
  // I2b (Astra #6): adopt K2 while K2 is tombstoned; DELETE without reservation; DELETE under a send.
  W("I2b-rej-adopt-tombstoned", "I2b_deleteReservation", "reject", "Astra#6", (() => { const w = baseS(); w.homes.S.durable.tombstones = ["K2"]; return w; })(),
    { kind: "answer", opId: "r1", resp: { code: 201, keyId: "K2" }, duplicate: true }, (n) => { n.homes.S.memory.candidateToken.b1 = "K2"; }),
  W("I2b-rej-no-reservation", "I2b_deleteReservation", "reject", "Astra#6", baseS(), call({ home: "S", kind: "delete", keyId: "K9", opId: "d9", cause: { by: "retire" } })),
  W("I2b-rej-send-in-flight", "I2b_deleteReservation", "reject", "Astra#6 G3", (() => { const w = retiring(); w.homes.S.memory.sendsInFlight = { b1: ["K1"] }; return w; })(),
    call({ home: "S", kind: "delete", keyId: "K1", opId: "d1", cause: { by: "retire" } })),
  W("I2b-acc-reserved", "I2b_deleteReservation", "accept", "Astra#6", retiring(), call({ home: "S", kind: "delete", keyId: "K1", opId: "d1", cause: { by: "retire" } })),
  // I3 (Fable F8, Astra #5): unproven save drops an id.
  W("I3-rej-unproven-save-drops", "I3_noDestructionUnproven", "reject", "Fable F8", (() => { const w = baseS(); w.homes.S.memory.evidence = null; w.homes.S.durable.disk.retired = ["K0"]; return w; })(),
    { kind: "save", home: "S", phase: "reread" }, (n) => { n.homes.S.durable.disk.retired = []; }),
  W("I3-rej-unproven-call", "I3_noDestructionUnproven", "reject", "rule (ii)", (() => { const w = baseS(); w.homes.S.memory.evidence = null; return w; })(),
    call({ home: "S", kind: "mint", opId: "m1", idem: "i1" })),
  W("I3-acc-unproven-noop", "I3_noDestructionUnproven", "accept", "rule (ii)", (() => { const w = baseS(); w.homes.S.memory.evidence = null; return w; })(), { kind: "drive", home: "S", bot: "b1" }),
  // I3b (Astra #5, #10): a stale queued save from before a child crash lands K1 over durable K2.
  W("I3b-rej-stale-save-rollback", "I3b_noDurableRollback", "reject", "Astra#5 #10", retiring(), { kind: "save", home: "S", phase: "reread" },
    (n) => { n.homes.S.durable.disk = { ...n.homes.S.durable.disk, gen: 3, bots: { b1: "K1" } }; }),
  W("I3b-acc-forward", "I3b_noDurableRollback", "accept", "Astra#5", (() => { const w = baseS(); w.homes.S.durable.intents.b1 = intent({ step: "save", newKeyId: "K2", validated: "K2", sends: 1 }); return w; })(),
    { kind: "save", home: "S", phase: "reread" }, (n) => { n.homes.S.durable.disk = { ...n.homes.S.durable.disk, gen: 2, bots: { b1: "K2" } }; }),
  // I4 (Astra r3.2 #3): durable successor, then a mint.
  W("I4-rej-mint-over-durable", "I4_durableSuccessorResumes", "reject", "rule (iii) Astra r3.2 #3", (() => { const w = retiring(); w.homes.S.durable.intents.b1.step = "save"; return w; })(),
    call({ home: "S", kind: "mint", opId: "m1", idem: "i1" })),
  W("I4-acc-cas", "I4_durableSuccessorResumes", "accept", "rule (iii)", retiring(), { kind: "commit", home: "S", what: "cas" }),
  // I5 (Astra #7): successor known dead, old key retired anyway.
  W("I5-rej-dead-successor", "I5_retireOnExactSuccessor", "reject", "Astra#7", (() => { const w = retiring(); w.homes.S.durable.observedDead.b1 = "K2"; return w; })(),
    call({ home: "S", kind: "delete", keyId: "K1", opId: "d1", cause: { by: "retire" } })),
  W("I5-acc-exact", "I5_retireOnExactSuccessor", "accept", "rule (iv)", retiring(), call({ home: "S", kind: "delete", keyId: "K1", opId: "d1", cause: { by: "retire" } })),
  // I5b (Astra r3.2 H2, Fable F11)
  W("I5b-rej-evidence-backward", "I5b_evidenceMonotone", "reject", "Astra r3.2 H2", retiring(), { kind: "ack", home: "S", ev: null },
    (n) => { n.homes.S.memory.evidence = { gen: 1, bots: { b1: "K1" } }; }),
  W("I5b-acc-newer-ack", "I5b_evidenceMonotone", "accept", "Astra r3.2 H2", baseS(), { kind: "ack", home: "S", ev: null },
    (n) => { n.homes.S.memory.evidence = { gen: 2, bots: { b1: "K2" } }; }),
  // I6 (Fable r3.2 H1): twin T, RC ExX → stray → DELETE of the source's K1.
  W("I6-rej-twin-deletes-source-key", "I6_noAutoKillOfOtherHomesKey", "reject", "Fable r3.2 H1", baseTwin(),
    call({ home: "T", kind: "delete", keyId: "K1", opId: "d1", cause: { by: "stray", opId: "m1" } })),
  W("I6-acc-source-rotates-own", "I6_noAutoKillOfOtherHomesKey", "accept", "Fable F2", baseTwin(), call({ home: "S", kind: "rotate", keyId: "K1", opId: "r1", idem: "i1" })),
  // I6b (Fable r3.2 H2, Astra #2, #3, Fable F2)
  W("I6b-rej-victim-auto-kills-takers-key", "I6b_noPingPong", "reject", "Fable r3.2 H2", (() => {
    const w = baseTwin(); w.flux.keys.K5 = fkey("K5", "T"); w.homes.T.durable.disk.bots.b1 = "K5"; return w; })(),
    call({ home: "S", kind: "delete", keyId: "K5", opId: "d5", cause: { by: "stray", opId: "m2" } })),
  W("I6b-rej-auth-other-bot", "I6b_noPingPong", "reject", "Astra#3", (() => {
    const w = baseTwin(); w.homes.T.durable.takeAuth = { b2: { target: "K1", opId: "t1" } }; return w; })(),
    call({ home: "T", kind: "rotate", keyId: "K1", opId: "t1", idem: "it", actor: "owner_take" })),
  W("I6b-rej-auth-without-press", "I6b_noPingPong", "reject", "Fable r3.2 H2", baseTwin(), { kind: "drive", home: "T", bot: "b1" },
    (n) => { n.homes.T.durable.takeAuth.b1 = { target: "K1", opId: "t9" }; }),
  W("I6b-acc-take-retry-after-503", "I6b_noPingPong", "accept", "Astra#2", (() => {
    const w = baseTwin(); w.homes.T.durable.takeAuth = { b1: { target: "K1", opId: "t1" } };
    w.ops.t1 = op({ opId: "t1", home: "T", kind: "rotate", keyId: "K1", idem: "it", delivered: [{ code: 503, error: "rotation_incomplete", keyId: "K7" }] }); return w; })(),
    call({ home: "T", kind: "rotate", keyId: "K1", opId: "t1", idem: "it", actor: "owner_take" })),
  W("I6b-acc-source-own-rotation", "I6b_noPingPong", "accept", "Fable F2", baseTwin(), call({ home: "S", kind: "rotate", keyId: "K1", opId: "r1", idem: "i1" })),
  // I6c (Astra #3, Fable R1): foreign bot_key_exists not recorded; auto mint while marked.
  W("I6c-rej-foreign-not-marked", "I6c_twinMarker", "reject", "Fable r3.2 H2", (() => { const w = baseS(); w.ops.m1 = op({ opId: "m1", home: "S", kind: "mint", idem: "im" }); return w; })(),
    { kind: "answer", opId: "m1", resp: { code: 409, error: "bot_key_exists", keyId: "K5" }, duplicate: false }),
  W("I6c-rej-auto-mint-taken-over", "I6c_twinMarker", "reject", "Astra#3", (() => { const w = baseS(); w.homes.S.durable.twinKeyLive.b1 = "K5"; return w; })(),
    call({ home: "S", kind: "mint", opId: "m2", idem: "im2" })),
  W("I6c-acc-marked", "I6c_twinMarker", "accept", "Fable r3.2 H2", (() => { const w = baseS(); w.ops.m1 = op({ opId: "m1", home: "S", kind: "mint", idem: "im" }); return w; })(),
    { kind: "answer", opId: "m1", resp: { code: 409, error: "bot_key_exists", keyId: "K5" }, duplicate: false },
    (n) => { n.homes.S.durable.twinKeyLive.b1 = "K5"; n.homes.S.repairVisible.b1 = true; }),
  // I6d (Astra #3, Fable F12, Q2)
  W("I6d-rej-not-disowned", "I6d_takeDisownsFirst", "reject", "Astra#3 Fable F12", (() => {
    const w = baseTwin(); const t = w.homes.T; t.durable.takeAuth = { b1: { target: "K1", opId: "t1" } };
    t.durable.intents.b1 = intent({ origin: "take", disowned: "K1", rotateIdem: "it" }); return w; })(),
    call({ home: "T", kind: "rotate", keyId: "K1", opId: "t1", idem: "it", actor: "owner_take" })),
  W("I6d-rej-take-deletes", "I6d_takeDisownsFirst", "reject", "Q2 ruling", (() => {
    const w = baseTwin(); w.homes.T.durable.intents.b1 = intent({ origin: "take", disowned: "K1" }); return w; })(),
    call({ home: "T", kind: "delete", keyId: "K1", opId: "d1", cause: { by: "retire" } })),
  W("I6d-acc-disowned", "I6d_takeDisownsFirst", "accept", "Fable r3.2 H2", (() => {
    const w = baseTwin(); const t = w.homes.T; t.durable.takeAuth = { b1: { target: "K1", opId: "t1" } };
    t.durable.intents.b1 = intent({ origin: "take", disowned: "K1", rotateIdem: "it" });
    delete t.durable.disk.bots.b1; t.durable.disk.gen = 2; t.memory.D = {}; t.memory.botKey = {}; t.memory.evidence = { gen: 2, bots: {} }; return w; })(),
    call({ home: "T", kind: "rotate", keyId: "K1", opId: "t1", idem: "it", actor: "owner_take" })),
  // I7 (Astra #8, Fable F4)
  W("I7-rej-new-idem-while-unknown", "I7_idempotency", "reject", "Astra#8", (() => {
    const w = baseS(); w.homes.S.durable.intents.b1 = intent({ rotateIdem: "i2", sends: 1 });
    w.ops.r1 = op({ opId: "r1", home: "S", kind: "rotate", keyId: "K1", idem: "i1" });
    w.requests = [{ reqId: 1, opId: "r1", appliedAtFlux: true, inbound: [{ code: 201, keyId: "K2" }] }]; return w; })(),
    call({ home: "S", kind: "rotate", keyId: "K1", opId: "r2", idem: "i2" })),
  W("I7-rej-cross-kind", "I7_idempotency", "reject", "Astra#8", (() => {
    const w = baseS(); w.homes.S.durable.intents.b1 = intent({ step: "recover", mintIdem: "im" });
    w.ops.r1 = op({ opId: "r1", home: "S", kind: "rotate", keyId: "K1", idem: "i1", delivered: [{ code: 503, error: "rotation_incomplete", keyId: "K2" }] }); return w; })(),
    call({ home: "S", kind: "mint", opId: "m1", idem: "im" })),
  W("I7-rej-delete-on-lost", "I7_idempotency", "reject", "B2", (() => {
    const w = baseS(); w.ops.m1 = op({ opId: "m1", home: "S", kind: "mint", idem: "im", delivered: [{ code: 500 }] }); return w; })(),
    call({ home: "S", kind: "delete", keyId: "K5", opId: "d5", cause: { by: "stray", opId: "m1" } })),
  W("I7-acc-same-idem-retry", "I7_idempotency", "accept", "B2", (() => {
    const w = baseS(); w.homes.S.durable.intents.b1 = intent({ rotateIdem: "i1", sends: 1 });
    w.ops.r1 = op({ opId: "r1", home: "S", kind: "rotate", keyId: "K1", idem: "i1", delivered: [{ code: "lost" }] }); return w; })(),
    call({ home: "S", kind: "rotate", keyId: "K1", opId: "r1", idem: "i1" })),
  // I7b (Fable F3, Astra #11, Q5)
  W("I7b-rej-no-margin", "I7b_deadlineConservative", "reject", "Q5", (() => {
    const w = baseS(); w.homes.S.durable.deadlines.K1 = T0 + H24; w.homes.S.durable.intents.b1 = intent({ rotateIdem: "i1", deadlineAt: T0 + H24 }); return w; })(),
    call({ home: "S", kind: "rotate", keyId: "K1", opId: "r1", idem: "i1" })),
  W("I7b-rej-cleared-then-later", "I7b_deadlineConservative", "reject", "Astra#11", (() => { const w = baseS(); w.homes.S.durable.deadlines.K1 = T0 + 3600_000; return w; })(),
    { kind: "commit", home: "S", what: "clearCursor" }, (n) => { delete n.homes.S.durable.deadlines.K1; }),
  W("I7b-acc-take-unknown-flux-deadline", "I7b_deadlineConservative", "accept", "Fable F3", (() => {
    const w = baseTwin(); w.flux.keys.K1.deadlineAt = T0 + 3600_000; // set earlier by S; T cannot know it
    w.homes.T.durable.deadlines.K1 = T0 + H24 - MARGIN; w.homes.T.durable.intents.b1 = intent({ origin: "take", rotateIdem: "it", deadlineAt: T0 + H24 - MARGIN }); return w; })(),
    call({ home: "T", kind: "rotate", keyId: "K1", opId: "t1", idem: "it", actor: "owner_take" })),
  // I7c (B2)
  W("I7c-rej-retry-400", "I7c_badRequestHeld", "reject", "B2 Astra#12", (() => {
    const w = baseS(); w.ops.r1 = op({ opId: "r1", home: "S", kind: "rotate", keyId: "K1", idem: "i1", outcome: "known", delivered: [{ code: 400, error: "invalid_request" }] }); return w; })(),
    call({ home: "S", kind: "rotate", keyId: "K1", opId: "r1", idem: "i1" })),
  W("I7c-acc-held", "I7c_badRequestHeld", "accept", "B2", (() => { const w = baseS(); w.ops.r1 = op({ opId: "r1", home: "S", kind: "rotate", keyId: "K1", idem: "i1" }); return w; })(),
    { kind: "answer", opId: "r1", resp: { code: 400, error: "invalid_request" }, duplicate: false },
    (n) => { n.homes.S.durable.intents.b1 = intent({ step: "held", heldCode: "invalid_request" }); n.alerts.push({ home: "S", bot: "b1", code: "invalid_request" }); }),
  // I8
  W("I8-rej-prune-active", "I8_pruneOnlySafeRetired", "reject", "Astra r3.1 H2", (() => { const w = baseS(); w.homes.S.durable.disk.retired = ["K1"]; return w; })(),
    call({ home: "S", kind: "delete", keyId: "K1", opId: "p1", cause: { by: "prune" } })),
  W("I8-acc-prune-retired", "I8_pruneOnlySafeRetired", "accept", "Astra r3.1 H2", (() => { const w = baseS(); w.homes.S.durable.disk.retired = ["K0"]; return w; })(),
    call({ home: "S", kind: "delete", keyId: "K0", opId: "p1", cause: { by: "prune" } })),
  // I11 (ruling Q4, FluxMain usage): an unknown live key, unused per a lagging list.
  W("I11-rej-unknown-live", "I11_reconcileNeverPrunesUnknownLive", "reject", "Q4 ruling", (() => {
    const w = baseS(); w.ops.l1 = op({ opId: "l1", home: "S", kind: "list", outcome: "known",
      delivered: [{ code: 200, list: [{ keyId: "K5", status: "live", createdAt: T0 - 3 * H24, lastUsedAt: null, used: false }] }] }); return w; })(),
    call({ home: "S", kind: "delete", keyId: "K5", opId: "x1", actor: "reconcile", cause: { by: "reconcile", listOpId: "l1" } })),
  W("I11-acc-revoked", "I11_reconcileNeverPrunesUnknownLive", "accept", "Q4 ruling", (() => {
    const w = baseS(); w.ops.l1 = op({ opId: "l1", home: "S", kind: "list", outcome: "known",
      delivered: [{ code: 200, list: [{ keyId: "K5", status: "revoked", createdAt: T0 - 3 * H24, lastUsedAt: null, used: false }] }] }); return w; })(),
    call({ home: "S", kind: "delete", keyId: "K5", opId: "x1", actor: "reconcile", cause: { by: "reconcile", listOpId: "l1" } })),
  // I12 (Astra #9, Fable F9): Remove clears the intent with a mint unknown inside its hold.
  W("I12-rej-remove-over-unknown", "I12_noCloseOverUnknown", "reject", "Astra#9 Fable F9", (() => {
    const w = baseS(); w.homes.S.durable.intents.b1 = intent({ step: "recover", mintIdem: "im" });
    w.ops.m1 = op({ opId: "m1", home: "S", kind: "mint", idem: "im" }); return w; })(),
    { kind: "owner", home: "S", bot: "b1", press: "remove" }, (n) => { delete n.homes.S.durable.intents.b1; n.homes.S.durable.bindings.b1.state = "removed"; }),
  W("I12-acc-remove-keeps-drain", "I12_noCloseOverUnknown", "accept", "Astra#9", (() => {
    const w = baseS(); w.homes.S.durable.intents.b1 = intent({ step: "recover", mintIdem: "im" });
    w.ops.m1 = op({ opId: "m1", home: "S", kind: "mint", idem: "im" }); return w; })(),
    { kind: "owner", home: "S", bot: "b1", press: "remove" }, (n) => { n.homes.S.durable.intents.b1 = intent({ step: "drain", next: "close", mintIdem: "im" }); n.homes.S.durable.bindings.b1.state = "removing"; }),
];

/** Continuation / quiescence witnesses (I9, I9b, I10). `enabled` for these is fixed in the witness. */
export type LiveWitness =
  | { id: string; inv: "I9_liveness" | "I9b_reconnectRecovers"; expect: "reject" | "accept"; finding: string; continuation: World[]; bound: number; target: "quiescent" | "q1"; enabled: Enabled }
  | { id: string; inv: "I10_noLeakAtQuiescence"; expect: "fail" | "warn" | "ok"; finding: string; world: World };
const deadRepair = (): World => { const w = baseS(); w.flux.keys.K1.status = "revoked"; w.homes.S.durable.observedDead.b1 = "K1"; w.homes.S.repairVisible.b1 = true; return w; };
export const LIVE_WITNESSES: LiveWitness[] = [
  // Astra #1: repair shown, Reconnect pressed, nothing ever happens.
  { id: "I9b-rej-reconnect-noop", inv: "I9b_reconnectRecovers", expect: "reject", finding: "Astra#1 Fable F5", continuation: [deadRepair(), deadRepair(), deadRepair()], bound: 48, target: "q1", enabled: { auto: 0, ownerReconnectHelps: true } },
  { id: "I9b-acc-reconnect-heals", inv: "I9b_reconnectRecovers", expect: "accept", finding: "Astra#1", continuation: [deadRepair(), retiring(), baseS()], bound: 48, target: "q1", enabled: { auto: 0, ownerReconnectHelps: true } },
  // Astra #1: q3 with a deadline already in the past is not quiescent.
  { id: "I9-rej-past-wait", inv: "I9_liveness", expect: "reject", finding: "Astra#1", continuation: [(() => { const w = baseS(); w.homes.S.durable.intents.b1 = intent({ step: "drain", next: "close", deadlineAt: T0 + H24 - MARGIN }); return w; })()], bound: 48, target: "quiescent", enabled: { auto: 0, onlyClockUntil: T0 - 1, ownerReconnectHelps: false } },
  { id: "I9-acc-lv", inv: "I9_liveness", expect: "accept", finding: "Astra#1", continuation: [baseS()], bound: 48, target: "quiescent", enabled: { auto: 0, ownerReconnectHelps: false } },
  // Astra #9, Fable F9: removed binding, key received and never deleted.
  { id: "I10-fail-removed-leak", inv: "I10_noLeakAtQuiescence", expect: "fail", finding: "Astra#9 Fable F9", world: (() => {
    const w = baseS(); w.flux.keys.K5 = fkey("K5", "S"); w.homes.S.durable.bindings.b1.state = "removed"; delete w.homes.S.durable.disk.bots.b1;
    w.homes.S.durable.mintLog = [{ keyId: "K5", bot: "b1", opId: "m1", wasDurable: false }]; w.flux.keys.K1.status = "revoked"; return w; })() },
  { id: "I10-ok-lv", inv: "I10_noLeakAtQuiescence", expect: "ok", finding: "Astra#9", world: baseS() },
];
// Witness count: 53 step witnesses + 6 continuation/quiescence witnesses = 59. Every exported invariant has ≥ 1
// must-reject and ≥ 1 must-accept (I10: fail and ok). Highs → witness: Astra #1 I9b-rej-reconnect-noop, I9-rej-past-wait;
// #2 I6b-acc-take-retry-after-503; #3 I6b-rej-auth-other-bot, I6c-rej-auto-mint-taken-over, I6d-rej-not-disowned;
// #4 I1-acc-victim-unobserved, I1d-rej-401-memory-only; #5 I3b-rej-stale-save-rollback, I3-rej-unproven-save-drops;
// #6 I2b-rej-adopt-tombstoned, I2b-rej-no-reservation, I2b-rej-send-in-flight; #7 I5-rej-dead-successor;
// #8 I7-rej-new-idem-while-unknown, I7-rej-cross-kind, I7-rej-delete-on-lost; #9 I12-rej-remove-over-unknown,
// I10-fail-removed-leak; #10 I3b-rej-stale-save-rollback (queued job survives the child crash).
// Fable F1 = Astra #4; F2 I6b-acc-source-own-rotation, I6-acc-source-rotates-own; F3 I7b-acc-take-unknown-flux-deadline.
// Fable r3.2 H1 I6-rej-twin-deletes-source-key; H2 I6b-rej-victim-auto-kills-takers-key, I6b-rej-auth-without-press.

// ---------------------------------------------------------------------------
// RULINGS 2026-11-10 20:27Z (MurageMain for Sean, BINDING; the author encodes these after the invariant review)
// Q1 ACCEPT. Q2 YES (take = rotate of the twin's key, not DELETE). Q3 YES, now: a 401 or 404 on the
// live key makes repair visible; owner deletes at Flux are in the fault model from day one.
// Q5 YES: the stored deadline carries a required 10-minute margin before Flux's.
// Q4 YES, with checker warning + periodic reconcile, under a HARD rule, as new invariant
// I11_reconcileNeverPrunesUnknownLive. An unknown LIVE key for this bot may be a twin home's key.
// Reconcile never prunes it; it enters twin_key_live (owner-visible, "Use email on this home").
// Reconcile may prune ONLY keys that are expired or revoked, OR all three of: Flux shows them
// unused since mint, they are older than the 24 h replay window, and this home's DURABLE mint
// log names them as its own. Checker seed: two homes, each with an unknown live key in the other's view.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// RULINGS 2026-11-10 20:48Z (MurageMain for Sean, BINDING): Q-A, Q-B, Q-C
// Q-A ACCEPT: I6c (twin_key_live instead of a DELETE of an unknown successor).
// Q-B ACCEPT WITH AMENDMENT. I10 is NOT all warn-only. Flux holds a 24 h idempotent replay of a 201,
//   so after an unknown create outcome the reducer re-POSTs with the SAME Idempotency-Key within 24 h,
//   recovers the key, then adopts or revokes it. I10 is ENFORCED for that path now, with witnesses:
//     must-reject: an unknown create outcome left unrecovered past the replay window;
//     must-accept: the replay recovers the key, which is then adopted or revoked.
//   Only a LOST replay window (for example a 24 h+ outage) stays warn-only until FluxMain measures
//   the usage-sync lag. The I10/I11 usage clause is a GATE ITEM before the RC, not "later".
// Q-C ACCEPT as an honest limit (the old key lives to Flux's deadline; the twin sees repair at its
//   first 401). It goes into the support notes in plain words.
// ---------------------------------------------------------------------------
