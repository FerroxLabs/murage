import type { api, useStore } from "@/state/store";
import type { TurnLive } from "@/state/turn-status";
import type { createDriver } from "./help-ask-fixture";

type Scope = ReturnType<typeof useStore>;
let driver: ReturnType<typeof createDriver> | undefined;
const pendingObservations: Array<[string, unknown]> = [];
const signedOutListeners = new Set<() => void>();
const listeners = new Set<() => void>();
export const askSubscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
if (import.meta.env.MODE === "help-fixture") {
  void import("./help-ask-fixture").then(({ createDriver }) => {
    driver = createDriver(() => listeners.forEach((listener) => listener()), () => signedOutListeners.forEach((listener) => listener()));
    for (const [kind, value] of pendingObservations.splice(0)) driver.observe(kind, value);
    Object.assign(window, { __helpAskFixture: driver });
    listeners.forEach((listener) => listener());
  });
}
export function askScope(scope: Scope, realApi?: typeof api): Scope {
  if (import.meta.env.MODE === "help-fixture") return driver?.scope(scope, realApi) ?? scope;
  return scope;
}
export function askApi(real: typeof api): typeof api {
  if (import.meta.env.MODE === "help-fixture") return driver ? driver.api(real) : real;
  return real;
}
export function askLive(live: TurnLive): TurnLive {
  if (import.meta.env.MODE === "help-fixture") return driver?.live(live) ?? live;
  return live;
}
export function askStream(stream: Record<string, string>): Record<string, string> {
  if (import.meta.env.MODE === "help-fixture") return driver?.stream(stream) ?? stream;
  return stream;
}
export function askObserve(kind: string, value: unknown): void {
  if (import.meta.env.MODE === "help-fixture") {
    if (driver) driver.observe(kind, value); else pendingObservations.push([kind, value]);
  }
}

export function askOnSignedOut(real: (listener: () => void) => () => void, listener: () => void) {
  const remove = real(listener);
  if (import.meta.env.MODE === "help-fixture") {
    signedOutListeners.add(listener);
    return () => { signedOutListeners.delete(listener); remove(); };
  }
  return remove;
}

export function askSetTimeout(run: () => void, ms: number): ReturnType<typeof setTimeout> {
  if (import.meta.env.MODE === "help-fixture" && driver) return driver.setTimeout(run, ms);
  return setTimeout(run, ms);
}
export function askClearTimeout(handle: ReturnType<typeof setTimeout> | undefined): void {
  if (import.meta.env.MODE === "help-fixture" && driver) { driver.clearTimeout(handle); return; }
  clearTimeout(handle);
}
export function askAddAbort(signal: AbortSignal | undefined, run: () => void) {
  if (import.meta.env.MODE === "help-fixture" && driver) { driver.addAbort(signal, run); return; }
  signal?.addEventListener("abort", run, { once: true });
}
export function askRemoveAbort(signal: AbortSignal | undefined, run: () => void) {
  if (import.meta.env.MODE === "help-fixture" && driver) { driver.removeAbort(signal, run); return; }
  signal?.removeEventListener("abort", run);
}
