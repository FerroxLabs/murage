// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Is this device on the internet? (UX 1.0.13, lane L2A, the offline band.)
//
// The browser's own online/offline events are the signal. They flap: a Wi-Fi
// hand-off or a sleeping laptop can drop the connection for a second, and a
// band that blinks on and off is worse than none. So going OFFLINE waits
// OFFLINE_DEBOUNCE_MS of continuous offline before it shows, and coming back
// ONLINE clears it at once (good news never waits).
//
// This is not "can I reach Murage": the server banner (ServerLifecycleBanner)
// and the phone's RemoteConnectionBanner already say that, with their own
// fixes. Bots on this computer keep working offline; only connected apps and
// Flux Router wait, which is what the band says.
import { useSyncExternalStore } from "react";

export const OFFLINE_DEBOUNCE_MS = 3_000;

export type Connectivity = "online" | "offline";

export interface ConnectivityEnv {
  isOnline: () => boolean;
  on: (event: "online" | "offline", listener: () => void) => void;
  off: (event: "online" | "offline", listener: () => void) => void;
  setTimer: (run: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

export interface ConnectivityWatch {
  get: () => Connectivity;
  subscribe: (listener: () => void) => () => void;
  dispose: () => void;
}

/** A debounced watch over an environment (the real window, or a test's fake one). */
export function watchConnectivity(env: ConnectivityEnv, debounceMs = OFFLINE_DEBOUNCE_MS): ConnectivityWatch {
  // Starting offline counts as offline at once: there is nothing to debounce
  // against, and an app opened with no network should say so straight away.
  let value: Connectivity = env.isOnline() ? "online" : "offline";
  let pending: unknown = null;
  const listeners = new Set<() => void>();
  const set = (next: Connectivity) => {
    if (next === value) return;
    value = next;
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* one listener must not stop the rest */ }
    }
  };
  const cancel = () => {
    if (pending !== null) env.clearTimer(pending);
    pending = null;
  };
  const onOffline = () => {
    if (pending !== null || value === "offline") return;
    pending = env.setTimer(() => {
      pending = null;
      // Re-read: an online event may have been missed while waiting.
      if (!env.isOnline()) set("offline");
    }, debounceMs);
  };
  const onOnline = () => {
    cancel();
    set("online");
  };
  env.on("offline", onOffline);
  env.on("online", onOnline);
  return {
    get: () => value,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose: () => {
      cancel();
      env.off("offline", onOffline);
      env.off("online", onOnline);
      listeners.clear();
    },
  };
}

function windowEnv(): ConnectivityEnv | null {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return null;
  return {
    isOnline: () => (typeof navigator === "undefined" ? true : navigator.onLine !== false),
    on: (event, listener) => window.addEventListener(event, listener),
    off: (event, listener) => window.removeEventListener(event, listener),
    setTimer: (run, ms) => window.setTimeout(run, ms),
    clearTimer: (handle) => window.clearTimeout(handle as number),
  };
}

let shared: ConnectivityWatch | null = null;
function sharedWatch(): ConnectivityWatch | null {
  if (shared) return shared;
  const env = windowEnv();
  if (!env) return null;
  shared = watchConnectivity(env);
  return shared;
}

const subscribeShared = (listener: () => void) => sharedWatch()?.subscribe(listener) ?? (() => undefined);
const readShared = (): Connectivity => sharedWatch()?.get() ?? "online";
const readServer = (): Connectivity => "online";

/** "online" | "offline" for this device, debounced. Server render: always online. */
export function useConnectivity(): Connectivity {
  return useSyncExternalStore(subscribeShared, readShared, readServer);
}
