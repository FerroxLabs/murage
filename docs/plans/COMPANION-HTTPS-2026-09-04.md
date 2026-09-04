# Companion remote access: drift, silent failure, and a bad default

Written 2026-09-04, after Sean hit "I can type in the box but Enter does
nothing" on the phone browser. Cue-up spec. NOT to be executed until the
upstream sweep has merged — §6 lists the file collisions.

---

## 1. What actually happened (all verified, not inferred)

Chain, in order:

1. `companion-settings.json` held `remoteAccess: false`, but `tailscale serve`
   was configured and running, proxying 443 -> `http://127.0.0.1:8813`.
2. With remote access off, `browserBindHost(BROWSER_BIND=auto, ...)` binds the
   **tailnet address** whenever Tailscale is up. Door went to
   `100.79.121.109:8813`. Nothing listened on loopback:8813.
3. `https://seans-macbook-pro.tail0a48a4.ts.net` therefore returned **502**.
4. The only reachable door was `http://100.79.121.109:8813` — plain HTTP to a
   bare IP, which is **not a secure context**. Proven in a real browser:
       isSecureContext        false
       crypto.randomUUID      undefined
       crypto.getRandomValues function      <- still available
       -> TypeError: crypto.randomUUID is not a function
5. `Composer.tsx:418` calls `crypto.randomUUID()` unguarded to mint `sendId`.
   It throws before `dispatch`. Text types fine; Enter silently does nothing.

The same secure-context gate also killed voice dictation (`getUserMedia`) and
PWA install (`shouldRegisterServiceWorker` requires `secure`). One cause,
three dead features, no error message anywhere.

`electron/companion.mjs:companionRemoteAccessAtRest()` describes this failure
verbatim in its own doc comment -- "serve up, door on the tailnet address, 502
for everyone. The two have to be restored together." The mechanism to prevent
it existed; nothing enforced it.

**Confirmed fixed by toggling Settings -> Allow remote access:** door moved to
`127.0.0.1:8813`, HTTPS front went 502 -> 401 (door answering), plain-HTTP
tailnet door now refused, and on the HTTPS origin `isSecureContext: true`
with `crypto.randomUUID` minting real ids.

---

## 2. Fix A — reconcile serve and door at startup (root cause)

The remembered flag and Tailscale's own persisted config are two sources of
truth that can drift. Remembering harder does not fix that; reconciling does.

At sidecar startup, and after any `moveBrowserDoor()`:
  - read what `serve` currently proxies (the parser already exists:
    `serveOwner()` returns `none` / `ours` / a conflict)
  - if serve points at OUR door on loopback and the door is NOT on loopback,
    the door is wrong -> rebind loopback.
  - if serve points at our door and the setting says off, the SETTING is stale
    -> adopt on, log it. Never leave a working proxy pointed at a dead socket.
  - if serve points somewhere else entirely, leave it alone and say so.

Acceptance: a test that sets serve=loopback + door=tailnet and asserts startup
converges to door=loopback. Negative control: break the reconcile branch, see
the test go red with the 502-shaped state.

## 3. Fix B — secure-context-safe id

`crypto.randomUUID` is secure-context-only. `crypto.getRandomValues` is NOT
(verified above). New `src/lib/uuid.ts`:

    export function uuid(): string {
      if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
      // RFC 4122 v4 from getRandomValues, which exists in insecure contexts too
      const b = new Uint8Array(16);
      crypto.getRandomValues(b);
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      const h = [...b].map((x) => x.toString(16).padStart(2, "0"));
      return `${h.slice(0,4).join("")}-${h.slice(4,6).join("")}-${h.slice(6,8).join("")}-${h.slice(8,10).join("")}-${h.slice(10).join("")}`;
    }

Call sites: `Composer.tsx:418`, `store.tsx:1674`, `store.tsx:1868`,
`LocalVmWorkspace.tsx:536`. A plain-HTTP door is a SUPPORTED mode; sending
must work in it.

Acceptance: unit test with `crypto.randomUUID` deleted asserts a well-formed
v4. Negative control: drop the getRandomValues branch, watch it throw.

## 4. Fix C — the default and the name

The toggle does not allow remote access. The tailnet bind already did that.
The app's own off-state copy admits it: "Off. Murage is reachable at a plain
HTTP address inside your tailnet." What the switch really does is put TLS in
front of a door that is already open — and OFF is the less safe state, since
the session cookie then crosses the tailnet in plaintext.

  - Rename: "Serve over HTTPS (recommended)". The scary tailnet-exposure
    banner belongs on the COMPANION toggle, which is where exposure begins.
  - Default: when the companion is enabled and `serveOwner()` is `none` or
    `ours` and Tailscale offers HTTPS -> turn it on automatically.
  - Ask only for the one question that is genuinely the user's: 443 is a
    node-global resource Murage does not own. If `serveOwner()` reports
    SOMEONE ELSE, do not touch it; surface the conflict and stay off.

That collapses two decisions into one for the normal case and keeps consent
exactly where consent is actually required.

## 5. Fix D — never fail silently

`PushToTalk.tsx` already sets the standard: "Showing a mic that cannot work is
worse than showing none." The send path gets the same treatment. With Fix B a
send now works on plain HTTP, so this is about the remaining gaps: if the page
is not a secure context, the composer says which features are degraded and
links to the HTTPS address, instead of a dead Enter key.

---

## 6. Collisions with the in-flight sweep — DO NOT LAND BEFORE IT MERGES

| file | owned by | note |
|---|---|---|
| `src/components/Composer.tsx` | Lane S (#9, #11) | Fix B call site |
| `src/state/store.tsx` | Lane S | Fix B call sites x2 |
| `electron/companion*.mjs` | Lane D (electron/) | Fix A, C |
| `companion/src/index.ts`, `browser.ts` | unclaimed | Fix A |
| `src/lib/uuid.ts` | NEW | collides with nothing |

Land order: sweep merges to `upstream-sweep-2026-09` -> Sean fast-forwards ->
then this branch rebases on top. Fix B's call sites are one-line each and
rebase cleanly; the new helper file is collision-free by construction.

---

## 7. Test rig — remote pairing must be proven, not assumed

Sean's requirement: prove a real remote device can connect and pair, not just
that curl gets a 200 locally.

Three layers, cheapest first:

**L1 — unit.** Fixes A/B/C branch logic, with a negative control each.

**L2 — same-host secure origin.** Headless browser against
`https://seans-macbook-pro.tail0a48a4.ts.net`. Already run today; proves TLS
termination, the door's Host allowlist, and a genuine secure context. Extend
to: complete a pairing code, send a message, assert it lands in the transcript.

**L3 — genuinely remote device.** A second tailnet node driving the HTTPS door
over the wire. Two ways:
  - `wayland-soak.tail0a48a4.ts.net` (linux, already on the tailnet, online):
    curl-level reachability + pairing handshake, no browser install. Least
    invasive, no new cost, but it is somebody's soak box.
  - a fresh `murage-test-<id>` DigitalOcean droplet joined to the tailnet,
    headless Chromium, full browser pairing + send. Clean and isolated.
    REQUIRES a Tailscale auth key, which is not in the environment — Sean has
    to mint one. Destroy the droplet before reporting, per standing rule.
    NEVER `tailscale funnel`; serve only.

The four production `flux-pool-r2-*` droplets are never touched.

## 8. Acceptance for the whole change

1. Fresh profile, companion on, Tailscale up, 443 free -> HTTPS is on with no
   second decision, and the printed link is the portless `https://<name>`.
2. 443 owned by another service -> Murage does not touch it, stays off, and
   names the conflict.
3. serve pointed at loopback while the door is on the tailnet -> startup
   converges instead of 502.
4. Plain-HTTP door -> a message still sends (Fix B) and the composer says what
   is degraded (Fix D).
5. A remote tailnet device pairs over HTTPS and sends a message that appears
   in the desktop transcript. (L3)
