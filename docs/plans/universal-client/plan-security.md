# Murage security architecture — the browser door

How a browser on Sean's phone, over Tailscale, safely reaches Murage.

Every claim below is either cited to `file:line` or was proven by running something; the
proofs are collected in §9. Where I could not determine something, it says so.

---

## 0. What is actually true today (verified, not assumed)

| Claim | Status | Evidence |
|---|---|---|
| Harness serves the built UI when `MURAGE_STATIC_DIR` is set | true | `server/index.ts:241`, `:8653-8669` |
| Harness binds loopback only, no env override | true | `server/index.ts:8681` `server.listen(PORT, "127.0.0.1", …)` |
| Harness `Host` gate fires before any route | true | `server/index.ts:5077-5079`, inside the `createServer` handler at `:5069` |
| Harness has zero authentication | true | no auth on any `/api/` route except `/api/internal/*` (`server/index.ts:5088` shared-token) |
| `routes.ts` is default-deny | true | `companion/src/routes.ts:184-194` |
| Companion 403s any `Origin`, before the token check | true | `companion/src/proxy.ts:240-242`; **proven live**, §9.2 |
| Companion does not forward `Host`/`Origin` | true | `companion/src/proxy.ts:200-227` — `forwardHeaders` is an allowlist of 5 headers |
| `PATCH /api/instances/:id` + `POST /api/cli-test` = RCE in two requests | true | `server/index.ts:8073-8100`, `:8051-8067`; both gated only by a content-type check (`:8055`, `:8075`) |
| Both are 404'd by the allowlist today | true | **proven live**, §9.3 |
| `GET /api/search` is allowlisted and unscoped | true | `routes.ts:102`; `server/message-db.ts:196` `const scope = threadId ? "thread_id = ? AND " : ""`; **proven live**, §9.3 |
| Pairing is strong (32B random, SHA-256 at rest, timingSafeEqual, 120s, 5 attempts, per-device revoke) | true | `devices.ts:189`, `:266`, `:71-91`, `:63-64`, `:333-340` |
| `companion/src/index.ts:150-151` — two listeners share one handler | true | `const companion = createServer(proxy); const managedOrigin = PRIVATE_ORIGIN ? createServer(proxy) : null;` |
| `endpoints.ts` ranks "hosted" ahead of tailnet | true | `endpoints.ts:71` priority 0 vs `:73` priority 100 |

**Three corrections to the brief.** These change the design, so they lead.

1. **The companion device port already binds `0.0.0.0`** — `companion/src/index.ts:226`
   `await listen(companion, COMPANION_PORT, "0.0.0.0")`. The brief's question "does anything
   in the design bind 0.0.0.0" has a pre-existing yes. It exists to serve the LAN + Bonjour
   path for the iOS app. iOS is being retired (decision 2), which removes its only
   justification. See §7.

2. **`managedOrigin` is a Unix socket / named pipe, not a TCP port** — `companion/src/origin.ts:11-30`
   validates the shape, `:34-67` binds it and `chmod 0600`s it. That is what cloudflared
   fronts. So "keep the browser door off the socket cloudflared fronts" is achievable by two
   independent means, not one. See §2.

3. **Tailscale HTTPS is OFF on this tailnet right now.** `tailscale status --json` reports
   `CertDomains: null` (§9.1). So `Secure` cookies are *not* available on day one; they become
   available only after Sean enables HTTPS Certificates in the admin console. The design must
   be correct over plain HTTP-on-WireGuard and *upgrade* to `Secure`/`__Host-` when TLS lands.
   The brief's "Tailscale gives real HTTPS, so Secure is available" is conditional, not free.

---

## 1. Where the UI is served from

### Decision

**A new, fourth listener in the sidecar — the "browser door" — bound to the Tailscale address
only, running its own handler, forwarding to the harness through `denyReason()`.**

The harness static branch (`server/index.ts:8653`) stays exactly where it is and stays
loopback-only. It is not the remote door and never becomes one. The browser door forwards
`GET /`, `GET /assets/*` and the PWA files *to* that branch over loopback, the same way every
other route is forwarded — so there is one copy of the bundle and one place it is built.

### Why not the existing device port

Proven, not argued: a browser cannot use it. `dist/index.html` loads its bundle with
`<script type="module" crossorigin src="/assets/index-*.js">`, and a `crossorigin` script tag
is a CORS-mode fetch, which sends `Origin` **even same-origin** (§9.4). `proxy.ts:240` would
403 the app's own entry bundle. Every `POST` would 403 too. The device port is not a browser
port and the fix is not to weaken it — see §2.

### Why not proxy `/` from a browser door that re-implements static serving

Considered and rejected. A second static server means a second MIME table, a second traversal
guard, and a second thing to keep in step with the vite build. Forwarding keeps `routes.ts` as
the single readable diff, which is the file's stated contract (`routes.ts:17-19`).

Two upstream defects have to be fixed for the forward to be correct:

- **`.webmanifest` has no MIME entry.** `server/index.ts:242-251` maps
  `.html .js .css .svg .png .ico .json .woff2` and nothing else; anything else falls to
  `application/octet-stream` (`:8658`). A manifest served as octet-stream is ignored by the
  browser and the PWA never installs. One line: `".webmanifest": "application/manifest+json"`.
- **The SPA fallback answers *everything*.** `server/index.ts:8660-8669` — a miss on
  `/assets/typo.js` returns `index.html` with `content-type: text/html` and **status 200**.
  A service worker precaching a stale hashed asset caches HTML under a `.js` URL and the app
  breaks in a way that survives reload. AionUi guards this with `networkOnlyWithTypeGuard` in
  `public/sw.js`; Wayland dropped it. The browser door must not rely on the fallback: it
  allowlists the exact static paths and 404s the rest, so the fallback is only ever reached
  for a genuine SPA route.

### The exact `routes.ts` change

`routes.ts` today has one `ALLOWED` list consumed by one `denyReason()`. Adding the UI paths
to that list would hand them to the device port as well. So the file grows a **surface**
discriminator — a change that keeps its promise ("adding a feature to the phone means adding
its route here, on purpose, in a diff someone can read") rather than diluting it.

```ts
// companion/src/routes.ts

/** Which door a request arrived at.
 *
 * The two are not the same surface and never converge. `device` is a native
 * client holding a bearer token and sending no Origin. `browser` is a page
 * this sidecar served, holding a cookie, sending Origin on every write. A
 * route reachable from one is not thereby reachable from the other, and the
 * two lists below are the whole statement of that. */
export type Surface = "device" | "browser";

export interface RouteRequest {
  path: string;
  method: string;
  authenticated: boolean;
  surface: Surface;          // NEW — no default; every caller must decide
}
```

`ALLOWED` is renamed `DEVICE_ALLOWED` and left **byte-identical** except for the two removals
in §4.3. A second list is added:

```ts
/** The UI shell itself. Only the browser door serves these; a native client
 * has its own bundle and has no use for them.
 *
 * Anchored and exact. `/assets/` carries vite's content hashes, so the pattern
 * is the hash alphabet plus one extension from the set the build actually
 * emits — not `.*`. An unmatched static path is a 404 here rather than the
 * harness's SPA fallback, which answers 200 text/html to any miss
 * (server/index.ts:8660) and would let a service worker cache HTML as JS. */
const BROWSER_SHELL: ReadonlyArray<{ method: string; path: RegExp }> = [
  { method: "GET", path: /^\/$/ },
  { method: "GET", path: /^\/index\.html$/ },
  { method: "GET", path: /^\/assets\/[\w-]+\.(?:js|css|woff2|svg|png|json)$/ },
  { method: "GET", path: /^\/app-icon\.svg$/ },
  { method: "GET", path: /^\/murage-logo(?:-dark)?\.png$/ },
  { method: "GET", path: /^\/manifest\.webmanifest$/ },
  { method: "GET", path: /^\/sw\.js$/ },
  { method: "GET", path: /^\/icons\/murage-(?:180|192|512)\.png$/ },
  // SPA deep links. Enumerated, not `/.*`: these are the only client routes
  // the app has, and a wildcard here would quietly re-open the SPA fallback
  // for every path the allowlist above refuses.
  { method: "GET", path: /^\/(?:chat|rooms|routines|settings|search)(?:\/[\w-]+)?$/ },
];

/** Harness routes the browser UI needs and the device surface does not, or
 * needs at a different method. See docs/browser-surface.md for the argument
 * per line; the short version is in the comment above each group. */
const BROWSER_EXTRA: ReadonlyArray<{ method: string; path: RegExp }> = [ /* §4 */ ];
```

and `denyReason` becomes:

```ts
export function denyReason({ path, method, authenticated, surface }: RouteRequest): Denial | null {
  // Pairing and liveness are unchanged, and belong to the device door only.
  // The browser door has its own unauthenticated route (`GET /enter`) and
  // terminates it before this function is reached.
  if (surface === "device") {
    if (method === "POST" && path === "/api/pair") return null;
    if (method === "GET" && path === "/api/health") return null;
  }

  if (!authenticated) {
    return surface === "browser"
      // A browser gets a place to go, not a sentence about a desktop panel.
      // 401 rather than a redirect: the SPA's own fetches must not follow a
      // 302 into an HTML login page and try to parse it as JSON.
      ? { status: 401, error: "sign in", signIn: "/enter" }
      : { status: 401, error: "pair this device from Phone settings in Murage on your computer" };
  }

  const allowed = surface === "browser"
    ? [...BROWSER_SHELL, ...BROWSER_EXTRA, ...SHARED_ALLOWED]
    : [...DEVICE_ALLOWED, ...SHARED_ALLOWED];
  if (allowed.some((route) => route.method === method && route.path.test(path))) return null;

  const explained = EXPLAINED.find((family) => family.path.test(path));
  if (explained) return { status: 403, error: explained.error };
  return { status: 404, error: `no route: ${method} ${path}` };
}
```

`SHARED_ALLOWED` holds the lines both doors genuinely share (transcripts, messages, rooms,
attachments, TTS). The split is mechanical and reviewable: after the change, `git diff` on
this file shows exactly which routes each surface gained.

**Test that pins the contract** (`companion/src/routes.test.ts`): for every entry in
`BROWSER_SHELL` and `BROWSER_EXTRA`, assert `denyReason({…, surface: "device"})` returns
non-null. The two surfaces cannot drift into each other without failing a test.

---

## 2. The Origin problem

### The finding that decides it

I ran a browser against an instrumented server and recorded what actually arrives (§9.4, §9.5).
The result contradicts the intuitive design:

| Request the app makes | `Origin` | `Sec-Fetch-Site` |
|---|---|---|
| `fetch('/api/bots')` — same-origin GET, default mode | **absent** | `same-origin` |
| `new EventSource('/api/events')` | **absent** | `same-origin` |
| `fetch('/api/bots/x/messages', {method:'POST'})` | **present** | `same-origin` |
| `<script crossorigin src="/assets/index-*.js">` | **present** | `same-origin` |
| `<img src>` / favicon | absent | `same-origin` |
| attacker page on another port, `fetch(…, {mode:'no-cors'})` | absent | **`same-site`** |
| attacker page on another port, cross-origin `POST` | present (attacker's) | **`same-site`** |
| attacker page, form POST navigation | present (attacker's) | **`same-site`** |

Three consequences, all load-bearing:

1. **"Require `Origin`" is not implementable.** It would break every GET and every
   `EventSource`. `EventSource` also has no headers API at all — the constructor takes only
   `withCredentials` — so a "custom header the proxy requires" CSRF scheme is impossible for
   `/api/events`, which is the app's spine (`src/lib/live-events.ts:9`, `:110-118` uses the
   native `EventSource`). That kills the custom-header option outright.
2. **`Origin` *is* always present on state-changing methods.** So an exact-match Origin check
   covers exactly the requests that need covering, and nothing else.
3. **`SameSite` cookies protect nothing here.** Two origins on the same hostname but different
   ports are `Sec-Fetch-Site: same-site`, and a `SameSite=Lax` cookie **was sent** on the
   attacker's cross-origin POST (§9.5). Site is scheme + registrable domain; ports are not
   part of it. Murage runs three or four ports on one MagicDNS name. `SameSite` is defence in
   depth here and nothing more — see §6.

### The design

**A separate listener with its own handler function.** Not a flag on `createProxyHandler`, not
a shared handler with a branch.

```ts
// companion/src/index.ts
const companion     = createServer(proxy);                       // :8810 device — unchanged
const managedOrigin = PRIVATE_ORIGIN ? createServer(proxy) : null; // UDS — unchanged
const browser       = createServer(createBrowserHandler({ … }));   // NEW — its own handler
```

**How this differs from the two listeners already sharing `proxy` at `index.ts:150-151`, and
how the browser door stays off the socket cloudflared fronts** — three independent reasons,
each sufficient:

1. **Different handler.** `createBrowserHandler` is a different function in a different file
   (`companion/src/browser.ts`). Adding a route to it cannot appear on `companion` or on
   `managedOrigin`, which is precisely the failure mode `index.ts:150-151` has today: anything
   bolted onto `proxy` is on the tunnel by default.
2. **Different socket, different transport.** `managedOrigin` is a Unix socket / named pipe
   (`origin.ts:11-30` rejects anything that is not the exact Electron-allocated shape;
   `origin.ts:48` chmods it 0600). The browser door is a TCP listener. cloudflared is
   configured against the UDS path; it cannot be pointed at the browser door without editing
   the tunnel config, which is a visible change.
3. **Different bind address.** The browser door binds the Tailscale address (§7), which is not
   reachable from loopback (§9.6) and therefore not reachable by a local tunnel client that
   dials 127.0.0.1.

**Assertion in code**, so #1 stays true under future edits:

```ts
// companion/src/index.ts — a startup invariant, not a comment.
// The tunnel-fronted socket and the browser door must never share a handler.
// index.ts once had two listeners on one handler and that is how a device
// route becomes a public route without anyone deciding it.
if (managedOrigin && browser && managedOrigin.listeners("request")[0] === browser.listeners("request")[0]) {
  throw new Error("the managed origin and the browser door share a request handler");
}
```

**The device door's `Origin` refusal (`proxy.ts:240-242`) does not change.** No weakening. Its
comment stays true: on *that* port, a browser has no business. The comment gains one line
naming where browsers go instead.

### The browser door's own origin policy

```ts
// companion/src/browser.ts

/** The origin this door serves, derived from the Host it was reached on and
 * checked against the addresses we actually bound. Never from a header alone:
 * Host is attacker-controlled, and computing "our origin" from it and then
 * comparing Origin to it proves nothing. */
function expectedOrigin(req: IncomingMessage, bound: BoundIdentity): string | null {
  const host = hostOf(String(req.headers.host ?? ""));   // reuse control.ts:47
  if (!bound.hosts.has(host)) return null;               // MagicDNS name + tailnet IP, that's all
  return `${bound.scheme}://${req.headers.host}`;
}
```

and the gate, in order:

```ts
// 1. Host allowlist. The harness has one (server/index.ts:5077); this door
//    needs its own because it is not on loopback. DNS rebinding otherwise
//    turns any name the phone resolves into a route to this port.
const origin = expectedOrigin(req, bound);
if (!origin) return sendJson(res, 403, { error: "forbidden: unexpected host" });

// 2. Sec-Fetch-Site. Present on every request from every browser that can run
//    this app (proven, §9.4/§9.5 — including EventSource and no-cors images).
//    Absent means not a browser, and this door is only for browsers.
//    `same-site` is refused, not tolerated: two ports on one hostname are
//    same-site, and refusing it is the only thing that closes the hole
//    SameSite cookies leave open (§9.5).
const site = req.headers["sec-fetch-site"];
if (site !== "same-origin" && site !== "none") {
  return sendJson(res, 403, { error: "forbidden: cross-origin request" });
}
// "none" is a user-typed URL or a bookmark — a top-level navigation with no
// initiator. Allowed only for GET of the shell, never for an API route.
if (site === "none" && (method !== "GET" || path.startsWith("/api/"))) {
  return sendJson(res, 403, { error: "forbidden: cross-origin request" });
}

// 3. Origin, when present, must be exactly ours. Present on every write
//    (proven); absent on same-origin GET and EventSource (proven), which is
//    why this is "when present" and not "required".
if (req.headers.origin && req.headers.origin !== origin) {
  return sendJson(res, 403, { error: "forbidden: cross-origin request" });
}

// 4. Writes must carry Origin. A browser always sends it on POST/PATCH/
//    PUT/DELETE, so a write without one is not a browser and does not belong.
if (!SAFE_METHODS.has(method) && !req.headers.origin) {
  return sendJson(res, 403, { error: "forbidden: cross-origin request" });
}
```

This is the same shape as the control server's check at `control.ts:251-254`
(`origin && !(originIsLoopback(origin) && origin === \`http://${authority}\`)`) — an in-repo
precedent, extended from loopback to the tailnet identity and hardened with `Sec-Fetch-Site`
because a tailnet has other hosts on it and loopback does not.

**And one negative invariant, stated as a rule the code enforces:** the browser door emits
**no CORS headers, ever** — no `Access-Control-Allow-Origin`, no `-Credentials`, no preflight
handler. Without them a cross-origin read is opaque, so a GET that slips a gate still leaks
nothing to the page that made it. This is why no CSRF token is needed on GETs.

---

## 3. Sessions

### Shape

A browser session is a **second credential form for an existing paired device**, not a new
identity. It reuses `DeviceRegistry` wholesale, which means per-device revocation
(`devices.ts:333-340`) and live-stream termination (`control.ts:308` →
`connected-devices.ts:28-44`) work on browsers on day one with no new revocation path.

### First contact — `GET /enter`

Modeled on Wayland's `GET /qr-login` (`app/src/process/webserver/routes/authRoutes.ts:576-585`):
a server-rendered, self-contained page whose script reads the credential from the URL and
POSTs it. Modeled equally on `control.ts:317` `page()` — "no build step and no assets on
purpose".

Four deliberate differences from Wayland:

1. **The credential rides in the fragment, not the query.** `https://<magicdns>:8812/enter#<token>`.
   A fragment is never sent to the server, never enters an access log, never leaks in
   `Referer`. Wayland's page reads a token "from the URL" (`authRoutes.ts:574`); the fragment
   is the strictly stronger spelling of that idea.
2. **The page clears it immediately** — `history.replaceState(null, "", "/enter")` before the
   POST — so it does not survive in session history or a screenshot of the address bar.
3. **The response body never contains the credential.** Wayland's qr-login returns
   `token: result.data.sessionToken` in the JSON *as well as* setting the cookie
   (`authRoutes.ts:560`). That hands a long-lived bearer to page JavaScript, where an XSS can
   read it and where it can be stored. Murage returns `{ ok: true, device: { name } }` and the
   cookie, nothing else. **The raw device bearer token is generated, hashed, and discarded
   inside the sidecar — it is never sent to the browser at all.**
4. **A CSP with a nonce**, same as Wayland's (`authRoutes.ts:577-584`), but tighter because
   the page has no assets:
   `default-src 'none'; script-src 'nonce-<b64>'; style-src 'nonce-<b64>'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`.

The QR is rendered by the existing control page (`control.ts:317`) — the pairing window it
already opens (`control.ts:262-272`, `devices.ts:185-194`) is reused unchanged. The only
change is that the QR payload becomes the `/enter#…` URL instead of a bare credential.

### Exchange — `POST /session`

```ts
// companion/src/browser.ts — terminates here, never forwarded.
if (method === "POST" && path === "/session") {
  const body = await readJson(req, 8 * 1024);
  // The same redeem the native path uses (proxy.ts:273). One redemption
  // implementation; a second one is a second set of attempt counters and a
  // second place the 5-attempt lockout can be forgotten.
  const result = devices.redeem(String(body.credential ?? ""), body.deviceName, body.pairRequestId);
  if ("error" in result) return sendJson(res, 401, { error: result.error });

  // The raw bearer stops here. It is never written down and never sent on.
  const session = sessions.open(result.device.id, userAgentLabel(req));
  res.setHeader("set-cookie", cookie(session.id, bound));
  return sendJson(res, 201, { ok: true, device: { name: result.device.name } });
}
```

### Cookie attributes

```ts
const cookie = (id: string, bound: BoundIdentity): string => {
  const parts = [
    // __Host- forbids Domain and forces Path=/ and Secure. It is the strongest
    // prefix the platform has and costs nothing — but it REQUIRES Secure, so
    // it is only available once the tailnet has HTTPS certs. CertDomains is
    // null today (§9.1), so the name is chosen at bind time, not compiled in.
    `${bound.scheme === "https" ? "__Host-murage_session" : "murage_session"}=${id}`,
    "Path=/",
    "HttpOnly",
    // Lax, not Strict: a bookmark or a link into /chat/<id> from a
    // notification must still arrive signed in. Lax is defence in depth only
    // — proven insufficient between ports on one host (§9.5) — and the
    // Sec-Fetch-Site check in §2 is what actually holds.
    "SameSite=Lax",
    `Max-Age=${IDLE_TTL_SECONDS}`,
  ];
  // NEVER a Domain attribute. Host-only keeps the cookie off every other
  // node in tail0a48a4.ts.net; ts.net is a public suffix (§9.7), so a Domain
  // cookie would be scoped to the whole tailnet.
  if (bound.scheme === "https") parts.push("Secure");
  return parts.join("; ");
};
```

`Secure` is unavailable today and the design says so rather than pretending. Over plain HTTP
the transport is still WireGuard-encrypted node to node, which is the honest justification for
shipping without it — and the cookie name changes to the `__Host-` form automatically the day
Sean enables HTTPS Certificates, with no code change.

### Storage, lifetime, refresh

Sessions live **in `devices.json`, as hashes**, following the file's existing rule (`devices.ts:8-11`:
"the token is generated once, handed to the phone at pairing, and never stored — devices.json
keeps only its SHA-256"):

```ts
export interface DeviceRecord {
  …                                    // unchanged
  /** Browser sessions issued to this device. Hashes only, same rule as
   * tokenHash: a stolen devices.json is not a stolen fleet. Capped so a
   * browser that clears cookies weekly cannot grow the file without bound. */
  sessions?: BrowserSession[];
}
interface BrowserSession {
  hash: string;        // sha256 of the cookie value; the value itself is never written
  label: string;       // "Safari on iPhone" — from UA, clamped like cleanDeviceName
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;   // absolute cap, not extended by use
}
const MAX_SESSIONS_PER_DEVICE = 3;
```

- **Idle timeout 14 days**, rolling. `lastSeenAt` is written at most once an hour, mirroring
  `devices.ts:68` `LAST_SEEN_WRITE_MS` — and, like it, a failed write must never fail the
  request (`devices.ts:322-326`).
- **Absolute cap 90 days**, never extended. After 90 days Sean re-scans a QR. That is ten
  seconds, once a quarter.
- **Refresh is implicit** — no refresh token, no rotation endpoint. A rotation endpoint is a
  second credential path to get wrong, and the thing it buys (short-lived bearers) is already
  bought by the cookie being `HttpOnly` and never leaving the browser.
- **Persisted rather than memory-only** because the sidecar restarts on every app restart, and
  a design that signs the phone out daily is a design Sean turns off.

### Revocation — three levers, all existing

| Lever | Where | Effect |
|---|---|---|
| Revoke the device | `control.ts:305-310` → `devices.revoke()` (`devices.ts:333`) | every session on it dies; `disconnectDevice` (`control.ts:308`) kills the live SSE synchronously |
| Sign out one browser | new `DELETE /session` on the browser door | drops that hash; other browsers on the same device survive |
| Expiry | `expiresAt` | no action needed |

Resolution on every request is one lookup: cookie → `sha256` → the device that owns that hash.
If the device is gone, the session resolves to nothing and the answer is 401. **There is no
separate session store to keep consistent with the device list**, which is the whole reason to
hang sessions off `DeviceRecord` rather than beside it.

Timing: the lookup uses `timingSafeEqual` on hex digests, same as `devices.ts:75-82` `sameDigest`.

---

## 4. What a phone is allowed to do

Method + path + the reason. Anything not listed is 404 by construction (`routes.ts:194`).

### 4.1 `BROWSER_SHELL` — the UI itself

Listed in §1. Static bytes only; the harness has already read them off disk from
`MURAGE_STATIC_DIR`. If `MURAGE_STATIC_DIR` is unset the harness falls through to
`json(res, 404, …)` at `server/index.ts:8672`; the browser door turns that into a
`503 "the desktop app is not serving the UI"` so a dev-mode misconfiguration reads as a
sentence rather than a blank page.

### 4.2 Sidecar-terminated

| Method | Path | Why |
|---|---|---|
| GET | `/enter` | the only unauthenticated route on this door. §3 |
| POST | `/session` | redeem a pairing credential for a cookie. §3 |
| GET | `/session` | who am I / when does this expire — lets the UI warn before it lapses |
| DELETE | `/session` | sign out this browser |
| GET | `/api/companion/endpoints` | already terminated locally (`proxy.ts:306`); harmless and useful |

### 4.3 Harness routes the browser gets

**Read.**

| Method | Path | Why |
|---|---|---|
| GET | `/api/config` | configured-or-not booleans only; values never echoed (SECURITY.md) and `sshAlias` scrubbed (`wire.ts:21`) |
| GET | `/api/events` | the app's spine (`src/lib/live-events.ts:9`). SSE, scrubbed by `createSseScrubber` (`wire.ts:87`) |
| GET | `/api/bots` | the fleet |
| GET | `/api/instances` | which engines exist, for a label. **GET only — see the denials** |
| GET | `/api/threads/[\w-]+/messages` | a transcript |
| GET | `/api/threads/[\w-]+/messages/[\w-]+/image` | its images |
| GET | `/api/threads/[\w-]+/export` | share a transcript from the phone |
| GET | `/api/attachments/[\w-]+\.(png\|jpe?g\|gif\|webp)` | a bare generated filename, never a path (`server/index.ts:6051`) |
| GET | `/api/search` | **scoped — §5.** Unscoped today, which is a live defect |
| GET | `/api/routines` | see what is scheduled |
| GET | `/api/routine-runs` state via `/api/events` | no separate read route needed |
| GET | `/api/team-map` | already filters hidden bots (`server/index.ts:5668`) |
| GET | `/api/decisions` | the approval log; read-only |
| GET | `/api/bots/[\w-]+/memory` | read what a bot remembers |
| GET | `/api/bots/[\w-]+/skills` | list what a bot can do |
| GET | `/api/bots/[\w-]+/skills/[a-z0-9-]+` | read one skill's text |
| GET | `/api/section-context` | read the section's shared instructions. **GET only** |
| GET | `/api/connectors/catalog`, `/connected`, `/api/connectors` | opaque ids and aliases only |
| GET | `/api/tts/voices` | labels; never touches the ElevenLabs key |

**Write — the things you actually do from a phone.**

| Method | Path | Why |
|---|---|---|
| POST | `/api/bots` | make a bot |
| POST | `/api/sidebar-sections` | narrow, atomic organizer write; cannot alter execution policy (`routes.ts:66-68`) |
| POST | `/api/bots/[\w-]+/messages` | talk to it. The point of the whole thing |
| POST | `/api/bots/[\w-]+/interrupt` | stop it. Must be reachable from a phone or a runaway turn has no brake |
| POST | `/api/bots/[\w-]+/read` | clear the unread dot |
| POST | `/api/bots/[\w-]+/always-allow` | answer an approval prompt. This is *the* mobile use case |
| POST | `/api/bots/[\w-]+/messages/[\w-]+/edit` | fix a typo |
| POST | `/api/bots/[\w-]+/active-branch` | switch versions |
| POST/PATCH/DELETE | `/api/bots/[\w-]+/tasks(/[\w-]+)?` | task lifecycle |
| DELETE | `/api/bots/[\w-]+/queue/[\w-]+` | unqueue a message you regret. Browser-only add (`server/index.ts:7596`) |
| PATCH | `/api/bots/[\w-]+/profile` | the harness itself rejects fields outside identity/avatar/notifications/voice (`routes.ts:79-81`) |
| POST | `/api/bots/[\w-]+/avatar/generate` | cosmetic |
| POST | `/api/groups` | make a room |
| POST | `/api/groups/[\w-]+/messages` | talk in one |
| POST | `/api/groups/[\w-]+/read` | clear the dot |
| POST | `/api/groups/[\w-]+/interrupt` | same brake argument. Browser-only add (`server/index.ts:6794`) |
| POST/PATCH/DELETE | `/api/groups/[\w-]+/tasks(/[\w-]+)?` | task lifecycle |
| POST | `/api/threads/[\w-]+/messages/[\w-]+/reactions` | react |
| POST | `/api/threads/[\w-]+/respond` | answer an approval on a thread |
| POST | `/api/attachments` | image-only, 10 MB cap at the harness |
| POST | `/api/files` | share-sheet documents, 25 MiB cap, generated filename |
| POST | `/api/tts/speak`, `/api/tts/prepare` | audio out; never reads the key |
| GET/POST/PATCH/DELETE | `/api/routines(/[\w-]+)?`, `POST …/run` | routines create ordinary tasks with an existing agent config (`routes.ts:118-119`) |
| POST | `/api/routine-runs/[\w-]+/(cancel\|seen)` | brake + dismiss |
| POST | `/api/bots/[\w-]+/computer/join` | **only behind the existing per-device `cloudDesktopAccess` flag** (`proxy.ts:260`, `devices.ts:345`), off by default. The browser door applies the identical check |

### 4.4 What it must never get, and why

| Denied | Why |
|---|---|
| `PATCH /api/instances/:id` | sets the CLI binary used for every later turn (`server/index.ts:8073-8100`). Half of the two-request RCE. Its only guard is a content-type check whose own comment (`:8074`) calls it an anti-CSRF measure for a loopback server |
| `POST /api/cli-test` | spawns a caller-supplied path (`server/index.ts:8051-8067`). The other half |
| `GET /api/cli-candidates` | `findCliCandidates` walks PATH (`server/index.ts:8040-8044`). Filesystem reconnaissance with no mobile use |
| `PUT\|PATCH /api/config` | credential writes (`server/index.ts:8116`). `EXPLAINED` already says "API keys can only be changed on your computer" (`routes.ts:148`) |
| `/api/webhooks*` | minting one exposes an internet endpoint; rotating a secret breaks whatever was sending to it (`routes.ts:150-156`). Public ingress from a pocket is the exact thing decision 1 forbids |
| `POST /api/connectors/:slug/authorize` | connected-app OAuth. **This is allowed on the device port today (`routes.ts:132`) and that is a live gap** — it lets a phone bind a Google account to this machine. Deny on both surfaces; §8 tracks the removal |
| `DELETE /api/connectors/:slug/accounts/:id` | already absent and stays absent (`routes.ts:126-128`) |
| `/api/bots/:id/secret-cards/*` | `server/index.ts:8457` — the card by which an agent asks for a credential. Answering it *is* a credential write |
| `/api/bots/:id/connector-cards/*` | `server/index.ts:8489` — connected-app authorisation inside a chat |
| `POST\|DELETE /api/bots/:id/skills*` | installing a skill installs instructions the agent will execute. Read is fine; write is code delivery |
| `PUT /api/section-context` | `server/index.ts:7328` — writes the shared instructions every bot in the section reads as system prompt. Prompt injection into a whole team, from a lost phone |
| `PATCH /api/groups/:id`, `/api/groups/:id/setup` | changes membership and the room bulletin, which is also a system prompt (`store.ts:174-176`) |
| `PATCH /api/bots/:id` (broad) | `server/index.ts:6982` — the desktop's wide patch: cwd, section, chiefOfStaff, model. The narrow `/profile` patch is the phone's version |
| `DELETE /api/bots/:id`, `DELETE /api/groups/:id` | `server/index.ts:7204`, `:6718`. Destruction is the blast radius of a lost phone; it stays on the Mac |
| `/api/local-computer*`, `/api/bots/:id/local-computer*` | shell and VM lifecycle. `EXPLAINED` already covers it (`routes.ts:149`) |
| `/api/bots/:id/computer/(provision\|exec\|sleep\|screenshot\|remove)` | `server/index.ts:8596`. `exec` is literally a remote shell (`:8642-8645`) |
| `/api/bots/:id/computer/control`, `viewer-close` | interactive desktop control outside the one audited join route |
| `/api/bots/:id/checkpoints/restore` | `server/index.ts:7424` — rewrites a working tree |
| `/api/teams/(import\|export\|scout)`, `/api/team-library/*` | importing a team package imports bot definitions, i.e. instructions and tool grants, in bulk |
| `/api/internal/*` | peer-agent comms behind a shared token (`server/index.ts:5087-5090`). Off this machine they genuinely do not exist, and `routes.ts:189-194` already says the 404 is deliberate |
| `POST /api/subscribe` | `server/index.ts:8103` — a marketing call with no phone use |
| `PATCH /api/bots/:id/cards/:mid` | `server/index.ts:7453`. Default deny; nothing on the phone needs it |

---

## 5. Fixing `/api/search`

### The defect, precisely

`routes.ts:102` allowlists `GET /api/search`. `proxy.ts:314` forwards `path: req.url` — the
**full URL including the query string** — while `denyReason` only ever sees
`(req.url ?? "/").split("?")[0]` (`proxy.ts:234`). So the allowlist has no opinion about query
parameters at all, and the harness runs `searchMessages(q, limit, undefined)`, which with no
`threadId` emits `const scope = ""` (`message-db.ts:196`) and scans every row in the table.
Proven live: §9.3 shows the request arriving at the harness with `?q=secret` and no scope.

A paired token is a full-transcript grep — across hidden bots, across auto-created bot⇄bot DM
channels (`store.ts:189-191`), across every section.

### Where the fix goes

**In the harness, in the SQL, not in the sidecar and not as a post-filter.**

- Not the sidecar: it cannot know which bots are hidden or who is in which room. `routes.ts`
  can bound the *inputs* and should, but it cannot scope the *output*.
- Not a post-filter: `searchMessages` applies `ORDER BY at DESC LIMIT ?` in SQL
  (`message-db.ts:201`) and `server/index.ts:6101` filters the rows afterwards. Filtering after
  the limit silently truncates — ask for 40 hits, get 3, with no indication why. Adding a
  visibility filter there makes an existing latent bug into a visible one.

### The change

**`server/message-db.ts`** — `searchMessages` takes a thread *set*:

```ts
/** @param threadIds when present, the only threads that may be searched.
 *  An empty array means "nothing is visible" and returns no rows — never
 *  "no restriction", which is the direction this function used to fail in. */
export function searchMessages(
  query: string,
  limit = 40,
  threadIds?: readonly string[],
): SearchHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  if (threadIds && threadIds.length === 0) return [];
  // Scope inside the SQL so LIMIT counts rows the caller can actually see.
  // A post-filter would return fewer hits than asked for and look like a
  // search that missed.
  const scope = threadIds ? `thread_id IN (${threadIds.map(() => "?").join(",")}) AND ` : "";
  …
}
```

**`server/store.ts`** — one function, so the definition of "visible" lives in one place:

```ts
/** Every thread a companion client may search or read.
 *
 * Three exclusions, each for its own reason:
 *  - hidden bots: the same filter /api/team-map already applies (index.ts:5668)
 *  - `dm` rooms: auto-created bot⇄bot channels (store.ts:189-191). Machine
 *    chatter, and the highest-volume thing in the DB — including it makes
 *    every search useless as well as leaky
 *  - rooms whose every member is hidden
 */
visibleThreadIds(): string[] {
  const visibleBots = this.bots.filter((b) => !b.hidden);
  const ids = new Set<string>();
  for (const bot of visibleBots) {
    ids.add(bot.threadId);
    for (const task of this.tasks(bot.id)) ids.add(task.threadId);
  }
  const visibleBotIds = new Set(visibleBots.map((b) => b.id));
  for (const group of this.groups) {
    if (group.dm) continue;
    if (!group.memberIds.some((id) => visibleBotIds.has(id))) continue;
    ids.add(group.threadId);
    for (const task of group.tasks ?? []) ids.add(task.threadId);
  }
  return [...ids];
}
```

**`server/index.ts:6069`** — the route consumes it, and narrows further for companion clients:

```ts
if (method === "GET" && path === "/api/search") {
  const q = url.searchParams.get("q") ?? "";
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit ? Math.min(Math.max(Number(rawLimit) || 0, 1), 100) : 40;
  const threadId = url.searchParams.get("threadId")?.trim() || undefined;

  // The desktop is the local user and searches everything. A companion
  // client — phone app or browser — searches what it can see. The header is
  // set by the sidecar (proxy.ts:206) and carries no authority: it can only
  // narrow. A forged one narrows the forger's own results.
  const companion = req.headers["x-murage-companion"] === "1";
  let scope: string[] | undefined = companion ? store.visibleThreadIds() : undefined;
  if (threadId) {
    if (!store.botByThread(threadId) && !store.groupByThread(threadId)) {
      return json(res, 404, { error: "no such conversation" });
    }
    if (scope && !scope.includes(threadId)) return json(res, 200, { hits: [] });
    scope = [threadId];
  }
  const hits = searchMessages(q, limit, scope) …
}
```

The `x-murage-companion` header is already forwarded (`proxy.ts:206`) with exactly this
rationale in its comment: "This header carries no authority; it only narrows behavior at the
harness." Reusing it adds no new trust.

**`companion/src/routes.ts`** also gains a query bound, because default-deny should extend to
the part of the request the allowlist currently cannot see:

```ts
/** Query-string policy for routes where the parameters are the security
 * boundary. The allowlist above matches on path alone; proxy.ts forwards
 * req.url whole, so without this the query is unexamined surface. */
const QUERY_POLICY: ReadonlyArray<{ path: RegExp; check: (q: URLSearchParams) => string | null }> = [
  {
    path: /^\/api\/search$/,
    check: (q) => {
      const term = (q.get("q") ?? "").trim();
      if (term.length < 2) return "search needs at least two characters";
      if (term.length > 200) return "search term too long";
      const limit = q.get("limit");
      if (limit && !/^(?:[1-9]|[1-4]\d|50)$/.test(limit)) return "limit must be 1-50";
      const thread = q.get("threadId");
      if (thread !== null && !/^[\w-]{1,64}$/.test(thread)) return "invalid threadId";
      for (const key of q.keys()) if (!["q", "limit", "threadId"].includes(key)) return `unexpected parameter: ${key}`;
      return null;
    },
  },
];
```

The two-character minimum matters: `?q=e` against a LIKE scan returns essentially the entire
message table, which is a bulk-exfiltration primitive dressed as a search.

---

## 6. CSRF

**Chosen: `Sec-Fetch-Site` + exact-match `Origin` on writes + no CORS headers. No token.**

The gate is written out in §2. The justification, against the alternatives:

| Option | Verdict |
|---|---|
| **Custom header the proxy requires** (`X-Murage: 1`) | **Impossible.** `EventSource` has no headers API — the constructor takes a URL and `withCredentials`, nothing else — and `/api/events` is the app's spine (`src/lib/live-events.ts:110-118`). A custom-header scheme forces a rewrite of live event delivery to a `fetch`-based reader. That is a large change to the most load-bearing code path to buy a property `Origin` already gives for free |
| **Double-submit CSRF token** | Unnecessary and weaker than it looks. It defends writes; writes already carry an unforgeable `Origin` (proven, §9.4). It does not defend reads; reads are already opaque cross-origin because the door emits no CORS headers. And it adds a token that page JavaScript must read, which is one more thing an XSS can lift |
| **`SameSite=Strict` cookies** | **Proven insufficient here.** §9.5: an attacker page on a different *port* of the same hostname is `Sec-Fetch-Site: same-site`, and a `SameSite=Lax` cookie was sent on its cross-origin POST. Site excludes port. Murage runs the harness on 8799, the webhook receiver on 8800, the device port on 8810, control on 8811, the browser door on 8812 — five same-site origins. `SameSite` stays on as depth, never as the gate |
| **Origin allowlist alone** | Necessary, not sufficient. `Origin` is absent on same-origin GET and on `EventSource` (proven), so an Origin-only rule either fails open on reads or breaks the app |
| **The existing `content-type: application/json` checks** (`server/index.ts:8055`, `:8075`) | Decorative once a browser is same-origin, exactly as the brief says — their own comments admit they are anti-CSRF for a loopback server. They are not removed (they still guard the desktop) but they are **not counted** as protection for anything the browser door forwards. That is why §4.4 denies both routes outright rather than relying on them |

The residual: `Sec-Fetch-*` are unforgeable by page script (forbidden header names) but trivially
forgeable by a non-browser client — `curl` from another tailnet node can send anything. So these
headers are **not authentication**. Authentication is the `HttpOnly`, host-only session cookie,
which that attacker cannot read. The two layers answer different questions and neither
substitutes for the other. §7 covers the case where that attacker exists.

---

## 7. The tailnet perimeter

### What Tailscale guarantees

- **Transport confidentiality and integrity** between nodes (WireGuard). This is what makes
  plain HTTP on the tailnet acceptable while `CertDomains` is null (§9.1).
- **A stable identity per node** and an address in 100.64.0.0/10 (RFC 6598 CGNAT), which is
  why it never collides with a home LAN — correctly documented at `companion/src/listener.ts:54-61`
  and correctly detected at `listener.ts:62-68`. **Murage does not repeat Wayland's `isLocalIP`
  omission**: `tailscaleAddress` matches `first === 100 && second >= 64 && second <= 127`,
  which is 100.64.0.0/10 exactly, not the 100.64/16 an off-by-one would give.
- **ACL enforcement in the data plane.** A peer with no ACL grant cannot open the TCP
  connection at all; the door never sees it.

### What must NOT be assumed

- **That the tailnet is one machine.** `tailscale status` on this box reports **5 peers**
  (§9.1). Every one of them can dial this port unless an ACL says otherwise.
- **That every peer is Sean's.** Tailnet *sharing* invites a node from another tailnet in. A
  shared node keeps its own tailnet's MagicDNS suffix, so it is cross-*site* to us (§9.7) —
  but it is not cross-*network*: it can still open a TCP connection to the browser door and
  present a cookie if it has one.
- **That a tailnet address means a trusted user.** It means a trusted *device key*. A phone
  that is unlocked in someone else's hand is a fully authorised tailnet node.
- **That exit nodes matter here.** They route a node's *outbound* internet traffic; they do
  not grant inbound reachability to this port. But an exit node does see plaintext for
  non-tailnet destinations, which is one more reason the browser door must never be reachable
  by a non-tailnet path.
- **That `ts.net` is exclusive.** It is a public suffix (§9.7), so `tail0a48a4.ts.net` is the
  registrable domain and every node in *Sean's* tailnet is same-site with every other. Cookie
  scope is therefore held by host-only cookies (no `Domain=`), never by `SameSite`.

### Required ACL

Design assumption, and the plan should not ship without it being written down in Sean's
tailnet policy file:

```jsonc
// Only Sean's own devices may reach the browser door and the device port.
{ "action": "accept", "src": ["sean@ferroxlabs.com"], "dst": ["macbook:8812", "macbook:8810"] }
```

Default-deny on the tailnet, so a shared-in node and a future peer both get nothing without an
explicit line. This is the outer perimeter the threat model names, and it is currently
implicit.

### Binds and tunnels — the explicit answer

**Does anything in this design bind `0.0.0.0`? No. Does it start a tunnel? No.**

The browser door binds the Tailscale address specifically:

```ts
// companion/src/index.ts
const tailnet = tailscaleAddress(lanAddresses());   // listener.ts:62 — 100.64.0.0/10
if (!tailnet) {
  // Refusing to bind is the right failure. Falling back to 0.0.0.0 or
  // 127.0.0.1 "so it works" is how a tailnet-only door becomes a LAN door.
  console.log("browser door: no Tailscale address — not starting. Bring Tailscale up and restart.");
} else {
  await listen(browser, BROWSER_PORT, tailnet);
}
```

**Proven** (§9.6): a listener bound to `100.79.121.109` answers on the tailnet IP *and* on the
MagicDNS name, and is `ECONNREFUSED` on the LAN IP `192.168.1.108` **and on `127.0.0.1`**. The
isolation is a property of the socket, not of a check that could be skipped.

Against the Wayland bug just filed — `tailscale funnel` (public ingress) pointed at the port
that also serves the WebUI, bypassing its own loopback binding — this design's position is:

- **No funnel, ever.** Nothing here shells out to `tailscale`, except the existing read-only
  `tailscale status --json` (`listener.ts:138-141`), which cannot change reachability.
- If Sean later wants TLS, the recommendation is `tailscale serve` (tailnet-scoped) and
  explicitly **not** `tailscale funnel` (public). A lint/test should reject the literal string
  `funnel` anywhere in the repo, because the two subcommands differ by one word and the
  difference is the whole security model.
- The harness's webhook receiver (`server/index.ts:240`, port 8800) is the one thing in Murage
  that a tunnel would ever legitimately front, and it is a **different port from both the
  harness and the browser door**. That separation is the structural answer to Wayland's bug and
  it already exists; the plan's job is to not undo it.

### Fold in: narrow the device port too

With iOS retired (decision 2), the LAN + Bonjour path has no client. So:

- `companion/src/index.ts:226` moves from `"0.0.0.0"` to the same tailnet address.
- The mDNS responder (`index.ts:112-133`, `mdns.ts`) can stop advertising — it exists to let a
  phone on the same wifi find the machine, which the tailnet makes unnecessary.
- `endpoints.ts:75-80` stops emitting `lan` and `bonjour` candidates, and `endpoints.ts:71`'s
  "hosted" priority-0 entry should be reconsidered: it ranks a public HTTPS endpoint **ahead**
  of the tailnet, which is backwards under decision 1. Recommend `tailnet` at priority 0 and
  `hosted` behind it, or removed entirely.

This is a strictly larger security win than anything else in this plan and it costs a
one-line bind change plus deletions. It should ship in the same milestone.

### Rebinding

The tailnet address can change (Tailscale restart, re-auth, a node key rotation). The sidecar
already polls the interface table for exactly this reason — `createAddressWatcher`
(`advertise-watch.ts`, wired at `index.ts:112-118`). Reuse it: on an address change, close the
browser door and re-bind to the new tailnet address. Sessions survive (they are keyed by device
hash in `devices.json`, not by socket).

**Undetermined:** whether Tailscale IPv6 reach is needed. `lanAddresses` is IPv4-only
(`listener.ts:46` `entry.family !== "IPv4"`), so the `fd7a:115c:a1e0::4d3b:796d` address this
machine has is invisible to it. v1 is IPv4-only; if an IPv6-only client turns up, the fix is a
sibling `tailscaleAddress6()` matching the `fd7a:115c:a1e0::/48` ULA prefix and a second
listener — **not** a bind to `::`, which is the v6 spelling of 0.0.0.0.

---

## 8. Threat model and failure modes

### Threat model

| # | Threat | Layer that stops it | If that layer fails |
|---|---|---|---|
| T1 | Internet attacker reaches the harness | Harness binds 127.0.0.1 (`server/index.ts:8681`), no env override; `isLoopbackHost` gate before any route (`:5077`) | Total compromise: RCE in two requests (`:8073`, `:8051`), every credential, every transcript. This is why the static branch is not the remote door |
| T2 | Internet attacker reaches the browser door | Bound to the tailnet address only (§9.6 proves LAN and loopback are refused); no funnel; no 0.0.0.0 | Falls to the session cookie + `Sec-Fetch-Site`. A blind attacker with no cookie gets 401 on everything but `GET /enter` |
| T3 | A malicious web page Sean visits drives Murage | `Sec-Fetch-Site` must be `same-origin`; `Origin` exact-match on writes; no CORS headers so reads are opaque | Falls to the route table: even a full CSRF cannot reach `PATCH /api/instances/:id` or `POST /api/cli-test`, which are 404 (proven §9.3) |
| T4 | Another port on the same host attacks the door | `Sec-Fetch-Site: same-site` is **refused** (§2). Note `SameSite` cookies do *not* help — proven §9.5 | Falls to the route table |
| T5 | Lost, unlocked phone | Per-device revoke (`devices.ts:333`) + live SSE termination (`control.ts:308`) | **Full read of every visible transcript and full write to every bot, until Sean revokes.** No delete, no credential write, no shell, no RCE — that is the route table earning its keep. §4.4 is chosen with this scenario as the design target |
| T6 | Another compromised tailnet node | Tailscale ACL (must be written — §7); then the door's `Host` allowlist and the session cookie, which that node cannot read (`HttpOnly`, host-only, no `Domain`) | Attacker can reach the port and hit `GET /enter`. It cannot pair without a live 120s window (`devices.ts:63`) opened from the Mac |
| T7 | Shared-in tailnet node | Same as T6; additionally cross-*site* because its MagicDNS suffix differs (§9.7) | Same |
| T8 | Stolen `devices.json` | Hashes only (`devices.ts:22`, `:270`); dir 0700, files 0600 (`state.ts:33-34`) | Offline brute-force against sha256 of a 32-byte random value. Not feasible. Session hashes inherit the same property |
| T9 | Bearer/session token in a log or URL | Credential rides in the URL **fragment** (§3), cleared with `replaceState` before the POST; the raw token is never returned in a response body (unlike `authRoutes.ts:560`) | A leaked session is revocable per-device and per-session, and expires |
| T10 | Sidecar leaks harness internals to the phone | `scrub()` drops `resumeCursors`/`sshAlias` (`wire.ts:21`), on JSON bodies and on every SSE `data:` line (`wire.ts:126-145`) | Resume cursors and a VPS alias reach a device. Not catastrophic, but it is the exact leak the scrubber exists for |
| T11 | Response cached in a CDN | `PRIVATE_RESPONSE_HEADERS` (`proxy.ts:114-120`) forces `no-store` including Cloudflare's variants; the browser door reuses them | Chat JSON becomes a shared cache entry. Only reachable if a hosted endpoint is enabled at all — which §7 recommends against |
| T12 | Unscoped transcript grep | §5 — SQL-level scoping to `visibleThreadIds()` | **Live today.** Any paired token greps every thread including hidden bots and bot⇄bot DMs |

### Failure modes, layer by layer

| Layer | Misconfigured how | Symptom | Blast radius |
|---|---|---|---|
| Tailnet bind | `tailscaleAddress()` returns null (Tailscale down at boot) | Browser door does not start; log line says why | **Fails closed.** Phone cannot connect. Correct |
| Tailnet bind | Someone "fixes" it by falling back to `0.0.0.0` | Silent: it works, and now the LAN can reach it | Every device on the coffee-shop wifi gets `GET /enter` and a login prompt. **This is the Wayland bug's shape.** Mitigation: a test asserting the bind host is the tailnet address, and no fallback branch in the code |
| Tailscale ACL | Absent (today's state) | Silent: works fine | Any of the 5 peers, and any shared-in node, can reach the door. Still needs a cookie |
| `Sec-Fetch-Site` | A browser that does not send it | Every request 403s | **Fails closed**, visibly. Fix is to widen the check deliberately, not to default-allow. Safari has sent it since iOS 16.4; if Sean's phone is older this surfaces immediately on first load, not silently |
| `Origin` check | `bound.hosts` computed from `Host` alone | Silent: any Host passes and Origin matches itself | DNS rebinding: a name Sean's phone resolves to the tailnet IP becomes a scriptable origin. Mitigation: `expectedOrigin` checks `Host` against the *bound* identity first (§2), and that identity comes from `tailscaleAddress()` + `tailnetName()`, not from the request |
| Route table | A route added to `SHARED_ALLOWED` when it belonged in one surface | Silent: the other door gains it | Mitigation: the §1 test asserting every browser-only entry is denied on the device surface |
| Route table | A future harness release adds a dangerous route | Nothing — default deny (`routes.ts:184-194`) | **Zero.** This is the property the file exists for and it has already failed once (`routes.ts:9-15`) |
| Session cookie | `Domain=` added "so it works from the IP too" | Silent: works | Cookie is sent to every `*.tail0a48a4.ts.net` host (§9.7). Mitigation: `__Host-` prefix once HTTPS is on makes `Domain=` a browser-level error rather than a review-level one |
| Session cookie | `Secure` set while still on HTTP | Cookie never stored; login loops | **Fails closed**, loudly. Hence deriving the flag from `bound.scheme`, not from an env var |
| Session store | `devices.json` unwritable | `redeem` already rolls back and reports (`devices.ts:281-286`); session writes must be best-effort like `lastSeenAt` (`devices.ts:322-326`) | Sessions do not survive restart. Annoying, not unsafe |
| Revocation | Device revoked but SSE not terminated | Silent: the phone keeps receiving events | Already handled — `control.ts:308` → `connected-devices.ts:28-44`. The browser door must register its `/api/events` stream with the same tracker (`proxy.ts:391-394`) or this regresses |
| Static serving | `MURAGE_STATIC_DIR` unset | Harness 404s (`server/index.ts:8672`); door turns it into 503 with a sentence | None |
| Static serving | SPA fallback answers a missing asset with HTML/200 (`server/index.ts:8660`) | Service worker caches HTML under a `.js` URL; app breaks across reloads | Mitigation: allowlist the exact static paths (§1) and restore AionUi's `networkOnlyWithTypeGuard` MIME guard in `sw.js` |
| `/api/search` | Scoping added as a post-filter instead of in SQL | Silent: fewer hits than `limit`, looks like a bad search | Mitigation: §5 puts the scope in the `WHERE`, before `LIMIT` |
| `/api/search` | `visibleThreadIds()` returns `[]` and the callee reads that as "no restriction" | Silent: full leak | Mitigation: the explicit `if (threadIds && threadIds.length === 0) return []` in §5, with the comment saying which direction this used to fail in |

### What this design does **not** defend against

Stated plainly, because a threat model that claims everything defends nothing.

1. **A compromised Mac.** The harness runs real CLIs with Sean's privileges (SECURITY.md).
   Anyone with local code execution owns everything, and no sidecar helps.
2. **Another local user account on the Mac.** The harness's loopback socket *is* its
   credential (`devices.ts:3-6`). A second unprivileged account can dial 127.0.0.1:8799 and
   get RCE. SECURITY.md names this as a vulnerability; this plan does not fix it, and does not
   make it worse.
3. **A lost, unlocked, already-signed-in phone, before revocation.** T5. Mitigated in scope,
   not in kind: full read and full write to conversations. Accepted.
4. **A malicious or prompt-injected agent.** Everything here is about the network boundary. An
   agent that is talked into running a bad command runs it with Sean's privileges regardless of
   which door the message came in through. The permission broker is that layer, not this one.
5. **Multi-tenant anything.** One user, one tailnet (decision 1). There are no roles, no
   per-user data partitioning, and `visibleThreadIds()` is a *surface* filter, not an
   authorisation model.
6. **Public HTTPS, TLS termination, certificate pinning, WAFs, rate limiting at the edge.**
   No public ingress exists.
7. **Traffic analysis on the tailnet.** A peer that can see WireGuard packets learns sizes and
   timings. Out of scope.
8. **The `hosted` endpoint if Sean ever enables it.** `MURAGE_COMPANION_HOSTED_URL`
   (`index.ts:53`, `endpoints.ts:24`) fronts the UDS with a public managed tunnel. The browser
   door is structurally excluded from it (§2), but the *device* port is not, and that is
   outside this track's remit beyond the recommendation in §7 to de-prioritise or remove it.
9. **XSS in the Murage bundle itself.** The session cookie is `HttpOnly` so it cannot be read,
   but an XSS runs same-origin and can therefore drive every route in §4.3. The route table is
   the mitigation: the worst an XSS achieves is what a phone achieves, which is deliberately
   not RCE. A CSP on the shell (`script-src 'self'`) would narrow it further and should be
   added, but the bundle uses `crossorigin` module scripts and shiki's dynamic imports, so
   the exact policy needs measuring against a real build — **undetermined**.

---

## 9. Proofs

Everything below was run. Scratch artefacts are in
`…/scratchpad/exp/`; no file in `murage-app`, `wayland`, or `aionui` was modified.

**9.1 — Tailscale state.**
`/Applications/Tailscale.app/Contents/MacOS/Tailscale status --json` →
`BackendState: Running`, `DNSName: seans-macbook-pro.tail0a48a4.ts.net.`,
`MagicDNSSuffix: tail0a48a4.ts.net`, `TailscaleIPs: ["100.79.121.109", "fd7a:115c:a1e0::4d3b:796d"]`,
**`CertDomains: null`**, **`Peers: 5`**.
→ HTTPS certs are off; `Secure` cookies are not available today. The tailnet is not one machine.

**9.2 — The device port refuses browsers, before authentication.**
Ran the real sidecar (`node companion/src/index.ts`) with `MURAGE_COMPANION_DIR` in a temp dir
and `MURAGE_PORT=18799 MURAGE_COMPANION_PORT=18810 MURAGE_CONTROL_PORT=18811`, against a stub
harness.

```
GET /api/health                                    → {"app":"murage"}
GET /api/health  -H 'Origin: http://…ts.net:18810' → {"error":"forbidden: cross-origin request"}
GET /            (no token)                        → 401
```
→ `proxy.ts:240` fires before the token check and before `denyReason`. Confirmed.

**9.3 — After pairing a real device, the allowlist holds.**
Opened a pairing window via the control server, redeemed it through `POST /api/pair`, then with
the issued bearer:

```
GET    /                        → {"error":"no route: GET /"}
GET    /index.html              → {"error":"no route: GET /index.html"}
GET    /assets/app.js           → {"error":"no route: GET /assets/app.js"}
GET    /sw.js                   → {"error":"no route: GET /sw.js"}
PATCH  /api/instances/claude    → {"error":"no route: PATCH /api/instances/claude"}
POST   /api/cli-test            → {"error":"no route: POST /api/cli-test"}
GET    /api/threads/t1/events   → {"error":"no route: GET /api/threads/t1/events"}
GET    /api/bots  + Origin      → {"error":"forbidden: cross-origin request"}
GET    /api/search?q=secret     → reached the harness as: url "/api/search?q=secret",
                                  headers {accept, x-murage-companion: 1, host: 127.0.0.1:18799}
```
→ The RCE pair is closed. The UI paths are closed. **`/api/search` is open and unscoped, and the
query string is forwarded unexamined** — the sidecar never inspected it.

**9.4 — What a browser actually sends (same-origin).**
Instrumented server + real Chromium via Playwright. Recorded per request:

| request | Origin | Sec-Fetch-Site | Sec-Fetch-Mode |
|---|---|---|---|
| `fetch('/x')` default | **null** | same-origin | cors |
| `fetch('/x',{mode:'same-origin'})` | null | same-origin | same-origin |
| `fetch('/x',{method:'POST'})` | **http://127.0.0.1:18830** | same-origin | cors |
| `new EventSource('/x')` | **null** | same-origin | cors |
| `<script src crossorigin>` | **http://127.0.0.1:18830** | same-origin | cors |
| `<script src>` plain | null | same-origin | no-cors |
| `<img src>` | null | same-origin | no-cors |

→ "Require Origin" breaks reads and SSE. "Origin on writes" is sound. `Sec-Fetch-Site` is
present on all seven. And `dist/index.html`'s `crossorigin` module script is why the device
port cannot serve this app.

**9.5 — Cross-origin, same-host: `SameSite` does not protect.**
Victim origin `127.0.0.1:18840` set `murage_sid=abc123; HttpOnly; SameSite=Lax`. Attacker page
served from `127.0.0.1:18841` fired a form POST, an image, a no-cors fetch and a no-cors POST.

| attacker request | Origin | Sec-Fetch-Site | cookie sent? |
|---|---|---|---|
| form POST navigation | http://127.0.0.1:18841 | **same-site** | **yes** |
| `fetch` no-cors POST | http://127.0.0.1:18841 | **same-site** | **yes** |
| `fetch` no-cors GET | null | **same-site** | **yes** |
| `<img>` | null | **same-site** | **yes** |

→ A different port is *same-site*, so `SameSite=Lax` sent the cookie on a cross-origin POST.
This is why §2 refuses `same-site` explicitly and why §6 rejects a SameSite-based defence.

**9.6 — Binding the Tailscale address isolates the socket.**
`createServer(...).listen(18820, "100.79.121.109")`, then probed four ways from the same host:

```
100.79.121.109:18820                        → 200 ok
seans-macbook-pro.tail0a48a4.ts.net:18820   → 200 ok
192.168.1.108:18820   (LAN)                 → FAILED: ECONNREFUSED
127.0.0.1:18820       (loopback)            → FAILED: ECONNREFUSED
```
→ The tailnet-only property is a property of the bind, not of a check. This is the perimeter.

**9.7 — `ts.net` is a public suffix.**
`publicsuffix.org/list/public_suffix_list.dat`, lines 15977-15980:
```
// Tailscale Inc. : https://www.tailscale.com
// Submitted by David Anderson <infra+public-suffix-list@tailscale.com>
ts.net
*.c.ts.net
```
→ The registrable domain is `tail0a48a4.ts.net` — Sean's own tailnet. Nodes within it are
same-site with each other; nodes in another tailnet are cross-site. Host-only cookies (no
`Domain=`) are therefore load-bearing, and `SameSite` is not.

---

## 10. Sequencing

1. **`/api/search` scoping** (§5). It is a live defect against the token that already exists,
   independent of everything else. Ship first.
2. **Remove `POST /api/connectors/:slug/authorize` from `DEVICE_ALLOWED`** (`routes.ts:132`).
   One line; closes connected-app authorisation from a paired device.
3. **`Surface` split in `routes.ts`** (§1) with the drift test. No behaviour change yet.
4. **The browser door**: `companion/src/browser.ts`, the tailnet bind, `GET /enter`,
   `POST/GET/DELETE /session`, the origin gate. `.webmanifest` MIME in `server/index.ts:242`.
5. **Narrow the device port to the tailnet address**, drop mDNS, re-rank `endpoints.ts`.
   Depends on the iOS retirement landing (decision 2).
6. **Write the Tailscale ACL.** Not code, but the outer perimeter is currently implicit.

---

## 11. Open questions for Sean

1. **HTTPS certs.** Enabling them in the Tailscale admin console upgrades the cookie to
   `__Host-`/`Secure` with no code change. Recommend enabling. If you do, say whether you want
   `tailscale serve` terminating TLS (simplest, renewal is Tailscale's problem) or Node
   terminating with `tailscale cert` output (one fewer hop, renewal is ours). **I could not
   verify what headers `tailscale serve` forwards** — specifically whether `Host` survives and
   whether `Tailscale-User-*` identity headers are added — without changing machine state.
   That verification is a prerequisite for the `serve` option, because the §2 origin gate reads
   `Host`.
2. **`cloudDesktopAccess` for a browser session.** Today it is a per-*device* flag
   (`devices.ts:345`). A browser session inherits its device's flag. Recommend keeping it that
   way and leaving it off by default, which is the current behaviour.
3. **The `hosted` endpoint.** `endpoints.ts:71` ranks a public HTTPS route ahead of the
   tailnet. Under decision 1 that is backwards. Recommend deleting the `hosted` kind entirely
   rather than re-ranking it — it is the only remaining path in the codebase by which Murage
   becomes internet-reachable.
