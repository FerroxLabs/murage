// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// GET /api/engine-health for Today's first tag and the Health dot (lane L2A).
// One shared read for the whole app: every caller subscribes to the same
// answer, refreshed once a minute, on window focus and when the network comes
// back. Until the route is wired (or on an older server: 404), the answer is
// null and callers fall back to the engine list the app already holds.
import { useEffect, useSyncExternalStore } from "react";
import { api, useStore } from "@/state/store";
import { primaryEngine } from "@/lib/today-model";
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
export function useEngineReading(): { engine: EngineHealthRow | null; flux: FluxHealthState; fromServer: boolean } {
  const server = useEngineHealthAnswer();
  const { state } = useStore();
  if (server) return { engine: server.primary, flux: server.flux, fromServer: true };
  const engines = state.instances.map((instance) => ({ instanceId: instance.instanceId, displayName: instance.displayName, enabled: instance.enabled, snapshot: instance.snapshot }));
  const used = state.bots.filter((bot) => !bot.hidden).map((bot) => bot.modelSelection?.instanceId).filter((id): id is string => Boolean(id));
  const keyState = state.config?.flux?.keyState;
  const flux: FluxHealthState = keyState === "refused" || keyState === "not-flux" ? "key-problem" : state.config?.flux?.configured ? "ok" : "none";
  return { engine: primaryEngine(engines, used), flux, fromServer: false };
}

/** Tests only. */
export function resetEngineHealthForTests(): void {
  answer = null; users = 0; inFlight = null; listeners.clear();
}
