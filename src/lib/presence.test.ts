import { describe, expect, it, vi } from "vitest";
import { Presence, PRESENCE_WINDOW_MS } from "../../server/mobile-presence";
import { browserPresenceDeps, PRESENCE_BEAT_MS, startPresenceReporting, type PresenceDeps } from "./presence";

vi.mock("./live-events", () => ({
  ensureDesktopSurfaceSecret: vi.fn(async () => "s3cret"),
  desktopSurfaceHeaders: () => ({ "x-murage-surface-secret": "s3cret" }),
}));

function deps(over: Partial<PresenceDeps> = {}) {
  const listeners: Array<() => void> = [];
  const timers: Array<() => void> = [];
  const post = vi.fn(async () => undefined);
  let hidden = false;
  const d: PresenceDeps = {
    post,
    isPhone: () => false,
    desktopApp: () => false,
    clientId: () => "tab-12345678",
    hidden: () => hidden,
    onVisibility: (fn) => {
      listeners.push(fn);
      return () => {};
    },
    every: (fn) => {
      timers.push(fn);
      return () => {};
    },
    ...over,
  };
  return { d, post, listeners, timers, setHidden: (v: boolean) => { hidden = v; } };
}

/** window.open and Chrome's Duplicate Tab hand the new page a copy of the
 * opener's sessionStorage; the node environment has none, so give it one. */
function stubSessionStorage(seed: Record<string, string>) {
  const items = new Map(Object.entries(seed));
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => { items.set(key, value); },
  });
}

describe("presence reporting", () => {
  it("reports visible at start, on every beat while visible, and hidden on change", async () => {
    const t = deps();
    const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
    startPresenceReporting(t.d);
    expect(t.post).toHaveBeenLastCalledWith({ clientId: "tab-12345678", visible: true, seq: 1 });
    await settled();
    t.timers[0]();
    expect(t.post).toHaveBeenCalledTimes(2);
    await settled();
    t.setHidden(true);
    t.listeners[0]();
    expect(t.post).toHaveBeenLastCalledWith({ clientId: "tab-12345678", visible: false, seq: 3 });
    await settled();
    t.timers[0]();
    expect(t.post).toHaveBeenCalledTimes(3);
  });
  it("never reports from the phone app or a phone browser", () => {
    const t = deps({ isPhone: () => true });
    startPresenceReporting(t.d);
    expect(t.post).not.toHaveBeenCalled();
  });

  // E1, 2026-09-29: a terminal covering the Murage window made Electron
  // report it hidden, which ended presence and buzzed the phones at the desk.
  // In the desktop app the main process reports the desk (Mac in use, screen
  // unlocked: electron/desk-presence.mjs), so the window says nothing at all.
  it("never reports from the desktop app's own window: the main process owns the desk there", () => {
    const t = deps({ desktopApp: () => true });
    startPresenceReporting(t.d);
    t.setHidden(true);
    t.listeners[0]?.();
    t.timers[0]?.();
    expect(t.post).not.toHaveBeenCalled();
  });

  it("knows the desktop app by its preload bridge, and a browser tab by its absence", () => {
    vi.stubGlobal("window", { muragebox: { platform: "darwin" } });
    try {
      expect(browserPresenceDeps().desktopApp()).toBe(true);
      vi.stubGlobal("window", {});
      expect(browserPresenceDeps().desktopApp()).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(browserPresenceDeps().desktopApp()).toBe(false);
  });

  it("reports as the proven desktop surface, so the route does not refuse the desktop app (E1)", async () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);
    try {
      await browserPresenceDeps().post({ clientId: "tab-12345678", visible: true, seq: 1 });
      const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("/api/presence");
      expect(init.headers).toMatchObject({ "x-murage-surface": "desktop", "x-murage-surface-secret": "s3cret" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // The flap on Sean's Murage (2026-09-28): an approval was held at 23:03:57,
  // then two "done" pushes went out at 23:04:37 and 23:06:06 with Murage in
  // front. Each of these is a way a desk that is being looked at reads absent.

  it("gives every page its own id, even when a window.open child or a duplicated tab copied sessionStorage", () => {
    stubSessionStorage({ "murage.presenceId": "copiedfromopener00000000" });
    try {
      const first = browserPresenceDeps().clientId();
      const second = browserPresenceDeps().clientId();
      expect(first).not.toBe("copiedfromopener00000000");
      expect(second).not.toBe(first);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a second window going hidden cannot end the first window's presence", () => {
    const presence = new Presence(() => 0);
    const post = async (body: { clientId: string; visible: boolean; seq: number }) => presence.report(body.clientId, body.visible, body.seq);
    const wire = (hidden: boolean) => {
      const listeners: Array<() => void> = [];
      startPresenceReporting({ ...browserPresenceDeps(), post, hidden: () => hidden, onVisibility: (fn) => { listeners.push(fn); return () => {}; }, every: () => () => {} });
      return listeners;
    };
    stubSessionStorage({ "murage.presenceId": "sharedbysessionstorage00" });
    try {
      wire(false);
      wire(true);
      expect(presence.present()).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("one lost beat never lets a visible window lapse on the host", async () => {
    let now = 0;
    const presence = new Presence(() => now);
    let beat: () => void = () => {};
    let every = 0;
    let beats = 0;
    startPresenceReporting({
      post: async (body) => {
        // the first beat after the start report never arrives (a slow or failed fetch)
        if (beats++ === 1) throw new Error("lost");
        presence.report(body.clientId, body.visible);
      },
      isPhone: () => false,
      desktopApp: () => false,
      clientId: () => "tab-12345678",
      hidden: () => false,
      onVisibility: () => () => {},
      every: (fn, ms) => { beat = fn; every = ms; return () => {}; },
    });
    for (now = 0; now <= 5 * 60_000; now += 1_000) {
      if (now > 0 && now % every === 0) beat();
      await Promise.resolve();
      await Promise.resolve();
      expect(presence.present(), `present at ${now / 1000}s`).toBe(true);
    }
    expect(PRESENCE_BEAT_MS * 3).toBeLessThanOrEqual(PRESENCE_WINDOW_MS);
  });

  it("sends one report at a time, so a hidden flicker cannot land after the visible that followed it", async () => {
    const presence = new Presence(() => 0);
    const pending: Array<{ body: { clientId: string; visible: boolean; seq: number }; done: () => void }> = [];
    let inFlight = 0;
    let most = 0;
    const listeners: Array<() => void> = [];
    let hidden = false;
    startPresenceReporting({
      post: (body) => new Promise<void>((resolve) => {
        inFlight++;
        most = Math.max(most, inFlight);
        pending.push({ body, done: () => { presence.report(body.clientId, body.visible); inFlight--; resolve(); } });
      }),
      isPhone: () => false,
      desktopApp: () => false,
      clientId: () => "tab-12345678",
      hidden: () => hidden,
      onVisibility: (fn) => { listeners.push(fn); return () => {}; },
      every: () => () => {},
    });
    hidden = true;
    listeners[0]();
    hidden = false;
    listeners[0]();
    // the host answers the newest request first, the oldest last
    while (pending.length) {
      pending.pop()!.done();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(most).toBe(1);
    expect(presence.present()).toBe(true);
  });

  it("a window coming to the front reports at once, and a report cannot hang the queue", async () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
    try {
      const d = browserPresenceDeps();
      const listener = vi.fn();
      const stop = d.onVisibility(listener);
      window.dispatchEvent(new Event("focus"));
      expect(listener).toHaveBeenCalledTimes(1);
      stop();
      window.dispatchEvent(new Event("focus"));
      expect(listener).toHaveBeenCalledTimes(1);
      await d.post({ clientId: "tab-12345678", visible: true, seq: 1 });
      const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
      expect(init.signal).toBeInstanceOf(AbortSignal);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("numbers each report it sends, rising, so the host can drop a late one", async () => {
    const t = deps();
    const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
    startPresenceReporting(t.d);
    await settled();
    t.timers[0]();
    await settled();
    t.setHidden(true);
    t.listeners[0]();
    await settled();
    expect(t.post.mock.calls.map((call) => (call as unknown as [{ seq: number }])[0].seq)).toEqual([1, 2, 3]);
  });
});
