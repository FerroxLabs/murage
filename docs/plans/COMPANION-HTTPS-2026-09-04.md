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

---

# ADDENDUM — 2026-09-04 overnight

## Local reconciliation patch — 2026-09-05

Fix A is implemented in the working candidate. Desktop startup reads existing
Serve state even when the remembered HTTPS flag is off. An exclusively owned
443 root proxy to the browser door is adopted, its stale setting is remembered
as on, and the sidecar independently observes Serve before startup/rebinding.
An owned front forces the HTTP backend onto loopback and supplies the portless
HTTPS origin. A failed rebind does not advertise a front it cannot serve.

Mixed 443 entries, extra mounts, different proxy paths, public routes, and
unreadable configurations are not adopted. Existing listeners are preserved
when ownership is uncertain, and the conflict is reported. No reconciliation
path creates, replaces, or removes a Tailscale route. Unexplained CLI failures
also no longer permit the explicit HTTPS-enable path to assume an empty config.

Local verification uses fake Tailscale command replies and isolated listener
fixtures, including negative controls for the original tailnet/loopback drift
and ownership parser failures. It does not establish live TLS or remote pairing.

Still outstanding for the whole plan: Fix C's HTTPS-by-default onboarding when
443 is free, the related product naming/onboarding decisions, and acceptance 5's
actual second-device HTTPS pairing/send proof. This adoption patch must not be
reported as completion of all task 10/whole-plan requirements.

## Shipped on this branch already

| commit | what | controls |
|---|---|---|
| `5c6c3546` | PWA: manifest fetched with credentials; duplicate `/sw.js` route dropped | 2, both RED then green |
| `8b20fe46` | Web: stop retrying a surface gate forever; `api()` now carries the status | 2, one exposed a hole in my own test |

### The PWA bug, stated plainly
The service worker was necessary and NOT sufficient. `<link rel="manifest">`
without `crossorigin="use-credentials"` is fetched in omit mode, the door
answers 401, and Chrome silently refuses to consider the site installable.
Measured live while signed in: omit 401, same-origin 200, include 200.

### A control that stayed green
Reverting the `api()` status attachment did not fail
`surface-refusal.test.ts`, because that file builds its own errors. Per our
own rule -- a green control means the TEST is wrong -- `api-status.test.ts`
was added to stub fetch and call `api()` for real. It now fails with
"expected undefined to be 403" when the change is reverted.

## Must fix before the sweep's staging branch is merged

### M-1 | HIGH | `server/mcp-probe.ts:87-92` (on `sweep/mcp`)
No `child.stdin.on("error")` listener; `write()` guards only synchronous
throws. An unhandled stream 'error' event terminates the process, so a
custom MCP server can kill the whole harness from the Test button.

Measured on node v22.23.1 -- the trigger BOTH auditors gave was wrong:
    child exits            -> ERR_STREAM_DESTROYED to the write callback, NO 'error' event
    stdin destroyed        -> ERR_STREAM_DESTROYED to the write callback, NO 'error' event
    child CLOSES STDIN and KEEPS RUNNING -> stdin 'error' EPIPE fires
End-to-end repro of mcp-probe's exact listener shape exits 42 on an uncaught
EPIPE. The probe writes three frames (initialize, notifications/initialized,
tools/list), so a server that closes stdin after the handshake hits it.

    child.stdin.on("error", () => finish({ ok: false, error: publicProbeError("closed") }));

Test: fixture that does `exec 0<&-` then sleeps; assert the probe returns
`{ ok: false }` and the process survives. Negative control: remove the
listener, watch the test runner die rather than fail.

### M-2 | MED | `src/components/PluginsPanel.tsx:516`
`(["apps","mcp"] as const).map(...)` renders the MCP tab with no desktop
check, on a surface where every backing route 404s by design. Same class as
the retry loop fixed in `8b20fe46`.

### R-1 | LOW | `server/index.ts:1682` (on `sweep/routines`)
`GROUP_GOAL_WAIT_MAX_MS` floors at 1s with no ceiling. Node clamps a
setTimeout delay above 2^31-1 to 1ms (measured), so a deliberately long wait
becomes an instant timeout and every busy teammate reassigns immediately.
Wrap in `Math.min(2_147_483_647, ...)`.

## Still unproven, needs Sean
- A genuinely remote device pairing over HTTPS. Same-host browser pairing IS
  proven end to end tonight: POST /pairing minted code 113872, /enter signed
  in over the ts.net name, the full app rendered, `isSecureContext: true` and
  `crypto.randomUUID` live. What is NOT proven is a second physical device.
  Needs an ephemeral tailnet auth key to stand up `murage-test-<id>`.
- Does Ferrox own `murage.ai`? `DEFAULT_COMPANION_CONTROL_PLANE_URL` is
  `https://accounts.murage.ai`, which does not resolve; the apex is parked on
  Namecheap. Packaged builds send account OTPs and bearer tokens there.
