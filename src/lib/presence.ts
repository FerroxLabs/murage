// Spec §3.4 and §3.6 "Presence reporting". A browser tab through the door says
// it is being looked at, so the phones in your pocket stay quiet. Phones never
// report: the phone app and a phone-sized browser are the pocket, not the desk.
// The desktop app's own window never reports either: its main process reports
// the desk from the Mac's activity instead (electron/desk-presence.mjs), since
// a window covered by a terminal reads hidden while Sean is at the Mac (E1).
import { desktopSurfaceHeaders, ensureDesktopSurfaceSecret } from "./live-events";
import { isPhoneClient } from "./phone-client";

// A third of the host's 90 s window (server/mobile-presence.ts), so two
// beats in a row can be lost before a visible window reads absent. At 60 s a
// single slow or failed beat was enough (the flap, 2026-09-28).
export const PRESENCE_BEAT_MS = 30_000;
/** A report that has not answered by then is abandoned, so it cannot hold
 * the queue below and silence every later beat. */
export const PRESENCE_POST_TIMEOUT_MS = 10_000;

export interface PresenceDeps {
  post: (body: { clientId: string; visible: boolean; seq: number }) => Promise<unknown>;
  isPhone: () => boolean;
  /** This page is the desktop app's window, whose main process owns presence. */
  desktopApp: () => boolean;
  clientId: () => string;
  hidden: () => boolean;
  onVisibility: (listener: () => void) => () => void;
  every: (fn: () => void, ms: number) => () => void;
}

export function startPresenceReporting(deps: PresenceDeps): () => void {
  if (deps.isPhone() || deps.desktopApp()) return () => {};
  const id = deps.clientId();
  // One report in flight at a time, and only the newest state waits behind
  // it. Unqueued, a hidden flicker's `false` could reach the host after the
  // `true` that followed it and end presence for a window on screen.
  // The queue orders sends, not arrivals: a report abandoned at the timeout
  // can still reach the host after the next one. Each carries a rising seq,
  // and the host drops one that is not newer than what it already took.
  let inFlight = false;
  let next: boolean | null = null;
  let seq = 0;
  const flush = () => {
    if (inFlight || next === null) return;
    const visible = next;
    next = null;
    inFlight = true;
    seq += 1;
    void deps.post({ clientId: id, visible, seq }).catch(() => {}).finally(() => {
      inFlight = false;
      flush();
    });
  };
  const send = (visible: boolean) => {
    next = visible;
    flush();
  };
  send(!deps.hidden());
  const stopVisibility = deps.onVisibility(() => send(!deps.hidden()));
  const stopBeat = deps.every(() => {
    if (!deps.hidden()) send(true);
  }, PRESENCE_BEAT_MS);
  return () => {
    stopVisibility();
    stopBeat();
  };
}

export function browserPresenceDeps(): PresenceDeps {
  return {
    // The route admits the desktop app only as the proven desktop surface
    // (the marker plus its secret, as every desktop request sends) or a
    // signed-in browser through the door. Without them the desktop's report
    // was refused with 403, so the phones buzzed while Murage was on screen
    // (E1, 2026-09-28). A browser without the secret stays "remote" and the
    // door's proof admits it.
    post: async (body) => {
      await ensureDesktopSurfaceSecret();
      return fetch("/api/presence", {
        method: "POST",
        signal: AbortSignal.timeout(PRESENCE_POST_TIMEOUT_MS),
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-murage-surface": "desktop", ...desktopSurfaceHeaders() },
        body: JSON.stringify(body),
      });
    },
    // The same "is this client a phone?" test the rest of the app uses
    // (spec §6 "phone mode", phone-client.ts): the phone app never reports
    // its own presence, and neither does a phone-sized browser tab.
    isPhone: isPhoneClient,
    // The preload bridge exists only in the desktop app's window
    // (electron/preload.cjs), never in a browser through the door.
    desktopApp: () => typeof globalThis.window?.muragebox?.platform === "string",
    // One id per page, never kept in sessionStorage: window.open and a
    // duplicated tab start with a copy of the opener's sessionStorage, so a
    // saved id was shared, and the copy going hidden deleted the presence of
    // the window still on screen.
    clientId: () => crypto.randomUUID().replaceAll("-", ""),
    hidden: () => document.visibilityState === "hidden",
    // Coming to the front counts too: a click into the window renews
    // presence at once instead of waiting for the next beat.
    onVisibility: (listener) => {
      document.addEventListener("visibilitychange", listener);
      window.addEventListener("focus", listener);
      return () => {
        document.removeEventListener("visibilitychange", listener);
        window.removeEventListener("focus", listener);
      };
    },
    every: (fn, ms) => {
      const timer = setInterval(fn, ms);
      return () => clearInterval(timer);
    },
  };
}
