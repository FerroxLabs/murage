// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// GET /api/engine-health (UX 1.0.13, lane L2A). One small answer for Today's
// first tag ("Claude signed in" / "Flux Router: allowance used up") and the
// Health dot: each engine's state in plain words, which one is the default,
// and whether Flux Router is usable.
//
// Read-only and cheap. It runs no engine and changes nothing: it reads the
// engine snapshots the server already describes for GET /api/instances and the
// Flux key answer flux-key-health.ts already caches (at most one /key/info
// call per ten minutes, and never past FLUX_WAIT_MS here, so a slow network
// cannot hold Today up). Owner only: any other caller gets the unknown-route
// 404, the same answer as a route that is not there.
//
// The answer's shape is the shell contract's EngineHealthAnswer
// (src/components/shell/shell-contract.ts); it is repeated here because the
// server build does not read src/.
import { checkFluxKey, fluxKeyRefused, requestFluxKeyRecheck, type FluxKeyCheck } from "./flux-key-health.ts";

export const ENGINE_HEALTH_PATH = "/api/engine-health";
/** Health's Check again (HEALTH-DOCTOR): drop the cached Flux answer and the memo so the next read asks Flux once, fresh. */
export const ENGINE_HEALTH_RECHECK_PATH = "/api/engine-health/recheck";
/** A second Check again inside this window changes nothing: one press is one fresh /key/info call at most. */
export const ENGINE_HEALTH_RECHECK_MS = 10_000;
/** The longest this route waits on the Flux key answer before saying "ok" (never a made-up problem). */
export const FLUX_WAIT_MS = 1_500;
/** One answer serves every caller for this long: a scan of the engines is not free, and Today asks on every focus. */
export const ENGINE_HEALTH_MEMO_MS = 60_000;

/** The last answer and when it was made. The integrator keeps ONE of these at module level in server/index.ts. */
export interface EngineHealthMemo { at: number; body: EngineHealthAnswer | null; recheckAt?: number; gen?: number }

/** Something changed what the answer says (Check again, an engine switched on or off): drop the memo, and a read that
 * started before this can no longer put its older answer back. */
export function dropEngineHealthMemo(memo: EngineHealthMemo): void {
  memo.gen = (memo.gen ?? 0) + 1;
  memo.at = 0;
  memo.body = null;
}

export type EngineHealthState = "ready" | "checking" | "signed-out" | "limit" | "off" | "missing";
export type FluxHealthState = "ok" | "allowance-used-up" | "key-problem" | "none";
/** `usedBy`: how many bots run on this engine. `fuigo`: the bundled Fuigo, whose state Flux Router speaks for. */
export interface EngineHealthRow { id: string; label: string; state: EngineHealthState; line: string; usedBy: number; fuigo?: true }
/** The Flux Router figures from the same cached /key/info answer: only from a valid check, never a stale or made-up figure. */
export interface FluxHealthInfo { spendPct: number | null; expires: string | null }
/** `primary` falls back to a ready engine for Today's tag; `defaultId` is the engine actually chosen as the default, or null. */
export interface EngineHealthAnswer { engines: EngineHealthRow[]; primary: EngineHealthRow | null; defaultId: string | null; flux: FluxHealthState; fluxInfo: FluxHealthInfo | null; checkedAt: number }

/** The parts of a described instance (GET /api/instances) this route reads. */
export interface EngineHealthInstance {
  instanceId: string;
  displayName: string;
  enabled?: boolean;
  /** The bundled Fuigo is a client: a missing login is a key, and Flux state speaks for it (server/setup.ts). */
  driverKind?: string;
  snapshot: { state: "available" | "unavailable"; authenticated?: boolean; authUnverified?: true; reason?: string };
}

export interface EngineHealthDeps {
  /** The caller proved it is the owner: the desktop, or the owner's own paired phone (route-policy class "companion"). */
  owner: boolean;
  instances: () => Promise<readonly EngineHealthInstance[]>;
  /** The default engine's instance id (the remembered engine choice), or null. */
  primaryId: () => string | null;
  /** The saved Flux Router key, or null. Never sent anywhere by this route except Flux's own /key/info, through checkFluxKey. */
  fluxKey: () => string | null;
  checkFlux?: (key: string) => Promise<FluxKeyCheck>;
  refused?: (key: string) => boolean;
  /** The engine each bot runs on (one id per bot), for `usedBy`. Read from memory: no scan. */
  botEngineIds?: () => readonly string[];
  /** Drops every cached Flux key answer (flux-key-health.ts requestFluxKeyRecheck). */
  recheck?: () => void;
  now?: () => number;
  /** Shared across requests: an answer younger than ENGINE_HEALTH_MEMO_MS is served again without a new scan. */
  memo?: EngineHealthMemo;
}

export interface EngineHealthRouteAnswer { status: number; body: unknown }

const LINE: Record<EngineHealthState, string> = {
  ready: "Signed in and ready.",
  checking: "Checking sign-in.",
  "signed-out": "Signed out. Sign in again in Settings, Engines.",
  limit: "Reached its limit for now. It carries on when the limit resets.",
  off: "Switched off in Settings.",
  missing: "Not found on this computer.",
};

export function engineRow(instance: EngineHealthInstance, usedBy = 0): EngineHealthRow {
  const state: EngineHealthState = instance.enabled === false
    ? "off"
    : instance.snapshot.state !== "available"
      ? "missing"
      : instance.snapshot.authenticated === false && instance.driverKind !== "fuigoAgent" ? "signed-out"
        : instance.snapshot.authUnverified === true ? "checking" : "ready";
  return { id: instance.instanceId, label: instance.displayName, state, line: LINE[state], usedBy, ...(instance.driverKind === "fuigoAgent" ? { fuigo: true as const } : {}) };
}

/** The Flux key in one word. "unknown" from Flux is "ok": a slow or failed check is never reported as a problem. */
export function fluxHealthFrom(key: string | null, refused: boolean, check: FluxKeyCheck | null): FluxHealthState {
  if (!key || !key.trim()) return "none";
  if (refused || check?.state === "invalid") return "key-problem";
  if (check?.state === "valid") {
    const { blocked, maxBudget, spend } = check.info;
    if (blocked || (maxBudget !== null && spend !== null && maxBudget > 0 && spend >= maxBudget)) return "allowance-used-up";
  }
  return "ok";
}

/** The figures behind the allowance line. Only a valid check has them; a budget of 0 or none has no percentage. */
export function fluxInfoFrom(check: FluxKeyCheck | null): FluxHealthInfo | null {
  if (check?.state !== "valid") return null;
  const { maxBudget, spend, expires } = check.info;
  const spendPct = maxBudget !== null && maxBudget > 0 && spend !== null ? Math.max(0, Math.min(100, Math.round((spend / maxBudget) * 100))) : null;
  return { spendPct, expires };
}

/** Bots per engine id. */
export function usedByCounts(ids: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
}

export function engineHealthBody(instances: readonly EngineHealthInstance[], primaryId: string | null, flux: FluxHealthState, checkedAt: number, extra: { usedBy?: ReadonlyMap<string, number>; fluxInfo?: FluxHealthInfo | null } = {}): EngineHealthAnswer {
  const engines = instances.map((instance) => engineRow(instance, extra.usedBy?.get(instance.instanceId) ?? 0));
  const primary = (primaryId ? engines.find((row) => row.id === primaryId) : undefined) ?? engines.find((row) => row.state === "ready") ?? engines[0] ?? null;
  const defaultId = primaryId && engines.some((row) => row.id === primaryId) ? primaryId : null;
  return { engines, primary, defaultId, flux, fluxInfo: flux === "none" || flux === "key-problem" ? null : extra.fluxInfo ?? null, checkedAt };
}

async function boundedCheck(key: string, check: (key: string) => Promise<FluxKeyCheck>): Promise<FluxKeyCheck | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wait = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), FLUX_WAIT_MS); });
  try {
    return await Promise.race([check(key).catch(() => null), wait]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The route, or null when the request is not for it. */
export async function engineHealthRoute(req: { method: string; url: URL; contentType?: string }, deps: EngineHealthDeps): Promise<EngineHealthRouteAnswer | null> {
  if (req.url.pathname !== ENGINE_HEALTH_PATH && req.url.pathname !== ENGINE_HEALTH_RECHECK_PATH) return null;
  if (!deps.owner) return { status: 404, body: { error: "no such route" } };
  const now = deps.now ?? Date.now;
  if (req.url.pathname === ENGINE_HEALTH_RECHECK_PATH) {
    if (req.method !== "POST") return { status: 405, body: { error: "Use POST to check again.", code: "METHOD" } };
    // The same non-simple-request gate as the other owner routes that change something.
    if (!String(req.contentType ?? "").toLowerCase().startsWith("application/json")) return { status: 415, body: { error: "content-type must be application/json" } };
    const at = now();
    if (deps.memo?.recheckAt !== undefined && at - deps.memo.recheckAt < ENGINE_HEALTH_RECHECK_MS) return { status: 200, body: { ok: true, fresh: false } };
    (deps.recheck ?? requestFluxKeyRecheck)();
    if (deps.memo) { dropEngineHealthMemo(deps.memo); deps.memo.recheckAt = at; }
    return { status: 200, body: { ok: true, fresh: true } };
  }
  if (req.method !== "GET") return { status: 405, body: { error: "Use GET to read engine health.", code: "METHOD" } };
  if (deps.memo?.body && now() - deps.memo.at < ENGINE_HEALTH_MEMO_MS) return { status: 200, body: deps.memo.body };
  const gen = deps.memo?.gen ?? 0;
  const key = deps.fluxKey();
  const [instances, check] = await Promise.all([
    deps.instances().catch(() => [] as readonly EngineHealthInstance[]),
    key ? boundedCheck(key, deps.checkFlux ?? checkFluxKey) : Promise.resolve(null),
  ]);
  const flux = fluxHealthFrom(key, key ? (deps.refused ?? fluxKeyRefused)(key) : false, check);
  let usedBy: Map<string, number> | undefined;
  try { usedBy = deps.botEngineIds ? usedByCounts(deps.botEngineIds()) : undefined; } catch { usedBy = undefined; }
  const body = engineHealthBody(instances, deps.primaryId(), flux, now(), { usedBy, fluxInfo: fluxInfoFrom(check) });
  // A read that started before the memo was dropped answers its caller but is not kept.
  if (deps.memo && (deps.memo.gen ?? 0) === gen) { deps.memo.at = body.checkedAt; deps.memo.body = body; }
  return { status: 200, body };
}
