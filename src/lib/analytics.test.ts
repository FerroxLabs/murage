// The opt-out has one job that matters: an install that turned analytics off
// must not talk to PostHog at all. optAction pins the decision, and the
// storage round-trip pins that the choice survives a restart.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { analyticsEnabled, initAnalytics, optAction, setAnalyticsEnabled } from "./analytics";

// The suite runs on the node environment, which has no localStorage.
const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});

beforeEach(() => store.clear());

describe("optAction", () => {
  it("initialises on the first opt-in of a session that started off", () => {
    expect(optAction(true, false)).toBe("init");
  });

  it("opts a running client back in rather than initialising twice", () => {
    expect(optAction(true, true)).toBe("opt-in");
  });

  it("stops a running client without waiting for a restart", () => {
    expect(optAction(false, true)).toBe("opt-out");
  });

  it("does nothing when there is no client to stop", () => {
    // The important half: opting out before init must not reach PostHog to
    // tell it so — that request would itself be the leak.
    expect(optAction(false, false)).toBe("none");
  });
});

describe("the stored choice", () => {
  it("is on for a fresh install", () => {
    expect(analyticsEnabled()).toBe(true);
  });

  it("survives a restart once opted out", () => {
    setAnalyticsEnabled(false);
    expect(analyticsEnabled()).toBe(false); // same read a later launch performs
  });

  it("can be turned back on", () => {
    setAnalyticsEnabled(false);
    setAnalyticsEnabled(true);
    expect(analyticsEnabled()).toBe(true);
  });

  it("treats unusable storage as a fresh install rather than failing", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });
    expect(analyticsEnabled()).toBe(true);
    expect(() => setAnalyticsEnabled(false)).not.toThrow();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
  });
});

describe("initAnalytics while opted out", () => {
  it("returns before touching the client or the install marker", () => {
    // No client is stubbed here on purpose: if init() got past the guard it
    // would reach the real posthog-js, and the missing marker proves it did
    // not — opting back in later still counts the install.
    setAnalyticsEnabled(false);
    initAnalytics();
    expect(store.get("omb-installed")).toBeUndefined();
  });
});
