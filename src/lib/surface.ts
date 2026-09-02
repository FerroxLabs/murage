import { desktopSurfaceHeaders, ensureDesktopSurfaceSecret } from "@/lib/live-events";

/** Which door this renderer came through.
 *
 * The same bundle is served to the local desktop app and, through the browser
 * door, to a phone on the tailnet. A handful of things differ between them —
 * copy that names a local action, affordances the door's allowlist does not
 * carry — and every one of them needs the same answer, so it is asked once
 * here rather than guessed per component.
 *
 * `window.muragebox` is NOT the test. It is absent when the desktop renderer
 * runs against the Vite dev server, which is how the app is developed, so it
 * answers "phone" for a developer sitting at the machine. The harness knows,
 * because it is the thing that read the request's markers, and it reports the
 * answer on `/api/config` — a route both surfaces may call.
 *
 * Unknown until the fetch lands, and deliberately typed to say so: a caller
 * that renders desktop copy on a phone for one frame has shipped the bug this
 * exists to prevent. Render the neutral thing while it is `undefined`. */
export type SurfaceAnswer = "desktop" | "remote";

let pending: Promise<SurfaceAnswer> | null = null;
let known: SurfaceAnswer | undefined;

/** The answer if it has already arrived, else `undefined`. Synchronous, for
 * the non-React callers and for a first render that must not block. */
export function knownSurface(): SurfaceAnswer | undefined {
  return known;
}

/** Ask once per page load and remember. A failed request answers `remote`,
 * the narrow side, and is not cached — the door may simply not be up yet. */
export function surface(): Promise<SurfaceAnswer> {
  if (known) return Promise.resolve(known);
  // Sends the desktop marker exactly like every other renderer fetch. That
  // is not self-defeating: the browser door builds its forwarded headers in a
  // FRESH object, copying only accept/content-type/content-length/last-event-id,
  // and stamps `x-murage-companion` in — which requestSurface checks first. So
  // the marker survives on loopback and is stripped on the way through the
  // door, which is exactly what makes the answer honest on both sides.
  //
  // The marker alone stopped being enough once the harness started minting a
  // per-launch secret: a bare `x-murage-surface: desktop` is exactly the
  // forgery that gate exists to refuse, so without the secret this asked
  // "am I the desktop?" in the voice of an impostor and was told no — in the
  // desktop app.
  pending ??= ensureDesktopSurfaceSecret()
    .then(() => fetch("/api/config", { headers: { "x-murage-surface": "desktop", ...desktopSurfaceHeaders() } }))
    .then((response) => (response.ok ? response.json() : null))
    .then((body: { surface?: string } | null) => {
      const answer: SurfaceAnswer = body?.surface === "desktop" ? "desktop" : "remote";
      known = answer;
      return answer;
    })
    .catch(() => {
      pending = null;
      return "remote" as const;
    });
  return pending;
}

/** `true` only once the harness has confirmed it. */
export async function isDesktopSurface(): Promise<boolean> {
  return (await surface()) === "desktop";
}
