import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEV_SECRET_PATH,
  LIVE_EVENTS_STALE_MS,
  desktopSurfaceHeaders,
  desktopSurfaceSecret,
  desktopSurfaceSecretNeedsRetry,
  ensureDesktopSurfaceSecret,
  isLivePing,
  liveEventsUrl,
  openLiveEvents,
  setDesktopSurfaceSecretForTest,
  shouldReconnectLiveEvents,
  type LiveEventSourceLike,
  type LiveEventsPlatform,
} from "./live-events";

class FakeTarget {
  private readonly listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, listener: () => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: () => void) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string) {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }

  count(type: string) {
    return this.listeners.get(type)?.size ?? 0;
  }
}

class FakeEventSource implements LiveEventSourceLike {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string; lastEventId?: string }) => void) | null = null;
  close = vi.fn();

  constructor(readonly url: string) {}

  open() {
    this.onopen?.();
  }

  error() {
    this.onerror?.();
  }

  message<T extends { kind: string }>(frame: T, lastEventId = "") {
    this.onmessage?.({ data: JSON.stringify(frame), lastEventId });
  }
}

function harness(options?: { online?: boolean; visible?: boolean; now?: number }) {
  const sources: FakeEventSource[] = [];
  const windowTarget = new FakeTarget();
  const documentTarget = new FakeTarget();
  let online = options?.online ?? true;
  let visible = options?.visible ?? true;
  let now = options?.now ?? 0;
  const platform: LiveEventsPlatform = {
    createEventSource: (url) => {
      const source = new FakeEventSource(url);
      sources.push(source);
      return source;
    },
    windowTarget,
    documentTarget,
    isOnline: () => online,
    isVisible: () => visible,
    now: () => now,
  };
  return {
    sources,
    platform,
    windowTarget,
    documentTarget,
    setOnline(value: boolean) {
      online = value;
    },
    setVisible(value: boolean) {
      visible = value;
    },
    setNow(value: number) {
      now = value;
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("live events URL", () => {
  it("builds cold, resumable, and screen-free stream URLs", () => {
    expect(liveEventsUrl()).toBe("/api/events?surface=desktop");
    expect(liveEventsUrl({ screens: true })).toBe("/api/events?surface=desktop");
    expect(liveEventsUrl({ since: "ab12cd34:9" })).toBe("/api/events?surface=desktop&since=ab12cd34%3A9");
    expect(liveEventsUrl({ since: "ab12cd34:9", screens: false })).toBe(
      "/api/events?surface=desktop&since=ab12cd34%3A9&screens=off",
    );
    expect(liveEventsUrl({ screens: false })).toBe("/api/events?surface=desktop&screens=off");
  });

  // EventSource cannot set a request header, which is why the marker travels
  // in the query string — and it is why the proof has to as well. Without it
  // the harness reads this stream as a paired phone's and scopes it, and the
  // symptom is a desktop that silently stops seeing its own hidden bots.
  it("carries this launch's desktop secret once the renderer has one", () => {
    const secret = "9".repeat(64);
    try {
      setDesktopSurfaceSecretForTest(secret);
      expect(desktopSurfaceSecret()).toBe(secret);
      expect(liveEventsUrl()).toBe(`/api/events?surface=desktop&surfaceSecret=${secret}`);
      // appended last, so every parameter that existed before keeps its place
      expect(liveEventsUrl({ since: "ab12cd34:9", screens: false })).toBe(
        `/api/events?surface=desktop&since=ab12cd34%3A9&screens=off&surfaceSecret=${secret}`,
      );
      // and the same proof for the fetch callers, who can use a header
      expect(desktopSurfaceHeaders()).toEqual({ "x-murage-surface-secret": secret });
    } finally {
      setDesktopSurfaceSecretForTest("");
    }
  });

  // The dev half of the injection, from the renderer's side: served by Vite
  // on another port, no Electron bridge to ask through, so it asks the
  // harness over loopback. `import.meta.env.DEV` is a compile-time constant,
  // so a production `vite build` deletes this branch outright — the shipped
  // bundle has no code that could ask.
  describe("acquiring the secret in development", () => {
    const realFetch = globalThis.fetch;
    afterEach(() => {
      globalThis.fetch = realFetch;
      setDesktopSurfaceSecretForTest("");
    });

    it("asks the harness once and remembers the answer", async () => {
      const secret = "b".repeat(64);
      const calls: string[] = [];
      globalThis.fetch = (async (input: unknown) => {
        calls.push(String(input));
        return { ok: true, json: async () => ({ secret }) } as unknown as Response;
      }) as typeof fetch;

      expect(await ensureDesktopSurfaceSecret()).toBe(secret);
      expect(calls).toEqual([DEV_SECRET_PATH]);
      // and the stream URL is built from it immediately afterwards
      expect(liveEventsUrl()).toContain(`surfaceSecret=${secret}`);
      // memoized — a second caller must not re-ask
      expect(await ensureDesktopSurfaceSecret()).toBe(secret);
      expect(calls).toHaveLength(1);
    });

    it("leaves the renderer on the scoped surface when the harness withholds one", async () => {
      // A packaged harness answers 404 here, and so does a cloud install. The
      // renderer must degrade to the narrow view rather than throw during
      // boot: a smaller app, not a broken one.
      globalThis.fetch = (async () => ({ ok: false, json: async () => ({}) }) as unknown as Response) as typeof fetch;
      expect(await ensureDesktopSurfaceSecret()).toBe("");
      expect(liveEventsUrl()).toBe("/api/events?surface=desktop");
    });

    it("does not ask at all once it already holds one", async () => {
      // The packaged path: the preload answered synchronously at page load.
      setDesktopSurfaceSecretForTest("c".repeat(64));
      let asked = false;
      globalThis.fetch = (async () => {
        asked = true;
        return { ok: true, json: async () => ({ secret: "wrong" }) } as unknown as Response;
      }) as typeof fetch;
      expect(await ensureDesktopSurfaceSecret()).toBe("c".repeat(64));
      expect(asked).toBe(false);
    });
  });

  it("sends no proof at all rather than an empty one", () => {
    // An empty header would be a wrong secret, not a missing one. The harness
    // answers `remote` either way, but a request that never claims to hold a
    // proof is the honest description of a renderer that has not been given
    // one — and it keeps these URLs byte-identical to the pre-secret ones.
    setDesktopSurfaceSecretForTest("");
    expect(liveEventsUrl()).toBe("/api/events?surface=desktop");
    expect(desktopSurfaceHeaders()).toEqual({});
  });
});

describe("live events supervisor", () => {
  it("uses data pings as liveness without forwarding them", () => {
    const test = harness();
    const onFrame = vi.fn();
    const stop = openLiveEvents(
      { onFrame, onSnapshotRequired: async () => true, staleMs: 1_000 },
      test.platform,
    );

    expect(test.sources).toHaveLength(1);
    test.sources[0].open();
    test.sources[0].message({ kind: "message" }, "run00000:4");
    test.setNow(900);
    test.sources[0].message({ kind: "ping" }, "run00000:999");
    vi.advanceTimersByTime(1_500);
    test.setNow(1_899);
    expect(test.sources).toHaveLength(1);
    expect(onFrame).toHaveBeenCalledOnce();

    test.setNow(1_900);
    vi.advanceTimersByTime(500);
    expect(test.sources).toHaveLength(2);
    expect(test.sources[1].url).toBe("/api/events?surface=desktop&since=run00000%3A4");
    expect(test.sources[0].close).toHaveBeenCalledOnce();
    stop();
  });

  it("ignores frames from a stream generation after replacing it", () => {
    const test = harness();
    const onFrame = vi.fn();
    const stop = openLiveEvents(
      { onFrame, onSnapshotRequired: async () => true, retryMinMs: 100, retryMaxMs: 100 },
      test.platform,
    );
    const staleHandler = test.sources[0].onmessage;

    test.sources[0].error();
    vi.advanceTimersByTime(100);
    staleHandler?.({ data: JSON.stringify({ kind: "message", value: "stale" }), lastEventId: "old:9" });
    test.sources[1].message({ kind: "message", value: "current" }, "new:1");

    expect(onFrame).toHaveBeenCalledOnce();
    expect(onFrame).toHaveBeenCalledWith({ kind: "message", value: "current" });
    stop();
  });

  it("commits a refused-resume boundary only after its replacement snapshot succeeds", async () => {
    const test = harness();
    const frames: unknown[] = [];
    const snapshotResolutions: Array<(loaded: boolean) => void> = [];
    const stop = openLiveEvents(
      {
        onFrame: (frame) => frames.push(frame),
        onSnapshotRequired: () =>
          new Promise<boolean>((resolve) => snapshotResolutions.push(resolve)),
        retryMinMs: 100,
        retryMaxMs: 100,
      },
      test.platform,
    );

    test.sources[0].message({ kind: "message" }, "oldrun00:10");
    test.sources[0].error();
    vi.advanceTimersByTime(100);
    expect(test.sources[1].url).toBe("/api/events?surface=desktop&since=oldrun00%3A10");

    // The server has three replay frames queued. If the socket dies before
    // they arrive, the next attempt still asks from the last consumed frame.
    test.sources[1].message({ kind: "hello", resumed: true, cursor: "oldrun00:13" });
    test.sources[1].error();
    vi.advanceTimersByTime(100);
    expect(test.sources[2].url).toBe("/api/events?surface=desktop&since=oldrun00%3A10");

    // A restart/expired replay window has no frames to replay. Application
    // frames may arrive while the consumer rebuilds, but neither their id nor
    // the hello boundary is safe until that replacement snapshot succeeds.
    test.sources[2].message({ kind: "hello", resumed: false, cursor: "newrun00:7" });
    test.sources[2].message({ kind: "message", value: "behind failed snapshot" }, "newrun00:8");
    snapshotResolutions.shift()?.(false);
    await Promise.resolve();
    vi.advanceTimersByTime(100);
    expect(test.sources[3].url).toBe("/api/events?surface=desktop&since=oldrun00%3A10");

    test.sources[3].message({ kind: "hello", resumed: false, cursor: "newrun00:8" });
    test.sources[3].message({ kind: "message", value: "after snapshot" }, "newrun00:9");
    snapshotResolutions.shift()?.(true);
    await Promise.resolve();
    test.sources[3].error();
    vi.advanceTimersByTime(100);
    expect(test.sources[4].url).toBe("/api/events?surface=desktop&since=newrun00%3A9");
    expect(frames).toEqual([
      { kind: "message" },
      { kind: "message", value: "behind failed snapshot" },
      { kind: "message", value: "after snapshot" },
    ]);
    stop();
  });

  it("caps retry backoff when opening the stream keeps failing", () => {
    const attempts: number[] = [];
    const onError = vi.fn();
    const platform: LiveEventsPlatform = {
      createEventSource: () => {
        attempts.push(Date.now());
        throw new Error("offline");
      },
      isOnline: () => true,
      isVisible: () => true,
      now: Date.now,
    };

    vi.setSystemTime(0);
    const stop = openLiveEvents(
      {
        onFrame: vi.fn(),
        onSnapshotRequired: async () => true,
        onError,
        retryMinMs: 100,
        retryMaxMs: 400,
        staleMs: 10_000,
      },
      platform,
    );
    vi.advanceTimersByTime(1_100);

    expect(attempts).toEqual([0, 100, 300, 700, 1_100]);
    expect(onError).toHaveBeenCalledTimes(5);
    stop();
  });

  it("backs off an open/error flap until the stream survives a heartbeat", () => {
    const test = harness();
    const stop = openLiveEvents(
      {
        onFrame: vi.fn(),
        onSnapshotRequired: async () => true,
        retryMinMs: 100,
        retryMaxMs: 400,
        staleMs: 10_000,
      },
      test.platform,
    );

    test.sources[0].open();
    test.sources[0].error();
    vi.advanceTimersByTime(99);
    expect(test.sources).toHaveLength(1);
    vi.advanceTimersByTime(1);
    test.sources[1].open();
    test.sources[1].error();
    vi.advanceTimersByTime(199);
    expect(test.sources).toHaveLength(2);
    vi.advanceTimersByTime(1);
    test.sources[2].open();
    test.sources[2].message({ kind: "ping" });
    test.sources[2].error();
    vi.advanceTimersByTime(99);
    expect(test.sources).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(test.sources).toHaveLength(4);
    stop();
  });

  it("does not churn a suspended hidden stream and recovers once visible", () => {
    const test = harness({ visible: false });
    const stop = openLiveEvents(
      {
        onFrame: vi.fn(),
        onSnapshotRequired: async () => true,
        staleMs: 1_000,
        retryMinMs: 100,
        retryMaxMs: 100,
      },
      test.platform,
    );

    test.setNow(10_000);
    vi.advanceTimersByTime(10_000);
    expect(test.sources).toHaveLength(1);

    // Even an explicit transport error stays quiet in the background; the
    // visibility edge below is the single owner of recovery.
    test.sources[0].error();
    vi.advanceTimersByTime(1_000);
    expect(test.sources).toHaveLength(1);

    test.setVisible(true);
    test.documentTarget.emit("visibilitychange");
    expect(test.sources).toHaveLength(2);
    expect(test.sources[0].close).toHaveBeenCalledOnce();
    stop();
  });

  it("recovers immediately on online/focus/visible and removes every owner on cleanup", () => {
    const test = harness({ online: false });
    const stop = openLiveEvents(
      { onFrame: vi.fn(), onSnapshotRequired: async () => true, staleMs: 1_000 },
      test.platform,
    );
    expect(test.sources).toHaveLength(0);

    test.setOnline(true);
    test.windowTarget.emit("online");
    expect(test.sources).toHaveLength(1);

    test.setNow(1_001);
    test.windowTarget.emit("focus");
    expect(test.sources).toHaveLength(2);
    expect(test.sources[0].close).toHaveBeenCalledOnce();

    test.setVisible(false);
    test.setNow(2_002);
    test.documentTarget.emit("visibilitychange");
    expect(test.sources).toHaveLength(2);
    test.setVisible(true);
    test.documentTarget.emit("visibilitychange");
    expect(test.sources).toHaveLength(3);

    stop();
    stop();
    expect(test.sources[2].close).toHaveBeenCalledOnce();
    expect(test.windowTarget.count("online")).toBe(0);
    expect(test.windowTarget.count("focus")).toBe(0);
    expect(test.documentTarget.count("visibilitychange")).toBe(0);
  });
});

describe("desktop proof recovery", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setDesktopSurfaceSecretForTest("");
  });

  it("distinguishes a temporary secret failure from an explicit refusal", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", request);
    expect(await ensureDesktopSurfaceSecret()).toBe("");
    expect(desktopSurfaceSecretNeedsRetry()).toBe(true);
    expect(await ensureDesktopSurfaceSecret()).toBe("");
    expect(desktopSurfaceSecretNeedsRetry()).toBe(false);
  });

  it("renews a previous launch's proof before reconnecting the stream", async () => {
    setDesktopSurfaceSecretForTest("old-launch");
    const request = vi.fn().mockResolvedValue(Response.json({ secret: "new-launch" }));
    vi.stubGlobal("fetch", request);
    const test = harness();
    const stop = openLiveEvents({ onFrame: vi.fn(), onSnapshotRequired: async () => true }, test.platform);
    expect(test.sources[0].url).toContain("surfaceSecret=old-launch");
    test.sources[0].error();
    await vi.advanceTimersByTimeAsync(500);
    expect(request).toHaveBeenCalledExactlyOnceWith(DEV_SECRET_PATH);
    expect(test.sources).toHaveLength(2);
    expect(test.sources[1].url).toContain("surfaceSecret=new-launch");
    expect(desktopSurfaceHeaders()).toEqual({ "x-murage-surface-secret": "new-launch" });
    stop();
  });

  it("does not probe a forbidden secret endpoint on remote reconnects", async () => {
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", request);
    await ensureDesktopSurfaceSecret();
    const test = harness();
    const stop = openLiveEvents({ onFrame: vi.fn(), onSnapshotRequired: async () => true }, test.platform);
    for (let attempt = 0; attempt < 3; attempt++) {
      test.sources.at(-1)!.error();
      await vi.advanceTimersByTimeAsync(2_000);
    }
    expect(test.sources).toHaveLength(4);
    expect(request).toHaveBeenCalledTimes(1);
    stop();
  });

  it("retries a temporarily unavailable proof before opening a replacement stream", async () => {
    setDesktopSurfaceSecretForTest("old-launch");
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ secret: "new-launch" }));
    vi.stubGlobal("fetch", request);
    const test = harness();
    const stop = openLiveEvents({ onFrame: vi.fn(), onSnapshotRequired: async () => true }, test.platform);
    test.sources[0].error();
    await vi.advanceTimersByTimeAsync(500);
    expect(test.sources).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(test.sources).toHaveLength(2);
    expect(test.sources[1].url).toContain("surfaceSecret=new-launch");
    expect(request).toHaveBeenCalledTimes(2);
    stop();
  });

  it("does not reopen after stopping during a pending proof refresh", async () => {
    setDesktopSurfaceSecretForTest("old-launch");
    let release!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { release = resolve; })));
    const test = harness();
    const stop = openLiveEvents({ onFrame: vi.fn(), onSnapshotRequired: async () => true }, test.platform);
    test.sources[0].error();
    await vi.advanceTimersByTimeAsync(500);
    stop();
    release(Response.json({ secret: "new-launch" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(test.sources).toHaveLength(1);
    expect(test.windowTarget.count("focus")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shares proof refresh with callers that would otherwise reuse a stale secret", async () => {
    setDesktopSurfaceSecretForTest("old-launch");
    let release!: (response: Response) => void;
    const request = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
    vi.stubGlobal("fetch", request);
    const first = ensureDesktopSurfaceSecret(true);
    expect(ensureDesktopSurfaceSecret()).toBe(first);
    expect(ensureDesktopSurfaceSecret(true)).toBe(first);
    release(Response.json({ secret: "new-launch" }));
    expect(await first).toBe("new-launch");
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("live event liveness predicates", () => {
  it("recognizes only ping frames and reconnects at the stale boundary", () => {
    expect(isLivePing({ kind: "ping" })).toBe(true);
    expect(isLivePing({ kind: "message" })).toBe(false);
    expect(shouldReconnectLiveEvents(0, LIVE_EVENTS_STALE_MS - 1)).toBe(false);
    expect(shouldReconnectLiveEvents(0, LIVE_EVENTS_STALE_MS)).toBe(true);
  });
});

describe("the secret's production path", () => {
  // The configuration this closes: a production bundle served by a harness
  // that Electron did not fork. The bridge is present, so the renderer knows
  // it is the desktop; the bridge carries no secret, because the secret only
  // travels over the fork's private channel; so the harness answered "remote"
  // to everything the renderer asked. Enabled buttons that 404 on press.
  it("asks the harness even in a production bundle", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./live-events.ts", import.meta.url)),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    // The guard that used to compile this fetch out of the shipped bundle.
    expect(source).not.toContain("import.meta.env.DEV");
    expect(source).toContain('export const DEV_SECRET_PATH = "/api/desktop-secret"');
  });

  it("is still refused at the browser door, which is the lock that matters", async () => {
    // Dropping a compile-time guard is only safe because the route is gated
    // structurally and the door's allowlist never carried the path. Assert
    // the second one here rather than trusting the comment.
    const { denyReason } = await import("../../companion/src/routes");
    for (const method of ["GET", "POST"]) {
      expect(
        denyReason({ method, path: "/api/desktop-secret", authenticated: true, surface: "browser" })?.status,
        `the door lets ${method} /api/desktop-secret through`,
      ).toBe(404);
      expect(
        denyReason({ method, path: "/api/desktop-secret", authenticated: true, surface: "device" })?.status,
        `the phone lets ${method} /api/desktop-secret through`,
      ).toBe(404);
    }
  });
});
