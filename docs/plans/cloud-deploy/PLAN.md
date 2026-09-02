# Murage cloud deploy — tailnet-only by construction

**Status:** installer built, tested, and partly blocked on one server-side change
(see [Patch requests](#patch-requests-outside-this-lane)).
**Lane:** `installer/**` and `docs/plans/cloud-deploy/**`.
**Date:** 2026-09-02.

---

## 1. What Sean asked for

> Deploy Murage to a cloud box or VPS, and **as part of setup** it joins my
> Tailscale network — so it is secured and never internet-accessible.

He remembered Wayland doing this. Wayland does not. Wayland's installer ends
with a `console.log` suggesting Tailscale, and Wayland's own docs say, verbatim,
that it is "a manual step, not something setup does for you". Closing that gap
is what this plan is.

## 2. The shape of the thing

```
  your laptop / phone                    the cloud box (e.g. a $6 droplet)
  ┌──────────────────┐                   ┌───────────────────────────────────┐
  │ Tailscale client │                   │ tailscaled                        │
  │  100.x / fd7a:…  │══ WireGuard ═════▶│  100.x / fd7a:…   tag:murage      │
  └──────────────────┘   (encrypted,     │        │                          │
                          authenticated, │        ▼  tailnet-only proxy      │
                          tailnet-only)  │   127.0.0.1:8799                  │
                                         │        │                          │
                                         │        ▼                          │
                                         │   murage server (node)            │
                                         │   listen(8799, "127.0.0.1")       │
                                         └───────────────────────────────────┘
                                              ▲
                          the public internet ╳  no listener, no route, nothing
```

There is no port open to the internet at any point. The only listener the app
creates is on `127.0.0.1`. The only way a packet from another machine reaches it
is by arriving over an authenticated WireGuard tunnel to a node your tailnet ACL
lets in, and then being proxied across loopback by `tailscaled` itself.

## 3. What was built

| File | What it is |
| --- | --- |
| `installer/bin/murage.mjs` | `setup` / `start` / `status` / `resetpass` / `help` |
| `installer/lib/tailscale.mjs` | enrolment: install, `up`, tag, proxy, **verify** |
| `installer/lib/bind.mjs` | the bind policy — the single most important file |
| `installer/lib/network-trust.mjs` | "did this connection arrive over the tailnet?" |
| `installer/lib/env-file.mjs` | the 0600 env file |
| `installer/lib/systemd.mjs` | the staged unit |
| `installer/lib/ui.mjs` | colour, scriptable prompts, the **no-echo** secret prompt |
| `installer/test/*.test.mjs` | 70 tests, `node --test`, no config and no dependencies |

Run the suite with:

```sh
node --test installer/test/*.test.mjs
```

### 3.1 `murage setup`, step by step

1. **Locate the server payload.** Packaged `payload/server/index.js`, or a repo
   `dist-server/index.js` after `pnpm build:server`, or `MURAGE_SERVER_ENTRY`.
   No payload, no setup — it exits rather than half-configuring a box.
2. **Tailscale first, before anything else.** There is no point wiring a
   provider API key into a box we are about to tell the operator not to trust.
   Detect the CLI; offer to install it (`curl -fsSL https://tailscale.com/install.sh | sh`).
3. **Read an auth key without it ever reaching `ps` or `~/.bash_history`.**
   See §4.1. Prompt is no-echo; `MURAGE_TS_AUTHKEY` / `TS_AUTHKEY` for unattended runs.
   There is deliberately **no `--auth-key` flag** on `murage setup`.
4. **`tailscale up`** with `--auth-key=file:<0600 path>`, `--advertise-tags=tag:murage`,
   `--accept-routes=false`, `--ssh=false`, `--timeout=90s`.
5. **Verify.** Poll `tailscale status --json` until *all four* hold: backend is
   `Running`, `Self.Online` is `true`, at least one `Self.TailscaleIPs`, and every
   requested tag was actually granted. Anything short of that is a failure with
   reasons printed — never a "secured" banner.
6. **Front the loopback listener** with the tailnet-only proxy
   (`tailscale serve --bg --https=443 http://127.0.0.1:8799`).
7. **Read the share config back** and assert the daemon reports (a) a proxy to
   *our* loopback port and (b) **no** entry published to the open internet.
8. **Write the 0600 env file**, including `MURAGE_TRUSTED_PROXY=1` (see §4.3).
9. **Report the truth.** Either the green block with the verified tailnet name,
   IPs, tags, and "public share: none" — or a red block listing exactly why not,
   plus the SSH-tunnel fallback.

### 3.2 `murage status`

The same verification, re-runnable at any time, on a box you did not just set
up. It prints the bind policy it *would* use, the env file's actual permission
bits, the live enrolment verdict, and the public-share check.

## 4. Threat model

The asset is the Murage harness: it holds provider API keys, spawns agent
processes with a shell, reads and writes the operator's files, and drives
connectors on their behalf. Unauthenticated access to it is total compromise of
everything it touches. It ships **no authentication of its own** (§5.4), so the
network *is* the access control. That raises the bar for the network.

| # | Threat | Mitigation | Enforced by |
| --- | --- | --- | --- |
| T1 | Internet-wide scanner finds the admin UI on a public IP | No wildcard bind is reachable from any input. Loopback is the default; the only other option is this host's own tailnet address. | `lib/bind.mjs`; `test/bind.test.mjs` ("there is no input that yields a wildcard bind") |
| T2 | Operator follows a stale tutorial and sets `HOST=0.0.0.0` | Refused, by name, with an explanation | `resolveBindFromEnv`; `test/bind.test.mjs` |
| T3 | Tailscale enrolment silently fails; box comes up reachable another way | Tailnet bind mode **refuses to start** with no tailnet address, rather than falling back | `BindRefused NO_TAILNET_ADDRESS` |
| T4 | Auth key leaks via `ps`, shell history, or a CI log | Key read no-echo or from env, written 0600 in a 0700 dir, passed as `--auth-key=file:<path>`, shredded in a `finally` | `lib/tailscale.mjs`; `test/tailscale.test.mjs` |
| T5 | Somebody publishes the box to the open internet with the sibling subcommand | The word is banned from the executable lane by a scanner, the argv builders are asserted clean, and the daemon's own config is read back and refused if a public share exists | `test/no-public-exposure.test.mjs`; `inspectShareConfig` |
| T6 | Provider keys world-readable in the env file | 0600 written with an explicit `chmod` after the write (the `mode:` option is masked by umask); `murage status` reports the real bits | `lib/env-file.mjs`; `test/env-file.test.mjs` |
| T7 | The proxy is a same-host reverse proxy, so "peer is loopback" stops meaning "the human at the console" | `MURAGE_TRUSTED_PROXY=1` is written whenever the proxy is configured, and `classifyClientTrust` then refuses to read loopback as operator | §4.3; `test/network-trust.test.mjs` |
| T8 | A carrier-NAT neighbour in 100.64.0.0/10 is mistaken for a tailnet peer | Trust is judged per-connection from the address the connection **landed on**, and only addresses on a proven-Tailscale interface count | §4.4 |
| T9 | Another local user on the box connects to 127.0.0.1 directly, bypassing the tailnet ACL | **Not mitigated.** See §6, honest limitations. |
| T10 | The box is destroyed and its node lingers in the tailnet forever | Setup steers the operator to an *ephemeral* auth key and explains why | §4.2 |

### 4.1 Why the key must not be an argument — and how it is not

On a normal Linux box `/proc/<pid>/cmdline` is world-readable, so any local user
can read the arguments of any running process; and an interactive `tailscale up
--auth-key=tskey-…` lands the key in `~/.bash_history` in cleartext, forever. A
key that has been on a command line is a key you have to rotate.

Tailscale supports a file reference, verified against the 1.98.8 CLI:

```
--auth-key value
        node authorization key; if it begins with "file:", then it's a path to
        a file containing the authkey
```

So the installer writes the key to `0600` inside a `0700` directory, passes
`--auth-key=file:<path>`, and shreds it in a `finally` block that runs even when
`up` throws. `test/tailscale.test.mjs` asserts, on a full simulated enrolment,
that the secret appears in **none** of the command lines and that the file is
gone afterwards.

### 4.2 On `--ephemeral`

The brief asked for `tailscale up --ephemeral`. **There is no such flag.**
Verified against the full 1.98.8 flag list: ephemerality is a property of the
*auth key*, chosen when the key is minted in the admin console or via the API,
not something the joining node can request.

So the installer does the only honest thing available: it tells the operator, at
the prompt, to mint an ephemeral key for a disposable box and says exactly why
(a destroyed droplet self-evicts instead of lingering as a dead tailnet entry).
It does not pretend to a capability the CLI does not have.

### 4.3 `tailscale serve` is a same-host reverse proxy — verified, not assumed

Measured on a live tailnet (a real macOS node, a real echo server, a real
request from another tailnet address):

```
$ curl http://seans-macbook-pro.<tailnet>.ts.net:8080/probe
{
  "host": "seans-macbook-pro.<tailnet>.ts.net:8080",
  "peer":  "127.0.0.1",          ← socket.remoteAddress
  "local": "127.0.0.1",          ← socket.localAddress
  "headers": {
    "tailscale-user-login": "sean.imsc@gmail.com",
    "x-forwarded-for":      "100.79.121.109",
    "x-forwarded-host":     "seans-macbook-pro.<tailnet>.ts.net:8080"
  }
}
```

Three consequences, each of which changed the design:

1. **The connection arrives on loopback.** So a rule of the form "loopback means
   the human at the console" is wrong the moment the proxy exists. This is the
   same hole Wayland tracked as #808. Hence `MURAGE_TRUSTED_PROXY=1`, written
   automatically by setup, which makes `classifyClientTrust` return `restricted`
   for a loopback peer.
2. **The original `Host` header is preserved**, not rewritten to the backend.
   This is what blocks the whole feature today — see the patch requests below.
3. **`Tailscale-User-Login` is authoritative, and client-supplied copies are
   overwritten.** Tested by forging the header: `attacker@evil.com` went in and
   `sean.imsc@gmail.com` came out. A forged `Host` through the proxy is answered
   by tailscaled with a 404, not forwarded. So these headers *are* a usable
   identity signal — but only for a request that actually came through the
   proxy, and a direct loopback request can forge them freely (also tested). They
   are therefore defence in depth, never the primary gate.

### 4.4 Network trust, ported from Wayland

`installer/lib/network-trust.mjs` is a port of Wayland's
`app/src/process/webserver/middleware/networkTrust.ts`. **Licence: both projects
are Apache-2.0 and both are Copyright 2026 Ferrox Labs — the same copyright
holder — so this is a first-party port, not a third-party inclusion.** The
SPDX header and a provenance note are carried at the top of the ported file. No
`NOTICE` change is required.

What it gets right, and why it is worth carrying over verbatim:

- It matches Tailscale's **registered ULA prefix** `fd7a:115c:a1e0::/48`, which
  nothing else hands out. That is what identifies the Tailscale interface on
  macOS, where the device is a bare `utun<N>` and a name-only `/^tailscale/`
  match finds nothing.
- It refuses to trust `100.64.0.0/10` on its own, because that is RFC 6598
  carrier-NAT space, not Tailscale's. Tailscale is the standard workaround *for*
  a CGNAT ISP, so "is this host on a tailnet?" answers yes for exactly the
  population at risk. The right question is per-connection.
- It therefore compares the connection's **local** address — the one it landed
  on — not the peer's, and an absent local address fails closed.
- It fails closed when interface enumeration throws.

Added here, because the bind policy needs it and Wayland never exposed it:
`tailnetAddresses()`, `tailnetIpv4()`, `isTailnetAddress()`. Wayland only ever
asked the yes/no question; we also need to know *which* address.

## 5. What we did differently from Wayland, and why

### 5.1 The default is inverted

Wayland's installer writes `ALLOW_REMOTE=true`
(`installer/bin/wayland.mjs:88`, and again at `:308`), and
`src/process/webserver/config/constants.ts:81` turns that into a `0.0.0.0`
bind. A plain `getwayland` deploy therefore puts an admin UI on a public IP over
cleartext HTTP. Their own `Dockerfile:34-35` defaults it **off** — two shipping
surfaces with opposite defaults and no shared constant between them.

Murage has no such switch. `lib/bind.mjs` accepts two answers, loopback and this
host's own tailnet address, and there is no input — env var, flag, or config —
that produces a wildcard. `HOST=0.0.0.0` is refused by name. A test enumerates
every accepted input and asserts none of them yields a wildcard.

### 5.2 Enrolment is a step, not a suggestion

Wayland prints `https://tailscale.com` and moves on (`wayland.mjs:255-256`).
Setup here installs the client, joins the tailnet, applies the tag, configures
the proxy, and then *reads the daemon's own state back* to check all of it.

### 5.3 Success is proven

Wayland's setup cannot fail at the security step, because it does not have one.
`enroll()` here returns `{ ok: false, stage, reasons[] }` and the CLI prints a
red "This box is NOT secured. Setup will not pretend otherwise." with the
reasons and the SSH-tunnel fallback. The green banner is only printed after four
independent conditions and a public-share check pass.

### 5.4 We did not copy the QR-plus-admin-login flow, because there is no login

Wayland prints a login QR and admin credentials on first boot. Murage's harness
has **no authentication at all**: no password, no session, no bearer for the
main API. It was written as a loopback server for the desktop app, and
`grep -rn "resetpass\|adminPassword" server/` returns nothing.

So:

- `murage resetpass` **probes the payload** for a `--resetpass` handler. If the
  build has one it forwards to it. If it does not — which is the case for
  0.1.44 — it says so plainly, explains that the boundary is the network
  (loopback listener → tailnet proxy → tailnet ACL), points at the admin console
  and `tailscale logout`, and exits non-zero. It does not invent a password.
- The QR encodes the **tailnet URL**, not a login. It renders via `qrencode`
  when present and prints the URL plus an install hint when not; the installer
  ships no QR encoder of its own (`qrcode.react` is a React component and cannot
  render to a terminal). It also says the obvious thing out loud: the phone must
  be signed into the same tailnet for that URL to resolve.

This is a real gap versus Wayland, and it is listed as a patch request.

### 5.5 One more difference: the runtime

Wayland's installer downloads and installs `bun`. Murage's server is bundled by
esbuild for `node20` and the app already requires node ≥ 24, so the installer
uses the node it is already running under and merely checks the version. One
fewer runtime to install, PATH-patch, and teach systemd about.

## 6. Honest limitations

- **T9 is not mitigated.** Any process or user on the box that can open
  `127.0.0.1:8799` reaches the full unauthenticated API, bypassing the tailnet
  ACL entirely. On a single-tenant droplet that is the same trust boundary as
  root. On a shared box it is not. The real fix is authentication in the server
  (patch request P3); a partial fix is a unix socket instead of a TCP port.
- **The tailnet ACL is the actual authorisation boundary**, and it lives in the
  Tailscale admin console, not in this repo. `--advertise-tags=tag:murage` gives
  the operator something to write a policy against; it does not write one.
  Setup verifies the tag was granted, which at least proves the key was
  authorised for it.
- **HTTPS on the tailnet requires HTTPS certificates enabled for the tailnet.**
  Setup asks and falls back to a plain HTTP listener, which is still
  WireGuard-encrypted end to end but presents as `http://` in the browser.
- **The end-to-end cloud path has not been run.** See §7.

## 7. What was and was not verified end to end

Verified, live:

- `tailscale serve` preserves the original `Host` header, arrives on loopback,
  and overwrites client-supplied `Tailscale-*` headers (§4.3), measured against
  a real tailnet.
- **The real, running Murage server answers a request through the proxy with
  `403 {"error":"forbidden: loopback host required"}`.** Reproduced against
  Murage 0.1.44 on 127.0.0.1:8799. This is the blocker, not a prediction.
- The `--auth-key file:` contract, the absence of `--ephemeral`, and the shape
  of `tailscale status --json`, all read from the 1.98.8 CLI.
- The network-trust port against a live macOS tailnet node (the `utun` case).
- 24 negative controls: every security-relevant behaviour was individually
  broken in the production source, the suite confirmed RED with the expected
  test named, the source was restored, and the suite confirmed GREEN again.
  All 24 were caught. The mutations covered the wildcard refusal, the
  no-tailnet-address refusal, the Tailscale-interface requirement, the
  fail-closed paths, the key-in-argv ban, the key-file mode and shredding, the
  public-share check, every verification condition, the env-file mode and
  newline injection guard, the systemd ordering, both tiers of the lane scanner,
  and the setup exit code.
- The whole lane on a **real Debian 13 droplet on node 20**: 69 pass, 1 skipped
  (the live-tailnet test, correctly skipped on a box with no tailnet), 0 fail.
  That run **found a real bug**: `planStart` returned a different refusal code
  depending on whether the host happened to be enrolled — `SERVER_CANNOT_BIND_TAILNET`
  on the macOS box, `NO_TAILNET_ADDRESS` on the bare droplet. Fixed by deciding
  the capability question before the address lookup, so the message an operator
  gets is the one they can act on.
- On that droplet, live: `murage setup` with no payload exits 1;
  `HOST=0.0.0.0 murage start` refuses; `MURAGE_BIND_MODE=tailnet murage start`
  refuses; `murage resetpass` reports the absence of password auth and exits 2;
  Tailscale installs via the installer's own command; `murage setup` with the
  daemon present but no auth key prints the red "NOT secured" block and **exits
  3**; the env file lands `0600` inside a `0700` directory; `ss -ltnp` shows the
  only public listeners on the box are the OS's own sshd and systemd-resolved —
  nothing of ours.

**Not** verified: a full `murage setup` run on a fresh droplet joining the
tailnet. That needs a Tailscale auth key, which is a credential this work was
not given and should not mint for itself. Every step it would exercise is unit
tested against captured fixtures of the real CLI's output, but that is not the
same as having run it.

## 8. Patch requests outside this lane

Each of these is in another agent's lane. None has been applied.

### P1 — BLOCKER: teach the Host gate about the tailnet

`server/index.ts:5278` rejects any request whose `Host` is not loopback:

```ts
if (!isLoopbackHost(req.headers.host)) {
  return json(res, 403, { error: "forbidden: loopback host required" });
}
```

The proxy preserves the tailnet `Host`, so **every** request through it 403s.
Measured, not inferred. The gate is right to exist — it defeats DNS rebinding —
so it should be widened, not removed. Suggested shape, at `server/index.ts:5220`:

```ts
/** The tailnet DNS names and addresses this node answers to, from
 *  MURAGE_TAILNET_HOSTS (written by `murage setup`). Exact match only — no
 *  suffix matching, or `evil-ts.net` would pass a `*.ts.net` test. */
const TAILNET_HOSTS = new Set(
  (process.env.MURAGE_TAILNET_HOSTS ?? "")
    .split(",").map((h) => h.trim().toLowerCase()).filter(Boolean)
);

function isAllowedHost(host: string | undefined): boolean {
  if (isLoopbackHost(host)) return true;
  if (!host) return false;
  const hostname = host.trim().toLowerCase().replace(/:\d+$/, "");
  return TAILNET_HOSTS.has(hostname);
}
```

then `isAllowedHost` at line 5278 and inside `isAllowedOrigin` at 5247. An
allowlist populated by setup from `Self.DNSName` and `Self.TailscaleIPs` — never
a `*.ts.net` suffix match, which any attacker can register a lookalike for.

**Without P1 the cloud deploy does not work at all.** It is the one change that
must land.

### P2 — honour an explicit bind address

`server/index.ts:9144` hardcodes the address:

```ts
server.listen(PORT, "127.0.0.1", () => { … });
```

For the direct tailnet-bind mode:

```ts
const BIND = process.env.MURAGE_BIND_ADDRESS ?? "127.0.0.1";
if (BIND === "0.0.0.0" || BIND === "::") throw new Error("refusing a wildcard bind");
server.listen(PORT, BIND, () => { … });
```

Until this lands, `murage start` **refuses** `MURAGE_BIND_MODE=tailnet` rather
than binding loopback while the operator believes otherwise
(`SERVER_CANNOT_BIND_TAILNET`). Loopback + proxy works without P2, so this is a
nice-to-have; P1 is not.

### P3 — the server has no authentication

Not a cloud-deploy bug, but it is why the network has to carry the entire
boundary, and it is what makes T9 unmitigated. Worth a decision: either a bearer
token minted by setup and written to the env file, or accepting that
`127.0.0.1` on this box is a root-equivalent trust boundary and documenting it.

### P4 — adopt the network-trust module server-side

`installer/lib/network-trust.mjs` is deliberately dependency-free JS so the
installer needs no build. If the server wants the same classification (it should,
for any destructive route), port it back to `server/network-trust.ts` with the
same tests rather than writing a second, subtly different one.

### P5 — wire the installer into the repo's scripts

Additions to `package.json` (not made — that file is out of lane):

```json
"test:installer": "node --test installer/test/*.test.mjs",
"installer:status": "node installer/bin/murage.mjs status"
```

and `"test"` extended with `pnpm test:installer`.

### P6 — the `Tailscale-User-*` headers are free identity

Once P1 lands, `Tailscale-User-Login` is available on every proxied request and
is not forgeable *through the proxy*. Combined with `MURAGE_TRUSTED_PROXY`, that
is a real per-user identity for audit logging and for gating destructive routes,
at no cost to the operator. Worth taking.

## 9. Appendix: the two Tailscale sharing modes

`tailscale serve` shares a local server **inside your tailnet**. Its sibling
subcommand publishes that same server to the **open internet**, which is the
precise anti-goal of this deployment — so that subcommand is NEVER used here,
its name is NEVER permitted anywhere in the executable lane (a scanner in
`installer/test/no-public-exposure.test.mjs` fails the build on any occurrence,
comments included), and the daemon's live config is read back at the end of
every setup so that a share published that way is caught and refused rather than
reported as secured. In this document the word may NEVER appear except on a line
that says so.

---

## CORRECTION — P1 is not a blocker, and the fix is not to widen the Host gate

Recorded 2026-09-02 by the orchestrator, after verifying both halves live.

The finding is real: `server/index.ts:5374` refuses any request whose `Host` is
not loopback, and `tailscale serve` preserves the original tailnet `Host`.
Measured against the running harness:

```
Host: 127.0.0.1:8799                       → 200
Host: seans-macbook-pro.tail0a48a4.ts.net  → 403 forbidden: loopback host required
```

**But that gate is a DNS-rebinding defence, and widening it is the wrong fix.**
It is the reason a malicious page cannot resolve a name it controls to 127.0.0.1
and drive the harness from a browser. Trading it away to accommodate a proxy
would remove a real control to work around an architecture choice.

**The architecture choice is what to fix.** `tailscale serve` must front the
**browser door on 8813**, never the harness on 8799. The door already solves this
correctly and was verified doing so: it builds its upstream header set from `{}`
and issues the request with `hostname: "127.0.0.1"`, so the harness sees a
loopback `Host` and the gate passes untouched. It also carries the allowlist, the
session model, the surface stamp and the `connectedDeviceTracker` registration —
none of which exist on a raw `serve → 8799` path.

`serveArgs(port)` in `installer/lib/tailscale.mjs:153` is already parameterised,
so this is a target change, not a redesign:

```
tailscale serve --bg --https=443 http://127.0.0.1:8813   # the door
NOT                              http://127.0.0.1:8799   # the harness
```

Consequences:

- **P1 is withdrawn.** Do not add `MURAGE_TAILNET_HOSTS`, and do not relax
  `isLoopbackHost`. If a future change makes it necessary, it needs its own
  threat-model review, because it is undoing a control rather than adding one.
- **P2 stands but drops to nice-to-have.** The harness already binds
  `127.0.0.1` hardcoded, which is the right default.
- **P3 stands and is the real one.** The harness has no authentication; the
  network carries the whole boundary. That is acceptable tailnet-only and is the
  precondition on any public ingress.
- The door must be running before `serve` is configured. Setup should verify
  8813 answers before reporting success, the same way it verifies enrolment.

This is the same "one door, two possible fronts" shape recorded in
`docs/plans/paid-tier/PLAN.md`: `tailscale serve` today, a tunnel later if the
paid tier happens, with the door and its allowlist unchanged underneath.
