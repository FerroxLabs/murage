# Murage as an always-on remote instance — plan

Track: cloud / headless. Tailnet only, single user, no public ingress.
Status: PLAN. No production code written. Every claim below is either cited `file:line` or was
proven by running something; the proof commands are in §8.

---

## 0. The one-paragraph answer

A headless Murage is real and closer than it looks. The harness and the companion sidecar are both
plain Node processes with zero Electron imports, and the esbuild bundle that already ships inside the
`.app` runs standalone under `env -i` with an empty `HOME`, no `node_modules`, and no Electron —
**proven** (§8.1, §8.2). What Electron owns is the *desktop shell*: the OS credential store, the
built-in browser, host computer-use, dictation, notifications, the updater and the managed cloudflared
tunnel. Every one of those degrades to "unavailable" rather than crashing, because the server already
treats `process.parentPort` as optional (`server/index.ts:270`). The two genuinely hard problems are
**(a) reachability** — the harness is double-locked to loopback by design and must stay that way, so
the remote instance is reached by an SSH/Tailscale forward for the full UI and by the paired-device
sidecar for the phone — and **(b) engine auth**, which is *not* fatal: `claude` accepts
`CLAUDE_CODE_OAUTH_TOKEN`, `codex login --device-auth` exists, and Flux Router redirects all three
engines with env vars alone (**proven end-to-end**, §8.3–§8.5).

**Recommendation: systemd units on a Hetzner/OVH box you own, not Docker.** Reasons in §3.

---

## 1. What a headless Murage actually loses

I booted the harness with no Electron and walked the API. Here is the honest ledger.

### 1.1 Load-bearing — must be replaced, not dropped

| Thing | Where it lives today | Headless consequence | Replacement |
|---|---|---|---|
| **Credential store** | `electron/main.mjs:238` `credentials.bin` via `safeStorage`; read path `electron/secure-credentials.mjs` | No `safeStorage` outside Electron. Secrets have nowhere encrypted to go. | `~/.murage/config.json`, mode `0600`. This path **already exists and is already the documented dev fallback** — `server/config.ts:466-490` reads env first, then the file, and `src/components/ApiKeys.tsx:159-164` falls back from `window.muragebox.setCredential` to `PUT /api/config` when the bridge is absent. Nothing to build; something to *document and lock down* (§3.4). |
| **`MURAGE_STATIC_DIR` / skills env** | `electron/harness-resources.mjs:23-27` maps three env vars to `extraResources` names | Unset → the UI 404s and every hire installs zero skills (that exact bug shipped through 0.1.44, per the file's own comment). | Set all three explicitly in the systemd unit. Proven working headless (§8.1): `/api/health` returned `"static":true` and `/` served the real `dist/index.html`. |
| **Reachability** | `server/index.ts:8681` `listen(PORT,"127.0.0.1")`, plus an `isLoopbackHost` Host gate at `:5077` that fires before any route | Nothing off-machine can reach it. | §2 and §4. Do **not** change either lock. |
| **Process supervision** | Electron main restarts the server child (`electron/main.mjs:842-925`, three-port fallback) | Nothing restarts a crashed harness. | `systemd` `Restart=always`. |

### 1.2 Optional — degrades cleanly, verified

- **Built-in browser panel.** `server/browser-connection.ts:113,224`: with `MURAGE_DESKTOP_PARENT`
  unset the server falls back to a descriptor file, finds none, and reports the browser unavailable.
  `server/index.ts:270` reads `process.parentPort` through an optional cast — "Plain Node/dev launches
  have no parentPort" is written into the comment. No crash. Bots simply have no browser tool.
- **Host computer-use (CUA).** `electron/cua.mjs` / `cua-linux*.cjs` publish `cua-connection.json` into
  Electron's `userData`; `server/local-computer.ts:314-345` reads it and returns null when absent.
  A headless box has no seat to drive anyway.
- **Speech / dictation and the screen recorder.** `electron/resources/speech-helper.swift`,
  `recorder-helper.swift`, shipped only under the macOS block of `electron-builder.yml:99-104`. Already
  absent on Linux. No loss on a Linux cloud node.
- **Notifications.** Server-side these are just SSE frames — `server/index.ts:1332-1335` broadcasts
  `{kind:"notify"}`. The *client* renders them. Headless changes nothing server-side. (The client-side
  consequence is real and belongs to the PWA track: over plain tailnet HTTP `isSecureContext` is false,
  so no `Notification` API and no service worker. §4.4.)
- **Updater** (`electron/updater.mjs`, electron-updater) — replaced by `apt`/`git pull` + restart.
- **`openExternal`, `setCredential`, screen preview, skill recorder.** 109 `window.muragebox` call
  sites in `src/`, 80 of them optional-chained; the unguarded ones sit inside branches already gated on
  the bridge existing. The UI runs in stock Chromium (established, and re-confirmed: `/` served 200
  from the headless harness). These buttons just don't appear.

### 1.3 Actually better headless

- **Local VM computer-use.** `server/container-computer.ts` drives the *local Docker CLI* to run a
  pinned Cua XFCE container per bot (`BASE_IMAGE_DIGEST` sha256:274eb63…, `IMAGE_REPOSITORY
  localhost/murage/cua-local-vm`). Proven the route answers headless: `GET /api/local-computer` returned
  `{"runtime":"docker","available":["docker"],…}` with no Electron in the process (§8.1). On a Linux VPS
  with dockerd this is a *first-class* computer for every bot, and it does not need a GUI session — which
  is exactly what `docs/byo-vps.md` already sells, except the agent runs locally instead of over SSH.
- **Webhook ingress** already listens on its own port (`server/index.ts:240` `MURAGE_WEBHOOK_PORT ||
  PORT + 1`, `server/webhook-ingress.ts:143` bound to `127.0.0.1`) and serves only `/hooks/*`. Verified
  live: the headless harness opened `127.0.0.1:18878` alongside `18877`. **This is the one port that
  could legitimately take a public tunnel later** — it serves no UI and no harness API. That is the
  structural difference from the known Wayland bug (`tailscale funnel` pointed at the WebUI port). If
  Murage ever needs public webhooks, it points a tunnel at `MURAGE_WEBHOOK_PORT` and nothing else, and
  that rule goes in the systemd unit as a comment.

---

## 2. Can harness + companion run without Electron? Yes. Proven.

### 2.1 What `electron/main.mjs` supplies, and whether the server needs it

`startServerOn()` (`electron/main.mjs:842-925`) forks `Resources/server/index.js` as an Electron
`utilityProcess` with:

| Supplied | Needed? |
|---|---|
| `harnessResourceEnvironment(resourcesPath)` → `MURAGE_STATIC_DIR`, `MURAGE_SKILLS_DIR`, `MURAGE_SKILL_LIBRARY` | **Yes.** Set them in the unit. |
| `MURAGE_PORT` | Optional (`server/index.ts:239` defaults 8799). |
| `MURAGE_DESKTOP_PARENT=1` | **No** — and it must stay unset. Set, it makes the browser path fail closed forever (`browser-connection.ts:224`). |
| `MURAGE_USER_DATA` | No. Only locates Electron-written descriptors. |
| `MURAGE_CREDENTIAL_STORE` | No. `server/composio.ts:204-212` treats `undefined` as the non-desktop case. |
| workspace credential env (`workspaceCredentialEnv`) | Replaced by `~/.murage/config.json` (§1.1). |
| `parentPort` message channel | No. `server/index.ts:270-296` guards every use. |

### 2.2 Smallest headless entrypoint

**There is no new entrypoint to write.** `scripts/bundle-server.mjs` already produces
`dist-server/index.js` as a self-contained ESM bundle with no `node_modules` dependency (the packaged
app ships zero — see the file's own header). I rebuilt that bundle into a scratch dir and ran it:

```
env -i PATH=/usr/bin:/bin:/usr/local/bin HOME=<empty dir> \
  MURAGE_DATA_DIR=… MURAGE_PORT=18899 MURAGE_STATIC_DIR=…/dist \
  MURAGE_SKILLS_DIR=…/skills MURAGE_SKILL_LIBRARY=…/skills-library \
  node dist-server/index.js
→ {"app":"murage","pid":61966,"static":true}
```

The companion is the same story: `tsconfig.companion.build.json` emits `dist-companion/`, and
`node companion/src/index.ts` ran headless against the scratch harness and correctly found the real
tailnet (§8.2).

So the "headless entrypoint" is three lines of packaging, not code:

```
pnpm build          # vite → dist/            (UI, no Electron)
pnpm build:server   # tsc + esbuild → dist-server/
pnpm build:companion# tsc → dist-companion/
```

Add one script alias — `"start:headless": "node dist-server/index.js"` — and a
`docs/self-hosting.md`. That is the whole delta.

### 2.3 What the headless entrypoint cannot do

No browser tool, no host computer control, no dictation, no OS notifications, no auto-update, no
`credentials.bin`, no managed cloudflared tunnel, no QR-handoff panel (the pairing page at
`MURAGE_CONTROL_PORT` replaces it and is loopback-only — `companion/src/index.ts:226`).

---

## 3. Deployment shape

### 3.1 What the repo already has

- **No Dockerfile, no compose file, no `docs/self-hosting`.** Searched; nothing. `docs/byo-vps.md`
  exists but is the *opposite* feature — a remote Docker daemon giving a **local** agent a desktop,
  explicitly "never runs an agent remotely".
- Precedent is Wayland's `/Users/seandonahoe/dev/wayland/app/Dockerfile`: `node:20-slim` builder →
  `bun run build:renderer:web` + `build-server.mjs` → `oven/bun` runtime, `DATA_DIR=/data`,
  `VOLUME ["/data"]`, and an explicit `ALLOW_REMOTE` opt-in comment.

### 3.2 Recommendation: **systemd on the host, not Docker**

Docker is the wrong default here for one concrete reason: **`server/container-computer.ts` shells out
to the host `docker` CLI to give bots their Linux desktops.** Running the harness inside a container
forces either docker-in-docker or mounting `/var/run/docker.sock` into the harness container — and
mounting the socket is root-equivalent on the host, which `docs/byo-vps.md` itself warns about in the
same breath. Running on the host makes the Local VM path work with zero ceremony, keeps agent CLI
installs (`claude`, `codex`, `qwen`) in a normal `$HOME` where their own installers expect them
(`server/env-path.ts:33-49` hunts `~/.local/bin`, `~/.npm-global/bin`, nvm dirs), and removes an entire
layer from the failure surface.

Ship a Dockerfile *later*, for people who want it, once the systemd path is proven.

### 3.3 Units

Two units, one user, no root. `murage` is an unprivileged user in the `docker` group.

`/etc/systemd/system/murage-harness.service`
```ini
[Unit]
Description=Murage harness
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=murage
WorkingDirectory=/opt/murage
Environment=NODE_ENV=production
Environment=MURAGE_PORT=8799
# unset on purpose: MURAGE_DESKTOP_PARENT (would fail the browser path closed),
# MURAGE_COMPANION_HOSTED_URL and MURAGE_COMPANION_INTERNAL_ORIGIN (cloudflared).
Environment=MURAGE_STATIC_DIR=/opt/murage/ui
Environment=MURAGE_SKILLS_DIR=/opt/murage/skills
Environment=MURAGE_SKILL_LIBRARY=/opt/murage/skills-library
Environment=CLAUDE_CODE_OAUTH_TOKEN=  # see §5, from a credentials file below
EnvironmentFile=-/etc/murage/engine.env
ExecStart=/usr/bin/node /opt/murage/server/index.js
Restart=always
RestartSec=5
# The harness binds 127.0.0.1 only (server/index.ts:8681). Nothing here may widen that.
[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/murage-companion.service` — same user, `ExecStart=/usr/bin/node
/opt/murage/companion/index.js`, `After=murage-harness.service`.

`/etc/murage/engine.env` is `0600 root:murage` and holds `CLAUDE_CODE_OAUTH_TOKEN`, `FLUX_API_KEY`, etc.

Node version: `package.json` `engines` says `>=24`. The bundle ran fine on 22.23.1 in my test, but
target **node 24** — `node:sqlite` (used by `server/message-db.ts`) is still flagged experimental and
its surface has moved between majors.

### 3.4 Storage layout

`server/config.ts:445`: `DATA_DIR = process.env.MURAGE_DATA_DIR ?? join(homedir(), ".murage")`.
Complete child list, grepped from `join(DATA_DIR, …)` across `server/`:

```
~/.murage/
  config.json              every credential in plaintext on a headless box — chmod 0600
  bots.json                the fleet
  groups.json              rooms
  messages.db  (+ -wal/-shm)   every transcript (node:sqlite)
  events/                  event log
  native/                  per-thread ndjson
  attachments/             uploads, images
  checkpoints/             per-bot shadow trees
  workspaces/              bot working directories  ← the big one
  skills/  skill-state/    user skills and their state
  routines.json  webhooks.json  calendar-calls.json
  delegations.json  delegation-receipts.json  section-contexts.json
  browser-cleanups.json    (desktop-only journal; inert headless)
  vm-home/  vm-homes/      Local VM persistent homes
~/.murage-companion/       paired devices (companion/src/state.ts:23)
```

Plus, outside `DATA_DIR` and easy to forget: `~/.claude/`, `~/.codex/auth.json`, `~/.qwen/` — the engine
logins (§5).

**Backup.** One `systemd` timer, nightly:
1. `sqlite3 ~/.murage/messages.db ".backup /var/backups/murage/messages.db"` — never `cp` a live WAL db.
2. `tar` the rest of `~/.murage` **excluding `workspaces/`, `vm-homes/`, `attachments/`** unless you
   want them (workspaces are git checkouts; treat them as disposable exactly like `byo-vps.md` treats
   container filesystems).
3. `restic`/`rclone` the tarball off the box. Encrypted — `config.json` is plaintext secrets.

**Divergence is a real cost, and it is not solved by this plan.** Two Murage instances (laptop + cloud)
have two `~/.murage` directories and no sync. There is no replication layer in the codebase and I am
not proposing one. The honest framing for Sean: *the cloud instance is the always-on fleet; the laptop
is a client to it*, not a second copy. Running both as independent fleets is fine but they will never
be the same fleet.

---

## 4. Reachability: how you actually get to it

### 4.1 The two locks, and why they stay

Proven live against a headless harness:

```
curl -H 'Host: seans-macbook-pro.tail0a48a4.ts.net' http://127.0.0.1:18877/api/health
→ 403 {"error":"forbidden: loopback host required"}
curl -H 'Host: 127.0.0.1:18877'                     → 200
curl http://100.79.121.109:18877/api/health          → connection refused
```

Lock 1 is `listen(PORT,"127.0.0.1")` at `server/index.ts:8681`, with **no env override**. Lock 2 is
`isLoopbackHost(req.headers.host)` at `server/index.ts:5077`, before any route. `SECURITY.md` names
making this off-machine reachable as *the* vulnerability class.

Why that matters more than usual: I confirmed the RCE is live and one request deep.

```
curl -H 'Origin: http://127.0.0.1:18877' -H 'content-type: application/json' \
     -d '{"cli":"/bin/echo"}' http://127.0.0.1:18877/api/cli-test
→ 200 {"ok":true,"version":"--version"}          # it spawned /bin/echo
curl -H 'Origin: https://evil.example' …          → 403
```

So the gate is genuinely *same-origin*, not merely content-type. Which means: **any origin that serves
the full UI is an origin with arbitrary-binary-spawn.** That single fact decides the whole reachability
design.

### 4.2 Recommended shape — two channels, ranked

**Channel A (admin / full UI): Tailscale SSH local forward. Recommended.**

```sh
tailscale ssh murage-cloud -L 8799:127.0.0.1:8799 -N
# then open http://127.0.0.1:8799 in any browser
```

- The browser's origin is `http://127.0.0.1:8799`, so the loopback Host gate passes (proven above) and
  `server/index.ts:5063` accepts it as a loopback origin.
- **Zero code changes.** Nothing binds off-loopback; the tunnel is the transport and Tailscale (device
  identity + ACL + SSH check mode) is the auth.
- The same-origin RCE stays inside a channel only Sean's tailnet identity can open.
- Wrap it in a `Host murage-cloud` block in `~/.ssh/config` with `LocalForward 8799 127.0.0.1:8799`,
  and you get `ssh -fN murage-cloud` from a laptop or a shortcut on the phone (Blink/Termius do this).

**Channel B (daily driver / phone): the companion sidecar over the tailnet.**
`companion/src/index.ts:226` binds `0.0.0.0:COMPANION_PORT`; the pairing control page binds
`127.0.0.1:CONTROL_PORT`. Pairing is strong already (`companion/src/devices.ts`: 32-byte random,
SHA-256 at rest, `timingSafeEqual`, 120s TTL, 5 attempts, per-device revoke).

**Rejected: binding the harness to the tailnet IP, or `tailscale serve` in front of it.** It needs
*two* code changes (the listen host and the Host allowlist), it puts an unauthenticated
arbitrary-spawn API on the tailnet, and every other process on the VM can reach loopback anyway. The
403 above is a feature — `tailscale serve` preserves the original `Host`, so pointing it at 8799 fails
closed today. Do not "fix" that.

### 4.3 Three things this plan must fix before Channel B is usable on cloud

1. **`companion` binds `0.0.0.0` with no override.** `companion/src/index.ts:226`
   `await listen(companion, COMPANION_PORT, "0.0.0.0")` — hardcoded. On a cloud VM with a public IP
   that is the internet, firewalled or not. **Add `MURAGE_COMPANION_HOST`, default `0.0.0.0` to
   preserve desktop LAN behaviour, and set it to the Tailscale IP (or `tailscale0`) in the unit.**
   Belt and braces: `ufw default deny incoming` + allow only `tailscale0`, and set the cloud provider's
   firewall to deny all inbound except SSH. Small, contained change; it is the single highest-value
   line of code in this track.
2. **The hosted/cloudflared path outranks tailnet.** `companion/src/endpoints.ts:70-77`: `hosted`
   priority 0, `tailnet` priority 100. `electron/managed-companion-tunnel.mjs` runs bundled
   `cloudflared` against the companion's private UDS origin (`companion/src/origin.ts`), which shares
   the *same* proxy handler and therefore the same allowlist — public by default. For the cloud
   instance: leave `MURAGE_COMPANION_HOSTED_URL` and `MURAGE_COMPANION_INTERNAL_ORIGIN` unset, and do
   not ship `cloudflared` in the headless artifact at all. Assert it in the unit's comments and in a
   startup log line ("hosted endpoint: disabled").
3. **`GET /api/search` is a full-transcript grep for any paired device.** `companion/src/routes.ts:102`
   allowlists it; `server/message-db.ts:196-205` shows `threadId` is optional and its absence means an
   unbounded `LIKE` scan across every thread and every bot. Proven inert only because my scratch db was
   empty (`{"hits":[]}`). This is a live defect, it gets worse the moment the instance is always-on and
   holds months of transcripts, and it is cheap to fix: **require `threadId` on the companion path**
   (deny in `routes.ts`, or add a proxy-side query check), or scope the scan to threads the device has
   already been shown.

### 4.4 A note the PWA track needs

A browser cannot use the companion at all today. Proven:

```
curl -H 'Origin: https://seans-macbook-pro.tail0a48a4.ts.net' http://127.0.0.1:18820/
→ 403 {"error":"forbidden: cross-origin request"}     # companion/src/proxy.ts:237-242
```

and `/`, `/index.html`, `/manifest.webmanifest` are all outside the allowlist. So "reach the cloud
instance from a phone browser" is blocked on the PWA track's decisions, not on this one. What *this*
track can hand that track: **`tailscale serve` in front of the companion port gives a real HTTPS
`*.ts.net` origin, tailnet-only, which is a secure context** — the prerequisite for a service worker
and the `Notification` API that plain tailnet HTTP cannot provide. `tailscale funnel` is the public
one and is banned outright.

---

## 5. Tailscale on the instance — concrete

**Node type: persistent, not ephemeral.** Ephemeral nodes are removed when they disconnect; an
always-on box that reboots must keep its MagicDNS name, because that name is what the companion
advertises (`companion/src/listener.ts:74-100`) and what a paired phone dials.

**tailscaled on the host, not in a container** — same reasoning as §3.2, and it keeps `tailscale0` a
real interface the firewall and the companion bind can name. `companion/src/listener.ts:57-66` already
identifies the tailnet address by the `100.64.0.0/10` CGNAT range, and `tailscaleCandidates()`
(`:87-101`) includes `/usr/bin/tailscale`, so a normal Linux install is found without configuration.
Verified on Sean's Mac that this whole path works end to end: the headless companion printed
`on your phone, enter seans-macbook-pro.tail0a48a4.ts.net:18820`, i.e. MagicDNS resolution and tailnet
detection are live, not theoretical.

```sh
# 1. install
curl -fsSL https://tailscale.com/install.sh | sh

# 2. join, with a REUSABLE, PRE-AUTHORIZED, NON-EPHEMERAL auth key minted in the admin console,
#    tagged so ACLs can name it. --ssh enables Tailscale SSH (Channel A).
sudo tailscale up \
  --authkey=tskey-auth-XXXX \
  --advertise-tags=tag:murage \
  --hostname=murage-cloud \
  --ssh \
  --accept-dns=true

# 3. confirm MagicDNS and the 100.x address the companion will advertise
tailscale status
tailscale ip -4
```

**MagicDNS** must be on tailnet-wide (admin console → DNS → MagicDNS). The resulting name is
`murage-cloud.<tailnet>.ts.net`. Enable **HTTPS Certificates** in the same panel — that is what makes
`tailscale serve` able to terminate TLS with a real cert (§4.4).

**ACL** — the point of tagging. Nothing but Sean's own devices may reach the box, and only on the
companion port and SSH:

```jsonc
{
  "tagOwners": { "tag:murage": ["autogroup:admin"] },
  "acls": [
    { "action": "accept",
      "src": ["autogroup:member"],
      "dst": ["tag:murage:8810", "tag:murage:22"] }
  ],
  "ssh": [
    { "action": "check",           // re-auth periodically, not "accept"
      "src": ["autogroup:member"],
      "dst": ["tag:murage"],
      "users": ["murage", "autogroup:nonroot"] }
  ],
  "nodeAttrs": [
    { "target": ["tag:murage"], "attr": ["funnel"] }   // OMIT THIS. Listed to be explicit: never grant funnel.
  ]
}
```
(Delete the `nodeAttrs` block. It is written down only so nobody adds it later thinking it was an
oversight.)

**Serve, for the phone channel (after the PWA track lifts the Origin gate):**
```sh
tailscale serve --bg --https=443 http://127.0.0.1:8810
tailscale serve status         # must show tailnet-only, never "Funnel on"
```

**Key hygiene:** auth keys expire (90 days max). Either set the node to "disable key expiry" in the
admin console — correct for an always-on server — or you will lose the box at an unpredictable moment.
Do this on day one.

---

## 6. The engine problem. Not fatal — but pick a lane per engine.

This is where I expected to deliver bad news and the code says otherwise.

### 6.1 The baseline problem is real

A fresh box has no logins. Proven: running the bundled harness with `HOME` pointed at an empty
directory, `/api/instances` reported `claude state=unavailable`, `codex available auth=false`.
And on macOS the Claude subscription credential is **not a file you can copy** — proven:

```
ls ~/.claude/.credentials.json      → No such file
security find-generic-password -s "Claude Code-credentials"
                                    → class "genp" in login.keychain-db
```

So "rsync my laptop's logins to the VPS" does not work for Claude on macOS. Say that plainly.

### 6.2 Three viable paths, all verified to some degree

**Path 1 — Flux Router / BYOK. Strongest, and already built.** `server/flux-surface.ts:33-37` declares
Flux surfaces for exactly the three engines Sean names: `claudeAgent` → Anthropic Messages,
`qwenAgent` → OpenAI chat-completions, `codex` → Responses. Executed the real exported function:

```
claudeAgent  applied=true  env → ANTHROPIC_BASE_URL=https://api.fluxrouter.ai/anthropic
                                 ANTHROPIC_AUTH_TOKEN=… ANTHROPIC_API_KEY=… ANTHROPIC_MODEL=flux-auto
qwenAgent    applied=true  env → OPENAI_BASE_URL=https://api.fluxrouter.ai/v1 OPENAI_API_KEY=… 
codex        applied=true  env → MURAGE_FLUX_API_KEY=… (+ provider table as argv, codex.ts:181-197)
opencode     applied=false                       (no surface — flux-surface.ts header explains why)
```

Then I proved the *CLI* accepts it, with no login at all:

```
env -i PATH=/usr/bin:/bin HOME=<empty dir> \
  ANTHROPIC_BASE_URL=http://127.0.0.1:19911 ANTHROPIC_AUTH_TOKEN=… ANTHROPIC_API_KEY=… \
  claude -p "say ok" --output-format json
→ {"is_error":false,"result":"ok",…}
stub log: POST /v1/messages?beta=true auth=bearer xapi=yes
```

A completely unlogged-in `claude`, in an empty HOME, completed a turn against a redirected endpoint.
**That is the headless answer, and it needs zero new code.** Set `FLUX_API_KEY` in
`/etc/murage/engine.env`, pick a `flux-*` model per bot, done. Cost moves from subscription to
per-token, which is the honest trade.

**Path 2 — subscription tokens, headless.** Also viable, and the codebase does not fight it:
- `claude setup-token` exists ("Set up a long-lived authentication token (requires Claude
  subscription)"), and `CLAUDE_CODE_OAUTH_TOKEN` is a string in the shipped `claude` binary (verified
  with `strings`). Critically, **`CLAUDE_CODE_OAUTH_TOKEN` appears in none of Murage's three strip
  lists** — not `WORKSPACE_CREDENTIAL_ENV` (`server/config.ts:541-561`), not `PROVIDER_CREDENTIAL_ENV`
  (`:576-589`), not `stripRoutingEnv` — and `claudeEnvironment()` (`server/drivers/claude.ts:80-96`)
  builds the child env as `{...process.env}` minus those lists. Grep-proven: zero hits for
  `CLAUDE_CODE_OAUTH_TOKEN` anywhere under `server/`. So it rides straight through to the CLI.
  → Put it in `EnvironmentFile`. One line, no code.
- `codex login --device-auth` exists (device-code flow, no local browser), as do `--with-api-key` and
  `--with-access-token` reading from stdin. `~/.codex/auth.json` is a plain JSON file with a `tokens`
  object — transplantable in a pinch, but device-auth is cleaner.

**Path 3 — run the CLI logins interactively over Tailscale SSH, once.** `tailscale ssh murage-cloud`,
then `claude` / `codex login --device-auth` / `qwen` in a real TTY, opening the printed URL on the
laptop. This works today with no changes at all and is the fastest way to get the box live. Its only
weakness is silent re-auth failure months later — mitigate by alerting on
`GET /api/instances` reporting `authenticated:false` (the harness already computes this;
`server/drivers/claude.ts:1282-1286`, `codex.ts:658-664`).

### 6.3 The recommendation, and the one thing I will not pretend about

**Do Path 3 to stand it up this week, then move the always-on workload to Path 1 (Flux) and keep
Path 2 as the subscription fallback.** Belt and braces: `GET /api/instances` is the health check for
all three, so a single monitor covers whichever lane a bot is on.

The thing I cannot resolve from the code: **whether running a *subscription* CLI unattended on a cloud
VM is within Anthropic's / OpenAI's terms.** That is a licence question, not an engineering one, and
Sean should read the current Consumer Terms before making the cloud box a subscription workhorse.
Flux/BYOK has no such ambiguity. Flagging it rather than burying it, because it is the one risk that
could invalidate Path 2 and Path 3 after the work is done.

Two smaller engine findings from the clean-HOME run, worth a follow-up issue but not blockers:
`qwen` and `opencodeGo` both reported `authenticated:true` with an empty `HOME` and no credentials
present. Their auth probes are almost certainly returning a false positive. On a cloud box that means
the roster lies to you about which engines are actually usable.

---

## 7. What this means for the desktop app

**Yes, desktop becomes one deployment mode among three, and no, packaging does not have to change.**

The three modes and what distinguishes them:

| Mode | Harness | UI origin | Companion | Credentials |
|---|---|---|---|---|
| **Desktop** (today) | Electron `utilityProcess` fork | `MURAGE_STATIC_DIR` same-origin, in a `BrowserWindow` | started/stopped from Settings | `safeStorage` → `credentials.bin` |
| **Headless server** (new) | `node dist-server/index.js` under systemd | same-origin, reached over an SSH forward | own systemd unit, always on | `~/.murage/config.json` 0600 |
| **Client** | none | the remote instance's origin, through the tunnel | n/a | n/a |

Three reasons packaging is undisturbed:

1. **Every headless artifact is already built by the existing scripts.** `pnpm build`,
   `build:server`, `build:companion` — all three are Electron-free and all three are already
   `extraResources` inputs (`electron-builder.yml:63-78`). The headless tarball is a *subset* of what
   the `.app` already contains. No new build graph.
2. **The UI needs no multi-instance code.** `src/state/store.tsx:1296` `api()` calls
   `fetch(path)` with a relative path — same-origin, always. "Which instance am I looking at" is
   answered by *which origin the browser is pointed at*, which is exactly what the SSH forward
   selects. No base-URL setting, no token in the client, and — importantly — no way for a compromised
   page on one origin to talk to another instance.
3. **The Electron shell already tolerates its absence.** The bridge is optional-chained in 80 of 109
   call sites and the remaining ones sit behind bridge-existence branches.

What *does* change in the product story: the desktop app stops being "the app" and becomes "the
richest client, which happens to bring its own server". The features that are genuinely Electron-only
(browser panel, host computer control, dictation, notifications) become **desktop-mode features**, and
that needs saying in the UI — a `desktopFeatures: false` style flag derived from `window.muragebox`
being absent, so panels say "available in the desktop app" instead of silently missing. That is a
small UI task and it belongs to the PWA/responsiveness track, which is already touching those panels.

---

## 8. Proof log

Everything below was run in the scratchpad against scratch ports and a scratch `MURAGE_DATA_DIR`.
Nothing in `murage-app`, `wayland`, or `aionui` was modified; no git write command was run.

**8.1 Harness runs headless, serves the UI, and the loopback locks hold.**
`node --experimental-strip-types <repo>/server/index.ts` with `MURAGE_DATA_DIR` in scratch,
`MURAGE_PORT=18877` →
`GET /api/health` → `{"app":"murage","pid":33173,"static":true}`;
`GET /` → 200; `lsof` showed exactly two listeners, both `127.0.0.1` (`:18877`, `:18878` webhook);
`GET /api/local-computer` → `{"runtime":"docker",…}`; `GET /api/webhooks` → `ingress.baseUrl
http://127.0.0.1:18878`.
Host gate: `Host: …ts.net` → 403 `loopback host required`; `Host: 127.0.0.1:18877` → 200;
direct `http://100.79.121.109:18877` → refused.

**8.2 Companion runs headless and finds the real tailnet.**
`node --experimental-strip-types <repo>/companion/src/index.ts` with `MURAGE_PORT=18877`,
`MURAGE_COMPANION_PORT=18820`, `MURAGE_CONTROL_PORT=18821`, `MURAGE_COMPANION_DIR` in scratch →
```
bonjour: advertising on 100.79.121.109, 192.168.1.108
companion  http://0.0.0.0:18820  →  harness 127.0.0.1:18877
pair here  http://127.0.0.1:18821
on your phone, enter  seans-macbook-pro.tail0a48a4.ts.net:18820
```
Browser refusal: `Origin:` header → 403 `forbidden: cross-origin request`. `/`, `/index.html`,
`/manifest.webmanifest` unauthenticated → 401 (allowlist sits behind the token check).

**8.3 Flux redirects all three engines with env alone.** Executed `applyFluxSurface` from
`server/flux-routing.ts` for `claudeAgent` / `codex` / `qwenAgent` / `opencode` — output in §6.2.

**8.4 An unlogged-in `claude` completes a turn against a redirected endpoint.** Local stub HTTP
server on `127.0.0.1:19911`; `env -i` + empty `HOME`; result `{"is_error":false,"result":"ok"}` and the
stub logged `POST /v1/messages?beta=true auth=bearer`.

**8.5 The bundled server runs standalone.** Rebuilt `scripts/bundle-server.mjs`'s esbuild config with
`outdir` in the scratchpad (repo untouched), then ran `dist-server/index.js` under `env -i` with an
empty `HOME` and no `node_modules` → `/api/health` 200, `static:true`. Same run's `/api/instances`
gave the clean-box engine picture in §6.1.

**8.6 `POST /api/cli-test` spawns a caller-supplied binary from a same-origin page.**
`{"cli":"/bin/echo"}` with a loopback `Origin` → `200 {"ok":true,"version":"--version"}`;
cross-origin → 403; wrong content-type → 415.

**8.7 macOS Claude credential is keychain-resident, not a file.** `~/.claude/.credentials.json`
absent; `security find-generic-password -s "Claude Code-credentials"` found it in `login.keychain-db`.

**8.8 `CLAUDE_CODE_OAUTH_TOKEN` survives the env strips.** `strings` on the `claude` binary contains
it; `grep -rn CLAUDE_CODE_OAUTH_TOKEN server/` → zero hits, so it is in none of the three strip lists
that `claudeEnvironment()` applies.

---

## 9. Sequenced work

| # | Item | Size | Depends on |
|---|---|---|---|
| 1 | `MURAGE_COMPANION_HOST` env (default `0.0.0.0`), plumb into `companion/src/index.ts:226` | XS | — |
| 2 | Scope `GET /api/search` for paired devices — require `threadId`, or scope the scan | S | — |
| 3 | `docs/self-hosting.md`: units, storage layout, backup timer, tailscale up/ACL, engine auth lanes | M | — |
| 4 | `start:headless` script alias + a `pnpm package:headless` that tars `dist/ dist-server/ dist-companion/ skills/ skills-library/` | S | — |
| 5 | Startup log line asserting the disabled surfaces (`hosted endpoint: disabled`, `browser: unavailable`, `cloudflared: not shipped`) | S | 4 |
| 6 | Stand the box up: Hetzner → tailscale up → node 24 → units → Path 3 interactive logins | M | 1,3,4 |
| 7 | Backup timer + a monitor on `GET /api/instances` `authenticated:false` | S | 6 |
| 8 | Move always-on bots to Flux (`FLUX_API_KEY` + `flux-*` model per bot) | S | 6 |
| 9 | Follow-up issue: `qwen`/`opencodeGo` report `authenticated:true` with an empty HOME | XS | — |
| 10 | *(PWA track)* companion Origin gate + static asset routes, then `tailscale serve` HTTPS | — | PWA plan |

Items 1–8 are the cloud track. Item 10 is where the two tracks meet.
