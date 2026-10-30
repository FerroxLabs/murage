// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The offline band's signal (UX 1.0.13, lane L2A): going offline waits three
// seconds of continuous offline; coming back clears at once.
import { describe, expect, it, vi } from "vitest";
import { OFFLINE_DEBOUNCE_MS, watchConnectivity, type ConnectivityEnv } from "./connectivity";

function fakeEnv(online: boolean) {
  const handlers: Record<string, Array<() => void>> = { online: [], offline: [] };
  let timers: Array<{ run: () => void; at: number; id: number }> = [];
  let clock = 0, nextId = 1;
  const state = { online };
  const env: ConnectivityEnv = {
    isOnline: () => state.online,
    on: (event, listener) => { handlers[event]!.push(listener); },
    off: (event, listener) => { handlers[event] = handlers[event]!.filter((item) => item !== listener); },
    setTimer: (run, ms) => { const id = nextId++; timers.push({ run, at: clock + ms, id }); return id; },
    clearTimer: (handle) => { timers = timers.filter((timer) => timer.id !== handle); },
  };
  return {
    env,
    go(next: boolean) { state.online = next; for (const listener of [...handlers[next ? "online" : "offline"]!]) listener(); },
    advance(ms: number) {
      clock += ms;
      const due = timers.filter((timer) => timer.at <= clock);
      timers = timers.filter((timer) => timer.at > clock);
      for (const timer of due) timer.run();
    },
    listeners: () => handlers.online!.length + handlers.offline!.length,
  };
}

describe("watchConnectivity", () => {
  it("starts offline at once when the app opens with no network", () => {
    expect(watchConnectivity(fakeEnv(false).env).get()).toBe("offline");
  });

  it("waits three seconds of continuous offline before saying so", () => {
    const fake = fakeEnv(true);
    const watch = watchConnectivity(fake.env);
    const seen = vi.fn();
    watch.subscribe(seen);
    fake.go(false);
    fake.advance(OFFLINE_DEBOUNCE_MS - 1);
    expect(watch.get()).toBe("online");
    fake.advance(1);
    expect(watch.get()).toBe("offline");
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("ignores a blip shorter than the wait, and clears at once when the network is back", () => {
    const fake = fakeEnv(true);
    const watch = watchConnectivity(fake.env);
    fake.go(false);
    fake.advance(1_000);
    fake.go(true);
    fake.advance(OFFLINE_DEBOUNCE_MS);
    expect(watch.get()).toBe("online");
    fake.go(false);
    fake.advance(OFFLINE_DEBOUNCE_MS);
    expect(watch.get()).toBe("offline");
    fake.go(true);
    expect(watch.get()).toBe("online");
  });

  it("re-reads the network when the wait ends, in case the online event was missed", () => {
    const fake = fakeEnv(true);
    const watch = watchConnectivity(fake.env);
    fake.go(false);
    (fake.env as { isOnline: () => boolean }).isOnline = () => true;
    fake.advance(OFFLINE_DEBOUNCE_MS);
    expect(watch.get()).toBe("online");
  });

  it("lets go of its listeners and timer when disposed", () => {
    const fake = fakeEnv(true);
    const watch = watchConnectivity(fake.env);
    fake.go(false);
    watch.dispose();
    expect(fake.listeners()).toBe(0);
    fake.advance(OFFLINE_DEBOUNCE_MS);
    expect(watch.get()).toBe("online");
  });
});
