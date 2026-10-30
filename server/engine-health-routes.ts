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
import { checkFluxKey, fluxKeyRefused, type FluxKeyCheck } from "./flux-key-health.ts";

export const ENGINE_HEALTH_PATH = "/api/engine-health";
/** The longest this route waits on the Flux key answer before saying "ok" (never a made-up problem). */
export const FLUX_WAIT_MS = 1_500;
/** One answer serves every caller for this long: a scan of the engines is not free, and Today asks on every focus. */
export const ENGINE_HEALTH_MEMO_MS = 60_000;

/** The last answer and when it was made. The integrator keeps ONE of these at module level in server/index.ts. */
export interface EngineHealthMemo { at: number; body: EngineHealthAnswer | null }

export type EngineHealthState = "ready" | "signed-out" | "limit" | "off" | "missing";
export type FluxHealthState = "ok" | "allowance-used-up" | "key-problem" | "none";
export interface EngineHealthRow { id: string; label: string; state: EngineHealthState; line: string }
export interface EngineHealthAnswer { engines: EngineHealthRow[]; primary: EngineHealthRow | null; flux: FluxHealthState; checkedAt: number }

/** The parts of a described instance (GET /api/instances) this route reads. */
export interface EngineHealthInstance {
  instanceId: string;
  displayName: string;
  enabled?: boolean;
  snapshot: { state: "available" | "unavailable"; authenticated?: boolean; reason?: string };
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
  now?: () => number;
  /** Shared across requests: an answer younger than ENGINE_HEALTH_MEMO_MS is served again without a new scan. */
  memo?: EngineHealthMemo;
}

export interface EngineHealthRouteAnswer { status: number; body: unknown }

const LINE: Record<EngineHealthState, string> = {
  ready: "Signed in and ready.",
  "signed-out": "Signed out. Sign in again in Settings, Engines.",
  limit: "Reached its limit for now. It carries on when the limit resets.",
  off: "Switched off in Settings.",
  missing: "Not found on this computer.",
};

export function engineRow(instance: EngineHealthInstance): EngineHealthRow {
  const state: EngineHealthState = instance.enabled === false
    ? "off"
    : instance.snapshot.state !== "available"
      ? "missing"
      : instance.snapshot.authenticated === false ? "signed-out" : "ready";
  return { id: instance.instanceId, label: instance.displayName, state, line: LINE[state] };
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

export function engineHealthBody(instances: readonly EngineHealthInstance[], primaryId: string | null, flux: FluxHealthState, checkedAt: number): EngineHealthAnswer {
  const engines = instances.map(engineRow);
  const primary = (primaryId ? engines.find((row) => row.id === primaryId) : undefined) ?? engines.find((row) => row.state === "ready") ?? engines[0] ?? null;
  return { engines, primary, flux, checkedAt };
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
export async function engineHealthRoute(req: { method: string; url: URL }, deps: EngineHealthDeps): Promise<EngineHealthRouteAnswer | null> {
  if (req.url.pathname !== ENGINE_HEALTH_PATH) return null;
  if (!deps.owner) return { status: 404, body: { error: "no such route" } };
  if (req.method !== "GET") return { status: 405, body: { error: "Use GET to read engine health.", code: "METHOD" } };
  const now = deps.now ?? Date.now;
  if (deps.memo?.body && now() - deps.memo.at < ENGINE_HEALTH_MEMO_MS) return { status: 200, body: deps.memo.body };
  const key = deps.fluxKey();
  const [instances, check] = await Promise.all([
    deps.instances().catch(() => [] as readonly EngineHealthInstance[]),
    key ? boundedCheck(key, deps.checkFlux ?? checkFluxKey) : Promise.resolve(null),
  ]);
  const flux = fluxHealthFrom(key, key ? (deps.refused ?? fluxKeyRefused)(key) : false, check);
  const body = engineHealthBody(instances, deps.primaryId(), flux, now());
  if (deps.memo) { deps.memo.at = body.checkedAt; deps.memo.body = body; }
  return { status: 200, body };
}
