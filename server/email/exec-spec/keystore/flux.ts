// FakeFlux with the real semantics (F3). Pure: every function clones and returns. The checker is omniscient; homes see only
// the Response. Nondeterminism (500 unknown, 503, 400) is chosen by the scheduler through `ApplyOutcome`, never inside.
import { DAY } from "./domain.ts";
import { NEVER_USAGE_PRUNE_KINDS } from "./invariants.current.ts";
import type { ApplyOutcome, BotId, CallKind, FluxKey, FluxX, HomeId, Idem, KeyId, ListedKey, OpId, Response, Time } from "./types.ts";

export interface FluxReq { home: HomeId; bot: BotId; kind: CallKind; keyId?: KeyId; idem?: Idem; opId?: OpId }
// harness keys with no kind are model-style (usage tracked) so the older tests keep their meaning; seed kind: "email:bot" for the never-tracked case
const neverUsage = (k: FluxKey) => k.kind !== undefined && NEVER_USAGE_PRUNE_KINDS.includes(k.kind);
export const emptyFlux = (now = 0): FluxX => ({ keys: {}, holds: {}, flagOn: true, now, seq: {}, incomplete: {} });
const opOf = (r: FluxReq): OpId => r.opId ?? `op-${r.idem ?? "none"}`;
const bodyHash = (r: FluxReq) => `${r.kind}|${r.bot}|${r.keyId ?? ""}`;

export function fluxHonours(f: FluxX, id: KeyId | undefined | null): boolean {
  if (!id) return false;
  const k = f.keys[id];
  if (!k) return false;
  if (k.status === "successor_pending") return true;
  return k.status === "live" && (k.deadlineAt === undefined || f.now < k.deadlineAt);
}
/** Seed helper: add a live key and keep the per-bot sequence ahead of it. */
export function addKey(f: FluxX, id: KeyId, bot: BotId, issuedForHome: HomeId, extra: Partial<FluxKey> = {}): FluxX {
  const g = structuredClone(f);
  g.keys[id] = { id, bot, status: "live", issuedFor: { home: issuedForHome, opId: "seed" }, createdAt: f.now, lastUsedAt: null, lastUsedVisibleAt: null, ...extra };
  g.seq[bot] = Math.max(g.seq[bot] ?? 0, Number(id.split(":k")[1] ?? 0));
  return g;
}
export const canAlloc = (f: FluxX, bot: BotId, cap: number) => (f.seq[bot] ?? 0) < cap;

/** Advance Flux's clock: a replay hold expires, a key past its deadline dies and its unclaimed successor becomes the live key. */
export function fluxAdvance(f0: FluxX, to: Time): FluxX {
  const f = structuredClone(f0);
  f.now = to;
  for (const [idem, h] of Object.entries(f.holds)) if (h.until <= to) delete f.holds[idem];
  for (const k of Object.values(f.keys)) {
    if (k.status === "live" && k.deadlineAt !== undefined && to >= k.deadlineAt) {
      k.status = "expired_by_deadline";
      const s = k.successor && f.keys[k.successor];
      if (s && s.status === "successor_pending") { s.status = "live"; delete s.replaces; }
      delete k.successor;
    }
  }
  return f;
}
/** A bot sends email with `key`: 200 and lastUsedAt = now if Flux honours it, else 401. The LIST shows lastUsedVisibleAt, which
 *  catches up only when the scheduler takes a `usageSync` step (F3 usage lag: nondeterministic delay 0..SYNC_LAG). */
export function fluxUse(f0: FluxX, id: KeyId | undefined | null): { flux: FluxX; resp: 200 | 401 } {
  const f = structuredClone(f0);
  // flux276: the reaper may stop, so an expired old key keeps answering 200 at ANY later time (the spec's honours() does not rely on it)
  const reaped = !f.reaperStopped || f.keys[id ?? ""]?.status !== "expired_by_deadline";
  if (!f.flagOn || (!fluxHonours(f, id) && reaped)) return { flux: f, resp: 401 };
  if (!neverUsage(f.keys[id!])) f.keys[id!].lastUsedAt = f.now; // email-proxy calls never set last_used_at
  return { flux: f, resp: 200 };
}
/** Usage sync: the list's visible last-use catches up with the truth. */
export function fluxUsageSync(f0: FluxX, id: KeyId): FluxX {
  const f = structuredClone(f0);
  if (f.keys[id]) f.keys[id].lastUsedVisibleAt = f.keys[id].lastUsedAt;
  return f;
}
export const usagePending = (f: FluxX, id: KeyId) => f.keys[id] !== undefined && f.keys[id].lastUsedVisibleAt !== f.keys[id].lastUsedAt;
/** The owner deletes a key in Flux's UI, outside Murage (Q3). */
export function fluxOwnerDelete(f0: FluxX, id: KeyId): FluxX { return fluxDelete(f0, id).flux; }

function fluxDelete(f0: FluxX, id: KeyId): { flux: FluxX; resp: Response } {
  const f = structuredClone(f0);
  const k = f.keys[id];
  if (!k) return { flux: f, resp: { code: 404, error: "key_not_found" } };
  if (k.status !== "revoked") {
    const wasSuccessor = k.status === "successor_pending";
    const pred = k.replaces ? f.keys[k.replaces] : undefined;
    const succ = k.successor ? f.keys[k.successor] : undefined;
    k.status = "revoked";
    if (wasSuccessor && pred && pred.successor === id) delete pred.successor; // predecessor keeps its ORIGINAL deadline
    if (succ && succ.status === "successor_pending") { succ.status = "live"; delete succ.replaces; } // retiring K1 leaves K2 live
    delete k.successor;
  }
  return { flux: f, resp: { code: 204 } };
}

export function fluxApply(f0: FluxX, r: FluxReq, outcome: ApplyOutcome, keysPerBot: number): { flux: FluxX; resp: Response } {
  if (!f0.flagOn) return { flux: structuredClone(f0), resp: { code: 404, error: "other" } };
  if (outcome === "bad400") return { flux: structuredClone(f0), resp: { code: 400, error: "invalid_request" } };
  if (outcome === "e500_dropped") return { flux: structuredClone(f0), resp: { code: 500 } };
  if (r.kind === "list") {
    const list: ListedKey[] = Object.values(f0.keys).filter((k) => k.bot === r.bot).map((k) => ({
      keyId: k.id, status: k.status, createdAt: k.createdAt, lastUsedAt: k.lastUsedVisibleAt,
      // r3: email:bot (kind absent) is never usage-tracked: used is null, never false
      used: neverUsage(k) ? null : k.lastUsedVisibleAt !== null, ...(k.kind ? { kind: k.kind } : {}),
    }));
    return { flux: structuredClone(f0), resp: { code: 200, list } };
  }
  if (r.kind === "delete") {
    if (!r.keyId) return { flux: structuredClone(f0), resp: { code: 400, error: "invalid_request" } };
    const d = fluxDelete(f0, r.keyId);
    return outcome.startsWith("e500_applied") ? { flux: d.flux, resp: { code: 500 } } : d;
  }
  const f = structuredClone(f0);
  const bh = bodyHash(r);
  if (r.idem) {
    const hold = f.holds[r.idem];
    if (hold && hold.until > f.now) {
      return hold.bodyHash === bh
        ? { flux: f, resp: { code: 201, keyId: hold.keyId, oldKeyExpiresAt: f.keys[r.keyId ?? ""]?.deadlineAt } } // only a 201 is replayed
        : { flux: f, resp: { code: 409, error: "idempotency_mismatch" } };
    }
  }
  const respond = (resp: Response, hold: boolean): { flux: FluxX; resp: Response } => {
    if (hold && resp.code === 201 && r.idem) f.holds[r.idem] = { idem: r.idem, bodyHash: bh, keyId: resp.keyId, until: f.now + DAY };
    return { flux: f, resp };
  };
  // 500: the call may have applied; the home learns nothing. e500_applied keeps the 201 replay hold, _nohold does not.
  const unknown500 = (issued: KeyId): { flux: FluxX; resp: Response } => {
    if (outcome === "e500_applied" && r.idem) f.holds[r.idem] = { idem: r.idem, bodyHash: bh, keyId: issued, until: f.now + DAY };
    return { flux: f, resp: { code: 500 } };
  };
  const alloc = (): KeyId | null => {
    const n = (f.seq[r.bot] ?? 0) + 1;
    if (n > keysPerBot) return null;
    f.seq[r.bot] = n;
    return `${r.bot}:k${n}`;
  };

  if (r.kind === "rotate") {
    const old = r.keyId ? f.keys[r.keyId] : undefined;
    if (!old) return { flux: f, resp: { code: 404, error: "key_not_found" } };
    // a 503'd rotate retried with the SAME key completes into the same successor
    const inc = r.idem ? f.incomplete[r.idem] : undefined;
    if (inc && f.keys[inc] && f.keys[inc].status !== "revoked") {
      delete f.incomplete[r.idem!];
      return respond({ code: 201, keyId: inc, oldKeyExpiresAt: old.deadlineAt }, true);
    }
    const honoured = old.status === "successor_pending" || (old.status === "live" && (old.deadlineAt === undefined || f.now < old.deadlineAt));
    if (!honoured) return { flux: f, resp: { code: 409, error: "key_revoked" } };
    const act = old.successor ? f.keys[old.successor] : undefined;
    if (act && act.status === "successor_pending") return { flux: f, resp: { code: 409, error: "rotation_pending", keyId: act.id } };
    const id = alloc();
    if (!id) return { flux: structuredClone(f0), resp: { code: 500 } };
    f.keys[id] = { id, bot: r.bot, status: "successor_pending", replaces: old.id, issuedFor: { home: r.home, opId: opOf(r) }, createdAt: f.now, lastUsedAt: null, lastUsedVisibleAt: null };
    old.successor = id;
    old.deadlineAt = Math.min(old.deadlineAt ?? Infinity, f.now + DAY); // CAS min rule: the 24 h deadline never restarts
    if (outcome === "incomplete503") { if (r.idem) f.incomplete[r.idem] = id; return { flux: f, resp: { code: 503, error: "rotation_incomplete", keyId: id } }; }
    if (outcome.startsWith("e500_applied")) return unknown500(id);
    return respond({ code: 201, keyId: id, oldKeyExpiresAt: old.deadlineAt }, true);
  }
  // mint
  const honoured = Object.values(f.keys).filter((k) => k.bot === r.bot && (k.status === "successor_pending" || (k.status === "live" && (k.deadlineAt === undefined || f.now < k.deadlineAt))));
  if (honoured.length) {
    const pick = honoured.find((k) => k.status === "successor_pending") ?? honoured[0];
    return { flux: f, resp: { code: 409, error: "bot_key_exists", keyId: pick.id } }; // re-evaluated, never replayed
  }
  const id = alloc();
  if (!id) return { flux: structuredClone(f0), resp: { code: 500 } };
  f.keys[id] = { id, bot: r.bot, status: "live", issuedFor: { home: r.home, opId: opOf(r) }, createdAt: f.now, lastUsedAt: null, lastUsedVisibleAt: null };
  if (outcome.startsWith("e500_applied")) return unknown500(id);
  return respond({ code: 201, keyId: id }, true);
}
