# Murage universal client — master plan

Five tracks, five plans, five adversarial audits. This is the reconciled version.
Read §0 first; it changes two of the five plans.

Everything below is either cited `file:line` against the working tree at commit `aa360d39`,
or was run in this session against a scratch harness on a scratch data dir. Nothing in
`murage-app`, `wayland` or `aionui` was modified. No git write command was run.

---

## 0. The three load-bearing claims — I ran them myself

### (a) A room turn gets agents tools at hop 0 — **TRUE**

Booted the real harness (`scratchpad/room-hop-proof.mjs`), created a room, posted a human
message, captured what the room turn's provider was handed at `session/new`:

```
group 3f801055-…  threadId f89b83d7-e2bb-46b0-88b0-e66d9a377f6f
mcpServers[0].env → MURAGE_THREAD_ID  = f89b83d7-e2bb-46b0-88b0-e66d9a377f6f   ← the ROOM thread
                    MURAGE_TURN_DEPTH = "0"
```

Static trace agrees. `runGroupMemberTurn` (`server/index.ts:3415`) takes `hop` as its 4th
parameter. Four call sites: `:4190` passes literal `0` (top-level room dispatch — I read the
argument list, it is `groupId, threadId, responder.id, 0, …`), `:3860` passes `hop + 1` (mention
chain, capped by `MAX_GROUP_HOPS`), `:3902` passes `run.turnCount===1?0:1`, `:4669`/`:4768` pass
`0` (connector/secret resume). `hop` is never inherited. `server/index.ts:3474` mounts the agents
MCP when `hop < MAX_COMMS_DEPTH`, and `MAX_COMMS_DEPTH = 1` (`:325`).

**`MAX_COMMS_DEPTH` never has to move.** The Chief of Staff design rests on solid ground.

Same run reproduced the blocking bug verbatim — the room bot's own reply was
`[bot/text] from=Asker :: peer says: source thread does not belong to sender`.

### (b) The companion proxy can serve static assets downstream of `denyReason()` — **FALSE as stated. TRUE only on a new listener.**

The device port cannot serve this app, and no amount of allowlist work changes that.
`dist/index.html` is:

```html
<script type="module" crossorigin src="/assets/index-Drw15rVO.js"></script>
<link rel="stylesheet" crossorigin href="/assets/index-SIv1BWUu.css">
```

`crossorigin` makes those CORS-mode fetches, which send `Origin` **even same-origin**.
`companion/src/proxy.ts:236-242` refuses any request carrying an `Origin` **before the token
check and before `denyReason` is ever called**. So the app's own entry bundle 403s. Every POST
403s too. The only way to serve the UI through the sidecar is a **separate listener with its own
handler and its own origin policy**, plus a `Surface` discriminator in `routes.ts` so a browser
route is not thereby a device route. That is what the security plan proposes and it is correct.

**But the security plan put that listener on port 8812, which is already taken by the public
tunnel.** `electron/companion-origin-gateway.mjs:11-12` — `MANAGED_COMPANION_ORIGIN_HOST =
"127.0.0.1"`, `MANAGED_COMPANION_ORIGIN_PORT = 8812` — and `:290`
`server.listen({ exclusive: true, host: originHost, port: originPort })`. That is the loopback
TCP socket the bundled cloudflared guardian dials (`electron/managed-companion-tunnel.mjs:309`,
`electron/managed-companion-guardian.mjs`). The security plan's argument that the tunnel is on a
UDS and therefore "cannot be pointed at the browser door" is wrong: the UDS is one hop *further
in*; cloudflared attaches at TCP 8812. **Pick 8813, and add it to the port-collision guard at
`companion/src/index.ts:218` and the `HARNESS_PORTS` check at `:63-70`.**

### (c) Agent CLIs can authenticate headless — **TRUE for the BYOK lane. The health check for the other lanes is broken.**

Ran a stub Anthropic endpoint on `127.0.0.1:19977` and drove a completely unlogged-in `claude`
in an empty `HOME` with `env -i`:

```
env -i PATH=… HOME=<empty> ANTHROPIC_BASE_URL=http://127.0.0.1:19977 \
  ANTHROPIC_AUTH_TOKEN=fake-tok ANTHROPIC_API_KEY=fake-key claude -p "say ok" --output-format json
→ {"is_error":false,"result":"HEADLESS_OK","num_turns":1,…}
stub log: HIT POST /v1/messages?beta=true auth=bearer xapi=yes
```

Zero new code. `server/flux-surface.ts` already writes exactly this env for `claudeAgent`,
`qwenAgent` and `codex`. **The cloud story's engine problem is solved for those three.**

But the cloud plan's monitor is not real:

```
env -i HOME=<empty> CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-FAKEFAKEFAKE claude auth status --json
→ {"loggedIn": true, "authMethod": "oauth_token", "apiProvider": "firstParty"}
```

`claude auth status` reports **presence, not validity**. `server/drivers/claude.ts` trusts
`loggedIn`, so `/api/instances` will report `authenticated: true` forever against a revoked or
expired token. The plan's §9 item 7 alert never fires for the exact failure it exists to catch.
A health check has to assert on a **completed turn**, not a snapshot.

Coverage is also 3 of 13, not 3 of 3: the harness enumerates thirteen driver kinds and
`server/flux-surface.ts` declares surfaces for three. The other ten have no headless auth story
in any plan.

---

## 0b. The finding that outranks everything in the security plan

**`GET /api/events` is an unfiltered firehose, and it is allowlisted for paired devices today.**

`server/index.ts:1087-1090` is the single place a persisted message becomes an SSE frame:

```ts
store.onChange((change) => {
  switch (change.type) {
    case "message":
      broadcast({ kind: "message", threadId: change.threadId, message: change.message });
```

`broadcast` (`:1215-1231`) writes the frame to **every** client in `sseClients`. The only filter
is `wants` at `:1202` — `kind !== "screen" || client.screens`. There is no per-client visibility
filter of any kind. `routes.ts:57` allowlists `GET /api/events`.

So a paired token that simply holds the stream open receives, in real time, **every message on
every thread** — hidden bots, bot⇄bot `dm` rooms (`store.ts:189-191`), delegation task threads.
That is precisely the set the security plan's `visibleThreadIds()` spends a page excluding.

**Consequence: scoping `/api/search` does not close transcript exposure. It removes a convenient
grep and changes nothing about what is reachable.** The security plan's threat table marks T12
"fixed by §5"; it is not. Combined with thread-id-only authorization on
`GET /api/threads/:id/messages` (`routes.ts:97`) and `/export` (`:100`), which perform no
visibility check at all, a client harvests thread ids from the firehose and then reads each one
directly.

This must be decided before the browser door ships, and it is a Sean decision (see §7, D1).

---

## 1. Track verdicts

| Track | Verdict | Why |
|---|---|---|
| **iOS retirement** | **BUILD** — smallest, safest, unblocks two others | Proven leaf: a scratch tree with no `ios/` passes 13 companion test files / 211 tests. Two critical fixes folded in (below). |
| **Security / browser door** | **BUILD WITH CHANGES** | Design is sound; four defects must be fixed first: the 8812 collision, the `/api/events` firehose, the tailnet-bind selector, and the search-scoping header polarity. |
| **PWA + responsive** | **BUILD WITH CHANGES — the service worker as specified is BROKEN** | The auditor built the plan's exact SW merge and measured it: offline, `#root` childCount=0, both cached assets `net::ERR_FAILED`, then the blank-root recovery unregistered the SW and landed on `chrome-error://`. Ship the responsive work first; ship the SW only after the cache-fallback fix. |
| **Cloud / headless** | **BUILD WITH CHANGES — but defer** | Headless works, proven. Blocked on nothing technical, but it is the lowest-value track until the phone story lands, and its Docker/systemd contradiction makes the service account root-equivalent on a box running an unauthenticated arbitrary-spawn API. |
| **Chief of Staff** | **BUILD WITH CHANGES — steps 0–5 only; step 6 DO NOT BUILD yet** | Load-bearing claim verified. But `delegate_bot` from a room is *silently deleted*, not merely undelivered, and the step-6 cycle controls can be reset by a normal user action mid-chain. Step 6 needs a redesign, not a fix. |

---

## 2. Do this first

**The smallest useful, independently safe, independently shippable change is the security
hardening batch — three edits, no new subsystems, no dependencies.** It closes live holes against
a credential that already exists (a paired iOS token, which Sean may still hold even though the
app is retiring).

1. **Delete `{ method: "GET", path: /^\/api\/search$/ }` from `companion/src/routes.ts:102`
   AND `["GET", "/api/search"]` from `companion/test/routes.test.ts:71`.**
   The auditor applied the plan's edit without the test line and CI went red:
   `AssertionError: expected { status: 404, error: "no route: GET /api/search" } to be null`
   (1 failed / 57 passed). Verified live that the route is a full-transcript grep — a scratch
   harness returned hits for `?q=e` (one character) across every thread with no scoping.
   Retirement is the one moment removal costs nothing: no client exists to call it.

2. **Delete `POST /api/connectors/:slug/authorize` from the allowlist
   (`companion/src/routes.ts:132`).** A paired phone can currently bind a Google account to this
   machine. Same class as the search hole, one line.

3. **Decide `/api/events` (§0b, decision D1) and act on it.** Either scope `broadcast()`
   per client, or drop `/api/events` from the device surface. Do not ship the browser door
   before this is answered.

Effort: **3–5 h** for items 1–2 with tests. Item 3 is 8–14 h if you scope `broadcast()`.

Everything else in this document waits behind, or runs beside, that.

---

## 3. Sequenced work plan

Dependencies are real: **security gates PWA, PWA gates the phone half of cloud.** The Chief of
Staff track is independent of all three and can run in parallel with a second pair of hands.

### Phase A — hardening and retirement (no new subsystems)

| # | Work | Effort | Depends on |
|---|---|---|---|
| A1 | Drop `GET /api/search` from allowlist **+ `routes.test.ts:71`** | 1 h | — |
| A2 | Drop `POST /api/connectors/:slug/authorize` from allowlist | 1 h | — |
| A3 | Decide and implement `/api/events` visibility (§0b / D1) | 8–14 h | D1 |
| A4 | Salvage out of `ios/` **before** deleting: `Sources/CompanionCore/*.swift` (14), `Tests/CompanionCoreTests/*.swift` (22), `ios/App/` + `ios/ShareExtension/` (the §3 plan reads ~15 files there), `ios/project.yml:104-121` (the ATS decision record), the 6 App Store screenshots, and the shared-layer half of `docs/ios-companion.md` (`:104-131`, `:136-163`, `:188-199`) | 2 h | — |
| A5 | Re-root the allowlist on a checked-in TS route contract extracted from `Client.swift` (56 KB) before it is deleted — 47 entries, each with a stated reason | 6–8 h | A4 |
| A6 | Delete `ios/`, the CI `ios:` job (`ci.yml:149-171`, not `-172`), 3 doc files, ~15 line edits. **Add the 6 doc references the plan missed**: `features/index.mdx:41` and `:51`, `contributing/index.mdx:25`, `notification-and-proactivity-qa.md:24,26,54,61`, `capture-companion-fixtures.mjs:2`, and a docs redirect for the `mobile/` → `devices/` rename (`apps/docs/next.config.mjs` has no `redirects()` today) | 4–6 h | A5 |
| A7 | Fix `companion/src/control.ts:151-165,377-379,389` — an iOS-only ATS policy encoded in the exported `hostCandidates()`, which **drops the bare tailnet address**, the one a browser *can* reach over plain HTTP. `listener.ts:70-76` carries the same justification. The plan lists control.ts under "keep — untouched" and it is not | 3 h | A6 |
| A8 | Narrow the device port from `0.0.0.0` (`companion/src/index.ts:226`) to the tailnet address; drop mDNS; re-rank `endpoints.ts` so `tailnet` leads `hosted` | 4 h | A6, D3 |

**Phase A total: 29–39 h.** A1+A2 alone are a same-day ship.

### Phase B — the browser door

| # | Work | Effort | Depends on |
|---|---|---|---|
| B1 | `Surface` discriminator in `routes.ts` (`DEVICE_ALLOWED` byte-identical, `BROWSER_SHELL`, `BROWSER_EXTRA`, `SHARED_ALLOWED`) + the pinning test asserting every browser entry is denied on the device surface | 6 h | A5 |
| B2 | Authoritative tailnet bind. **Do not** use `tailscaleAddress(lanAddresses())`: `listener.ts:26-29` ranks `/^en\d+$/` at 0 and `utun` at 2, sorted ascending, so a physical interface carrying a 100.64/10 CGNAT address (Starlink CPE, some carrier and corporate networks) is returned **ahead of** the real Tailscale address, and the door binds the LAN while every ECONNREFUSED proof still passes. Read `Self.TailscaleIPs` from `tailscale status --json` — the process already shells out for `Self.DNSName` at `listener.ts:139-141` — or require the interface name to match `VIRTUAL_INTERFACES`. Fail closed | 4 h | — |
| B3 | `companion/src/browser.ts`: new listener on **8813** (not 8812), own handler, `Host` allowlist, `Sec-Fetch-Site` gate, exact-match `Origin` on writes, zero CORS headers. **Must reuse `proxy.ts:200-216 forwardHeaders` verbatim** — `x-murage-companion: 1` is now a security control, and `content-length` canonicalisation and `last-event-id` have to survive the copy. Extend the port-collision guard at `index.ts:218` and `HARNESS_PORTS` at `:63-70` | 14–18 h | B1, B2 |
| B4 | Sessions on `DeviceRecord` (hashes only), `GET /enter` (credential in the URL **fragment**), `POST/GET/DELETE /session`, cookie derived from `bound.scheme`. **Rate-limit `POST /session` and `POST /api/pair` per source** — `devices.ts:64 MAX_PAIRING_ATTEMPTS = 5` and `redeem` burns the window at zero, so any tailnet peer can permanently deny Sean the ability to pair | 10–14 h | B3 |
| B5 | Register the browser door's `/api/events` stream with `connectedDeviceTracker` (`proxy.ts:373-457` does this for devices). Without it, revoking a device leaves the browser's live stream running — the one revocation lever §3 claims comes free. **Never prototyped; prove it before committing** | 4 h | B3 |
| B6 | Scope `/api/search` in SQL via `store.visibleThreadIds()`, not a post-filter (`message-db.ts:201` applies `LIMIT` before `index.ts:6103` filters). **Reverse the header polarity**: the plan's `const companion = req.headers["x-murage-companion"] === "1"; scope = companion ? … : undefined` means *absent header = unscoped*, and B3 is explicitly a different handler in a different file. Make the harness scope by **default** and have the loopback desktop opt out. Chunk the `thread_id IN (…)` expansion — `MAX_WORKSPACE_BOTS = 100` (`index.ts:326`) plus task threads makes the parameter count unbounded | 6–8 h | A3 |
| B7 | Onboarding step rework (Sean's addendum): "enable the web UI?" (off by default, backend toggle) and "connect a device?" as **two** questions. Slot exists — `src/components/Onboarding.tsx:8,:349` already renders `PhoneSetupFlow` with `track("phone_setup_skipped"/"completed")` at `:353`/`:357`. Port Wayland's `WebuiModalContent.tsx` shape; keep Murage's device model | 10–14 h | B4 |
| B8 | `X-Content-Type-Options: nosniff` on the harness static branch (`server/index.ts:8729` writes only `content-type` — measured, no nosniff on any path); `.webmanifest` MIME (`MIME` map at `:248-256` has no entry — measured, serves the SPA fallback); reject rather than strip on traversal (`:8725` is `path.replace(/\.\./g,"")`, a mangling strip that is only safe because `url.pathname` already normalised) | 2 h | — |
| B9 | Measure and ship a CSP for the shell. §8.9 of the security plan makes it the only mitigation for XSS in the bundle, and §11 leaves it undetermined. The bundle uses `crossorigin` module scripts and shiki dynamic imports | 4 h | B3 |
| B10 | Write the Tailscale ACL. Not code. 5 peers today, no ACL, every one can dial any port this machine binds | 1 h | D3 |

**Phase B total: 61–79 h.** The security plan said 34.

### Phase C — responsive UI (ships without the PWA)

| # | Work | Effort | Depends on |
|---|---|---|---|
| C1 | Tier 0 globals: `viewport-fit=cover`, `styles.css` safe-area + `overscroll-behavior`, the `tap-44` pseudo-element rule, 15px→16px on every focusable input (**including `Onboarding.tsx`, which the plan never mentions and which is the first screen a phone user sees**) | 3 h | — |
| C2 | `tap-44` application. **52 sites, not ~35** (size-6 ×6, size-7 ×5, size-8 ×15, size-9 ×11, size-10 ×15), before padding-sized buttons. The neighbour-steal hazard is reproducible headless and the plan names the wrong row: the ChatView header chip row passes; the **per-message action cluster** fails — probing outside the Speak button hit "Reply to message", probing outside that hit "Pin message" | 5 h | C1 |
| C3 | Tier 1 collapse fixes: `InspectorPanel.tsx:184`, `SettingsPanel.tsx:378`, `ComputerPanel.tsx:832-842` (inline `style` needs a `matchMedia` branch), `SettingsModal.tsx:584/587`, `Sidebar.tsx:1379`. Measured: Inspector open at 390px gives `main.w=0`, `textarea.w=8`, `docScrollW=461` — a bug at any narrow width, not just mobile | 5 h | C1 |
| C4 | `visualViewport` → `--vvh` → `#root`. **Verified working**: injecting `#root{height:var(--vvh)}` and setting `--vvh:508px` moved the composer from `taBottom=826` to `taBottom=490` with zero component changes. Plus scroll-anchor preservation in `ChatView.tsx` | 5 h | C1 |
| C5 | **20 `fixed inset-0` overlays across 14 files**, 9 of them in the shipping set. `position: fixed` resolves against the layout viewport, which iOS does not shrink for the keyboard, so C4 fixes the chat column and leaves every modal at full 844px behind the keyboard | 4 h | C4 |
| C6 | **Hover-only affordances — absent from the plan entirely** (`grep hover` on the plan: 0 hits). Measured at 390×844 with `any-hover: hover` false: six controls have effective opacity 0 — Copy, Regenerate, Reply, Pin, Speak (all 26px) and Archive. That is the entire per-message action set, invisible and unreachable. 21 `group-hover:opacity-100` sites in 10 files, 6 in the shipping set | 6 h | C1 |
| C7 | **Touch-unreachable interactions — also absent.** `Sidebar.tsx:847-877` exposes the bot row menu **only** via `onContextMenu`; iOS produces no `contextmenu` event. `TaskPicker.tsx:308-317` offers rename via `onDoubleClick` **or** `onContextMenu` and nothing else — and TaskPicker is in the ships list, so a task cannot be renamed on a phone. `Sidebar.tsx:1601-1625` reorders sections with HTML5 drag-and-drop, dead on touch | 8 h | C1 |
| C8 | The 38 non-test components named nowhere in the plan that render inside shipping surfaces: `Onboarding` (367), `PendingApproval` (211), `SecretRequestCard` (197), `ConnectorCard` (158), `GoalRunCard` (97), `SidebarPhoneButton` (211), `OptionCard` (105), `EmberAvatar`, plus `BotSkillsPanel`/`VoiceSettings`/`BotProfileAvatarCard`/`CompanionSection` under SettingsPanel | 10 h | C3 |
| C9 | `React.lazy` on nine desktop roots + extend `desktop.ts`'s capability object. **`ModelPicker` is not free**: `contained` is a plain prop defaulting to false (`:109,116`) passed only by `SettingsPanel.tsx:554`, so `ChatView.tsx:1137` always renders the absolute `w-[380px]` branch on a 390px screen | 4 h | — |
| C10 | Re-measure at 390×844 and 430×932, fix fallout | 4 h | C1–C9 |

**Phase C total: 54 h.** The plan said 13–18 h for "tolerable". The audit is right that it is ~2×,
and the missing categories (C6, C7, C8) are the reason.

### Phase D — PWA layer (on top of a responsive app that already works)

| # | Work | Effort | Depends on |
|---|---|---|---|
| D-a | Enable Tailscale HTTPS Certificates in the admin console. **Blocking prerequisite, currently off** — `tailscale status --json` reports `CertDomains: null` (re-verified this session). Without it there is no trusted origin, `isSecureContext` is false, `registerPwa` returns undefined, and the entire PWA half does not run. One click, but nowhere in the plan | 0 h + Sean | — |
| D-b | Icons from `ios/App/Assets.xcassets/AppIcon.appiconset/icon-1024.png` (opaque, ground `#100F15`) via `sips`; manifest; `index.html` head block; `registerPwa.ts`; `swVersionInjector` | 4 h | A4, D-a |
| D-c | **`sw.js` — rewrite, not the plan's merge.** The plan's merge is measured broken: AionUi's `networkOnlyWithTypeGuard` (`aionui/public/sw.js:120-137`) opens with a bare `await fetch(request)` with **no catch and no cache fallback**, while Wayland's `handleNavigate` fails open. Merged, the shell loads offline and every script/style is rejected with the bundle sitting in the cache. Fix: on network *rejection* fall back to `cache.match(request)` (safe because `/assets/*` is content-hashed); on content-type *mismatch* delete and fail fast. Two different failures, two different answers | 6 h | D-b |
| D-d | **Derive `CACHE_NAME` from the built asset manifest, not `package.json`.** `package.json` is `0.1.44` and `"build": "tsc -b && tsc -p tsconfig.server.json && vite build"` never bumps it, so two different bundles share `murage-webui-0.1.44` and `activate` purges nothing | 2 h | D-c |
| D-e | Precache content-type assertion. `cache.addAll`'s atomic-fail safety net is defeated by the SPA fallback — **measured live this session**: `/sw.js`, `/manifest.webmanifest`, `/icons/murage-192.png` and `/assets/index-NOPE.js` all return `200 content-type: text/html` from a real harness with the real `dist`. A mis-generated icon does not fail the install; it caches `index.html` **as** the icon | 3 h | B8 |
| D-f | A rehearsed kill switch: a no-op self-unregistering `sw.js` as a documented deploy artefact, plus a runbook line for a standalone home-screen install that has no URL bar to escape with | 3 h | D-c |
| D-g | AionUi's post-claim `clients.matchAll → client.navigate(client.url)` (`aionui/public/sw.js:40-49`), which Wayland dropped | 1 h | D-c |
| D-h | Install-and-launch verification on Sean's actual phone | 1 h | all |

**Phase D total: 20 h**, and it is genuinely optional — the responsive app works over plain
HTTP-on-WireGuard without any of it. Ship C before D.

### Phase E — Chief of Staff (parallel track, independent)

| # | Work | Effort | Notes |
|---|---|---|---|
| E0 | Room-thread delivery. `server/index.ts:2136` (`botByThread` null for a room), `:2222` (`reportStartFailure`), `:2249` (`isUnattended`) — **plus `server/delegations.ts:311-316`**, which the plan missed and which is the one that matters | 8 h | See below |
| E1 | `canReach()` in `store.ts`, replacing **nine** section gates, not seven — the plan misses `index.ts:5206` (routine **proposal**-time `for_bot_id` check) and `:5447` (`check_delegation`/`wait_delegation`) | 8 h | Not a strict superset — see below |
| E2 | `chiefScope?: "workspace"` field, scope-aware `setChiefOfStaff`, load-time de-dupe, **not** exported. Also handle `setBotsSection` (`store.ts:1263-1275` refuses on `chief-conflict`) and the re-election at `index.ts:7228-7235` | 6 h | |
| E3 | `connectorThread` on `ask_bot`/`delegate_bot` (`:5335`, `:5487`) **+ the three post-approval re-checks** at `:5386`, `:5389` and `delegations.ts:499` — the last writes no receipt at all, a silent drop. Extend `dismissStalePeerCards` (`peer-approval.ts:186-204`) to sweep group threads, or a crash leaves a room composer permanently blocked | 10 h | |
| E4 | Prompts: chief branch in the room system array (`index.ts:3588-3602` has none today — the room prompt actively tells a chief to `@mention`, which runs the teammate at `hop+1` with no tools); workspace roster grouping; `create_bot` section argument | 8 h | Highest value line in the whole track |
| E5 | UI: scope control, split badge, exec-room action, `TeamMapPage` hoist | 8 h | **Stop and review here** |
| E6 | `delegate_room` + chain budget + visited set | **DO NOT BUILD YET** | See below |

**Phase E (E0–E5) total: 48 h.** The plan said 38 for all seven steps.

#### Why E0 is bigger than the plan says, and why step 3 does not ship alone

`server/delegations.ts:311-316`:

```ts
const from = bus.store.botByThread(threadId);
if (!from) { pendingDelegations.delete(threadId); savePending(); return; }
```

On a room turn's `turn.completed`, `botByThread` is null, and the queued delegation is **deleted
with no `runTarget` call and no receipt**. The auditor proved this against the real `Store` and
the real `delegations` module: `pending before drain = 1`, `runTarget calls = 0`,
`pending after drain = 0`, `receipt = NONE`; the 1:1 control gave `runTarget calls = 1`.

So fixing `index.ts:2136` alone is unreachable for `delegate_bot`, and shipping the plan's step 3
without the drain fix makes Murage **silently swallow delegations launched from a room** — strictly
worse than today's honest 403. `delegations.ts:311` belongs in step 0.

#### Why `canReach` is not a strict superset

The proposed predicate opens `if (to.hidden || from.id === to.id) return false`. Four of the gates
have no hidden check today — `ask_bot` (`:5331`), `delegate_bot` (`:5487`), routine
`validateTarget` (`:3220`), `dropIfSectionsChanged` (`delegations.ts:553`). Swapping them in newly
refuses peer contact with an archived bot and newly drops queued delegations whose target was
archived. Probably desirable; it is still a behaviour change shipping in the step whose entire
justification is that it changes nothing.

#### Why E6 is not buildable as specified

The chain controls live on `GroupTurnOrchestration`, which is the **12th parameter** of
`runGroupMemberTurn`. I read the argument lists: `:4190` (top-level dispatch) and `:3860` (mention
chain) both end at `skillAuthoringClaim` and pass no orchestration; `:3902` constructs a fresh one;
`:4669` and `:4768` (connector/secret resume) re-enter at hop **0** with none. Concrete loop:
Ember → `delegate_room(TeamA)` → Rex at hop 0, chainDepth 1 → Rex calls `request_credential` → Sean
connects the app → `:4768` re-runs Rex at hop 0 with orchestration undefined → chainDepth 0,
visited `{}` → Rex calls `delegate_room(Exec)` → forever. Both controls evaporate together and the
trigger is a normal human action.

Delegations are also persisted and re-drained at boot (`index.ts:3408-3413`), so a restart
mid-chain resets both controls too. `chainDepth` and the visited set must live on the persisted
`DelegationItem` (`delegations.ts:24-37`), and `orchestration` must be threaded through all four
omitted call sites. Until that redesign exists, **E6 stays unbuilt**.

Also unaddressed: routines are a hole in the computer-provision denial. `server/routines.ts`
`sanitizeInput` accepts `runOn: "ember" | "cloud"` with no capability check, and
`server/index.ts:2670`/`:2757-2767` reach `box.provisionBox(…)` — the same call the *denied*
`computer/provision` route makes at `:8708`. `POST /api/routines` is allowlisted today
(`routes.ts:121,124`). A lost phone provisions cloud infrastructure around both the route denial
and the `cloudDesktopAccess` gate.

### Phase F — cloud (defer)

Buildable, and the hard part is proven. Not recommended until A–D land, because the phone half of
it is blocked on Phase B anyway and the desktop half is an SSH forward that needs no code.

Changes the plan must absorb before it is safe to execute:

- **The Docker contradiction.** §3.2 rejects Docker *because* `docs/byo-vps.md:26` says docker-group
  membership is root-equivalent; §3.3 then puts the `murage` user in the docker group. That makes
  the account running an unauthenticated arbitrary-binary-spawn API root-equivalent on an always-on
  box. **Fix is free: rootless podman is already a supported runtime**
  (`container-computer.ts:54`, `:790`, `:883`) and docker is preferred only when installed
  (`:238-241`). Don't install docker.
- **Local VM sizing is a constant, not an unknown.** `container-computer.ts:60-61` hard-pins 4 GiB
  and 2 CPUs, and `dockerSecurityIsHardened` (`:764-765`) *requires* those exact values or the
  container is reported unsafe. Two concurrent bot desktops = 8 GB before the harness. Either size
  for N×4 GB or drop Local VM from the cloud story.
- **Credential migration is missing and blocks day one.** `electron/workspace-credentials.mjs:10-16,
  :39-59` sweeps `xaiApiKey`/`boxToken`/`ttsKey`/`openaiImageApiKey`/`opencodeGoApiKey` out of
  `config.json` into `credentials.bin` at every boot and **deletes the plaintext field**. A laptop
  that has run the packaged app has an empty `config.json` and a macOS-keychain-encrypted blob that
  cannot be decrypted on Linux. Those five keys must be re-obtained from each provider by hand.
  (`FLUX_API_KEY` and composio are not in that list and do survive.)
- **§4.3 and §5 contradict each other.** §4.3 binds the companion to the tailnet IP; §5 runs
  `tailscale serve … http://127.0.0.1:8810`, which then proxies to a closed port. Also the plan's
  own ACL grants only ports 8810 and 22, so `serve` on 443 is blocked by it.
- **Channel A is untested.** `tailscale ssh … -L … -N` was historically prohibited
  (tailscale#5091, fixed by PR #5865). Tailscale is **not absent from this machine** — the plan's
  stated unknown is wrong: `/Applications/Tailscale.app/Contents/MacOS/Tailscale` is a working CLI,
  version 1.98.8, and `serve status` returns "No serve config", so `serve` is supported. Test the
  forward on the box before relying on it, and name plain OpenSSH on a non-22 port as the fallback.
- **The health monitor is broken** (§0c above). Assert on a completed turn.
- **`MURAGE_RESOURCES_PATH` is missing from the unit** (`electron/harness-resources.mjs:28`,
  consumed by `server/drivers/phone-proxy.ts:46`).
- **The backup omits what §3.4 says is easy to forget** — the recipe tars only `~/.murage`, so a
  restore leaves every phone unpaired and every engine logged out.

**Phase F realistic: 55–65 h**, or ~40 h with Local VM dropped. The plan said 34.

---

## 4. Total effort, honestly

| Phase | Hours |
|---|---|
| A — hardening + iOS retirement | 29–39 |
| B — browser door | 61–79 |
| C — responsive UI | 54 |
| D — PWA layer | 20 |
| E — Chief of Staff (E0–E5) | 48 |
| F — cloud | 40–65 |
| **Total, everything** | **252–305 h** |

At 30 focused hours a week that is **8–10 weeks for one engineer**. The five plans as written
add up to 165 h, so the plans are collectively about **40% under**, and the gap is concentrated in
three places: the browser door's real dependency list, the responsive work's unmapped components,
and the Chief of Staff delegation ledger.

**A phone in Sean's hand that is safe and works — Phases A + B + C — is 144–172 h, five to six
weeks.** Phase D adds a home-screen icon and an offline shell for 20 h more. Phases E and F are
separate products and should be scheduled as such.

If only three weeks are available: **A + C**. That gives a responsive Murage reachable over an SSH
forward, with the live holes closed, and no new attack surface. It is the honest MVP.

---

## 5. Threat model

Only the rows that changed from the security plan are annotated. `T` numbers preserved.

| # | Threat | Layer that stops it | Status / if that layer fails |
|---|---|---|---|
| T1 | Internet attacker reaches the harness | `server.listen(PORT,"127.0.0.1")` (`index.ts:8752`, no env override) + `isLoopbackHost` gate before any route (`:5078`, fired at `:5120`) | **Holds.** Verified: `Host: …ts.net` → 403; `/api/cli-test {"cli":"/bin/echo"}` with a loopback Origin → `200 {"ok":true}`. Failure = RCE in one request |
| T2 | Internet attacker reaches the browser door | Bound to the tailnet address only; no funnel; nothing binds 0.0.0.0 | **Conditional on B2.** The naive selector can bind a physical interface — see §3/B2. Day one, the only real credential is one `HttpOnly` cookie; `Sec-Fetch-*` is forgeable by any non-browser peer |
| T3 | Malicious web page drives Murage | `Sec-Fetch-Site` must be `same-origin`; exact-match `Origin` on writes; no CORS headers | **Sound.** Measured in a real browser: `Origin` absent on same-origin GET and EventSource, present on every write and on `crossorigin` script tags; `Sec-Fetch-Site` present on all seven request shapes |
| T4 | Another port on the same host attacks the door | `Sec-Fetch-Site: same-site` explicitly **refused** | **Sound and necessary.** Proven: an attacker page on `:18841` reaching `:18840` registers as `same-site` and the `SameSite=Lax` cookie **was sent** on its cross-origin POST. Site excludes port; Murage runs 5 ports on one hostname |
| T5 | Lost, unlocked phone | Per-device revoke (`devices.ts:333`) + live SSE termination (`control.ts:308`) | **Wider than the plan says.** Full read *and* full write to every bot — plus cloud-infrastructure provisioning via `POST /api/routines` with `runOn:"cloud"` (§3/E6 note), which is around both the route denial and `cloudDesktopAccess` |
| T6 | Another compromised tailnet node | Tailscale ACL (unwritten — 5 peers today) + `Host` allowlist + the cookie it cannot read | **Plus a DoS the plan missed**: any peer can spray 5 wrong credentials at `POST /session` or `/api/pair` and burn every pairing window Sean opens, indefinitely (`devices.ts:64`, `redeem`'s `closePairing`). Needs rate limiting |
| T8 | Stolen `devices.json` | Hashes only; dir 0700, files 0600 (`state.ts:33-34`) | **Holds.** Session hashes inherit it |
| T9 | Credential in a log or URL | Fragment-carried credential, `replaceState` before the POST, raw bearer never returned in a body | **Sound.** Strictly better than Wayland's `authRoutes.ts:560`, which returns the session token in JSON |
| T11 | Response cached in a CDN | `PRIVATE_RESPONSE_HEADERS` (`proxy.ts:114-120`) | Only reachable if a hosted endpoint is on at all — which D3 recommends against |
| **T12** | **Transcript exposure** | **NOT `/api/search` scoping.** `/api/events` is an unfiltered per-message firehose (`index.ts:1087-1090` → `:1215-1231`, only filter is `screen`), and `GET /api/threads/:id/messages` and `/export` do no visibility check at all | **LIVE AND OPEN.** Scoping search removes a grep and nothing else. See §0b and decision D1 |
| **T13** | **Desktop compromise → phone compromise** | Nothing today | **New with the browser door.** It serves the bundle from `MURAGE_STATIC_DIR` with no SRI, no CSP, no nosniff. An agent with `autoApprove: true` and shell tools that writes one file into `STATIC_DIR/assets/*.js` — an explicitly allowlisted path — gets script execution inside the browser-door origin on Sean's phone, with the `HttpOnly` cookie riding along. The shell CSP (B9) is therefore not polish |
| **T14** | **Execution-policy escalation via `PATCH /api/bots/:id`** | Currently denied. **The PWA plan proposes adding it** for the unread flag | **Do not add it.** `routes.ts` matches method+path only, no body inspection. The handler (`index.ts:7053-7240`) accepts in one request: `modelSelection`, `cwd`, `autoApprove`, `alwaysAllow` (up to 200 tool keys), `computer`, `browser`, `chiefOfStaff`, `hidden`. The "Auto on this Mac" guard at `:7203` keys on `body.acknowledgeLocalAuto !== true` — a **client-supplied boolean**, despite its own comment saying "the renderer dialog alone is not a boundary; this check is". Outcome-equivalent to the RCE pair. The correct routes already exist and are already allowlisted: `POST /api/bots/:id/read` and `/always-allow` |

**Not defended against, stated plainly:** a compromised Mac; a second local user account (the
harness's loopback socket *is* its credential); a lost unlocked already-signed-in phone before
revocation; a prompt-injected agent; anything multi-tenant; traffic analysis on the tailnet.
`visibleThreadIds()` is a surface filter, not an authorisation model.

---

## 6. The route allowlist

Current state: **47 entries in `companion/src/routes.ts`**, extracted programmatically from
`ALLOWED` plus `CLOUD_DESKTOP_JOIN_ROUTE`. `D` = device surface (native — retiring). `B` = browser
surface. Default is deny; anything not here 404s (`routes.ts:184-194`).

| Method | Path | D | B | Note |
|---|---|---|---|---|
| GET | `/api/config` | ✓ | ✓ | booleans only; values never echoed, `sshAlias` scrubbed (`wire.ts:21`) |
| GET | `/api/events` | ⚠ | ⚠ | **UNSCOPED FIREHOSE — decision D1 gates both columns** |
| GET | `/api/instances` | ✓ | ✓ | GET only. `PATCH` is half the RCE |
| GET | `/api/companion/endpoints` | ✓ | ✓ | sidecar-terminated (`proxy.ts:306`) |
| GET | `/api/bots` | ✓ | ✓ | |
| POST | `/api/bots` | ✓ | ✓ | |
| POST | `/api/sidebar-sections` | ✓ | ✓ | narrow organizer write; cannot alter execution policy |
| POST | `/api/bots/:id/messages` | ✓ | ✓ | the point of the whole thing |
| POST | `/api/bots/:id/interrupt` | ✓ | ✓ | the brake; must be reachable from a phone |
| POST | `/api/bots/:id/read` | ✓ | ✓ | **use this, not `PATCH /api/bots/:id`** (T14) |
| POST | `/api/bots/:id/always-allow` | ✓ | ✓ | answering an approval — *the* mobile use case |
| POST | `/api/bots/:id/messages/:mid/edit` | ✓ | ✓ | |
| POST | `/api/bots/:id/active-branch` | ✓ | ✓ | |
| POST/PATCH/DELETE | `/api/bots/:id/tasks(/:tid)?` | ✓ | ✓ | 4 entries |
| PATCH | `/api/bots/:id/profile` | ✓ | ✓ | harness rejects fields outside identity/avatar/notifications/voice |
| POST | `/api/bots/:id/avatar/generate` | ✓ | ✓ | cosmetic |
| POST | `/api/groups` | ✓ | ✓ | |
| POST | `/api/groups/:id/messages` | ✓ | ✓ | |
| POST | `/api/groups/:id/read` | ✓ | ✓ | |
| POST/PATCH/DELETE | `/api/groups/:id/tasks(/:tid)?` | ✓ | ✓ | 4 entries |
| GET | `/api/threads/:id/messages` | ✗ | ✗ | **the React app never calls it** — transcript arrives via the `/api/events` snapshot + `GET /api/bots`. Drop with iOS |
| GET | `/api/threads/:id/messages/:mid/image` | ✓ | ✓ | |
| POST | `/api/threads/:id/messages/:mid/reactions` | ✓ | ✓ | |
| GET | `/api/threads/:id/export` | ✓ | ✓ | **no visibility check in the harness** (`index.ts:6149-6189`) — gated only by knowing a thread id |
| POST | `/api/threads/:id/respond` | ✓ | ✓ | |
| GET | `/api/search` | **✗ REMOVE NOW** | ✓ after B6 | unscoped grep, verified live with `?q=e` |
| POST | `/api/attachments` | ✓ | ✓ | image-only, 10 MB harness cap |
| GET | `/api/attachments/<name>.(png\|jpe?g\|gif\|webp)` | ✓ | ✓ | pattern is `[\w-]+`; **the app builds this path with `encodeURIComponent(name)`**, so some names will 404 |
| POST | `/api/files` | ✓ | ✓ | 25 MiB, generated filename, retry-safe on `uploadId` |
| GET | `/api/tts/voices` | ✓ | ✓ | labels; never touches the key |
| POST | `/api/tts/speak` | ✓ | ✓ | |
| GET/POST | `/api/routines`, PATCH/DELETE `/api/routines/:id`, POST `…/run` | ⚠ | ⚠ | **5 entries. `runOn:"cloud"` reaches `box.provisionBox` around the computer denial** — decision D5 |
| GET | `/api/connectors/catalog`, `/connected`, `/api/connectors` | ✓ | ✓ | 3 entries; opaque ids and aliases |
| POST | `/api/connectors/:slug/authorize` | **✗ REMOVE NOW** | ✗ | binds a Google account to this machine from a phone |
| POST | `/api/bots/:id/computer/join` | ✓* | ✓* | *only behind per-device `cloudDesktopAccess` (`devices.ts:345`), off by default |

**Browser-only additions (`BROWSER_SHELL` + `BROWSER_EXTRA`)** — none reachable from the device
surface, pinned by the B1 test:

`GET /`, `/index.html`, `/assets/<hash>.(js|css|woff2|svg|png|json)`, `/app-icon.svg`,
`/manifest.webmanifest`, `/sw.js`, `/icons/murage-(180|192|512).png`, enumerated SPA deep links;
sidecar-terminated `GET /enter`, `POST/GET/DELETE /session`; plus the reads the web app needs and
the iOS-derived list lacks: `GET /api/groups`, `GET /api/bots/:id`, `POST /api/bots/:id/respond`,
`DELETE /api/bots/:id/queue/:id`, `POST /api/groups/:id/interrupt`, `GET/PATCH/DELETE
/api/groups/:id`, `POST /api/groups/:id/setup`, `GET /api/bots/:id/memory` (+ `/topics/:name`),
`POST /api/tts/prepare`, `POST /api/routine-runs/:id/(cancel|seen)`, `/api/bots/:id/cards/:mid`.

Note the plan's own route delta was ~2× under; the list above is the audited version. Three
entries it proposed are **rejected**: `PATCH /api/bots/:id` (T14), `GET /api/section-context`
(its only caller `TeamMapPage` is excluded from mobile — an allowlist entry for a surface you
excluded is surface for nothing), `POST /api/subscribe` (a marketing call with no phone use).

**Undecided and needing an owner:** `SecretRequestCard.tsx` (`POST /api/bots/:id/secret-cards/:mid`)
and `ConnectorCard.tsx` (`/connector-cards/:mid`) render inside the shipping transcript and appear
in no plan. Whether a paired browser may answer a bot's request for a credential is a decision
nobody has made.

**Permanently denied, no surface:** `PATCH /api/instances/:id`, `POST /api/cli-test`,
`GET /api/cli-candidates`, `PUT|PATCH /api/config`, `/api/webhooks*`,
`DELETE /api/connectors/:slug/accounts/:id`, `/api/bots/:id/secret-cards/*` (pending the above),
`POST|DELETE /api/bots/:id/skills*`, `PUT /api/section-context`, `PATCH /api/groups/:id/setup`,
`PATCH /api/bots/:id`, `DELETE /api/bots/:id`, `DELETE /api/groups/:id`, `/api/local-computer*`,
`/api/bots/:id/computer/(provision|exec|sleep|screenshot|remove|control|viewer-close)`,
`/api/bots/:id/checkpoints/restore`, `/api/teams/(import|export|scout)`, `/api/team-library/*`,
`/api/internal/*`.

---

## 7. Decisions Sean must make

**D1 — `/api/events` visibility. Blocking. Recommend: scope `broadcast()` per client.**
Today every SSE client receives every message on every thread (verified, §0b). Three options:
(a) add a per-client thread filter in `broadcast()` keyed on `store.visibleThreadIds()` — ~8–14 h,
keeps the phone's live transcript working, and is the only option that makes T12 honest;
(b) drop `/api/events` from both companion surfaces — cheap, but it is the app's spine
(`src/lib/live-events.ts:9,110-118`) and the phone would need a polling path;
(c) accept it and downgrade T12 in writing. **My pick is (a).** It is the difference between
"the phone can read what you'd let it read" and "the phone can read everything."

**D2 — Global search on the phone: ship it scoped, or not at all?**
Cheapest correct answer is find-in-conversation only (require `threadId`), which ships the useful
half and drops the exposure. **Recommend: remove the route now (A1), re-add it scoped in B6** —
retirement is the one moment removal costs nothing.

**D3 — The `hosted` / cloudflared stack: delete or de-prioritise?**
`endpoints.ts:71` ranks a public HTTPS route at priority 0, **ahead of** tailnet at 100
(proven). Under decision 1 that is backwards. **Recommend: delete the `hosted` kind entirely**,
in its own commit before the browser door — it is the only remaining path by which Murage becomes
internet-reachable, and it frees port 8812 so the browser door could use it after all. It touches
`cloudflare/control-plane/`, `electron/companion-account-service.mjs`,
`electron/managed-companion-{tunnel,guardian}.mjs`, `scripts/prepare-cloudflared.mjs` and two
`package.json` scripts — bigger than it looks, ~10–14 h, and worth it.

**D4 — Enable Tailscale HTTPS Certificates?** `CertDomains: null` today (re-verified). Enabling
it is one click in the admin console and upgrades the session cookie to `__Host-`/`Secure` with
no code change, and is a hard prerequisite for the PWA half. **Recommend: enable.** Then say
whether you want `tailscale serve` terminating TLS (simplest; renewal is Tailscale's problem) or
Node terminating with `tailscale cert` output (one fewer hop). I could not verify what headers
`serve` forwards — specifically whether the original `Host` survives, which the origin gate reads
— without changing machine state.

**D5 — Routines with `runOn: "cloud"` from a phone: allow or deny?**
`POST /api/routines` and `…/run` are allowlisted today, and `server/routines.ts` accepts
`runOn: "cloud"` with no capability check, reaching `box.provisionBox` — the same call the denied
`computer/provision` route makes. **Recommend: gate `runOn:"cloud"` behind the same per-device
`cloudDesktopAccess` flag** rather than removing routines, which are a genuine mobile use case.

**D6 — Chief of Staff `approvePeerComms`: once per chain, or once per hop?**
The plan flips it on by default at workspace-chief promotion. Once per hop is safer and probably
unbearable at depth 2. Note this interacts with E3: as currently specified, promoting Ember routes
every one of her peer actions through three unfixed post-approval gates and they fail 100% of the
time, two of them silently.

**D7 — Cloud track: schedule it, or shelve it?** It works, and it is 40–65 h that buys nothing
Sean cannot get today from `ssh -L`. **Recommend: shelve until Phases A–C ship**, then revisit.

**D8 — Subscription CLI terms.** Running a subscription `claude`/`codex` unattended on a cloud VM
may be outside consumer terms. Flux/BYOK has no such ambiguity and is proven working headless.
Not an engineering question; read the terms before making the box a subscription workhorse.

---

## 8. What is still unproven, and what must be tested before shipping

**Unproven — nobody has run it:**

1. **The browser door's `/api/events` registration with `connectedDeviceTracker`.** The security
   plan specifies the requirement and admits it was never prototyped. Without it, revoking a
   device leaves the browser's live stream running — the one revocation lever the design claims
   comes for free. **Prototype before committing to B4.**
2. **`Sec-Fetch-Site` under Safari's service-worker and back-forward-cache requests.** Every
   measurement was Chromium. The gate is fail-closed, so a miss is loud rather than silent, but it
   will look like the door is broken on first load.
3. **What `tailscale serve` forwards.** Neither the original `Host` nor the presence of
   `Tailscale-User-*` identity headers was verified — that would have meant mutating Sean's
   tailscale state. Those identity headers are, under a tailnet-only threat model, a stronger and
   cheaper primitive than the session cookie and should at least be evaluated before B4 is written.
4. **`tailscale ssh -L … -N` on a current tailscaled.** Historically prohibited (tailscale#5091),
   fixed by PR #5865. The entire cloud admin channel rests on it. Also: `tailscale up --ssh`
   intercepts port 22, so the fallback has to be a non-22 sshd.
5. **Whether the Cua container actually provisions on a Linux VPS.** The pinned image
   `docker.io/trycua/xfce-cua@sha256:274eb63…` is confirmed multi-arch (amd64 + arm64), so it will
   pull; it has never been run there.
6. **The exact CSP the shipped bundle tolerates.** `crossorigin` module scripts plus shiki dynamic
   imports; whether `script-src 'self'` suffices and whether `style-src` needs `'unsafe-inline'`
   for Tailwind's injected styles needs measuring against a real build in a real browser.
7. **The iOS software keyboard.** Chromium's `visualViewport` never shrinks for a keyboard, so C4
   cannot be regression-tested in CI. The inset math and a synthetic-resize assertion are testable;
   the real behaviour is one manual test on Sean's phone and then it stays untested.
8. **Whether any App Store Connect record exists that needs withdrawing.** Off-repo state.

**Must be tested before shipping — write these tests:**

- The `Surface` pinning test: every `BROWSER_SHELL`/`BROWSER_EXTRA` entry returns non-null from
  `denyReason({…, surface: "device"})`. This is load-bearing, not optional.
- A test asserting the browser door's bind host equals the address `tailscale status --json`
  reports, **with no fallback branch in the code**. The security plan names this test and never
  sequences it.
- A test that the two servers do not share a request listener — compared against **both**
  `companion` and `managedOrigin`, unconditionally. The plan's version is skipped entirely when
  `PRIVATE_ORIGIN` is unset (the default) and never compares against `companion`, which is the
  listener that both shares `proxy` and binds `0.0.0.0`.
- `searchMessages` with `threadIds: []` returns `[]` — never "no restriction".
- SW offline: load, go offline, reload, assert `#root` has children. This is the test that would
  have caught the measured brick.
- SW version: two builds produce two `CACHE_NAME`s.
- CoS Test 2 and Test 3 from the plan (`delegate_bot` from a room delivers into the room;
  `check_delegation` returns done). They fail today **and** after the plan's own steps 0+3 — they
  are correct tests of an incorrect plan, and running them would have found the drain bug.
- A CoS room+comms harness in `server/comms.test.ts`. The file has 25 `it(` blocks and **zero**
  occurrences of `api/groups`; no group is ever created in it. That is a day of rig work before
  the first assertion, and it is not in the plan's estimate.
- `E6` only: `delegate_room` refuses a visited room; `chainDepth` survives a connector resume;
  `chainDepth` survives a harness restart mid-chain; `MAX_CHAIN_TURNS` actually terminates a
  fan-out. Zero tests are currently specified for the one step the plan says can burn tokens
  without bound.

**Stale citations — re-anchor before anyone edits by line number.** Every `server/index.ts`
reference in the security, PWA and cloud plans is wrong; `server/index.ts` was modified after they
were written. The substance holds at the real lines; the anchors do not. Verified current values:
`STATIC_DIR` `:247`, MIME map `:248-256` (no `.webmanifest`), `isLoopbackHost` `:5078` with the
gate at `:5120`, static branch `:8724-8741`, SPA fallback `:8732-8739`,
`server.listen(PORT,"127.0.0.1")` `:8752`, `MAX_COMMS_DEPTH` `:325`, `runGroupMemberTurn` `:3415`,
agents gate `:3474-3475`, room dispatch `:4190`. Offsets are not constant, so this is not one
rebase. Citations into `companion/`, `src/`, `store.ts`, `delegations.ts` and `message-db.ts`
checked out exactly.
