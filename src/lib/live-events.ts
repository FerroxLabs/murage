/**
 * Supervise one browser EventSource for `/api/events`.
 *
 * EventSource hides SSE comment keepalives, so a half-open proxy can leave the
 * UI looking connected forever. The server also sends a visible `ping` frame;
 * this supervisor uses it as liveness, owns reconnects itself, and carries an
 * explicit replay cursor whenever it replaces the native EventSource.
 */
export const LIVE_EVENTS_PATH = "/api/events";
export const LIVE_EVENTS_STALE_MS = 40_000;
export const LIVE_EVENTS_RETRY_MIN_MS = 500;
export const LIVE_EVENTS_RETRY_MAX_MS = 10_000;

export interface LiveFrame {
  kind: string;
  cursor?: string;
  resumed?: boolean;
  event?: unknown;
}

interface LiveMessageEvent {
  data: string;
  lastEventId?: string;
}

export interface LiveEventSourceLike {
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: LiveMessageEvent) => void) | null;
  close: () => void;
}

interface ListenerTarget {
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
}

export interface LiveEventsPlatform {
  createEventSource: (url: string) => LiveEventSourceLike;
  windowTarget?: ListenerTarget;
  documentTarget?: ListenerTarget;
  isVisible: () => boolean;
  isOnline: () => boolean;
  now: () => number;
}

export interface LiveEventsHandlers {
  onFrame: (frame: LiveFrame) => void;
  /** Rebuild the consumer's complete snapshot after the server says its
   * replay gap cannot be filled. The transport commits the new cursor only
   * after this succeeds; false/rejection closes the stream and retries from
   * the last known-good boundary. */
  onSnapshotRequired: () => Promise<boolean>;
  onOpen?: () => void;
  onError?: () => void;
  screens?: boolean;
  staleMs?: number;
  retryMinMs?: number;
  retryMaxMs?: number;
}

// ── proving this renderer is the renderer ──────────────────────────────
//
// The surface marker says what a caller WANTS; it never said who the caller
// was. Any local process could type `x-murage-surface: desktop`, and until
// this existed that was enough to reach routes that spawn a binary. So the
// harness mints a secret per launch and answers "desktop" only for a request
// that carries it (server/sse-visibility.ts).
//
// Two ways in, and the app needs both:
//
//   packaged — Electron's main process receives it from the harness child
//     over their private port and the preload exposes it synchronously, so
//     it is already here when this module loads.
//   dev      — Vite serves this bundle from another port and there is no
//     Electron at all under Playwright, so it is fetched from the harness
//     over loopback. That fetch lives behind `import.meta.env.DEV`, which is
//     a compile-time constant: a production `vite build` deletes the branch,
//     so a shipped bundle has no code that could ask.
export const SURFACE_SECRET_HEADER = "x-murage-surface-secret";
export const SURFACE_SECRET_QUERY = "surfaceSecret";
/** Same path the harness serves it on; dev only, at both ends. */
export const DEV_SECRET_PATH = "/api/desktop-secret";

const bridgeSecret = (): string => {
  const bridge = (globalThis as { muragebox?: { desktopSurfaceSecret?: unknown } }).muragebox;
  return typeof bridge?.desktopSurfaceSecret === "string" ? bridge.desktopSurfaceSecret : "";
};

let desktopSecret = bridgeSecret();
let pendingSecret: Promise<string> | null = null;

/** The secret, or "" when this renderer has not been given one. Absent means
 * absent: nothing here invents a value, and a request without one is simply
 * treated as remote — which is the same narrow answer a phone gets. */
export function desktopSurfaceSecret(): string {
  return desktopSecret;
}

/** The headers a `fetch` on this origin should carry, merged into whatever
 * the caller already sends. Empty while the secret is unknown so that a call
 * made too early degrades to the scoped view rather than sending garbage. */
export function desktopSurfaceHeaders(): Record<string, string> {
  return desktopSecret ? { [SURFACE_SECRET_HEADER]: desktopSecret } : {};
}

/** Resolve the secret once, and remember the answer.
 *
 * Called before the first hydration fetch and before the stream opens. It
 * never rejects: a harness that will not hand one over leaves this renderer
 * on the scoped surface, which is a smaller app, not a broken one. */
export function ensureDesktopSurfaceSecret(): Promise<string> {
  if (desktopSecret) return Promise.resolve(desktopSecret);
  // A late preload is still the packaged answer — re-read before asking.
  desktopSecret = bridgeSecret();
  if (desktopSecret) return Promise.resolve(desktopSecret);
  // Deliberately NOT behind `import.meta.env.DEV`.
  //
  // It used to be, and that left a real configuration with no path to the
  // secret at all: a PRODUCTION bundle served by a harness that Electron did
  // not fork. The secret travels desktop-ward over `postDesktopPrivateMessage`
  // (server/index.ts:363), a channel that exists only when the packaged app
  // forked the harness as its own child. Start the harness separately — which
  // is how this app is run against a built bundle — and `main.mjs` never
  // receives one, so the preload bridge hands the renderer "".
  //
  // The renderer then believed it was the desktop (the bridge is present, and
  // presence is the one true positive) while the harness answered "remote" to
  // every request it made (the marker without the secret is exactly the
  // forgery that gate refuses). Desktop-only buttons rendered enabled and
  // then 404'd on press. A disagreement between "which surface am I" and
  // "what am I allowed to do" is worse than either answer being wrong.
  //
  // Dropping the guard opens nothing, because the ROUTE is what is gated and
  // its gate is structural, not an environment flag: `/api/desktop-secret`
  // 404s whenever `process.parentPort` is present, which is exactly and only
  // the utility child a packaged build forks (server/index.ts:8703). So in a
  // shipped app the bridge answers first and this fetch never runs; if it did
  // it would 404. It 404s to anything carrying the companion marker. And the
  // browser door's allowlist does not carry the path at all, so a phone's
  // request is refused before the harness ever sees it — three independent
  // locks, none of which was the compile-time guard.
  if (typeof globalThis.fetch !== "function") {
    return Promise.resolve("");
  }
  pendingSecret ??= globalThis
    .fetch(DEV_SECRET_PATH)
    .then((res) => (res.ok ? res.json() : null))
    .then((body: { secret?: unknown } | null) => {
      const secret = typeof body?.secret === "string" ? body.secret : "";
      if (secret) desktopSecret = secret;
      return desktopSecret;
    })
    .catch(() => desktopSecret)
    .finally(() => {
      pendingSecret = null;
    });
  return pendingSecret;
}

/** Test seam. The renderer never calls this; `live-events.test.ts` does, to
 * state a world in which the secret is or is not known. */
export function setDesktopSurfaceSecretForTest(value: string): void {
  desktopSecret = value;
  pendingSecret = null;
}

export function liveEventsUrl(options?: { since?: string | null; screens?: boolean }): string {
  const params = new URLSearchParams();
  // The harness scopes this stream to a phone's narrow view by default, so
  // that a paired device cannot receive frames for hidden bots or bot-to-bot
  // rooms simply by holding the stream open. This renderer IS the desktop, so
  // it opts out. EventSource cannot send headers, which is why the surface
  // travels in the query string here and in a header everywhere else.
  params.set("surface", "desktop");
  if (options?.since) params.set("since", options.since);
  if (options?.screens === false) params.set("screens", "off");
  // …and the marker alone is not believed. Appended LAST so that every other
  // parameter keeps the position it had before this existed, and omitted
  // entirely when unknown — an empty value would only be a wrong one.
  if (desktopSecret) params.set(SURFACE_SECRET_QUERY, desktopSecret);
  const query = params.toString();
  return query ? `${LIVE_EVENTS_PATH}?${query}` : LIVE_EVENTS_PATH;
}

export function isLivePing(frame: Pick<LiveFrame, "kind">): boolean {
  return frame.kind === "ping";
}

export function shouldReconnectLiveEvents(
  lastHeardAt: number,
  now: number,
  staleMs = LIVE_EVENTS_STALE_MS,
): boolean {
  return now - lastHeardAt >= staleMs;
}

/** Parse only the transport envelope here. Payloads remain owned by their
 * consumers; cloning every token delta through a general schema would put
 * avoidable work on the hottest renderer path. */
function parseLiveFrame(data: string): LiveFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (!value || Array.isArray(value) || Object(value) !== value) return null;
  // SAFETY: the object guard above establishes an indexable JSON object; each
  // transport-owned field is validated below before exposing LiveFrame.
  const candidate = value as {
    kind?: unknown;
    cursor?: unknown;
    resumed?: unknown;
    event?: unknown;
  };
  if (candidate.kind !== String(candidate.kind)) return null;
  if (candidate.cursor !== undefined && candidate.cursor !== String(candidate.cursor)) return null;
  if (candidate.resumed !== undefined && candidate.resumed !== Boolean(candidate.resumed)) return null;
  // SAFETY: kind is a string and the two optional transport fields were
  // checked against their exact primitive representations above.
  return candidate as LiveFrame;
}

function browserPlatform(overrides: Partial<LiveEventsPlatform>): LiveEventsPlatform | null {
  const NativeEventSource = globalThis.EventSource;
  const createEventSource =
    overrides.createEventSource ??
    (!NativeEventSource
      ? undefined
      : (url: string) => {
          const native = new NativeEventSource(url);
          const adapter: LiveEventSourceLike = {
            onopen: null,
            onerror: null,
            onmessage: null,
            close: () => native.close(),
          };
          native.onopen = () => adapter.onopen?.();
          native.onerror = () => adapter.onerror?.();
          native.onmessage = (event) => adapter.onmessage?.(event);
          return adapter;
        });
  if (!createEventSource) return null;

  const browserWindow = globalThis.window;
  const browserDocument = globalThis.document;
  return {
    createEventSource,
    windowTarget:
      overrides.windowTarget ??
      (browserWindow
        ? {
            addEventListener: (type, listener) => browserWindow.addEventListener(type, listener),
            removeEventListener: (type, listener) => browserWindow.removeEventListener(type, listener),
          }
        : undefined),
    documentTarget:
      overrides.documentTarget ??
      (browserDocument
        ? {
            addEventListener: (type, listener) => browserDocument.addEventListener(type, listener),
            removeEventListener: (type, listener) => browserDocument.removeEventListener(type, listener),
          }
        : undefined),
    isVisible:
      overrides.isVisible ?? (() => !browserDocument || browserDocument.visibilityState === "visible"),
    isOnline: overrides.isOnline ?? (() => globalThis.navigator?.onLine !== false),
    now: overrides.now ?? Date.now,
  };
}

/**
 * Open and supervise one live stream. The returned function owns all cleanup:
 * after it runs, no EventSource, reconnect timer, or browser listener remains.
 * The optional platform is intentionally narrow so connection behavior can be
 * tested without a browser or network.
 */
export function openLiveEvents(
  handlers: LiveEventsHandlers,
  platformOverrides: Partial<LiveEventsPlatform> = {},
): () => void {
  const platform = browserPlatform(platformOverrides);
  if (!platform) {
    handlers.onError?.();
    return () => {};
  }

  const staleMs = handlers.staleMs ?? LIVE_EVENTS_STALE_MS;
  const retryMinMs = Math.max(1, handlers.retryMinMs ?? LIVE_EVENTS_RETRY_MIN_MS);
  const retryMaxMs = Math.max(retryMinMs, handlers.retryMaxMs ?? LIVE_EVENTS_RETRY_MAX_MS);
  const staleCheckMs = Math.min(10_000, Math.max(250, staleMs / 2));

  let stopped = false;
  let source: LiveEventSourceLike | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryAttempt = 0;
  let cursor: string | null = null;
  let lastHeardAt = platform.now();
  let snapshotGeneration = 0;
  let pendingSnapshot: {
    generation: number;
    source: LiveEventSourceLike;
    boundaryCursor: string | null;
    newestFrameCursor: string | null;
  } | null = null;

  const clearRetry = () => {
    if (retryTimer === null) return;
    clearTimeout(retryTimer);
    retryTimer = null;
  };

  const closeSource = () => {
    const current = source;
    source = null;
    if (!current) return;
    if (pendingSnapshot?.source === current) {
      snapshotGeneration += 1;
      pendingSnapshot = null;
    }
    current.onopen = null;
    current.onerror = null;
    current.onmessage = null;
    current.close();
  };

  let connect: () => void;
  const scheduleReconnect = () => {
    if (stopped || retryTimer !== null || !platform.isOnline() || !platform.isVisible()) return;
    const exponent = Math.min(retryAttempt, 20);
    const delay = Math.min(retryMaxMs, retryMinMs * 2 ** exponent);
    retryAttempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!platform.isVisible()) return;
      connect();
    }, delay);
  };

  const connectionLost = (current: LiveEventSourceLike) => {
    if (stopped || source !== current) return;
    closeSource();
    handlers.onError?.();
    scheduleReconnect();
  };

  connect = () => {
    if (stopped || source || !platform.isOnline()) return;
    let current: LiveEventSourceLike;
    try {
      current = platform.createEventSource(
        liveEventsUrl({ since: cursor, screens: handlers.screens }),
      );
    } catch {
      handlers.onError?.();
      scheduleReconnect();
      return;
    }

    source = current;
    lastHeardAt = platform.now();
    current.onopen = () => {
      if (stopped || source !== current) return;
      lastHeardAt = platform.now();
      handlers.onOpen?.();
    };
    current.onerror = () => connectionLost(current);
    current.onmessage = (event) => {
      if (stopped || source !== current) return;
      lastHeardAt = platform.now();

      const frame = parseLiveFrame(event.data);
      if (!frame) return;

      // Heartbeats prove this socket is alive, but they are not application
      // state and never establish a replay boundary of their own.
      if (isLivePing(frame)) {
        // An open event only proves that a TCP handshake happened. A ping
        // proves the stream stayed usable, so only now forgive prior flaps.
        retryAttempt = 0;
        return;
      }

      if (frame.kind === "hello") {
        // `resumed:true` is followed by replay frames. Advancing to hello's
        // newest cursor here would skip any replay frame not yet delivered if
        // this socket died mid-replay. A failed resume has no replay, but its
        // cursor is safe only after the consumer's replacement snapshot loads.
        if (frame.resumed === false) {
          const generation = ++snapshotGeneration;
          pendingSnapshot = {
            generation,
            source: current,
            boundaryCursor: frame.cursor || null,
            newestFrameCursor: null,
          };
          void (async () => {
            let loaded = false;
            try {
              loaded = await handlers.onSnapshotRequired();
            } catch {
              loaded = false;
            }
            const pending = pendingSnapshot;
            if (
              stopped ||
              source !== current ||
              !pending ||
              pending.generation !== generation
            ) {
              return;
            }
            if (!loaded) {
              pendingSnapshot = null;
              connectionLost(current);
              return;
            }
            // The consumer resolved only after applying every frame it held
            // behind the snapshot. Commit the newest delivered cursor, or the
            // hello boundary when no application frame arrived meanwhile.
            cursor = pending.newestFrameCursor ?? pending.boundaryCursor;
            pendingSnapshot = null;
          })();
        }
      } else if (event.lastEventId) {
        if (pendingSnapshot?.source === current) {
          pendingSnapshot.newestFrameCursor = event.lastEventId;
        } else {
          cursor = event.lastEventId;
        }
      }

      // Hello is transport control, not application state. Consumers rebuild
      // through onSnapshotRequired and receive only numbered application data.
      if (frame.kind !== "hello") handlers.onFrame(frame);
    };
  };

  const reconnectNow = (reportDisconnect: boolean) => {
    if (stopped || !platform.isOnline()) return;
    clearRetry();
    if (source) {
      closeSource();
      if (reportDisconnect) handlers.onError?.();
    }
    connect();
  };

  const recover = () => {
    // Background tabs suspend timers and network delivery. Let visibility or
    // focus perform one recovery on wake instead of churning hidden sockets.
    if (stopped || !platform.isOnline() || !platform.isVisible()) return;
    if (!source || shouldReconnectLiveEvents(lastHeardAt, platform.now(), staleMs)) {
      reconnectNow(source !== null);
    }
  };
  const onOnline = () => recover();
  const onFocus = () => {
    if (platform.isVisible()) recover();
  };
  const onVisibilityChange = () => {
    if (platform.isVisible()) recover();
  };

  connect();
  const staleTimer = setInterval(recover, staleCheckMs);
  platform.windowTarget?.addEventListener("online", onOnline);
  platform.windowTarget?.addEventListener("focus", onFocus);
  platform.documentTarget?.addEventListener("visibilitychange", onVisibilityChange);

  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(staleTimer);
    clearRetry();
    closeSource();
    platform.windowTarget?.removeEventListener("online", onOnline);
    platform.windowTarget?.removeEventListener("focus", onFocus);
    platform.documentTarget?.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
