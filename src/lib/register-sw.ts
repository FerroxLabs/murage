// Registering the worker, with the two guards that decide whether it should
// exist at all on this surface.
//
// This is the half of "Add to Home Screen" that was missing: the manifest, the
// icons and the door's allowlist were all correct, but Chrome does not fire
// `beforeinstallprompt` for a site with no service worker — so `installInvite`
// (`install-prompt.ts`) never saw `captured`, always returned "hidden", and
// Android was silently offered nothing.

/** Whether this surface should register the worker at all.
 *
 * Pure, so the decision is testable without a browser or a registration.
 *
 * Two exclusions, both load-bearing:
 *
 *   `desktop` — the Electron shell is not a web page anyone installs. It has
 *   its own updater, and a worker there would sit between the renderer and the
 *   harness for no benefit whatsoever.
 *
 *   `dev` — Vite serves unhashed modules over HMR in development. A worker
 *   holding an offline shell across a hot reload is a class of "why is my
 *   change not showing" that costs an hour every time it happens. Production
 *   builds are the only place the shell is stable enough to cache.
 */
export function shouldRegisterServiceWorker(facts: {
  supported: boolean;
  secure: boolean;
  desktop: boolean;
  dev: boolean;
}): boolean {
  if (!facts.supported || !facts.secure) return false;
  return !facts.desktop && !facts.dev;
}

/** Fire and forget: a failed registration must never block the app booting.
 *
 * Deliberately after `load`. Registration competes with the first render for
 * the network otherwise, and the only thing it buys by running earlier is a
 * marginally sooner install prompt on a visit where nobody is looking for one.
 */
export function registerServiceWorker(): void {
  if (
    !shouldRegisterServiceWorker({
      supported: typeof navigator !== "undefined" && "serviceWorker" in navigator,
      secure: typeof window !== "undefined" && window.isSecureContext,
      desktop: typeof window !== "undefined" && Boolean(window.muragebox?.platform),
      dev: import.meta.env.DEV,
    })
  ) {
    return;
  }
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
      // A door that declines to serve /sw.js, a browser that refuses the
      // scope, a private window with storage disabled. None of these are worth
      // an error in front of a person: the cost is that this browser is not
      // offered an install, which is exactly where it already was.
    });
  });
}
