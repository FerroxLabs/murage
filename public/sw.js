// The service worker exists for one reason: without it Chrome will not fire
// `beforeinstallprompt`, so `installInvite()` never sees `captured`, never
// returns "prompt", and Android is offered nothing at all. The manifest, the
// icons and the door allowlist were all already correct — this was the one
// missing piece, and its absence looked exactly like a working app that simply
// declines to install.
//
// It is deliberately the smallest thing that satisfies that requirement.
// Murage is a live view of a harness: a bot list, a transcript, a running
// turn. Caching that aggressively would not make the app faster, it would make
// it WRONG — a stale bot roster is worse than a spinner. So:
//
//   - `/api/*` is never touched. Not cached, not read from cache, not even
//     intercepted beyond falling straight through to the network.
//   - Navigations are network-FIRST. The cached shell is a fallback for when
//     the network fails, never a fast path that could serve yesterday's build.
//   - Nothing else is cached at all. Hashed assets are already immutable and
//     the browser's own HTTP cache handles them better than we would.
//
// The offline shell is what makes this more than a checkbox: a phone that
// wakes on a dead tailnet gets Murage's own shell saying so, rather than
// Chrome's dinosaur.

// Bumping this name is how a deploy evicts the previous shell. `activate`
// deletes every cache that is not this one, so an old build's shell cannot
// survive into a new one.
const CACHE = "murage-shell-v1";
const SHELL = "/";

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        // `cache.add` would throw on a non-2xx and abort the whole install.
        // The door can legitimately answer a pairing redirect here, and an
        // install that fails leaves the site permanently uninstallable — so
        // the shell is fetched, inspected, and only stored when it is real.
        const response = await fetch(SHELL, { credentials: "same-origin" });
        if (response.ok) await cache.put(SHELL, response.clone());
      } catch {
        // Offline at install time. The worker still installs and still has a
        // fetch handler, which is what installability actually requires; the
        // shell gets cached on the first successful navigation instead.
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;

  // Only GET. A POST to /api/voice/transcribe or a turn submission must reach
  // the network untouched, and a cache that answered one would be a bug with
  // teeth.
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // The harness. Never ours to answer, cache, or delay.
  if (url.pathname.startsWith("/api/")) return;

  // Server-sent events and websockets: an intercepted stream is a hung stream.
  if (request.headers.get("accept") === "text/event-stream") return;

  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          // Refresh the offline shell on every successful navigation, so what
          // a disconnected phone sees is the last build it actually loaded
          // rather than the one it first installed.
          if (fresh.ok) {
            const cache = await caches.open(CACHE);
            await cache.put(SHELL, fresh.clone());
          }
          return fresh;
        } catch {
          const cached = await caches.match(SHELL);
          if (cached) return cached;
          // No shell yet and no network. Answer in Murage's own voice rather
          // than letting the browser's offline page speak for the app.
          return new Response(
            "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>" +
              "<title>Murage is offline</title>" +
              "<body style=\"margin:0;display:grid;place-items:center;min-height:100dvh;background:#0a0a0a;" +
              'color:#e5e5e5;font:15px/1.5 system-ui,sans-serif">' +
              "<div style=\"text-align:center;padding:24px\"><p style=\"color:#ff6b35;font-weight:600\">Murage is offline</p>" +
              "<p style=\"color:#9a9a9a\">This device cannot reach your computer right now.</p></div>",
            { status: 503, headers: { "content-type": "text/html; charset=utf-8" } },
          );
        }
      })(),
    );
  }

  // Everything else — hashed assets, icons, the manifest — falls through to
  // the network and the browser's own HTTP cache, which is better at this
  // than a hand-rolled cache would be.
});
