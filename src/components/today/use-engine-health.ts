// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// GET /api/engine-health for Today's first tag and the Health dot (lane L2A).
// One shared read for the whole app: every caller subscribes to the same
// answer, refreshed once a minute, on window focus and when the network comes
// back. Until the route is wired (or on an older server: 404), the answer is
// null and callers fall back to the engine list the app already holds.
import { useEffect, useSyncExternalStore } from "react";
import { api, useStoreIfAny } from "@/state/store";
import { engineState, healthEngine, primaryEngine } from "@/lib/today-model";
import type { EngineHealthAnswer, EngineHealthRow, FluxHealthState } from "@/components/shell/shell-contract";

export const ENGINE_HEALTH_PATH = "/api/engine-health";
export const ENGINE_HEALTH_REFRESH_MS = 60_000;

let answer: EngineHealthAnswer | null = null;
let users = 0;
let timer = 0;
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish(next: EngineHealthAnswer | null) {
  answer = next;
  for (const listener of [...listeners]) listener();
}

function refresh(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (api(ENGINE_HEALTH_PATH) as Promise<EngineHealthAnswer>)
    .then((value) => { publish(value && Array.isArray(value.engines) ? value : null); })
    // A route that is not there yet, or a server that is away: no answer, never a wrong one.
    .catch(() => { publish(null); })
    .finally(() => { inFlight = null; });
  return inFlight;
}

function start() {
  users += 1;
  if (users > 1) return;
  void refresh();
  timer = window.setInterval(() => { void refresh(); }, ENGINE_HEALTH_REFRESH_MS);
  window.addEventListener("focus", onWake);
  window.addEventListener("online", onWake);
}

function stop() {
  users = Math.max(0, users - 1);
  if (users > 0) return;
  window.clearInterval(timer);
  window.removeEventListener("focus", onWake);
  window.removeEventListener("online", onWake);
}

function onWake() { void refresh(); }

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const read = () => answer;
const readServer = () => null;

/** The server's answer, or null while there is none. */
export function useEngineHealthAnswer(): EngineHealthAnswer | null {
  useEffect(() => { start(); return stop; }, []);
  return useSyncExternalStore(subscribe, read, readServer);
}

/** The engine Today names and the Flux state: the server's answer when it has one, else the app's own engine list. */
/** `engine` is the one Today names; `health` is the one the Health level reads (healthEngine): the default and the
 * engines bots use, never an unused fallback. */
export interface EngineReadingAnswer { engine: EngineHealthRow | null; health: EngineHealthRow | null; flux: FluxHealthState; fromServer: boolean }

/** The server's default id, or the primary's on an older server that does not send one. */
export function answerDefaultId(server: EngineHealthAnswer): string | null {
  return server.defaultId !== undefined ? server.defaultId : server.primary?.id ?? null;
}

export function useEngineReading(): EngineReadingAnswer {
  const server = useEngineHealthAnswer();
  // The Inbox reads this too, and it also renders with no store around it (its own page fixtures).
  const state = useStoreIfAny()?.state;
  if (server) return { engine: server.primary, health: healthEngine(server.engines, answerDefaultId(server)), flux: server.flux, fromServer: true };
  if (!state) return { engine: null, health: null, flux: "none", fromServer: false };
  const engines = state.instances.map((instance) => ({ instanceId: instance.instanceId, displayName: instance.displayName, enabled: instance.enabled, driverKind: instance.driverKind, snapshot: instance.snapshot }));
  const used = state.bots.filter((bot) => !bot.hidden).map((bot) => bot.modelSelection?.instanceId).filter((id): id is string => Boolean(id));
  const keyState = state.config?.flux?.keyState;
  const flux: FluxHealthState = keyState === "refused" || keyState === "not-flux" ? "key-problem" : state.config?.flux?.configured ? "ok" : "none";
  const counts = new Map<string, number>();
  for (const id of used) counts.set(id, (counts.get(id) ?? 0) + 1);
  const rows: EngineHealthRow[] = engines.map((e) => ({ id: e.instanceId, label: e.displayName, state: engineState(e), line: "", usedBy: counts.get(e.instanceId) ?? 0 }));
  return { engine: primaryEngine(engines, used), health: healthEngine(rows, null), flux, fromServer: false };
}

/** Read the answer again now (Health's Check again and Switch on), for everyone showing it. A read already on its way
 * started before the change, so a fresh one follows it. True when an answer came back. */
export function refreshEngineHealth(): Promise<boolean> {
  const fresh = () => refresh().then(() => answer !== null);
  return inFlight ? inFlight.then(fresh, fresh) : fresh();
}

/** Tests only. */
export function resetEngineHealthForTests(): void {
  answer = null; users = 0; inFlight = null; listeners.clear();
}
