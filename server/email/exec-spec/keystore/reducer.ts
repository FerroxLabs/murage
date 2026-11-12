// KEYSTORE REDUCER. `reduce(home, event) -> { actions, state }` is the pure function production will call and the checker
// explores. No I/O, no clock reads, no randomness: time arrives in `ev.now`, fresh ids come from durable counters.
//
// Shape of the machine (one intent per bot; every Flux-authorising field is committed in the SAME reduce result that emits the
// call, the harness runs the call after that commit):
//   rotate-origin:   rotate -> (201 adopt) save -> (acked) retire_old -> DELETE old -> close
//   reconnect:       owner Reconnect from repair -> recover (mint) -> (201 adopt) -> save -> acked -> retire dead old -> close
//   take:            owner take -> disown (save without the slot, acked) -> rotate the twin's key as owner_take -> adopt -> save -> close
//   remove:          binding removed at once, drain intent: replay unknown ops, drop the slot, DELETE every key issued for this home
// Memory extensions (cleared by every crash/boot, like any child memory): `busy` = the one effect awaiting an answer per bot.
// Durable extensions: `idemN` (idempotency counters), `IntentX.unk` (an unknown rotate/mint operation: first/last send).
//
// STUB-HIGH-n markers: behaviour governed by the five predicates under revision. It is the most conservative behaviour.
import { br, declareBranches } from "./coverage.ts";
import { DAY, MARGIN } from "./domain.ts";
import { EVENT_TYPES } from "./types.ts";
import type { BotId, Home, HomeAction, HomeEvent, Intent, KeyId, Time, Response } from "./types.ts";

export const PLACEHOLDER_BRANCHES = EVENT_TYPES.map((t) => `placeholder.${t}`);
export interface ReduceResult { actions: HomeAction[]; state: Home }

type IntentX = Intent & { unk?: { kind: "rotate" | "mint"; first: Time; last: Time }; takeDead?: boolean; takeLost?: boolean; from409?: KeyId[] };
type DurX = Home["durable"] & { idemN?: Record<BotId, number> };
type MemX = Home["memory"] & { busy?: Record<string, string>; reconAt?: Record<BotId, Time> };
/** r3.1: worst-case outbox + reconciler lag for model-key usage (MurageMain final rule); email:bot is never usage-pruned. */
const SYNC_LAG = 15 * 60_000;
const NEVER_USAGE_PRUNE_KINDS: readonly string[] = ["email:bot"];
/** reconcile (list) cadence per bot, memory only: a boot lists again */
const RECON_EVERY = 6 * 3_600_000;
const H24 = DAY;

const dur = (h: Home) => h.durable as DurX;
const mem = (h: Home) => h.memory as MemX;
const defined = <T>(x: T | undefined | null): x is T => x !== undefined && x !== null;
const intentOf = (h: Home, b: BotId) => h.durable.intents[b] as IntentX | undefined;
const durableKey = (h: Home, b: BotId): KeyId | undefined => h.durable.disk.bots[b];
const liveBinding = (h: Home, b: BotId) => { const s = h.durable.bindings[b]?.state; return s === "active" || s === "restored_unverified"; };
const busyOf = (h: Home, k: string) => mem(h).busy?.[k];
const setBusy = (h: Home, k: string, v: string) => { const m = mem(h); (m.busy ??= {})[k] = v; };
const clrBusy = (h: Home, k: string) => { const m = mem(h); if (m.busy) delete m.busy[k]; };
const supIdle = (h: Home) => h.supervisor.queue.length === 0 && h.supervisor.builtAcks.length === 0;
const saveTag = (h: Home) => `save@${h.durable.disk.gen}`;
const staleSave = (h: Home, tag: string | undefined) => tag?.startsWith("save@") === true && supIdle(h) && h.durable.disk.gen > Number(tag.slice(5));

/** Spec V(bot): the owner-visible repair is a FUNCTION of durable state and the clock (same rule the invariants check). */
export function repairOf(h: Home, b: BotId, now: Time): boolean {
  if (!liveBinding(h, b)) return false;
  const d = h.durable, i = d.intents[b], k = durableKey(h, b);
  if (d.bindings[b].state === "restored_unverified") return true;
  if (!defined(k)) return true;
  if (d.observedDead[b] === k) return true;
  if (defined(d.twinKeyLive[b])) return true;
  if (!i) return false;
  if (i.step === "recover" || i.step === "expired" || i.step === "repair") return true;
  if (i.step === "held" && defined(i.deadlineAt) && now >= i.deadlineAt) return true;
  if (i.origin !== "rotate" && k !== i.newKeyId) return true;
  return defined(i.deadlineAt) && now >= i.deadlineAt && k !== i.newKeyId;
}

/** r3.2b/c: this home's open take is STALLED (mirror of the spec's takeStalled, from what the home itself observed): the target answered
 *  dead (401/404/409 revoked, or a list row naming it dead), or the take operation is unknown at/after the first send (intent.at) + 24 h. Narrower is fine. */
function takeStalledR(h: Home, b: BotId, i: IntentX | undefined, now: Time): boolean {
  if (!i || i.origin !== "take" || !defined(i.disowned)) return false;
  if (h.durable.observedDead[b] === i.disowned || i.takeDead) return true;
  if (i.takeLost) return true;
  if (!i.unk) return false;
  if (!defined(i.at)) throw new Error("intent.at missing"); // r3.2h Opus check: the hold ends at first send + 24 h, not at the last attempt
  return now >= i.at + H24;
}

let justStamped = new Set<string>();
const freshIdem = (h: Home, b: BotId, tag: string): string => {
  const d = dur(h); const n = ((d.idemN ??= {})[b] ?? 0) + 1; d.idemN[b] = n;
  return `${h.id}:${b}:${tag}${n}`;
};
const alertOnce = (acts: HomeAction[], bot: BotId, code: string) => { if (!acts.some((a) => a.a === "alert" && a.bot === bot && a.code === code)) acts.push({ a: "alert", bot, code }); };

/** Every id this home is protecting right now (A, P, Q of the invariants): never DELETE these. */
function isProtected(h: Home, k: KeyId): boolean {
  const d = h.durable, m = h.memory;
  for (const b of Object.keys(d.bindings)) {
    if (m.D[b] === k || m.botKey[b] === k || m.candidateToken[b] === k || d.disk.bots[b] === k) return true;
    const i = d.intents[b];
    if (i && (i.newKeyId === k || i.oldKeyId === k)) return true;
  }
  if (h.supervisor.queue.some((j) => Object.values(j.image.bots).includes(k) || j.image.owner === k)) return true;
  if (d.disk.owner === k || m.evidence?.owner === k) return true;
  const ev = m.evidence ?? d.proof;
  return !!ev && Object.keys(ev.bots).some((b) => ev.bots[b] === k);
}
const tombstoned = (h: Home, k: KeyId) => h.durable.tombstones.includes(k);
/** Every id this home knows as its own or as handled (knowledge: disk, retired, prev, owner, tombstones, mint log, intents). */
function ownKnown(h: Home): Set<KeyId> {
  const d = h.durable;
  const s = new Set<KeyId>([...Object.values(d.disk.bots), ...d.disk.retired, ...d.disk.prev, ...d.tombstones, ...d.mintLog.map((m) => m.keyId)]);
  if (defined(d.disk.owner)) s.add(d.disk.owner);
  for (const i of Object.values(d.intents)) for (const k of [i.oldKeyId, i.newKeyId, ...i.strays]) if (defined(k)) s.add(k);
  return s;
}
/** This home has a rotate/mint of `b` whose outcome is unknown and whose replay hold (intent.at + 24 h) may still be open. */
export const replayOpenR = (h: Home, b: BotId, now: Time): boolean => {
  const i = intentOf(h, b), u = i?.unk;
  if (!u) return false;
  if (!defined(i!.at)) throw new Error("intent.at missing"); // r3.2h (F3): the hold is judged on the FIRST send (intent.at), like holdEnd, I7, I12, isQuiescent
  return now < i!.at + H24 || busyOf(h, b) === "call"; // busy "call" is cleared by `expired` (G1), so it cannot pin the replay open forever
};
const allStrayIds = (h: Home): Set<KeyId> => new Set(Object.values(h.durable.intents).flatMap((i) => i.strays));
const logMint = (h: Home, b: BotId, keyId: KeyId, opId: string, at: Time) => {
  const d = h.durable;
  if (!d.mintLog.some((m) => m.keyId === keyId)) d.mintLog.push({ keyId, bot: b, opId, wasDurable: d.disk.bots[b] === keyId, at });
};

// ─────────────────────────── emission helpers ───────────────────────────
function emitSave(h: Home, b: BotId, bots: Record<BotId, KeyId>, acts: HomeAction[], key = b, prevAdd?: KeyId) {
  const d = h.durable.disk;
  setBusy(h, key, saveTag(h));
  acts.push({ a: "save", bots, owner: d.owner, retired: [...d.retired], prev: defined(prevAdd) && !d.prev.includes(prevAdd) ? [...d.prev, prevAdd] : [...d.prev] });
}
function emitCall(h: Home, b: BotId, i: IntentX | undefined, call: Omit<Extract<HomeAction, { a: "call" }>, "a" | "bot">, acts: HomeAction[]) {
  setBusy(h, b, "call");
  acts.push({ a: "call", bot: b, ...call, ...(i && defined(i.at) && (call.kind === "rotate" || call.kind === "mint") ? { at: i.at } : {}) }); // r3.2h (H4): the durable decision time rides on every rotate/mint call
}
/** Deadline mirror: a stored deadline is never moved later; the intent mirrors it (I7b). */
function ensureDeadline(h: Home, i: IntentX, now: Time) {
  const old = i.oldKeyId, d = h.durable;
  if (!defined(old) || i.origin === "reconnect" || i.origin === "recover") return;
  const cap = now + H24 - MARGIN;
  const ex = d.deadlines[old];
  d.deadlines[old] = defined(ex) ? ex : Math.min(i.deadlineAt ?? cap, cap);
  i.deadlineAt = d.deadlines[old];
}
const deadlinePassed = (i: IntentX, now: Time) => defined(i.deadlineAt) && now >= i.deadlineAt;

// ─────────────────────────── normalisation ───────────────────────────
function normalise(h: Home, now: Time) {
  const d = h.durable;
  for (const b of Object.keys(d.intents)) {
    const i = intentOf(h, b)!;
    if (i.origin === "rotate" || i.origin === "take") ensureDeadline(h, i, now);
    else if (defined(i.oldKeyId) && defined(d.deadlines[i.oldKeyId])) i.deadlineAt = d.deadlines[i.oldKeyId]; // I7b mirror, never cleared
    // a seed/legacy shape: save or retire_old without a validated successor restarts at rotate
    if ((i.step === "save" || i.step === "retire_old") && (!defined(i.newKeyId) || i.validated !== i.newKeyId)) {
      br("norm.stepWithoutSuccessor"); i.step = "rotate"; if (i.newKeyId !== undefined && i.validated !== i.newKeyId) delete i.newKeyId;
    }
    // the deadline passes while a save is still in flight: keep repair stable through the (reducer-less) sync step
    if (i.step === "save" && deadlinePassed(i, now) && durableKey(h, b) !== i.newKeyId) { br("norm.saveExpired"); i.step = "expired"; }
  }
}
function refresh(h: Home, now: Time) {
  // I7b: while a deadline is stored for the intent's old key, the intent mirrors it (a replaced intent included)
  for (const b of Object.keys(h.durable.intents)) { const i = intentOf(h, b)!; if (defined(i.oldKeyId) && defined(h.durable.deadlines[i.oldKeyId])) i.deadlineAt = h.durable.deadlines[i.oldKeyId]; }
  for (const b of Object.keys(h.durable.bindings)) h.repairVisible[b] = repairOf(h, b, now);
}

// ─────────────────────────── the main reduce ───────────────────────────
function reduceImpl(home: Home, ev: HomeEvent): ReduceResult {
  const h = structuredClone(home) as Home;
  const acts: HomeAction[] = [];
  const now = ev.now;
  justStamped = new Set();
  // r3.2h (M1): the Reconnect capability is bound to the take's IDENTITY (origin, oldKeyId, disowned, openedAt) and takeAuth[b]; PROGRESSION (step, sends,
  // newKeyId, unk, ...) keeps it. Any identity or takeAuth change clears it (rc.stampCleared).
  const snap = (bb: BotId) => { const t = h.durable.intents[bb]; return JSON.stringify([t && { origin: t.origin, oldKeyId: t.oldKeyId, disowned: t.disowned, openedAt: t.openedAt }, h.durable.takeAuth[bb]]); };
  const pre: Record<string, string> = {}; for (const bb of Object.keys(h.durable.intents)) pre[bb] = snap(bb);
  br(`reduce.${ev.t}`);
  switch (ev.t) {
    case "boot": onBoot(h, ev, now, acts); break;
    case "drive": normalise(h, now); advance(h, ev.bot, now, acts); break;
    case "response": normalise(h, now); onResponse(h, ev, now, acts); break;
    case "lost": normalise(h, now); onLost(h, ev, now, acts); break;
    case "ack": normalise(h, now); onAck(h, ev, now, acts); break;
    case "clock": normalise(h, now); for (const b of Object.keys(h.durable.bindings)) advance(h, b, now, acts); break;
    case "owner": normalise(h, now); onOwner(h, ev.bot, ev.press, now, acts); break;
    case "fence": br(ev.on ? "fence.on" : "fence.off"); if (ev.on) dropQueued(h, (a) => a.a === "call" && a.kind !== "list"); /* I3: no Flux write while fenced; the unk marks replay it on release */ if (!ev.on) { normalise(h, now); for (const b of Object.keys(h.durable.bindings)) advance(h, b, now, acts); } break;
    case "rejected": normalise(h, now); onRejected(h, ev.bot, now, acts); break;
    case "use": onUse(h, ev, now); break;
    case "expired": normalise(h, now); onExpired(h, ev, now, acts); break;
    default: { const _never: never = ev; throw new Error(`unknown event ${JSON.stringify(_never)}`); }
  }
  for (const bb of Object.keys(h.durable.intents)) { // r3.2d: ANY change to the take intent or takeAuth[b] clears the owner-press capability
    if (defined(h.durable.intents[bb].ownerReconnect) && !justStamped.has(bb) && pre[bb] !== snap(bb)) { br("rc.stampCleared"); delete h.durable.intents[bb].ownerReconnect; }
  }
  refresh(h, now);
  return { actions: acts, state: h };
}

/** The reducer with the production pure read of the repair flag attached (the harness applies it after every step). */
export const reduce: ((home: Home, ev: HomeEvent) => ReduceResult) & { keyRepair: (h: Home, bot: BotId, now: Time) => boolean } =
  Object.assign(reduceImpl, { keyRepair: (h: Home, bot: BotId, now: Time) => repairOf(h, bot, now) });

/** Placeholder: identity (kept for the harness tests). */
export function placeholderReduce(home: Home, ev: HomeEvent): ReduceResult {
  br(`placeholder.${ev.t}`);
  return { actions: [], state: home };
}

// ─────────────────────────── events ───────────────────────────
function onBoot(h: Home, ev: Extract<HomeEvent, { t: "boot" }>, now: Time, acts: HomeAction[]) {
  const m = h.memory;
  m.running = true; delete (m as MemX).busy;
  if (ev.proofValid && ev.proof) {
    br("boot.proven");
    m.evidence = ev.proof; m.D = { ...ev.proof.bots }; m.botKey = { ...ev.proof.bots };
  } else { br("boot.unproven"); m.evidence = null; }
  normalise(h, now);
  for (const b of Object.keys(h.durable.bindings)) advance(h, b, now, acts);
}

/** A bot send with the mounted key: lastLocalUse is committed in THIS step (I11), never moving backward. */
function onUse(h: Home, ev: Extract<HomeEvent, { t: "use" }>, now: Time) {
  br("use.record");
  if (!defined(ev.keyId)) return;
  const d = h.durable, ex = d.lastLocalUse[ev.keyId];
  d.lastLocalUse[ev.keyId] = defined(ex) ? Math.max(ex, now) : now;
}

function onAck(h: Home, ev: Extract<HomeEvent, { t: "ack" }>, now: Time, acts: HomeAction[]) {
  const m = h.memory, e = ev.ev;
  if (m.evidence && e.gen < m.evidence.gen) { br("ack.stale"); return; } // evidence never moves backward (I5b)
  br("ack.apply");
  m.evidence = e; h.durable.proof = e; m.D = { ...e.bots };
  for (const b of Object.keys(h.durable.bindings)) {
    if (m.botKey[b] !== e.bots[b]) { m.rejected[b] = false; m.botKey[b] = e.bots[b]; }
  }
  const bz = (m as MemX).busy; if (bz) for (const k of Object.keys(bz)) if (bz[k].startsWith("save")) delete bz[k];
  for (const b of Object.keys(h.durable.bindings)) advance(h, b, now, acts);
}

function onRejected(h: Home, b: BotId, now: Time, acts: HomeAction[]) {
  const m = h.memory, d = h.durable;
  if (!d.bindings[b]) return;
  m.rejected[b] = true;
  const key = m.botKey[b] ?? durableKey(h, b);
  // STUB-HIGH-1: this home acts only on ITS OWN observed 401/404; the marker is committed in the same step.
  if (defined(key) && key === durableKey(h, b)) {
    br("rejected.markDead");
    d.observedDead[b] = key;
    const i = intentOf(h, b);
    if (i && i.step === "rotate" && !i.unk && !defined(i.newKeyId) && i.oldKeyId === key) { br("rejected.toRepair"); i.step = "repair"; }
  } else br("rejected.other");
  advance(h, b, now, acts);
}

function onLost(h: Home, ev: Extract<HomeEvent, { t: "lost" }>, now: Time, acts: HomeAction[]) {
  br("lost.retry");
  clrBusy(h, ev.bot);
  { const i = intentOf(h, ev.bot); if (i?.unk && defined(ev.idem) && (ev.idem === i.rotateIdem || ev.idem === i.mintIdem)) i.unk.last = Math.max(i.unk.last, now); } // the send left no earlier than unk.last: a queued retry executes later than it was committed
  advance(h, ev.bot, now, acts);
}

/** r3.2h (G1): the scheduler dropped this rotate call from the outbox because its rotation expired there (now >= intent.at + 24 h, successor unsaved):
 *  the product does clearCursor + rotation_expired (binding-service.ts:521). The intent closes, nothing is sent, and the "call busy" memory is cleared. */
function onExpired(h: Home, ev: Extract<HomeEvent, { t: "expired" }>, now: Time, acts: HomeAction[]) {
  const b = ev.bot, d = h.durable, i = intentOf(h, b);
  if (i && defined(ev.idem) && ev.kind === "mint" && ev.idem === i.mintIdem) {
    // the setup re-op (binding-service.ts:165) applied to a mint op: past 24 h the old op cannot be replayed, so a NEW op with at = now is started
    br("rot.expiredMint");
    clrBusy(h, b);
    dropQueued(h, (a) => a.a === "call" && a.bot === b && (a.kind === "rotate" || a.kind === "mint"));
    delete i.unk;
    i.mintIdem = freshIdem(h, b, "m"); i.at = now;
    advance(h, b, now, acts);
    return;
  }
  const mine = !!i && defined(ev.idem) && ev.kind === "rotate" && ev.idem === i.rotateIdem;
  if (!mine) { br("rot.expiredStale"); return; }
  const stored = durableKey(h, b);
  if (defined(stored) && stored !== i!.oldKeyId) { br("rot.expiredStale"); return; } // the successor is saved: not an expiry (binding-service.ts:519)
  clrBusy(h, b);
  dropQueued(h, (a) => a.a === "call" && a.bot === b && (a.kind === "rotate" || a.kind === "mint"));
  if (i!.origin === "take") {
    // a take closes only at an owner Reconnect (I6d): the expiry makes it STALLED, exactly like unk.windowLost
    br("rot.expiredTake"); alertOnce(acts, b, "replay_window_lost");
    i!.takeLost = true;
    if (i!.newKeyId !== undefined && i!.validated !== i!.newKeyId) delete i!.newKeyId;
    delete i!.unk; delete i!.rotateIdem;
    return;
  }
  {
    // the key's deadline has passed (it always has at intent.at + 24 h): the owner-visible repair must persist (I1b), so the intent stays as the
    // `expired` repair step with no op left to replay (no idem, no unk, no busy): nothing is re-emitted. r3.2h: found by the d6 run (I1b).
    br("rot.expiredRepair");
    i!.step = "expired"; delete i!.unk; delete i!.rotateIdem;
    if (i!.newKeyId !== undefined && i!.validated !== i!.newKeyId) delete i!.newKeyId;
    return;
  }
  // dead branch (r3.2h Opus check): the old `rot.expired` delete of the intent can never run. Both d6 logs list it as never taken: the deadline
  // always passes by intent.at + 24 h, so the repair step above is the only exit. Removed.
  void acts; void d;
}

function onResponse(h: Home, ev: Extract<HomeEvent, { t: "response" }>, now: Time, acts: HomeAction[]) {
  const b = ev.bot, d = h.durable;
  if (!ev.duplicate) clrBusy(h, b);
  if (ev.kind === "list") { br("resp.list"); onListAnswer(h, ev, ev.resp, now, acts); if (d.bindings[b]) advance(h, b, now, acts); return; }
  const r = ev.resp;
  // I7b: a delivered 201 with old_key_expires_at caps the stored deadline of the predecessor (any 201 of a rotate, adopted or not)
  if (ev.kind === "rotate" && r.code === 201 && defined(r.oldKeyExpiresAt) && defined(ev.keyId) && d.bindings[b]) {
    br("resp.deadlineFrom201");
    const cap = r.oldKeyExpiresAt - MARGIN, ex = d.deadlines[ev.keyId];
    d.deadlines[ev.keyId] = defined(ex) ? Math.min(ex, cap) : cap;
    for (const x of Object.keys(d.intents)) { const it = d.intents[x]; if (it.oldKeyId === ev.keyId) it.deadlineAt = d.deadlines[ev.keyId]; }
  }
  if (!d.bindings[b]) return;
  if (ev.kind === "delete") onDeleteAnswer(h, ev, r, now);
  else onCreateAnswer(h, ev, r, now, acts);
  advance(h, b, now, acts);
}

/** Reconcile (I11, I6c). A listed live key this home does not know commits twin_key_live (except during this home's own open replay);
 *  a usage prune needs every clause: kind known and not email:bot, used=false, no local use in SYNC_LAG, older than 24 h, named in the
 *  mint log and never durable here. Never an unknown or twin key; one DELETE per answer, tombstone first. */
function onListAnswer(h: Home, ev: Extract<HomeEvent, { t: "response" }>, r: Response, now: Time, acts: HomeAction[]) {
  if (r.code !== 200 || !r.list) { br("list.none"); return; }
  const d = h.durable, known = ownKnown(h);
  for (const bb of Object.keys(d.intents)) { const ti = d.intents[bb] as IntentX; if (ti.origin === "take" && defined(ti.disowned) && r.list.some((row) => row.keyId === ti.disowned && (row.status === "revoked" || row.status === "expired_by_deadline")) && !ti.takeDead) { br("list.takeDead"); ti.takeDead = true; } }
  for (const row of r.list) { // r3.2: a list naming this home's own durable key dead is evidence about THAT key
    for (const bb of Object.keys(d.bindings)) if (liveBinding(h, bb) && d.disk.bots[bb] === row.keyId && (row.status === "revoked" || row.status === "expired_by_deadline") && d.observedDead[bb] !== row.keyId) { br("list.ownDead"); d.observedDead[bb] = row.keyId; }
  }
  for (const row of r.list) {
    const rb = row.bot ?? ev.bot;
    if (!(row.status === "live" || row.status === "successor_pending") || known.has(row.keyId) || !d.bindings[rb] || !liveBinding(h, rb)) continue;
    if (replayOpenR(h, rb, now)) { br("list.unknownDuringReplay"); continue; }
    if (!defined(d.twinKeyLive[rb])) {
      br("list.twin"); d.twinKeyLive[rb] = row.keyId;
      // r3.2l (Fable M1): same as c409.twin: the marker also drops the automatic calls already queued for THIS bot (a two-bot home: a list answer for A can mark B).
      dropQueued(h, (a) => a.a === "call" && a.bot === rb && a.kind !== "list" && (a.actor === "auto" || a.actor === "reconcile"));
    }
  }
  if (d.fenced || h.memory.evidence === null) return;
  const strays = allStrayIds(h);
  for (const row of r.list) {
    const k = row.keyId, rb = row.bot ?? ev.bot;
    if (row.status !== "live" || !d.bindings[rb] || defined(d.twinKeyLive[rb])) continue;
    if (!defined(row.kind) || NEVER_USAGE_PRUNE_KINDS.includes(row.kind)) { br("prune.skipKind"); continue; } // email:bot (and no kind): never
    if (row.used !== false || row.lastUsedAt !== null) { br("prune.skipUsed"); continue; }
    const local = d.lastLocalUse[k];
    if (defined(local) && local > now - SYNC_LAG) { br("prune.skipLocalUse"); continue; }
    if (!(now > row.createdAt + H24)) { br("prune.skipYoung"); continue; }
    const entry = d.mintLog.find((m) => m.keyId === k && m.bot === rb);
    if (!entry || entry.wasDurable) { br("prune.skipNotMinted"); continue; }
    if (isProtected(h, k) || strays.has(k) || d.disk.prev.includes(k) || Object.values(d.twinKeyLive).includes(k) || h.memory.candidateToken[rb] === k) { br("prune.skipProtected"); continue; }
    if (busyOf(h, rb)) return;
    br("prune.delete");
    if (!tombstoned(h, k)) d.tombstones.push(k);
    setBusy(h, rb, "call");
    acts.push({ a: "call", bot: rb, kind: "delete", keyId: k, actor: "reconcile", cause: { by: "reconcile", listOpId: ev.opId } });
    return;
  }
}

function onDeleteAnswer(h: Home, ev: Extract<HomeEvent, { t: "response" }>, r: Response, _now: Time) {
  const b = ev.bot, i = intentOf(h, b);
  const done = r.code === 204 || (r.code === 404 && r.error === "key_not_found");
  if (!done) { br("del.notDone"); return; }
  br("del.done");
  if (!i || !defined(ev.keyId)) return;
  i.strays = i.strays.filter((k) => k !== ev.keyId);
  if (i.step === "retire_old" && i.oldKeyId === ev.keyId) { br("del.retired"); closeOrDrain(h, b, i); }
}

function closeOrDrain(h: Home, b: BotId, i: IntentX) {
  if (i.strays.length > 0 || i.unk) { br("close.drain"); i.step = "drain"; i.next = "close"; return; }
  br("close.intent"); delete h.durable.intents[b];
}

function onCreateAnswer(h: Home, ev: Extract<HomeEvent, { t: "response" }>, r: Response, now: Time, acts: HomeAction[]) {
  const b = ev.bot, d = h.durable, i = intentOf(h, b);
  const mine = !!i && ((ev.kind === "rotate" && defined(ev.idem) && ev.idem === i.rotateIdem) || (ev.kind === "mint" && defined(ev.idem) && ev.idem === i.mintIdem));
  const definitive = r.code !== 500 && r.code !== 503 && r.code !== "lost";
  if (mine && definitive) delete i!.unk;
  else if (mine && i!.unk) i!.unk.last = Math.max(i!.unk.last, now);
  const bd = d.bindings[b];
  const adoptable = mine && !!i && liveBinding(h, b) && i.step !== "drain" && i.step !== "held" && !(defined(i.newKeyId) && i.validated === i.newKeyId);
  if (i && i.origin === "take" && ev.kind === "rotate" && defined(i.disowned) && ev.keyId === i.disowned && !i.takeDead &&
      (r.code === 401 || (r.code === 404 && r.error === "key_not_found") || (r.code === 409 && r.error === "key_revoked"))) { br("take.targetDead"); i.takeDead = true; }
  switch (r.code) {
    case 201: {
      const K = r.keyId;
      logMint(h, b, K, ev.opId, now);
      if (tombstoned(h, K)) { br("c201.tombstoned"); return; }
      if (adoptable && i) { br("c201.adopt"); adopt(h, b, i, K, now, acts); return; }
      if ((i && i.newKeyId === K) || durableKey(h, b) === K) { br("c201.dup"); return; }
      br("c201.stray"); addStray(h, b, K, bd.state === "removed"); return;
    }
    case 503: {
      // STUB-HIGH-2: a 503 rotation_incomplete for THIS home's own rotation is not foreign. Retry with the SAME key and the
      // same Idempotency-Key until the 201; the successor id is recorded (unvalidated) so it is known, never marked twin.
      br("c503.own");
      logMint(h, b, r.keyId, ev.opId, now); // r3.2: a 503's successor is this home's own key: ownKnown, never foreign
      if (mine && i && !defined(i.newKeyId)) i.newKeyId = r.keyId;
      return;
    }
    case 409: {
      if (r.error === "idempotency_mismatch") { br("c409.mismatch"); if (mine && i) hold(h, b, i, "idempotency_mismatch", acts); return; }
      if (r.error === "key_revoked") { br("c409.revoked"); onDead(h, b, ev, i, acts); return; }
      const K = r.keyId;
      if (!defined(K)) { br("c409.nokey"); return; }
      // r3.2h item 4 (product: binding-service reconnect 409 rule). A reconnect mint that meets a live key: X === D(bot) is the key this bot holds
      // now, so alert rotation_live_conflict and HOLD, never revoke; X this home minted before (ownKnown, not D(bot)) is a stray: DELETEd by the
      // drain, then a fresh op mints once more. An X this home never knew stays the twin marker below (the model keeps its stricter twin rule).
      if (ev.kind === "mint" && r.error === "bot_key_exists" && mine && i && i.origin === "reconnect" && durableKey(h, b) === K && d.mintLog.some((m) => m.keyId === K)) { br("c409.mintHoldLive"); hold(h, b, i, "rotation_live_conflict", acts); return; }
      // r3.2k (Astra M3): a durable X with NO mint-log entry (a copied foreign credential) is not "own": it falls to the twin marker below, never a bare hold.
      // r3.2i (Opus full check, product binding-service 369-372): X this home minted and does not hold is a stray only 24 h after that mint; inside the
      // 24 h it HOLDS with the same alert (hold state step "held"). Never a DELETE inside the window.
      const ownMint = d.mintLog.find((m) => m.keyId === K);
      if (ev.kind === "mint" && r.error === "bot_key_exists" && mine && i && i.origin === "reconnect" && i.newKeyId !== K && !tombstoned(h, K) && ownMint) {
        // r3.2j (Opus L1): an own X that is still protected (memory ahead of disk, candidate, proof) also holds with the alert, like the product's held line.
        if (isProtected(h, K) || !(now >= ownMint.at + H24)) { br("c409.mintHoldLive"); hold(h, b, i, "rotation_live_conflict", acts); return; }
        br("c409.mintStray"); addStray(h, b, K, false); (i.from409 ??= []).includes(K) || i.from409.push(K); i.mintIdem = freshIdem(h, b, "m"); i.at = now; i.step = "recover"; return;
      }
      const known = (i && i.newKeyId === K) || (d.mintLog.some((m) => m.keyId === K) && !tombstoned(h, K));
      if (adoptable && i && known && !(r.error === "bot_key_exists" && durableKey(h, b) === K)) { br("c409.adoptKnown"); adopt(h, b, i, K, now, acts); return; }
      // a live key this home does not know: it may be a twin's. Marker committed now, no automatic mint/rotate/DELETE after it.
      // r3.2j (Astra 3): a reconnect mint's X with NO mint-log entry (never minted here, even if disk.prev/retired/intents know the id) is always the twin case below.
      const neverMinted = ev.kind === "mint" && r.error === "bot_key_exists" && mine && !!i && i.origin === "reconnect" && !ownMint && i.newKeyId !== K;
      if (!neverMinted && ownKnown(h).has(K)) {
        br("c409.ownKnown");
        // r3.2k (Astra M2, Opus L2, Fable): a reconnect mint's tombstoned (or otherwise known, not own-minted) X ALERTS AND HOLDS: the step is held, nothing is queued, no further mint and no DELETE;
        // the product holds with the owner line in the same case.
        if (ev.kind === "mint" && r.error === "bot_key_exists" && mine && i && i.origin === "reconnect") { br("c409.ownKnownHold"); hold(h, b, i, "rotation_live_conflict", acts); }
        return;
      }
      // r3.2m (Astra M2, Fable L2): a late foreign 409 for a REMOVED binding installs no marker. Remove deletes the marker (own.remove) and the removed binding's
      // drain DELETEs its own strays; a marker installed now would stall that drain (adv.twin) for ever, and only an owner press clears it, which a removed binding no longer has.
      if (!liveBinding(h, b)) { br("c409.removedNoTwin"); return; }
      br("c409.twin");
      d.twinKeyLive[b] = K;
      // r3.2k (I6c root cause): committing the marker also drops every automatic call already queued for this bot (a lost-answer re-send of the same mint), or it would still go out under the marker.
      dropQueued(h, (a) => a.a === "call" && a.bot === b && a.kind !== "list" && (a.actor === "auto" || a.actor === "reconcile"));
      if (ev.kind === "mint" && r.error === "bot_key_exists" && mine && i && i.origin === "reconnect") alertOnce(acts, b, "rotation_live_conflict"); // r3.2i: an X this home never minted: alert naming it, never a DELETE
      // r3.2n (Fable L1): a NON-current 409 (a late answer of an earlier op) that commits the marker while the current op is still unknown (unk) drops that op's queued re-send
      // and leaves unk pending, so nothing automatic runs until an owner press: it raises the same current-operation alert as the current-op branch above (the owner is told, never a silent stall).
      else if (i && !mine && i.unk) alertOnce(acts, b, "rotation_live_conflict");
      if (i && mine) { if (i.step === "rotate" || i.step === "recover") i.step = "repair"; }
      return;
    }
    case 404: {
      if (r.error === "key_not_found") { br("c404.dead"); onDead(h, b, ev, i, acts); return; }
      br("c404.other"); alertOnce(acts, b, "flux_off"); return;
    }
    case 400: {
      br("c400.held");
      if (i) hold(h, b, i, "invalid_request", acts);
      else { br("c400.newIntent"); const ni = { origin: "recover", step: "held", oldKeyId: null, sends: 0, strays: [] } as IntentX; d.intents[b] = ni; hold(h, b, ni, "invalid_request", acts); }
      return;
    }
    default: br("c.other"); return; // 500, lost: the retry runs from advance() (same Idempotency-Key)
  }
}

/** I7c: a 400 is held and alerted, never retried. */
function dropQueued(h: Home, pred: (a: HomeAction) => boolean) {
  const x = h as unknown as { outbox?: HomeAction[] };
  if (!x.outbox) return;
  for (const a of x.outbox) if (a.a === "call" && pred(a)) clrBusy(h, a.bot);
  x.outbox = x.outbox.filter((a) => !pred(a));
}
function hold(h: Home, b: BotId, i: IntentX, code: string, acts: HomeAction[]) {
  dropQueued(h, (a) => a.a === "call" && a.bot === b && (a.kind === "rotate" || a.kind === "mint")); // I7c: no queued retry survives a 400
  i.step = "held"; i.heldCode = code; alertOnce(acts, b, code);
}

/** The answer shows the key of a rotate is dead. Commit durable repair only for ITS OWN durable key (STUB-HIGH-1). */
function onDead(h: Home, b: BotId, ev: Extract<HomeEvent, { t: "response" }>, i: IntentX | undefined, acts: HomeAction[]) {
  void acts;
  const d = h.durable;
  if (ev.kind === "rotate" && defined(ev.keyId) && ev.keyId === durableKey(h, b)) {
    br("dead.own"); d.observedDead[b] = ev.keyId;
    if (i && i.step === "rotate" && !defined(i.newKeyId)) i.step = "repair";
  } else br("dead.notDurable");
}

function addStray(h: Home, b: BotId, K: KeyId, removed: boolean) {
  void removed;
  if (isProtected(h, K) || tombstoned(h, K)) { br("stray.skip"); return; }
  let i = intentOf(h, b);
  if (!i) { br("stray.newDrain"); i = { origin: "recover", step: "drain", next: "close", oldKeyId: null, sends: 0, strays: [] } as IntentX; h.durable.intents[b] = i; }
  if (!i.strays.includes(K)) i.strays.push(K);
}

function adopt(h: Home, b: BotId, i: IntentX, K: KeyId, now: Time, acts: HomeAction[]) {
  dropQueued(h, (a) => a.a === "call" && a.bot === b && (a.kind === "rotate" || a.kind === "mint")); // the operation is answered: no queued retry
  i.newKeyId = K; i.validated = K; delete i.unk;
  { const ex = h.durable.lastLocalUse[K]; h.durable.lastLocalUse[K] = defined(ex) ? Math.max(ex, now) : now; } // validation call = a use (r3.2)
  // a take must not pass the repair marker up: stay in a step whose spec V is TRUE until the slot is durable and acked
  const pre = repairOf(h, b, now);
  i.step = pre ? "expired" : "save";
  if (pre) br("adopt.keepRepair"); else br("adopt.save");
  const disk = h.durable.disk;
  // r3 coordination note: closing a take puts the disowned key into disk.prev (never DELETEd by this home)
  const prev = i.origin === "take" && defined(i.disowned) && !disk.prev.includes(i.disowned) ? [...disk.prev, i.disowned] : [...disk.prev];
  setBusy(h, b, saveTag(h));
  acts.push({ a: "save", bots: { ...disk.bots, [b]: K }, owner: disk.owner, retired: [...disk.retired], prev });
}

// ─────────────────────────── the advance engine ───────────────────────────
function reprove(h: Home, acts: HomeAction[]) {
  const cur = busyOf(h, "*");
  if (cur && !staleSave(h, cur)) { br("reprove.busy"); return; }
  br("reprove.save");
  emitSave(h, "*", { ...h.durable.disk.bots }, acts, "*");
}

function advance(h: Home, b: BotId, now: Time, acts: HomeAction[]) {
  const d = h.durable;
  if (!d.bindings[b]) return;
  if (d.fenced) { br("adv.fenced"); return; }
  if (h.memory.evidence === null) { br("adv.unproven"); reprove(h, acts); return; }
  const bz = busyOf(h, b);
  if (bz) { if (staleSave(h, bz)) { br("adv.staleBusy"); clrBusy(h, b); } else { br("adv.busy"); return; } }
  const i = intentOf(h, b);
  if (!i) { br("adv.noIntent"); maybeReconcile(h, b, now, acts); return; }
  if (defined(d.twinKeyLive[b])) { br("adv.twin"); return; } // I6c: nothing automatic while the marker stands
  if (i.origin === "take" && defined(i.ownerReconnect) && takePendingClose(h, b, i, now, acts)) return;
  if (i.unk && resolveUnknown(h, b, i, now, acts)) return;
  if (i.strays.length > 0 && cleanStrays(h, b, i, acts)) return;
  switch (i.step) {
    case "rotate": return stepRotate(h, b, i, now, acts);
    case "save": case "recover": case "expired": case "repair": case "held": return stepSavePhase(h, b, i, now, acts);
    case "retire_old": return stepRetire(h, b, i, acts);
    case "drain": return stepDrain(h, b, i, now, acts);
  }
}

/** Reconnect over a STALLED take (r3.2b/c): only an owner Reconnect arms this (reconnectPending); the disowned key goes durable in disk.prev
 *  first (never tombstoned, never DELETEd), then the take intent is replaced by the reconnect intent. Returns true when it acted/waits. */
function takePendingClose(h: Home, b: BotId, i: IntentX, now: Time, acts: HomeAction[]): boolean {
  const d = h.durable, x = i.disowned!;
  const auth = d.takeAuth[b];
  if (!takeStalledR(h, b, i, now) || !liveBinding(h, b) || !auth || auth.opId !== i.ownerReconnect!.takeAuthOp || !defined(i.openedAt) || i.ownerReconnect!.at <= i.openedAt || auth.target !== x || tombstoned(h, x)) { br("rc.pendingVoid"); delete i.ownerReconnect; return false; }
  if (!d.disk.prev.includes(x)) {
    if (supIdle(h)) { br("rc.takePrevSave"); const disk = d.disk; setBusy(h, b, saveTag(h)); acts.push({ a: "save", bots: { ...disk.bots }, owner: disk.owner, retired: [...disk.retired], prev: [...disk.prev, x] }); }
    else br("rc.takePrevWait");
    return true;
  }
  br("rc.takeClose");
  dropQueued(h, (a) => a.a === "call" && a.bot === b && (a.kind === "rotate" || a.kind === "mint"));
  d.intents[b] = { origin: "reconnect", step: "recover", next: "RC", oldKeyId: durableKey(h, b) ?? null, mintIdem: freshIdem(h, b, "m"), at: now, sends: 0, strays: i.strays.filter((k) => k !== x) } as IntentX;
  delete d.takeAuth[b];
  advance(h, b, now, acts);
  return true;
}

/** Reconcile: an idle live binding lists Flux's keys for its bot (never a write), at most once per RECON_EVERY and again after a boot. */
function maybeReconcile(h: Home, b: BotId, now: Time, acts: HomeAction[]) {
  const d = h.durable, m = mem(h);
  if (!liveBinding(h, b) || defined(d.twinKeyLive[b]) || busyOf(h, b)) return;
  const at = m.reconAt?.[b];
  if (defined(at) && now < at + RECON_EVERY) return;
  br("recon.list");
  (m.reconAt ??= {})[b] = now;
  emitCall(h, b, undefined, { kind: "list", actor: "reconcile" }, acts);
}

/** Q-B + STUB-HIGH-4/5: after an unknown create outcome, re-POST with the SAME Idempotency-Key. Returns true if it acted/waits. */
function resolveUnknown(h: Home, b: BotId, i: IntentX, now: Time, acts: HomeAction[]): boolean {
  const u = i.unk!, d = h.durable;
  // STUB-HIGH-4: the hold is counted from the FIRST send (intent.at) + 24 h; retry with the same key while the first send could still be held
  if (!defined(i.at)) throw new Error("intent.at missing"); // r3.2h Opus check: the hold is first send + 24 h (intent.at), like replayOpenR and onExpired
  if (now >= i.at + H24) {
    br("unk.windowLost"); alertOnce(acts, b, "replay_window_lost");
    if (i.origin === "take" && u.kind === "rotate") i.takeLost = true; // the take can never complete: a stalled take (Reconnect may close it)
    dropQueued(h, (a) => a.a === "call" && a.bot === b && (a.kind === "rotate" || a.kind === "mint"));
    // STUB-HIGH-5: only a LOST window is warn-only. The key stays unknown; a fresh operation is allowed after the window.
    if (i.newKeyId !== undefined && i.validated !== i.newKeyId) delete i.newKeyId;
    delete i.unk;
    if (u.kind === "rotate") delete i.rotateIdem; else delete i.mintIdem; // a mint: the next advance starts a NEW op with at = now (same exit as onExpired rot.expiredMint)
    // same exit as onExpired for a non-take rotate whose successor is not saved: the owner repair stays visible (the `expired` step, I1b)
    if (u.kind === "rotate" && i.origin !== "take" && !(defined(durableKey(h, b)) && durableKey(h, b) !== i.oldKeyId)) { br("unk.windowLostRepair"); i.step = "expired"; }
    return true; // one change per step: the intent is not closed in the step that crosses holdEnd (I12)
  }
  if (i.step === "held") { br("unk.held"); return true; }
  if (defined(i.newKeyId) && d.disk.bots[b] === i.newKeyId) { br("unk.durable"); delete i.unk; return false; } // I4: no more calls
  if (u.kind === "rotate") {
    if (!defined(i.oldKeyId) || !defined(i.rotateIdem)) { delete i.unk; return false; }
    if (i.origin === "take" && !takeReady(h, b, i, acts)) { br("unk.takeNotReady"); return true; }
    br("unk.replayRotate");
    i.unk = { ...u, last: now }; i.sends++;
    emitCall(h, b, i, { kind: "rotate", keyId: i.oldKeyId, idem: i.rotateIdem, actor: i.origin === "take" ? "owner_take" : "auto" }, acts);
    return true;
  }
  if (!defined(i.mintIdem)) { delete i.unk; return false; }
  br("unk.replayMint");
  i.unk = { ...u, last: now }; i.sends++;
  emitCall(h, b, i, { kind: "mint", idem: i.mintIdem, actor: "auto" }, acts);
  return true;
}

/** I6d: the take disowns first. Returns true when the take rotate may be sent now. */
function takeReady(h: Home, b: BotId, i: IntentX, acts: HomeAction[]): boolean {
  const d = h.durable, m = h.memory, x = i.disowned;
  const auth = d.takeAuth[b];
  if (!defined(x) || !auth || auth.target !== x || i.oldKeyId !== x) { br("take.noAuth"); return false; }
  if (d.disk.bots[b] === x) { br("take.disownSave"); const bots = { ...d.disk.bots }; delete bots[b]; emitSave(h, b, bots, acts); return false; }
  const ev = m.evidence;
  if (m.D[b] === x || m.botKey[b] === x || ev?.bots[b] === x) {
    br("take.waitAck");
    if (supIdle(h)) { emitSave(h, b, { ...d.disk.bots }, acts); }
    return false;
  }
  return true;
}

function stepRotate(h: Home, b: BotId, i: IntentX, now: Time, acts: HomeAction[]) {
  const d = h.durable;
  if (defined(i.newKeyId) && i.validated === i.newKeyId) { br("rot.successorKnown"); i.step = "save"; return stepSavePhase(h, b, i, now, acts); }
  if (!defined(i.oldKeyId)) { br("rot.noOld"); i.step = "repair"; return; }
  if (d.observedDead[b] === i.oldKeyId) { br("rot.deadKey"); i.step = "repair"; return; }
  if (deadlinePassed(i, now)) { br("rot.deadline"); i.step = "expired"; return; }
  if (i.origin === "take" && !takeReady(h, b, i, acts)) return;
  if (!defined(i.rotateIdem)) { br("rot.newIdem"); i.rotateIdem = freshIdem(h, b, "r"); i.at = now; }
  ensureDeadline(h, i, now);
  br("rot.send");
  i.unk = { kind: "rotate", first: i.unk?.first ?? now, last: now }; i.sends++;
  emitCall(h, b, i, { kind: "rotate", keyId: i.oldKeyId, idem: i.rotateIdem, actor: i.origin === "take" ? "owner_take" : "auto" }, acts);
}

/** save / recover / expired / repair / held. With a validated successor these all drive the slot durable; without one only
 *  `recover` (a reconnect mint) acts. */
function stepSavePhase(h: Home, b: BotId, i: IntentX, now: Time, acts: HomeAction[]) {
  const d = h.durable, m = h.memory;
  const nk = i.newKeyId;
  if (defined(nk) && i.validated === nk && !tombstoned(h, nk)) {
    if (d.disk.bots[b] === nk) {
      if (m.D[b] === nk && m.evidence?.bots[b] === nk) return finalize(h, b, i, now, acts);
      br("save.waitAck"); // durable but the ack has not reached memory: the supervisor's ack (or a re-save) brings it
      if (supIdle(h)) { br("save.resave"); emitSave(h, b, { ...d.disk.bots }, acts); }
      return;
    }
    if (i.step === "held" && !liveBinding(h, b)) return;
    br("save.emit"); emitSave(h, b, { ...d.disk.bots, [b]: nk }, acts); return;
  }
  if (i.step === "recover" && !defined(nk)) {
    if (!defined(i.mintIdem)) { i.mintIdem = freshIdem(h, b, "m"); i.at = now; }
    br("rec.mint");
    i.unk = { kind: "mint", first: i.unk?.first ?? now, last: now }; i.sends++;
    emitCall(h, b, i, { kind: "mint", idem: i.mintIdem, actor: "auto" }, acts);
    return;
  }
  br("save.holdRepair"); // repair / expired / held: no automatic call; the owner's Reconnect restarts it
}

function finalize(h: Home, b: BotId, i: IntentX, now: Time, acts: HomeAction[]) {
  void now;
  const d = h.durable, nk = i.newKeyId!;
  const bd = d.bindings[b];
  if (bd.state !== "removed") { bd.state = "active"; bd.emailKeyRef = nk; }
  if (i.origin === "take" && defined(i.disowned) && !d.disk.prev.includes(i.disowned)) {
    // the close keeps the disowned key in disk.prev (never forgotten, never DELETEd by this home): make that durable first
    br("fin.takePrev");
    if (supIdle(h)) { const disk = d.disk; setBusy(h, b, saveTag(h)); acts.push({ a: "save", bots: { ...disk.bots }, owner: disk.owner, retired: [...disk.retired], prev: [...disk.prev, i.disowned] }); }
    return;
  }
  if (i.origin === "take" || !defined(i.oldKeyId) || i.oldKeyId === nk) { br("fin.close"); closeOrDrain(h, b, i); return; }
  br("fin.retire"); i.step = "retire_old";
}

function stepRetire(h: Home, b: BotId, i: IntentX, acts: HomeAction[]) {
  const d = h.durable, m = h.memory, nk = i.newKeyId, old = i.oldKeyId;
  if (!defined(nk) || i.validated !== nk || d.disk.bots[b] !== nk || m.D[b] !== nk) { br("ret.notExact"); i.step = "save"; return; }
  if (!defined(old) || old === nk) { br("ret.noOld"); closeOrDrain(h, b, i); return; }
  if (d.observedDead[b] === nk || m.rejected[b] === true || defined(d.twinKeyLive[b])) { br("ret.holdContested"); return; } // I5
  if ((m.sendsInFlight[b] ?? []).includes(old)) { br("ret.sendHolds"); return; }
  if (!tombstoned(h, old)) { br("ret.tombstone"); d.tombstones.push(old); }
  br("ret.delete");
  emitCall(h, b, i, { kind: "delete", keyId: old, actor: "auto", cause: { by: "retire" } }, acts);
}

function stepDrain(h: Home, b: BotId, i: IntentX, now: Time, acts: HomeAction[]) {
  const d = h.durable, m = h.memory;
  if (d.bindings[b].state === "removed") {
    // the slot leaves disk first (I2, I3b), memory follows the ack
    if (defined(d.disk.bots[b])) { br("drain.dropSlot"); const bots = { ...d.disk.bots }; delete bots[b]; emitSave(h, b, bots, acts); return; }
    if (defined(m.D[b]) || defined(m.botKey[b]) || defined(m.evidence?.bots[b])) { br("drain.waitAck"); if (supIdle(h)) emitSave(h, b, { ...d.disk.bots }, acts); return; }
  }
  void now;
  if (d.bindings[b].state === "removed" && defined(i.newKeyId) && i.validated === i.newKeyId) {
    if (!supIdle(h)) { br("drain.waitSup"); return; }
    br("drain.releaseSuccessor"); delete i.newKeyId; delete i.validated;
  }
  if (i.strays.length === 0 && !i.unk) {
    if (defined(i.disowned) && !d.disk.prev.includes(i.disowned)) { br("drain.keepDisowned"); emitSave(h, b, { ...d.disk.bots }, acts, b, i.disowned); return; } // I6d: the target stays ownKnown
    br("drain.close"); delete d.intents[b]; return;
  }
  br("drain.wait");
}

/** DELETE learned strays one at a time, tombstone first. Returns true if it acted or must wait. */
function cleanStrays(h: Home, b: BotId, i: IntentX, acts: HomeAction[]): boolean {
  const d = h.durable;
  for (const K of i.strays) {
    if (isProtected(h, K)) { br("stray.protected"); continue; }
    const removed = d.bindings[b].state === "removed";
    const entry = d.mintLog.find((m) => m.keyId === K);
    // STUB-HIGH-3: the DELETE cites the operation that actually PRODUCED the key (the mint log names it); keys with no
    // producing operation (a removed binding's own key) are DELETEd as a removal.
    // r3.2k (Opus L4, Fable L4): a stray learned from a reconnect 409 {X} carries via409, the key of invariant I13 (the 24 h rule).
    const via409 = !!i.from409?.includes(K);
    const cause = entry && !removed ? (via409 ? ({ by: "stray", opId: entry.opId, via409: true } as const) : ({ by: "stray", opId: entry.opId } as const)) : ({ by: "remove" } as const);
    if ((h.memory.sendsInFlight[b] ?? []).includes(K)) { br("stray.sendHolds"); return true; }
    if (!tombstoned(h, K)) { br("stray.tombstone"); d.tombstones.push(K); }
    br("stray.delete");
    emitCall(h, b, i, { kind: "delete", keyId: K, actor: "auto", cause }, acts);
    return true;
  }
  return false;
}

// ─────────────────────────── owner presses ───────────────────────────
function onOwner(h: Home, b: BotId, press: "reconnect" | "take" | "remove", now: Time, acts: HomeAction[]) {
  const d = h.durable, bd = d.bindings[b];
  if (!bd) return;
  const i = intentOf(h, b);
  const open = !!i?.unk && replayOpenR(h, b, now); // r3.2h Opus check: judged on the first send (intent.at), the same predicate the list branch uses
  if (press === "remove") {
    if (bd.state === "removed") { br("own.removeAgain"); return; }
    br("own.remove");
    const ni: IntentX = i ?? ({ origin: "recover", step: "drain", next: "close", oldKeyId: null, sends: 0, strays: [] } as IntentX);
    const dis = ni.disowned; // a take's disowned target is another home's key: never a stray, never forgotten (I6d)
    const add = [d.disk.bots[b], i?.oldKeyId, i?.newKeyId && i.validated === i.newKeyId ? i.newKeyId : undefined].filter((k): k is KeyId => defined(k) && k !== dis);
    for (const k of add) if (!ni.strays.includes(k)) ni.strays.push(k);
    // the old/validated keys become strays (DELETEd once off disk); an unvalidated 503 successor stays so a replay can learn it
    if (defined(ni.oldKeyId) && ni.oldKeyId !== dis) ni.oldKeyId = null;
    // the validated successor stays on the intent until its slot has left disk and the queue is idle (I3b, I4); stepDrain clears it
    ni.step = "drain"; ni.next = "close";
    d.intents[b] = ni;
    bd.state = "removed"; // I3b: the slot may be cleared once the binding is removed
    delete d.twinKeyLive[b];
    advance(h, b, now, acts);
    return;
  }
  if (!liveBinding(h, b)) { br("own.notLive"); return; }
  if (d.fenced || h.memory.evidence === null) { br("own.unprovenIgnored"); return; }
  if (press === "reconnect") {
    if (!repairOf(h, b, now) || bd.state === "restored_unverified" || defined(d.twinKeyLive[b])) { br("own.reconnectIgnored"); return; }
    if (i?.origin === "take" && defined(i.disowned) && !defined(i.newKeyId) && busyOf(h, b) !== "call" && takeStalledR(h, b, i, now)) {
      br("own.reconnectStalledTake");
      // r3.2d: the owner press is a capability bound to THIS take (takeAuthOp, at > openedAt); created only here, cleared by reduce() on ANY change to the take
      const au = h.durable.takeAuth[b];
      if (au && defined(i.openedAt) && now > i.openedAt) { i.ownerReconnect = { at: now, takeAuthOp: au.opId }; justStamped.add(b); return; }
      br("own.reconnectWaits"); return;
    }
    if (open || (i && defined(i.newKeyId)) || (i?.origin === "take" && defined(i.disowned))) { br("own.reconnectWaits"); return; }
    br("own.reconnect");
    dropQueued(h, (a) => a.a === "call" && a.bot === b && (a.kind === "rotate" || a.kind === "mint")); // the old operation's idem leaves the intent
    const keep = i?.strays ?? [];
    d.intents[b] = { origin: "reconnect", step: "recover", next: "RC", oldKeyId: durableKey(h, b) ?? null, mintIdem: freshIdem(h, b, "m"), at: now, sends: 0, strays: [...keep] } as IntentX;
    advance(h, b, now, acts);
    return;
  }
  // take: "Use email on this home" on the twin's key (the marker) or the key a restored copy holds
  const target = d.twinKeyLive[b] ?? (bd.state === "restored_unverified" ? durableKey(h, b) : undefined);
  // r3.2e: a take press never replaces an OPEN take (I6d: take A closes only at an owner Reconnect, checked on A's own target; a K1 -> K2 move is
  // that close followed, in a LATER step, by the take press that opens take B on K2 with its own openedAt and takeAuth).
  if (!defined(target) || open || (i?.origin === "take" && defined(i.disowned))) { br("own.takeIgnored"); return; }
  br("own.take");
  dropQueued(h, (a) => a.a === "call" && a.bot === b && (a.kind === "rotate" || a.kind === "mint"));
  const strays = [...(i?.strays ?? [])];
  if (i && defined(i.newKeyId) && i.validated === i.newKeyId && durableKey(h, b) !== i.newKeyId && !strays.includes(i.newKeyId)) strays.push(i.newKeyId);
  const idem = freshIdem(h, b, "t");
  d.takeAuth[b] = { target, opId: `take:${h.id}:${b}:${idem}` };
  delete d.twinKeyLive[b];
  const ni: IntentX = { origin: "take", step: "rotate", oldKeyId: target, disowned: target, rotateIdem: idem, at: now, sends: 0, strays, openedAt: now } as IntentX;
  d.intents[b] = ni;
  ensureDeadline(h, ni, now);
  advance(h, b, now, acts);
}

export const REDUCER_BRANCHES: string[] = [
  "ack.apply",
  "c400.newIntent",
  "c409.ownKnown",
  "fin.takePrev",
  "list.none",
  "list.ownDead",
  "list.twin",
  "list.unknownDuringReplay",
  "prune.delete",
  "prune.skipKind",
  "prune.skipLocalUse",
  "prune.skipNotMinted",
  "prune.skipProtected",
  "prune.skipUsed",
  "prune.skipYoung",
  "recon.list",
  "reduce.use",
  "use.record",
  "ack.stale",
  "adopt.keepRepair",
  "adopt.save",
  "adv.busy",
  "adv.fenced",
  "adv.noIntent",
  "adv.staleBusy",
  "adv.twin",
  "adv.unproven",
  "boot.proven",
  "boot.unproven",
  "c.other",
  "c201.adopt",
  "c201.dup",
  "c201.stray",
  "c201.tombstoned",
  "c400.held",
  "c404.dead",
  "c404.other",
  "c409.adoptKnown",
  "c409.mismatch",
  "c409.nokey",
  "c409.revoked",
  "c409.twin",
  "c409.ownKnownHold",
  "c409.removedNoTwin",
  "c503.own",
  "close.drain",
  "close.intent",
  "dead.notDurable",
  "dead.own",
  "del.done",
  "del.notDone",
  "del.retired",
  "drain.close",
  "drain.dropSlot",
  "drain.wait",
  "drain.waitAck",
  "fin.close",
  "fin.retire",
  "lost.retry",
  "norm.saveExpired",
  "norm.stepWithoutSuccessor",
  "own.notLive",
  "own.reconnect",
  "own.reconnectIgnored",
  "own.reconnectWaits",
  "own.reconnectStalledTake",
  "rc.pendingVoid",
  "rc.takePrevSave",
  "rc.takePrevWait",
  "rc.takeClose",
  "rc.stampCleared",
  "take.targetDead",
  "list.takeDead",
  "own.remove",
  "own.removeAgain",
  "own.take",
  "own.takeIgnored",
  "own.unprovenIgnored",
  "rec.mint",
  "reduce.ack",
  "reduce.boot",
  "reduce.clock",
  "reduce.drive",
  "reduce.fence",
  "reduce.lost",
  "reduce.owner",
  "reduce.rejected",
  "reduce.response",
  "rejected.markDead",
  "rejected.other",
  "rejected.toRepair",
  "reprove.busy",
  "reprove.save",
  "resp.deadlineFrom201",
  "resp.list",
  "ret.delete",
  "ret.holdContested",
  "ret.noOld",
  "ret.notExact",
  "ret.sendHolds",
  "ret.tombstone",
  "rot.deadKey",
  "rot.deadline",
  "rot.expiredStale",
  "rot.expiredMint",
  "unk.windowLostRepair",
  "c409.mintHoldLive",
  "c409.mintStray",
  "rot.expiredRepair",
  "rot.expiredTake",
  "rot.newIdem",
  "rot.noOld",
  "rot.send",
  "rot.successorKnown",
  "save.emit",
  "save.holdRepair",
  "save.resave",
  "save.waitAck",
  "stray.delete",
  "stray.newDrain",
  "stray.protected",
  "stray.sendHolds",
  "stray.skip",
  "stray.tombstone",
  "take.disownSave",
  "take.noAuth",
  "take.waitAck",
  "unk.durable",
  "unk.held",
  "unk.replayMint",
  "unk.replayRotate",
  "unk.takeNotReady",
  "unk.windowLost",
];
declareBranches(REDUCER_BRANCHES);
