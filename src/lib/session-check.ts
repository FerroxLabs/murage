// Is this browser still signed in at the door?
//
// Asked after any API 401 and after the event stream drops (spec §3.6). A
// 401 on its own proves nothing: harness routes answer 401 for a provider
// they could not authenticate to (server/avatar-image.ts:297), and the
// companion's renewal deliberately never answers 401 (companion/src/
// browser.ts:1194-1199). The event stream cannot report its status at all.
// So the door's own `GET /session` decides (browser.ts:1270-1277):
//
//   200  signed in; carry on
//   401  signed out; stop reconnecting and ask the person to pair again
//   else unknown — asleep, restarting, or no door at all; carry on
//
// Signed-out is final for the page. A new session arrives only through
// /enter, which is a new page load.

export const SESSION_PATH = "/session";
export const SESSION_CHECK_MIN_GAP_MS = 5_000;
/** The door's code-entry page; `/enter` with no fragment asks for the six
 * digits (companion/src/browser.ts:1170). */
export const PAIR_AGAIN_PATH = "/enter";

export type SessionVerdict = "signed-in" | "signed-out" | "unknown";

export function sessionVerdict(status: number | null): SessionVerdict {
  if (status === 401) return "signed-out";
  if (status !== null && status >= 200 && status < 300) return "signed-in";
  return "unknown";
}

export interface SessionWatchDeps {
  fetch: (path: string, init: RequestInit) => Promise<{ status: number }>;
  now: () => number;
  /** The desktop app has no door and no session to lose. */
  desktop: () => boolean;
}

export function createSessionWatch(deps: SessionWatchDeps) {
  let signedOut = false;
  let pending: Promise<SessionVerdict> | null = null;
  let lastAt = Number.NEGATIVE_INFINITY;
  let last: SessionVerdict = "unknown";
  const listeners = new Set<() => void>();

  const check = (): Promise<SessionVerdict> => {
    if (signedOut) return Promise.resolve("signed-out");
    if (deps.desktop()) return Promise.resolve("unknown");
    if (pending) return pending;
    // A reconnect loop and a burst of failing panels arrive together; one
    // answer covers all of them.
    if (deps.now() - lastAt < SESSION_CHECK_MIN_GAP_MS) return Promise.resolve(last);
    lastAt = deps.now();
    pending = deps
      .fetch(SESSION_PATH, { credentials: "same-origin", cache: "no-store" })
      .then((response) => sessionVerdict(response.status), () => sessionVerdict(null))
      .then((verdict) => {
        last = verdict;
        if (verdict === "signed-out" && !signedOut) {
          signedOut = true;
          for (const listener of [...listeners]) listener();
        }
        return verdict;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };

  return {
    check,
    isSignedOut: () => signedOut,
    onSignedOut(listener: () => void): () => void {
      listeners.add(listener);
      if (signedOut) queueMicrotask(listener);
      return () => listeners.delete(listener);
    },
  };
}

const watch = createSessionWatch({
  fetch: (path, init) => globalThis.fetch(path, init),
  now: () => Date.now(),
  // The Electron preload is the one signal that cannot be forged through the
  // door (src/lib/use-surface.ts). Its absence proves nothing, which is fine:
  // the desktop dev server answers /session with the SPA shell, "unknown".
  desktop: () => Boolean((globalThis as { muragebox?: unknown }).muragebox),
});

export const checkSession = watch.check;
export const sessionSignedOut = watch.isSignedOut;
export const onSignedOut = watch.onSignedOut;
