# Murage PWA + Responsive UI — Plan

Track: PWA mechanics and responsive UI. No production code written. Every claim below carries a
file:line or a command I ran; where I could not determine something I say so.

Scratch rig used for every measurement (nothing in `murage-app` was written to):

```
MURAGE_PORT=8931 MURAGE_WEBHOOK_PORT=8932 \
MURAGE_DATA_DIR=<scratch>/data MURAGE_STATIC_DIR=/Volumes/Mando/WaylandBots/murage-app/dist \
node --experimental-strip-types server/index.ts     # node v24.20.0
```
plus Playwright (`/Volumes/Mando/resources/openclaw/node_modules/playwright`) driving the installed
Chrome-for-Testing 1234 at 390x844, `isMobile: true`, `hasTouch: true`.

---

## 0. What I verified before planning (and what changed as a result)

| Claim | Result |
|---|---|
| Harness serves the built UI when `MURAGE_STATIC_DIR` is set | **True.** `server/index.ts:241`, `:8653-8668`. `curl http://127.0.0.1:8931/` returned the real `dist/index.html` with the hashed script tag. |
| Harness 403s a non-loopback Host | **True.** `curl -H "Host: mac.tail1234.ts.net" …/` → `403`. Gate at `server/index.ts:5077`, helper at `:5034-5056`. |
| Harness 403s a non-loopback Origin | **True.** `curl -H "Origin: https://mac.tail1234.ts.net" …/api/bots` → `403`. `server/index.ts:5081`, `isAllowedOrigin` at `:5059`. |
| The static SPA fallback returns `index.html` for a **missing hashed asset** | **True, and this is the reason the MIME guard is mandatory.** `curl -w '%{content_type}' …/assets/index-STALEHASH.js` → `200 text/html`. `server/index.ts:8659-8666`. |
| `.webmanifest` gets a JSON MIME | **False.** Second harness on :8933 with a scratch `MURAGE_STATIC_DIR` containing a real `manifest.webmanifest` → `200 application/octet-stream`. The MIME table at `server/index.ts:242-251` has no `.webmanifest` entry. `sw.js` → `text/javascript`, correct. |
| Murage responsiveness: 14 of 156 non-test src files carry a breakpoint | **True.** `grep -rlE "\b(max-)?(sm\|md\|lg\|xl\|2xl):" src --include='*.tsx' --include='*.ts' \| grep -v '\.test\.' \| wc -l` → 14; `find src -name '*.tsx' -o -name '*.ts' \| grep -v '\.test\.' \| wc -l` → 156. |
| Composer textarea computes to 15px | **True.** `getComputedStyle(textarea).fontSize` → `15px`. Source: `Composer.tsx:841` `text-[15px]`. |
| Zero `safe-area-inset` anywhere; `body{overflow:hidden}` | **True.** Stylesheet walk found 0 rules containing `safe-area-inset` across all 1 sheet. `styles.css:279-285`. Zero `env(` in `src/`. |
| "The page does not scroll sideways at 390px" | **True only in the base state.** With the Inspector open it does — see below. |
| 40 of 49 controls under 44px | **My count differs and is worse in kind.** In the base chat state 14 of 14 *on-screen* controls are under 44px (100%). Counting every rendered control including the off-screen drawer, 34 buttons exist and 30 are under 44px in at least one axis. The earlier 40/49 was presumably a different state; the direction is identical. |

### New findings the earlier pass did not have

1. **The Inspector annihilates the chat at 390px, and the document scrolls sideways.**
   Measured by clicking the Inspector button at 390x844:
   ```
   BASE      docScrollW=390  main.w=390  textarea.w=221
   INSPECTOR docScrollW=461  main.w=0    textarea.w=8   aside.w=460
   COMPUTER  docScrollW=400  main.w=0    textarea.w=8   aside.w=400
   ```
   `main` is literally `0px` wide. `InspectorPanel.tsx:184` is `w-[460px] shrink-0`;
   `ComputerPanel.tsx:833-834` sets `style={{width: panelWidth}}` with `shrink-0`, default 400
   (`ComputerPanel.tsx:132`). The `flex-1 min-w-0` chat has no floor, so it collapses to zero
   and the panel overflows the document.

2. **Same-origin `POST` carries an `Origin` header; `GET` and `EventSource` do not.** Proven with a
   local echo server plus Chromium:
   ```
   GET  /api/get-same-origin   origin=<none>
   POST /api/post-same-origin  origin=http://127.0.0.1:8941
   GET  /api/events-sse (SSE)  origin=<none>
   ```
   Therefore `companion/src/proxy.ts:237-242` — `if (req.headers.origin) return 403` — lets a browser
   PWA *read* everything and *send* nothing. Every write in the app (send message, interrupt, respond
   to an approval, mark read) is a POST/PATCH and dies at that line. This is not a security nicety to
   preserve as-is; it is the single line that decides whether the PWA can talk at all. Section 2 says
   what replaces it.

3. **The app never calls `GET /api/threads/:id/messages`** — the route the companion allowlist
   provisions for the iOS app (`companion/src/routes.ts:99`). The React app gets its transcript from
   the `GET /api/events` SSE snapshot (`src/lib/live-events.ts:9`) plus `GET /api/bots`
   (`store.tsx:1419`). `GET /api/threads/:id/events?limit=400` is used only by `InspectorPanel.tsx:39`,
   a desktop-only surface. Route-table consequence in section 5.

4. **The main JS chunk is 1,641,078 bytes raw / 497,441 gzip** (`dist/assets/index-Drw15rVO.js`), CSS
   119,564 / 20,015. There is no `manualChunks` and no `React.lazy` anywhere in `src/`
   (only `ChatMarkdown.tsx:71` dynamically imports `shiki`). ~486 KB gz on first load over a phone
   link is the real mobile cost, and it is one indivisible chunk today.

5. **The companion device port binds `0.0.0.0`, not the tailnet** — `companion/src/index.ts:225`
   `await listen(companion, COMPANION_PORT, "0.0.0.0")`. Under a tailnet-only threat model that is
   already wider than intended (it is the LAN too). The new web listener must not repeat it.

6. **1,073 hard-coded arbitrary font sizes** in `src/**/*.tsx` (`text-[13px]` ×258, `[12px]` ×216,
   `[12.5px]` ×139, `[11.5px]` ×114, `[11px]` ×84, …). Any plan that proposes "bump the type on mobile"
   by editing call sites is a plan to touch a thousand lines. Section 3 does not propose that.

---

## 1. Port Wayland's PWA — file by file

Wayland's PWA is five artefacts and no plugin dependency. All five port; two change materially.

### 1.1 `public/pwa/` — icons

**Source of truth: `ios/App/Assets.xcassets/AppIcon.appiconset/icon-1024.png`.** 1024×1024,
`hasAlpha: no`, dark ground sampled at `rgb(16,15,21)` = `#100F15`, white "M" with the orange flame.
This is the finished Murage app icon and it is about to be deleted with the iOS app — salvage it
before the removal lands. I rendered it and confirmed it visually.

Do **not** use `brand/MurageIconIsolated.png`: 1254², `hasAlpha: yes`, and the mark is *black* on
transparent. I rendered it — on any dark home screen it is an invisible glyph with a floating flame.
`public/app-icon.svg` is 902 KB and stays where it is (the Vite favicon).

Exact commands, all run and verified in scratch:

```sh
SRC=ios/App/Assets.xcassets/AppIcon.appiconset/icon-1024.png
mkdir -p public/pwa
sips -s format png -Z 192 "$SRC" --out public/pwa/icon-192.png   # → 192x192, hasAlpha: no
sips -s format png -Z 512 "$SRC" --out public/pwa/icon-512.png   # → 512x512, hasAlpha: no
sips -s format png -Z 180 "$SRC" --out public/pwa/icon-180.png   # → 180x180, hasAlpha: no  (apple-touch-icon)

# maskable: Android crops to a circle of ~80% diameter, so the mark has to be
# inset or the flame loses its tip. Shrink to 410 and pad back to 512 on the
# icon's own ground so the seam is invisible.
sips -s format png -Z 410 "$SRC" --out public/pwa/icon-maskable-512.png
sips -p 512 512 --padColor 100F15 public/pwa/icon-maskable-512.png --out public/pwa/icon-maskable-512.png
```
(`magick`/`convert`/`rsvg-convert` are all absent on this machine — `which` returned nothing for each.
`sips` is the only raster tool present, and it does the whole job.)

Wayland ships 180/192/512 and no maskable (`app/public/pwa/`). Adding maskable is a one-line manifest
delta and worth it.

### 1.2 `public/manifest.webmanifest`

Port `app/public/manifest.webmanifest` verbatim in shape. **Keep `start_url: "./"` and `scope: "./"`** —
relative values are what let one build serve from `http://127.0.0.1:8799` (Electron), a dev server, and
`https://<machine>.<tailnet>.ts.net` without three builds. That is the single most important line in
the file and the reason no `base` change is needed in `vite.config.ts` (Vite's default `base: "/"`
already emits absolute `/assets/…` refs, which resolve correctly under a root-mounted origin; the
manifest is the one file that must stay relative because it is fetched and resolved by the browser).

```json
{
  "name": "Murage",
  "short_name": "Murage",
  "description": "Run a team of AI agents from your phone.",
  "start_url": "./",
  "scope": "./",
  "display": "standalone",
  "orientation": "portrait",
  "background_color": "#100F15",
  "theme_color": "#111111",
  "icons": [
    { "src": "./pwa/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "./pwa/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "./pwa/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

`background_color` is the icon's own ground (`#100F15`, sampled) so the iOS/Android splash has no seam
against the icon. `theme_color` is `--color-panel` from the default Midnight skin (`styles.css:38`).

**Server change required (proven defect):** add to the MIME table at `server/index.ts:242-251`
```ts
".webmanifest": "application/manifest+json",
```
and the same table in the new web listener (section 2). Today it serves `application/octet-stream`
— measured. Chrome is lenient about manifest MIME in practice, but the fix is one line and the
alternative is debugging an install prompt that silently does not appear.

While in that table, also add `.webp`, `.jpg`/`.jpeg`, `.txt`, `.map` — the same
`?? "application/octet-stream"` fallback at `server/index.ts:8663` hits all of them.

### 1.3 `public/sw.js` — Wayland's shell, **AionUi's MIME guard**

Base: `app/public/sw.js` (Wayland). It is the better shell — it has the versioned `CACHE_NAME` from the
`__WAYLAND_SW_VERSION__` token, the `activate` purge of every prior cache, and `handleNavigate`, which
fails *open* to a self-reloading `RECONNECT_HTML` rather than a blank root. Keep all of that. Rename the
token to `__MURAGE_SW_VERSION__` and the cache prefix to `murage-webui-`.

Three deltas.

**(a) Take AionUi's `networkOnlyWithTypeGuard` for `script`/`style`.** Wayland dropped it and routes
those destinations through `networkFirst` (`app/public/sw.js` fetch handler). Murage cannot afford that,
because Murage's static handler poisons exactly this case: I proved
`GET /assets/index-STALEHASH.js` → `200 text/html` (`server/index.ts:8659-8666` SPA fallback). Under
`networkFirst` that HTML is `response.ok`, gets `cache.put`, and the next load executes HTML as a module
— the "module script MIME text/html" failure AionUi wrote the guard for, now permanently cached. Copy
`isAssetContentTypeMismatch` and `networkOnlyWithTypeGuard` from
`/Volumes/Mando/resources/aionui/public/sw.js` unchanged; they already `cache.delete(request)` on
mismatch and `Response.error()` so the browser shows a real error instead of running HTML.

**(b) `/api/` must never be touched — for a reason bigger than freshness.** Wayland's
`shouldHandleRequest` already returns false for `url.pathname.startsWith('/api/')`; keep the line and
strengthen the comment. `GET /api/events` is a permanently-open SSE stream (`src/lib/live-events.ts:9`,
harness route in `server/index.ts`). A service worker that calls `event.respondWith(fetch(request))` on
it holds the stream inside the SW's fetch handler; any caching wrapper around it never resolves, and the
app appears to connect and then receive nothing forever. Not caching is not an optimisation here, it is
the difference between a working app and a silent one.

**(c) Drop `NON_CACHEABLE_PATHS = ['/qr-login']`.** Murage has no `/qr-login` route (that is Wayland's
server-rendered page at `webserver/routes/authRoutes.ts:573`). Murage pairs through
`companion/src/devices.ts` and `PhoneSetupFlow.tsx`. Replace the set with `['/pair']` only if section 2's
pairing page lands at a distinct path; otherwise remove the concept.

### 1.4 `src/lib/registerPwa.ts` (new, ~45 lines)

Port `app/src/renderer/services/registerPwa.ts` one-for-one. The only substantive change is the platform
guard: Wayland's `isElectronDesktop()` (`app/src/renderer/utils/platform.ts:16`, `Boolean(window.electronAPI)`)
maps onto Murage's `window.muragebox` — the same bridge object `src/lib/desktop.ts:33` already keys on
(`const platform = window.muragebox?.platform; if (!platform) return browserCapabilities;`).

```ts
// The desktop shell talks to the harness over an origin it controls and
// updates itself through electron-updater; a service worker there would only
// add a second, slower cache of a bundle that ships inside the app.
const SERVICE_WORKER_URL = "./sw.js";
const LOCALHOST_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function supported(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  if (window.muragebox || !("serviceWorker" in navigator)) return false;
  const { protocol, hostname } = window.location;
  if (protocol !== "http:" && protocol !== "https:") return false;
  return window.isSecureContext || LOCALHOST_HOSTS.has(hostname);
}

export async function registerPwa(): Promise<ServiceWorkerRegistration | undefined> {
  if (!supported()) return undefined;
  try {
    return await navigator.serviceWorker.register(SERVICE_WORKER_URL, { scope: "./" });
  } catch (error) {
    console.warn("[PWA] service worker registration failed:", error);
    return undefined;
  }
}
```

Call site: `src/main.tsx`, after `createRoot(...).render(...)` — the same position as Wayland's
`app/src/renderer/main.tsx:160`. Registration must not block first paint.

### 1.5 `index.html` — meta/link block

Murage's `index.html` is 11 lines and has none of this. Port Wayland's head block
(`app/src/renderer/index.html:5-14`) with Murage names:

```html
<!-- viewport-fit=cover is load-bearing, not decoration: without it iOS resolves
     every env(safe-area-inset-*) to 0 and the composer sits under the home
     indicator. Section 3 depends on this one attribute. -->
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
<meta name="application-name" content="Murage" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<meta name="apple-mobile-web-app-title" content="Murage" />
<meta name="mobile-web-app-capable" content="yes" />
<meta name="theme-color" content="#111111" />
<link rel="icon" type="image/svg+xml" href="/app-icon.svg" />
<link rel="apple-touch-icon" href="./pwa/icon-180.png" />
<link rel="manifest" href="./manifest.webmanifest" />
```

Two Murage-specific deltas from Wayland:

- `black-translucent`, not `default`. Murage's default skin is Midnight (`styles.css:38`, `--color-app:
  #070707`). `default` paints a white status bar over a black app. `black-translucent` puts the page
  under the status bar, which is precisely why `viewport-fit=cover` + `safe-area-inset-top` in section 3
  is mandatory rather than optional — they are one decision, not two.
- Make `theme-color` follow the skin. `src/lib/skins.ts:63 applySkin()` already reaches one surface CSS
  cannot (`window.muragebox?.applySkin` for the Windows caption bar, `skins.ts:76`). Add the meta update
  in the same function, for the same reason: a surface CSS cannot reach.
  ```ts
  // The iOS/Android chrome around a standalone PWA. Same class of problem as
  // the Windows caption strip below: painted by the OS from a value we hand it
  // once, so it has to be re-handed when the skin changes.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content",
    getComputedStyle(document.documentElement).getPropertyValue("--color-panel").trim() || "#111111");
  ```

Port Wayland's **blank-root recovery script** (`app/src/renderer/index.html:53-101`) too. It is 40 lines,
gated on an existing SW registration so it can never fire in Electron, one-shot via `sessionStorage`, and
it is the difference between "reinstall the PWA" and "it fixed itself". Wayland wrote it after a real
incident (#53). Do not make Murage learn the same lesson.

Do **not** port Wayland's inline theme-restore script or its `html,body,#root{height:100%;overflow:hidden}`
block — Murage already has the skin bootstrap in `src/main.tsx:11` (`applySkin(readSkin())` before render)
and the layout rules in `styles.css:273-285`.

### 1.6 `vite.config.ts` — the version injector, ~14 lines, no plugin

Wayland needs no `vite-plugin-pwa` and no workbox; `swVersionInjector()` at
`app/vite.renderer.config.ts:17-30` is the whole build-time story. Port it into
`/Volumes/Mando/WaylandBots/murage-app/vite.config.ts` (which currently has `plugins: [react(),
tailwindcss()]` and no `base` override):

```ts
// public/sw.js carries a __MURAGE_SW_VERSION__ token. Stamping package.json's
// version into it gives every release a unique CACHE_NAME, so the SW's own
// activate cleanup purges the previous cache and a stale bundle cannot outlive
// a release. Build only — dev leaves the token as a stable constant.
function swVersionInjector(): Plugin {
  const version = JSON.parse(readFileSync(resolve("package.json"), "utf8")).version as string;
  return {
    name: "murage-sw-version-injector",
    apply: "build",
    closeBundle() {
      const swPath = resolve("dist/sw.js");
      if (!existsSync(swPath)) return;
      const src = readFileSync(swPath, "utf8");
      const out = src.replace(/__MURAGE_SW_VERSION__/g, version);
      if (out !== src) writeFileSync(swPath, out);
    },
  };
}
```
Note the output path is `dist/`, not Wayland's `out/renderer/`. `public/` is copied verbatim by Vite,
so `sw.js`, `manifest.webmanifest` and `pwa/*` land at the dist root with no config.

Also add cache headers in the static handlers (harness `server/index.ts:8658-8662` and the new web
listener). `/assets/*` is content-hashed → `Cache-Control: public, max-age=31536000, immutable`.
`sw.js`, `index.html`, `manifest.webmanifest` → `Cache-Control: no-cache`. Today the static handler emits
no cache headers and no validators at all; browsers mostly decline to cache that, but "mostly" is a bad
property for the file that controls every other file.

---

## 2. isSecureContext — how the browser gets an HTTPS origin

Service workers require a secure context. `registerPwa` refuses otherwise (`window.isSecureContext ||
hostname ∈ {localhost, 127.0.0.1, ::1}`). Three facts constrain the answer, all verified above:

- The harness 403s any request whose `Host` is not loopback (`server/index.ts:5077`) — so the browser
  can **never** reach the harness directly over the tailnet, on any scheme. Measured: `403`.
- `createServer(proxy)` is instantiated twice from one handler (`companion/src/index.ts:150-151`) and the
  second is `managedOrigin`, which the bundled cloudflared fronts. Anything bolted onto `proxy` is public.
- The device port binds `0.0.0.0` (`companion/src/index.ts:225`) — LAN, not tailnet.

### The design

**A new, third companion listener** — call it the *web listener* — bound to `127.0.0.1` on
`MURAGE_WEB_PORT` (default 8812), fronted by `tailscale serve`. It is a sibling of `companion` and
`control` (`companion/src/index.ts:135-163`), built from its **own handler**, never
`createProxyHandler`'s. That separation is the entire point: `managedOrigin` reuses the proxy handler and
is public; the web listener must be structurally incapable of being attached to a tunnel.

```
iPhone Safari
   │  https://<machine>.<tailnet>.ts.net/        (Tailscale-issued LE cert, MagicDNS name)
   ▼
tailscale serve --bg --https=443 http://127.0.0.1:8812
   ▼
companion web listener   127.0.0.1:8812   ← binds loopback only; the tailnet is the only way in
   │  static: dist/  (index.html, /assets/*, sw.js, manifest.webmanifest, pwa/*)
   │  /api/*: allowlist → replay to harness on 127.0.0.1:8799 as this process
   ▼
harness 127.0.0.1:8799   ← Host is "127.0.0.1:8799"; the loopback gate passes by construction
```

Why the browser gets a real HTTPS origin: `tailscale cert` / `tailscale serve --https` terminates TLS
with a Let's Encrypt certificate issued for the MagicDNS name, which every device on the tailnet already
trusts through the public CA chain. No self-signed cert, no profile install on iOS, `isSecureContext` is
`true`, and the SW registers. This is the *only* path in the stated threat model that produces a trusted
HTTPS origin without public ingress: Tailscale's cert issuance uses DNS-01 against `ts.net`, so nothing
has to be reachable from the internet.

**Not** `tailscale funnel`. Funnel is public ingress and is exactly the Wayland bug already filed — its
webhook tunnel funnels the port that also serves its WebUI. Murage's rule, stated once and enforced in
review: *a tunnel is never pointed at a port that serves UI or harness routes.* The web listener is
`serve`-only; the cloudflared managed tunnel keeps `managedOrigin` and gains nothing new.

### Three concrete changes the web listener needs

1. **Static routes, off the allowlist.** `companion/src/routes.ts` is default-deny and 404s `/`,
   `/index.html`, `/assets/*`, `/manifest.webmanifest`, `/sw.js`. That stays true for the *device*
   listener. The web listener serves those from `dist/` before it ever consults the allowlist, and
   forwards nothing but `/api/*`. One handler, two policies, no shared mutable route table.

2. **An origin policy, replacing the blanket refusal.** `companion/src/proxy.ts:237-242` refuses any
   request with an `Origin` on the reasoning that "a browser has no business on it". For the device
   listener that is correct and stays. For the web listener a browser is the *only* client, and I proved
   above that same-origin POSTs carry `Origin` while GETs and SSE do not. So the web listener replaces
   the refusal with an exact-match check against its own origin:
   ```ts
   // A browser is the point here, so "has an Origin" cannot be the test. The
   // test is whether it is OUR origin: a same-origin POST sends one (verified),
   // a cross-site page's POST sends its own, and neither GET nor EventSource
   // sends any. Exact string match, no prefix, no wildcard.
   const origin = req.headers.origin;
   if (origin && origin !== selfOrigin) return sendJson(res, 403, { error: "forbidden: cross-origin" });
   ```
   `selfOrigin` comes from the configured serve hostname, not from the request. It is still true that
   the *harness* never sees an Origin, because the web listener rebuilds the upstream request the same
   way `proxy.ts:7-13` describes.

3. **Session credential, not a bearer in JS.** Out of scope for this track — the security track owns it.
   What this track needs from it: whatever it is must be readable by a plain `fetch` from the page with
   no header the SW has to add, because the SW does not touch `/api/` at all. An `HttpOnly; Secure;
   SameSite=Strict` cookie set at pairing satisfies that; a `localStorage` bearer would force every
   `fetch` call site in `src/state/store.tsx` to grow an `Authorization` header. Recommend the cookie.

### If there is no HTTPS origin — the degrade

`registerPwa` returns `undefined` and the app runs as a **normal responsive web page**, fully functional:
every feature in section 5's mobile set works over plain HTTP, because none of them is a
secure-context-only API (no `getUserMedia` — dictation is already gated off in the browser by
`desktop.ts:15-22`; no `Notification`; no `WebAuthn`). What is lost, precisely:

| Lost without a secure context | Consequence |
|---|---|
| Service worker | No offline shell, no self-healing reconnect page, no cached transcript view |
| `beforeinstallprompt` / iOS "Add to Home Screen" as a standalone app | Safari still offers Add to Home Screen, but without the manifest honoured it opens in a tab with browser chrome |
| `display: standalone` | Address bar stays; ~90px of a 844px screen goes to browser chrome |
| Push (future) | Not in scope, but would be permanently blocked |

That degrade is real but not fatal, which is the right shape: the PWA is an enhancement over a page that
already works. Build it in that order — responsive page first, then the SW on top.

**What I could not determine:** whether `tailscale serve` rewrites the `Host` header it forwards to the
backend. It does not matter for this design — the web listener has no Host gate and constructs its own
upstream request — but it *would* matter if anyone ever pointed `tailscale serve` straight at 8799, which
would 403 everything. Worth a line in the runbook saying why that shortcut does not work.

---

## 3. The responsive work, component by component

Ordered by "the app is unusable without this" → "the app is nice with this".

### Tier 0 — global, ~1 file each, unblocks everything

**0.1 `index.html:5` — `viewport-fit=cover`.** Currently `width=device-width, initial-scale=1.0`. Without
`viewport-fit=cover`, iOS resolves every `env(safe-area-inset-*)` to `0px`, so all of 0.2 is dead code.
This attribute must land first.

**0.2 `src/styles.css:273-285` — safe areas and touch behaviour.** Currently: `html,body,#root{height:100%}`,
`body{overflow:hidden}`, and zero `env()`. Replace with:
```css
html, body, #root { height: 100%; }
/* The visual viewport, not the layout viewport. On iOS the layout viewport does
   not shrink when the keyboard opens, so 100% here is the pre-keyboard height —
   which is how a bottom-docked composer ends up under the keyboard. --vvh is
   written by the visualViewport listener in section 4; the 100% is the fallback
   for every browser that never fires it. */
#root { height: var(--vvh, 100%); }

body {
  overflow: hidden;
  /* iOS rubber-band on the document drags the whole standalone app; the
     transcript keeps its own overscroll-y-contain (ChatView.tsx:1195). */
  overscroll-behavior: none;
  /* Safari inflates text in landscape without this, which desynchronises every
     measured layout below. */
  -webkit-text-size-adjust: 100%;
}
```
Safe-area padding goes on the *elements at the edges*, not on `body` — `body` is `overflow:hidden` and a
padded body would shrink the flex column rather than inset its contents. Concretely: the Sidebar aside
(`Sidebar.tsx:1375`) gets `pt-[env(safe-area-inset-top)]`, the composer dock (`ChatView.tsx:1346`) gets
`pb-[env(safe-area-inset-bottom)]`, the chat header (`ChatView.tsx:1069-1076`) gets
`pt-[env(safe-area-inset-top)]`.

**0.3 `styles.css` — one touch-target rule, not 100 edits.** 30 of 34 rendered controls are under 44px
in at least one axis; 15 distinct `size-8`, 11 `size-9`, 6 `size-6`, 5 `size-7` occurrences across 18
files. Growing them breaks the desktop density that is the app's whole look. Expand the *hit* area
without moving a pixel:
```css
/* A coarse pointer needs 44px of target; the desktop needs 30px of chrome.
   The pseudo-element gives the first without changing the second — no layout
   shift, no reflow of the header chip row. `position: relative` comes with the
   utility so a caller cannot half-apply it. */
@media (pointer: coarse) {
  .tap-44 { position: relative; }
  .tap-44::after {
    content: ""; position: absolute; top: 50%; left: 50%;
    width: max(100%, 44px); height: max(100%, 44px);
    transform: translate(-50%, -50%);
  }
}
```
Then add `tap-44` to the icon buttons in the mobile surfaces only. Bounded: 29 buttons in
`ChatView.tsx`, 12 in `Composer.tsx`, 34 in `Sidebar.tsx`, 23 in `GroupView.tsx`, 4 in
`ComposerAttachments.tsx`, 3 in `ChatFindBar.tsx` — and only those that are actually small (~35 class
sites). Overlapping `::after` boxes between adjacent 30px buttons is the one hazard; the header chip row
in `ChatView.tsx:1068-1076` is the place to check, and `gap-1` there needs to become `max-md:gap-2`.

**0.4 `Composer.tsx:841` — `text-[15px]` → `text-[16px]`.** Measured `fontSize: 15px`. Any focused input
under 16px triggers iOS's zoom-on-focus, which then leaves the page zoomed and the composer half
off-screen. 16px is the threshold; 15 → 16 is invisible on desktop and fixes it everywhere. Same sweep
for any other `<input>`/`<textarea>` in the mobile surface set — check `ChatFindBar.tsx`,
`CommandPalette.tsx`, `SettingsModal.tsx:592` search input, `RenameTitle.tsx`.
Do **not** reach for `maximum-scale=1` in the viewport meta — it disables pinch zoom and is an
accessibility regression.

### Tier 1 — the layout collapses

**1.1 `InspectorPanel.tsx:184` — `w-[460px] shrink-0`.** Proven: at 390px the chat becomes `main.w=0`
and the document scrolls 71px sideways. Fix: make it a full-screen overlay below `md`, a side panel
above.
```
"animate-panel-in flex h-full flex-col border-l border-hairline/40 bg-panel"
"md:w-[460px] md:shrink-0"
"max-md:absolute max-md:inset-0 max-md:z-40 max-md:w-full"
```
Note the `max-md:` scoping discipline from `Sidebar.tsx:1381-1387`: Tailwind v4 emits a native
`translate` property, and any value other than `none` turns the element into a containing block for its
`fixed` descendants — so mobile rules are *scoped with `max-md:`*, never *cancelled with `md:`*. Follow
that in every rule below. (Inspector is desktop-only per section 5, so this is a safety net rather than a
shipped surface — but a 0px-wide chat is a bug at any window size, including a narrow desktop window.)

**1.2 `SettingsPanel.tsx:378` — `w-[400px] shrink-0`.** Same treatment, and this one *does* ship to
mobile (agent profile): `md:w-[400px] md:shrink-0` + `max-md:absolute max-md:inset-0 max-md:z-40
max-md:w-full`, plus a back affordance in its header since it now covers the chat.

**1.3 `ComputerPanel.tsx:833-834` — `style={{width: panelWidth}}` with `shrink-0`, from
`localStorage` (`ComputerPanel.tsx:129-142`, min 360 / default 400 / max 960).** An inline `style` width
beats every Tailwind class, so `max-md:w-full` will not fix it. Two lines:
```ts
// Below md the panel is the screen, not a column beside it. A persisted
// desktop width must not become a fixed 400px column on a 390px phone.
const coarse = matchMedia("(max-width: 767px)").matches;
style={coarse ? undefined : { width: panelWidth }}
```
plus `max-md:absolute max-md:inset-0 max-md:z-40 max-md:w-full` on the aside, and hide the resize
separator (`ComputerPanel.tsx:836-840`) under `max-md:hidden` — a drag handle on a touch screen fights
the scroll gesture. ComputerPanel is excluded from mobile per section 5, so this is again the
narrow-desktop-window fix, and it is cheap.

**1.4 `SettingsModal.tsx:584` — `h-[560px] w-full max-w-[860px]` with a `w-[190px] shrink-0` nav
(`:586`).** Measured at 390x844: dialog 342×560, nav 190px, leaving **152px** of content. Fix:
```
"flex h-[560px] w-full max-w-[860px] … "
→ "flex w-full max-w-[860px] overflow-hidden rounded-2xl …
   h-[min(560px,calc(100dvh-2rem))]
   max-md:h-[100dvh] max-md:max-w-none max-md:rounded-none max-md:flex-col"
```
and the nav `w-[190px] shrink-0` → `md:w-[190px] md:shrink-0 max-md:w-full max-md:flex-row
max-md:overflow-x-auto max-md:border-b max-md:border-r-0`. This turns the sidebar nav into a horizontal
scroller above the content, which is the standard phone settings shape. The codebase already knows this
pattern — `PluginsPanel.tsx:481` and `TeamLibraryPanel.tsx:431` use
`h-[min(780px,calc(100dvh-2rem))]`. `SettingsModal` just never got it.

**1.5 `Sidebar.tsx:1379` — `w-[320px]` on a 390px screen.** The drawer works (`Sidebar.tsx:1388-1390`,
`max-md:absolute … translate-x-full`) but leaves 70px of chat. `max-md:w-[min(320px,86vw)]` gives a
proper edge to tap. Also add `max-md:pt-[env(safe-area-inset-top)]` — in `black-translucent` mode the
drawer header currently sits under the clock.

### Tier 2 — the layout survives but reads badly

**2.1 `Composer.tsx` — 929 lines, zero breakpoints.** Six things:
- `:566` `px-5 pb-3` → `px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:px-5 md:pb-3`. This is
  the home-indicator fix.
- `:841` textarea → 16px (0.4 above), and `max-h-[9rem]` → `max-h-[min(9rem,32dvh)]` so a six-line draft
  cannot eat the transcript on a short screen. The autosize cap at `:319-326` computes from
  `lineHeight × 6` and needs no change.
- `:107` mention popup `w-80` (320px) and `:622` permission popup `w-72` → `w-[min(20rem,calc(100vw-1.5rem))]`.
  Both are `absolute bottom-full left-0/left-2` and will overflow the right edge at 390px.
- The trailing action cluster (`:842`+, Stop / Mic / Send, each `size-8`) gets `tap-44`. The mic button
  at `:859-871` is already gated on `capabilities.dictation.available`, which is `false` in a browser
  (`desktop.ts:15-22`) — one fewer control to make room for, for free.
- `:32` `size-8` attach button and `:32` "Ask for approval" (measured 69×32) get `tap-44`.

**2.2 `ChatView.tsx:1069-1076` header.** Already has `pl-11 md:pl-5` for the drawer button, and
`@container/chathead` so the right-hand chips fold — that part is done and works. Missing:
`pt-[env(safe-area-inset-top)]`, and `max-md:gap-2` on the chip row so `tap-44` boxes do not overlap.
The agent-profile button at `:1080-1083` is already `size-10` (40px) — one `tap-44` away from compliant.
`GroupView.tsx:1035` has the same `pl-11 md:pl-5` and needs the same two additions.

**2.3 `ChatView.tsx:1195` transcript pane — `px-5`.** → `px-3 md:px-5`. 40px of a 390px screen is 10% of
the line length. `overscroll-y-contain` and `[overflow-anchor:none]` are already right; leave them.

**2.4 `ChatView.tsx:1334-1336` "Jump to latest" — `style={{bottom: composerDock.height}}`.** Correct
today and correct after section 4, because `composerDock.height` is measured by `ResizeObserver`
(`composer-dock.ts:24-31`). No change needed. Worth stating: this is the one piece of the layout that
was already built to move with the composer, and section 4 rides on it.

**2.5 `ModelPicker.tsx:285-286`.** Already has a narrow branch (`relative mt-3 w-full max-h-[min(420px,50dvh)]`)
next to the desktop `w-[380px]`. Confirm the branch condition keys on width and not on a desktop-only
capability; if it keys on the container it is already correct and this line is free.

### Tier 3 — polish

`SearchResults.tsx`, `ApprovalCard.tsx`, `AttachmentPreview.tsx` (already has breakpoints),
`CommandPalette.tsx`, `RenameTitle.tsx`, `TaskPicker.tsx`, `BotPickerList.tsx`. All render inside the
surfaces above; mostly a `px-5 → px-3 md:px-5` sweep and `tap-44` on their buttons.

### Deliberately not doing

**The 1,073 arbitrary font sizes.** `text-[13px]` ×258, `[12px]` ×216, `[12.5px]` ×139, `[11.5px]` ×114,
`[11px]` ×84. These are absolute px in Tailwind arbitrary values, so no root `font-size` change reaches
them, and editing them is a thousand-line diff with a thousand chances to break desktop density. On a 3×
retina phone 11-13px is legible. The one size that *must* change is the 15px on focusable inputs, and
that is 0.4 above. If Sean later wants a mobile type bump, the honest way is a
`@media (pointer: coarse)` block in `styles.css` overriding the five arbitrary classes by name — about
ten lines — not a refactor. Flag it, do not do it now.

---

## 4. visualViewport and the iOS keyboard

### The mechanism, stated exactly

On iOS Safari the **layout viewport does not change** when the software keyboard opens. `window.innerHeight`,
`100vh`, `100dvh` and `height: 100%` all keep their pre-keyboard values. Only `window.visualViewport`
shrinks. Murage's chat is `#root{height:100%}` (`styles.css:273-277`) → flex column → transcript pane
`min-h-0 flex-1` (`ChatView.tsx:1192`) → composer dock `absolute inset-x-0 bottom-0` (`ChatView.tsx:1346`).
"Bottom" is the bottom of the *layout* viewport. So when the keyboard opens, the composer — the element
the user just tapped — is behind it. Measured pre-keyboard: the textarea sits at `y: 794, bottom: 826`
in an 844px viewport, i.e. the dock's bottom edge is exactly `innerHeight`. There are **zero**
`visualViewport` references in `src/` (grep).

### The fix

One hook, one CSS variable, no component rewrites. It works because
`useComposerDockPad` (`src/lib/composer-dock.ts:22-35`) already measures the composer with a
`ResizeObserver` and already pads the transcript by that height; the only missing input is the keyboard.

`src/lib/visual-viewport.ts` (new, ~40 lines):

```ts
/** The visual viewport height as a CSS variable, plus the keyboard inset.
 *
 * iOS does not resize the layout viewport for the software keyboard, so a
 * bottom-docked composer inside a 100%-height column ends up behind it. Every
 * other approach to this (scrollIntoView on focus, position:fixed, a resize
 * listener on window) fails on one of: rubber-band, a rotated device, or a
 * hardware keyboard attached mid-session. visualViewport is the only signal
 * that is correct in all three. */
export function trackVisualViewport(): () => void {
  const vv = window.visualViewport;
  if (!vv) return () => {};             // desktop Firefox pre-91, and Electron
  let frame = 0;
  const apply = () => {
    frame = 0;
    const root = document.documentElement;
    // offsetTop matters when the page is pinch-zoomed: the visual viewport can
    // be scrolled within the layout viewport, and the keyboard inset is what is
    // left below it, never a negative number.
    const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    root.style.setProperty("--vvh", `${vv.height}px`);
    root.style.setProperty("--kb", `${inset}px`);
    root.dataset.keyboard = inset > 80 ? "open" : "closed";   // 80px: taller than
    // any URL-bar collapse, shorter than any keyboard.
  };
  // Coalesce: iOS fires resize+scroll many times through the keyboard animation.
  const schedule = () => { if (!frame) frame = requestAnimationFrame(apply); };
  vv.addEventListener("resize", schedule);
  vv.addEventListener("scroll", schedule);
  apply();
  return () => {
    vv.removeEventListener("resize", schedule);
    vv.removeEventListener("scroll", schedule);
    if (frame) cancelAnimationFrame(frame);
  };
}
```

Called once from `src/App.tsx` in the existing effect block (near `:213`), not per-component.

Consumers, all one-liners:
- `styles.css`: `#root { height: var(--vvh, 100%); }` (section 3.0.2). The whole column shrinks with the
  visual viewport, so `absolute bottom-0` lands on top of the keyboard rather than under it. This alone
  fixes the composer.
- Composer dock (`ChatView.tsx:1346`): safe-area padding collapses when the keyboard is up, because the
  home indicator is behind the keyboard —
  `pb-[max(0px,env(safe-area-inset-bottom))] data-[keyboard=open]:pb-0` driven off
  `documentElement.dataset.keyboard`, or simply
  `pb-[calc(max(0px,env(safe-area-inset-bottom)) - min(var(--kb,0px), env(safe-area-inset-bottom)))]`.
  Prefer the data-attribute — it is readable.
- `SettingsModal.tsx:584`: `max-md:h-[100dvh]` → `max-md:h-[var(--vvh,100dvh)]` so its footer buttons
  stay reachable with the keyboard up.

### What happens to a scrolled transcript when the keyboard opens

This is the part people get wrong, and the reason for a rule rather than an accident.

`#root` shrinks by the keyboard height. The transcript pane is `min-h-0 flex-1` (`ChatView.tsx:1192`) so
its `clientHeight` shrinks by the same amount while `scrollHeight` is unchanged — meaning `scrollTop`
stays put and **the content the user was reading scrolls up out of view by exactly the keyboard height**,
from the bottom. Two cases, two behaviours:

1. **Pinned to the end** (`follow === true`, `ChatView.tsx:1004-1008`, threshold 4px in
   `bottom-follow.ts:3`). Stay pinned. The existing scroll effect at `:1004` already depends on
   `composerDock.pad`; add `--kb` to its dependency list so it re-runs on the keyboard transition and
   re-pins to `scrollHeight`. The last message stays glued above the composer, which is what a chat app
   does.

2. **Reading scrollback** (`follow === false`). **Preserve the anchor, do not jump.** Before applying the
   new height, capture `distanceFromBottom = scrollHeight - scrollTop - clientHeight`; after, restore
   `scrollTop = scrollHeight - clientHeight - distanceFromBottom`. The reader's position relative to the
   message they were looking at is unchanged, and the "Jump to latest" pill (`ChatView.tsx:1332-1339`,
   already positioned at `bottom: composerDock.height`) rides up with the composer. There is prior art
   for exactly this bookkeeping at `ChatView.tsx:1015` (`preExpandHeight.current = scrollRef.current?.scrollHeight`)
   — reuse the pattern rather than inventing a second one.

Do **not** call `scrollIntoView()` on focus. It is the reflex fix and it is wrong: iOS fires it against
the layout viewport, so it scrolls the *document* (which is `overflow:hidden`, `styles.css:284`) rather
than the transcript, and on a rotated device it lands somewhere arbitrary. The `--vvh` approach means
nothing needs to scroll on focus at all.

Also set `overscroll-behavior: none` on `body` (section 3.0.2). Without it, an over-scroll gesture in a
standalone iOS PWA drags the whole app down and reveals the page ground under a keyboard that has not
moved — visually broken and un-dismissable without a scroll back.

### Testing it

Chromium's `visualViewport` never shrinks for a keyboard, so Playwright cannot regression-test this
directly. Two things that *are* testable and worth wiring:
- Unit-test the inset math (`window.innerHeight - vv.height - vv.offsetTop`, clamped at 0) with a fake
  `visualViewport`, alongside `src/lib/composer-dock.test.ts` which already tests this neighbourhood.
- Drive it in Playwright by dispatching a synthetic `visualViewport` resize with a stubbed height and
  asserting `--vvh`, `--kb` and `data-keyboard` land correctly and the transcript anchor is preserved.
  That tests the code; the device test stays manual, on Sean's phone, once.

---

## 5. Which surfaces ship to mobile, and how they are excluded

### The set

**Ships:**
- Chat with a bot — `ChatView.tsx`, `Composer.tsx`, `ChatMarkdown.tsx`, `ApprovalCard.tsx`,
  `AttachmentPreview.tsx`, `ReplyQuote.tsx`, `WorkingIndicator.tsx`, `TurnPresence.tsx`
- Rooms — `GroupView.tsx`, `ManageMembersPanel.tsx`
- The roster / drawer — `Sidebar.tsx`, `BotPickerList.tsx`, `Avatar.tsx`, `SidebarSectionHeader.tsx`
- Tasks — `TaskPicker.tsx`
- Search — `SearchResults.tsx`, `ChatFindBar.tsx` *(see the defect note below)*
- Agent profile, read-mostly — `SettingsPanel.tsx` restricted to identity / avatar / notifications /
  voice, matching what `companion/src/routes.ts:81` already allows (`PATCH /api/bots/:id/profile`)
- Routines, list and run — `RoutinesPage.tsx`, `RoutineRunCard.tsx` (allowlisted at `routes.ts:118-123`)
- Model picker — `ModelPicker.tsx` (read-only; changing an instance is not)
- Pairing — `PhoneSetupFlow.tsx` (repurposed; it is the QR flow today)

**Does not ship:**

| Surface | File | Why |
|---|---|---|
| Bot's computer | `ComputerPanel.tsx` (1401), `AndroidDevicePanel.tsx` (349) | Desktop-shaped, fixed-px, and its routes are the cloud-desktop-join family gated per-device at `proxy.ts:257-259` |
| Browser control | `BrowserPanel.tsx` (838), `BrowserWorkspace.tsx` | Same |
| Local VM | `LocalVmWorkspace.tsx` (799), `LocalComputerSection.tsx`, `MacLocalControl.tsx`, `LinuxLocalControl.tsx`, `LocalScreenPreview.tsx` | `desktop.ts:15-22` already reports `localComputer.available: false` in a browser |
| Skill recorder | `SkillRecorderPage.tsx` (518) | Records desktop input |
| Inspector | `InspectorPanel.tsx` | Raw protocol; also the only caller of `/api/threads/:id/events` |
| App settings | `SettingsModal.tsx` (710) | Contains engine setup, which drives `PATCH /api/instances/:id` (`server/index.ts:8073`) and `POST /api/cli-test` (`:8051`) — the two-request RCE. Never render a UI on a phone whose only correct outcome is a 404. |
| Plugins / MCP | `PluginsPanel.tsx` | Host configuration |
| Webhooks | `WebhooksPanel.tsx` | Explicitly denied by the allowlist already |
| Team library / import / map | `TeamLibraryPanel.tsx`, `TeamMapPage.tsx` | Filesystem-shaped (`/api/teams/scout?cwd=…`) |
| Calls | `CallView.tsx`, `GroupCallView.tsx` | Already gated — measured, the call button renders as "Calls currently need the macOS desktop app" |
| API keys | `ApiKeys.tsx`, `EnginesSettings.tsx` | Credentials |

### How it is excluded — answered concretely

I read `vite.config.ts` and the entry graph. **A second bundle is feasible but wrong here.**

- There is exactly one entry: `index.html:11` → `/src/main.tsx` → `App.tsx`. `vite.config.ts` has no
  `build.rollupOptions.input`, so adding `{ index: 'index.html', mobile: 'mobile.html' }` is
  mechanically about six lines.
- But there is **no router**. `App.tsx:248-280` is a chain of ternaries on `state.activeView`. A second
  entry would need a parallel `AppMobile.tsx` reproducing that chain, the `StoreProvider`
  (`store.tsx`, ~2000 lines), `DesktopCapabilitiesProvider`, and the shell — then two shells drift, and
  the drift is silent because neither build type-checks the other's behaviour.
- And the payload win is smaller than it looks. The desktop-only roots total **9,069 lines of 39,277**
  non-test src lines (23%), but the 497 KB gzip main chunk is dominated by React, `react-markdown`,
  `shiki`'s core (`index-BSUrauK2.js`, 198 KB raw / 62 KB gz), `lucide-react`, `posthog-js` and
  `qrcode.react` — none of which a second entry drops.

**Recommendation: one monolith, runtime gating for the decision, `React.lazy` for the payload.**

1. **The gate already exists.** `src/lib/desktop.ts:33` returns `browserCapabilities` whenever
   `window.muragebox?.platform` is absent, and that object already reports `screenPreview`, `dictation`
   and `localComputer` as unavailable with `reasonCode: "desktop-app-required"` (`desktop.ts:1-28`).
   Extend it with the surfaces above rather than inventing a second mechanism — one predicate, one place
   to audit. Add `computer`, `browserControl`, `skillRecorder`, `inspector`, `appSettings`,
   `plugins`, `webhooks`, `teamLibrary` as the same shape.
2. **`React.lazy` on the four desktop roots in `App.tsx`** — lines 11 (`ComputerPanel`), 19
   (`LocalVmWorkspace`), 20 (`BrowserWorkspace`), 21 (`SkillRecorderPage`), plus `InspectorPanel`,
   `SettingsModal`, `PluginsPanel`, `TeamLibraryPanel`, `TeamMapPage`. `ComputerPanel.tsx:33-34` already
   makes `AndroidDevicePanel` and `BrowserPanel` its children, so those come along for free. Four to
   nine `const X = lazy(() => import(...))` lines plus a `<Suspense>` wrapper around the ternary chain at
   `App.tsx:248`.
3. **Say the honest thing about what this is.** Code-splitting and runtime gating are a *product*
   decision, not a security boundary. A curious browser can still request the lazy chunk. The boundary is
   and remains `companion/src/routes.ts` — default-deny, in a diff someone reads. That is why the route
   table matters and the bundle does not.

Estimated main-chunk effect: ~9k of ~39k app lines move out of the entry chunk. The entry chunk is
mostly library code, so expect the 497 KB gz to land around 420-460 KB gz — a real but unspectacular win.
The larger and cheaper mobile-payload wins, if Sean wants them, are `posthog-js` (dynamic-import
`src/lib/analytics.ts:14` behind the opt-in it already checks at `:65`) and `qrcode.react`
(`PhoneSetupFlow.tsx:20`, used on exactly one screen). Both are one-line `await import()` changes.

### The route-table delta the security track needs from this section

The current allowlist was derived from the iOS app. The PWA calls different routes. Deltas found by
enumerating `/api/` string literals across `src/`:

- **Needed, currently missing:** `GET /api/groups`, `GET /api/bots/:id`, `PATCH /api/bots/:id`
  (unread flag only — `store.tsx:1652,1660`), `POST /api/bots/:id/respond` (`store.tsx:1581,1605`),
  `DELETE /api/bots/:id/queue/:id` (`store.tsx:1491`), `POST /api/groups/:id/interrupt`,
  `PATCH /api/groups/:id` (unread), `GET /api/section-context`, `POST /api/tts/prepare`,
  `POST /api/subscribe`.
- **Allowlisted but never called by the web app:** `GET /api/threads/:id/messages` (`routes.ts:99`) —
  the iOS-only transcript route. It can be dropped with the iOS app.
- **Live defect, not mine to fix but named here because it is in a shipping surface:**
  `GET /api/search` is allowlisted (`routes.ts:105`) and `server/message-db.ts:196` does an unrestricted
  cross-thread, cross-bot scan when `threadId` is absent. The UI calls it both ways
  (`?q=…&limit=12`, `?q=…&limit=100&threadId=…`). If search ships to mobile, the allowlist entry must
  require `threadId`, or the harness must scope it. Shipping `SearchResults.tsx` to the PWA on today's
  rule hands a paired browser a full-transcript grep.
- **`PATCH /api/instances/:id` and `POST /api/cli-test` stay 404'd.** Section 5 excludes the UI that
  calls them for the same reason.

---

## 6. Effort

Hours are engineer-hours for someone who already knows this codebase, including the test and review
passes, excluding Sean's review cycles.

### PWA plumbing — **11-15 h**

| Work | h | Reasoning |
|---|---|---|
| Icons from `icon-1024.png`, 4 files | 0.5 | Commands verified end-to-end in scratch; the only judgement is the maskable inset |
| `manifest.webmanifest` | 0.5 | A port with three values changed |
| `sw.js`: Wayland shell + AionUi guard, retokenised | 2.5 | Not a copy — two files merged, `NON_CACHEABLE_PATHS` dropped, and the merge has to be reasoned about rather than pasted |
| `registerPwa.ts` + `main.tsx` call site | 0.5 | 45 lines, one predicate changed |
| `index.html` head block + blank-root recovery | 1.0 | Mostly a port; `black-translucent` is a decision with a consequence |
| `swVersionInjector` in `vite.config.ts` | 0.5 | 14 lines, output path changed |
| Harness MIME table + cache headers | 0.5 | Five map entries and three `Cache-Control` lines, in two static handlers |
| `theme-color` follows the skin (`skins.ts:63`) | 0.5 | |
| **New companion web listener** | 4-6 | The real work. Third `createServer`, its own handler, static serving with the SPA fallback, `/api/*` through the allowlist, exact-match origin policy, bind 127.0.0.1, port-conflict guard matching `index.ts:216-222`, plus tests. It must be structurally separate from `createProxyHandler` so nobody can attach it to `managedOrigin` later. |
| `tailscale serve` runbook + a check that no tunnel fronts it | 1.0 | Includes writing down *why* pointing `serve` at 8799 does not work |
| Install-and-launch verification on the actual phone | 0.5 | |

Risk in that range is almost entirely the web listener. If the security track decides the PWA should
instead ride the existing device listener with a mode flag, subtract ~3 h and add a permanent hazard —
I would not take that trade.

### Responsive to tolerable — **13-18 h**

Definition of tolerable: nothing collapses, nothing is under a finger's width in the shipped surfaces,
the keyboard does not cover the composer, and iOS does not zoom on focus.

| Work | h | Reasoning |
|---|---|---|
| Tier 0 globals (`viewport-fit`, `styles.css`, `tap-44`, 16px inputs) | 2.0 | Four small edits; the `tap-44` rule takes a couple of iterations to stop adjacent boxes overlapping |
| Apply `tap-44` across ~35 class sites in 6 files | 2.5 | Mechanical but each needs a look at its container's `gap` |
| Tier 1 collapse fixes (Inspector, SettingsPanel, ComputerPanel, SettingsModal, Sidebar width) | 4.0 | Five components; ComputerPanel's inline `style` needs the `matchMedia` branch, SettingsModal's nav is a genuine relayout |
| visualViewport hook + `--vvh` wiring + scroll-anchor preservation | 3.5 | The hook is 40 lines; the scroll-anchor bookkeeping in `ChatView.tsx` is where the time goes, and it interacts with the existing `follow` state at `:1004-1030` |
| Composer padding / popup widths / max-height | 1.5 | |
| `React.lazy` + capability gating for the excluded set | 2.0 | Nine `lazy()` lines, one `<Suspense>`, extending `desktop.ts`'s capability object, and checking nothing renders a null panel |
| Measure again at 390×844 and 430×932, fix the fallout | 2.0 | There is always fallout |

The reason this is 13-18 h rather than 40 is that the shell is genuinely done — `App.tsx:37,224-239`
(drawer state, hamburger, scrim) and `Sidebar.tsx:1374-1392` (`max-md:` slide-in) are correct, and
`Sidebar.tsx:1381-1387`'s comment about Tailwind v4 emitting `translate` is the kind of thing that costs
a day to rediscover. Somebody already paid that.

### Responsive to good — **+22-30 h on top**

Definition of good: it reads as designed for a phone rather than survived on one.

| Work | h |
|---|---|
| Mobile navigation model — a real back stack for roster → chat → profile, since three of the four panels now cover the chat rather than sitting beside it; today's `dispatch({type:"toggleSettings"})` has no history integration and the hardware/edge back gesture does nothing | 6-8 |
| Composer redesign for touch: the trailing cluster (attach / approval / mic / stop / send) is five controls in ~150px; on a phone that wants a sheet or an overflow | 4-5 |
| Transcript density and bubble layout at 390px — `ChatMarkdown` code blocks, tables and `shiki` output all need their own horizontal scroll containers | 4-5 |
| Sidebar reworked as a mobile roster (sections, unread, search) rather than a 320px desktop column slid sideways | 4-5 |
| Pull-to-refresh / reconnect affordance and an offline state that says something true | 2-3 |
| The `@media (pointer: coarse)` type-scale block, if Sean wants it after seeing it on device | 2-4 |

Total for everything: **46-63 h**. My recommendation on sequencing: PWA plumbing and
responsive-to-tolerable are one milestone (24-33 h) and ship together, because a PWA of a broken layout
is worse than a browser tab of a broken layout — the standalone install removes the URL bar the user
would otherwise use to escape. Responsive-to-good is a separate milestone Sean decides on after using the
first one on his own phone for a week.

---

## Open questions for Sean

1. **Search on mobile.** The `GET /api/search` cross-thread scan is a live defect. Cheapest correct
   answer is to require `threadId` in the allowlist entry, which means find-in-conversation ships and
   global search does not. Ship it that way, or hold search off mobile until the harness scopes it?
   My pick: ship find-in-conversation, hold global search — the value of global search on a phone is low
   and the exposure is total.
2. **Session credential shape.** I recommend an `HttpOnly; Secure; SameSite=Strict` cookie set at pairing,
   because it keeps every `fetch` call site in `store.tsx` unchanged and keeps the token out of JS. The
   security track owns the decision; this track needs to know before the web listener is written.
3. **`black-translucent` status bar.** It is the right call for a dark-first app but it puts content under
   the clock until the safe-area work lands. Both land in the same milestone, so this is a heads-up, not
   a question — unless Sean wants `default` as an interim.
