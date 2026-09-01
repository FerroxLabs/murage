# Murage — session handoff

**Updated:** 2026-09-02, ~00:30 · **Branch:** `upstream-apply-test` · **main:** `a3154a62`
**Repo:** `github.com/FerroxLabs/murage` · **Local:** `/Volumes/Mando/WaylandBots/murage-app`

Murage is Ferrox Labs' multi-engine AI agent desktop app. Hard fork of
[OpenMausBot](https://github.com/milind-soni/OpenMausBot) (Apache-2.0) at `6140532`, rebranded,
carrying the Wayland teams/skills library.

**Sean is asleep.** This handoff is written so the work continues without him.

---

## THE PROTOCOL — Sean set this explicitly, follow it exactly

> plan → cross-audit the plan → build → test → cross-audit **once** → fix **Critical and High only**

"Once" is the point: one audit pass after execution, then stop. Do not loop on Mediums and Lows —
log them as follow-ups and move to the next item. This is what stops an audit spiral eating the night.

## BACKGROUND WORK STILL RUNNING AT HANDOFF

| What | Where |
|---|---|
| Master-plan agent (11th of the planning swarm) | writes `MURAGE-UNIVERSAL-CLIENT-PLAN.md` to the scratchpad below |

**Scratchpad** (ephemeral — copy anything valuable into the repo):
`/private/tmp/claude-501/-Volumes-Mando-WaylandBots/4536dffe-6a1e-4570-b329-01008562e207/scratchpad/`

Workflow run ids, for `Workflow({scriptPath, resumeFromRunId})`:
- planning swarm `wf_80de03f5-c76` — 5 plans + 5 audits done, master plan running
- upstream port `wf_c1c78727-d07` — complete, merged
- PWA precedent research `wf_1f0e0bf0-2e9` · CoS research `wf_3a5c06f1-a22` · Android brief `wf_ef508d1e-052`

**When the master plan lands:** `cp` it into `docs/plans/universal-client/` and commit. It is told to
resolve every audit finding above, so if it contradicts one, trust the audit — the audits ran the code.

## AUTONOMY BOUNDARIES while he sleeps

**Do freely:** write code on branches, run tests, run workflows, commit to feature branches, write
plans, read anything.

**Do NOT without him awake:**
- Push to `FerroxLabs/murage-teams` (the live catalog every user's library panel reads)
- Publish a GitHub release, or run the Release workflow
- Delete bots, rooms or anything under `~/.murage` (there are backups from the cleanup:
  `~/.murage/bots.json.bak-20260901-224927`)
- `git push --force` anything, or push to `upstream` (its push URL is already set to `no_push`)
- Change anything in `~/dev/smarttrader` (unpublished IP — read-only reference, never into this repo)

**Merging `upstream-apply-test` → `main` is fine once its audit reports SOUND.** That was the
approved step 1.

---

## START HERE — the overnight queue, in order

### 0. Land the upstream port  — **DONE, merged to `main`, pushed** (`294f833a`)

Five commits from upstream plus one fixing the three High findings its audit raised. Audit verdict
**SOUND_WITH_CHANGES, no Critical, 8/8 mutations caught** — including reverting the vendored updater
bundle to upstream's behaviour, which was the stated risk. The auditor also re-ran the bundler and got
a byte-identical artifact, so the committed vendor file is genuinely generated, not hand-edited.

Not yet proven, and it needs a real Linux box: that `sudo apt-get install '<quoted .deb>'` installs on
clean Ubuntu 24.04 and resolves the `libgtk-3-0t64` virtual-Provides chain, and that a real
differential AppImage download leaves exactly one file at the launched path. Everything else was
proven by mutation on this filesystem.

### 1. Chief of Staff hierarchy  — plan done, audit pending

Plan: `docs/plans/universal-client/plan-chief-of-staff.md`

**The load-bearing claim is PROVEN, live, not read:** a room turn gets the agents integration at
hop 0 — `MURAGE_TURN_DEPTH=0` in the injected MCP env. So Sean's model runs as **two hops of
depth-1**, and `MAX_COMMS_DEPTH` never has to move.

```
you → Ember (her DM, hop 0)
Ember posts in the exec room → a lead answers (hop 0, fresh room turn)
  → lead delegates to a team member (hop 1)
```

Both blocking bugs reproduce:
- `ask_bot` from a room returns the literal `source thread does not belong to sender`
  (`server/index.ts:5292`, `:5448` — siblings at `:4266-4273` use `connectorThread`, which handles groups)
- `store.botByThread(roomThread)` is undefined, so a delegation launched from a room completes and
  its result is **silently dropped** (`server/index.ts:2126`)

Also: `chiefOfStaff` is one-per-**section** (`store.ts:1318-1324`), so it is a per-team role today.
Ember has `section: null`, and her live prompt literally reads *"No other visible bots are available
yet."* Seven gates enforce the section filter — all enumerated in the plan.

**Constraint:** `pkg.chiefOfStaff` is in the published bot-package format and **122 live catalog
entries carry it**. Change the concept, not the wire field.

Do this first after the merge. Smallest, highest daily value, blocks nothing and is blocked by nothing.

### 2. Security architecture — the browser door

Plan: `docs/plans/universal-client/plan-security.md` (65KB, the keystone; everything else depends on it)

Fixes `/api/search` whether or not a PWA ever ships — see **Live security issues** below.

### 3. PWA + responsive UI

Plan: `docs/plans/universal-client/plan-pwa-ui.md`

### 4. Onboarding rework — the WebUI toggle

Plan: `docs/plans/universal-client/plan-addendum-onboarding-webui.md`

Sean's ask: the onboarding step that offers to install the iOS app becomes the **security** step —
*"connect a phone or another device?"* and separately *"enable the web UI at all?"*, off by default,
Wayland-style. The slot already exists (`Onboarding.tsx:349` renders `PhoneSetupFlow`).

Keep the two questions separate. Enabling the door ≠ pairing a key.

### 5. iOS retirement

Plan: `docs/plans/universal-client/plan-ios-retirement.md`

**iOS is a leaf.** 130 files, 4.2 MB, and exactly **two** references from the rest of the repo: a
comment in `companion/test/routes.test.ts:36` and an OUT path in `scripts/capture-companion-fixtures`.
The companion sidecar and its pairing must survive — they are the foundation of the PWA plan.

### 6. Cloud / headless — conditional, and the condition passed

Plan: `docs/plans/universal-client/plan-cloud.md`

**I was wrong to bet against this.** Headless is real: harness and sidecar are plain Node with zero
Electron imports, and the shipped esbuild bundle runs standalone under `env -i` with empty `HOME`,
no `node_modules`, no Electron — proven. Electron owns only the desktop shell, and every piece of it
degrades to "unavailable" rather than crashing (`server/index.ts:270` already treats
`process.parentPort` as optional).

Engine auth is **not** fatal: `claude` accepts `CLAUDE_CODE_OAUTH_TOKEN`, `codex login --device-auth`
exists, and **Flux Router redirects all three engines with env vars alone — proven end-to-end.**

Recommendation in the plan: systemd on a box you own, not Docker.

**One real question for Sean, flagged not buried:** whether running a *subscription* CLI unattended
on a cloud box is within Anthropic's Consumer Terms. Flux/BYOK has no such ambiguity. He should read
the terms before making the cloud box a subscription workhorse.

---

## PLAN AUDITS — all five landed. **Read this before building anything.**

Verdicts: **4 SOUND_WITH_CHANGES, 1 BROKEN.** The audits ran the code rather than reading it, and
several critical findings contradict their own plan. The master-plan agent (11th in the swarm) was
still running at handoff; when it lands, **copy it out of the scratchpad into
`docs/plans/universal-client/` — `/private/tmp` does not survive.**

Workflow run id for resume: `wf_80de03f5-c76`.

### PWA + responsive — **BROKEN**. Do not build from it as written.

- **The service worker bricks the app offline — measured, not argued.** The plan merges AionUi's
  `networkOnlyWithTypeGuard`, which opens with a bare `fetch` and has no catch and no `cache.match`
  fallback (`aionui/public/sw.js:120-137`). Offline, it throws instead of serving the cached shell.
- **The cache version never changes between builds.** §1.6 stamps `package.json`'s version into
  `__MURAGE_SW_VERSION__` and claims "a stale bundle cannot outlive a release" — but the version is
  `0.1.44` and `"build": "tsc -b && tsc -p tsconfig.server.json && vite build"` never touches it.
- **`PATCH /api/bots/:id` is an execution-policy escalation.** The plan wants it for an unread flag;
  `companion/src/routes.ts` matches method+path regex only, with no body filtering, so allowlisting it
  grants every field on the bot record.
- `tailscale serve --https=443` publishes to **every node on the tailnet**, and the plan budgets a
  listener with no authentication while deferring the credential to the security track.
- **Better primitive the plan missed:** Tailscale Serve injects `Tailscale-User-Login` /
  `Tailscale-User-Name` identity headers on proxied requests. Under a tailnet-only threat model that is
  stronger and cheaper than the cookie it proposes.

### Chief of Staff — SOUND_WITH_CHANGES. Hop-0 claim independently reproduced.

- **A room-sourced `delegate_bot` is SILENTLY DELETED, not merely undelivered.**
  `server/delegations.ts:311-316`: `const from = bus.store.botByThread(threadId); if (!from) {
  pendingDelegations.delete(threadId); savePending(); return; }`. Worse than the plan assumed.
- **There is an EIGHTH section gate** the plan missed: `server/index.ts:5206`, the routine
  proposal-time check on `for_bot_id`. The plan's gate 6 is only the other half.
- Post-approval re-checks at `server/index.ts:5386` re-validate section equality, and the plan's own
  blast-radius mitigation routes every workspace-chief action straight into them.
- `canReach` is **not** a strict superset, so "gates 1-7 are behaviourally inert until a workspace
  chief exists" is false — four of the seven have no `hidden` check today.
- A peer-approval card in a room thread can never be settled after a crash:
  `server/peer-approval.ts:186-204` never visits a group thread.

### Security — SOUND_WITH_CHANGES. Two findings invalidate parts of the design.

- **Port 8812 is ALREADY the cloudflared tunnel origin** (`electron/companion-origin-gateway.mjs:12`).
  The plan puts the browser door there. That is the Wayland bug shape — pick another port.
- **Fixing `/api/search` does not close the hole, because `/api/events` is an unfiltered firehose.**
  `server/index.ts:1087-1090` broadcasts every persisted message as an SSE frame, by construction.
- **"Tailnet-only" can silently become a LAN bind.** `companion/src/listener.ts:62-68` matches
  `100.64-127.x` over the machine's own interface table — right range, wrong trust assumption.
- Routines are a hole in the computer-provision denial: `POST /api/routines` is granted while
  `computer/provision` is denied, and a routine can drive one.
- `POST /session` hands an unauthenticated tailnet peer a **permanent pairing DoS** — it reuses
  `devices.redeem`, which decrements `MAX_PAIRING_ATTEMPTS = 5` on every call.
- No `X-Content-Type-Options: nosniff` on the static branch; measured live.

### Cloud / headless — SOUND_WITH_CHANGES. One finding matters a lot.

- **THREE engines lie about auth, not one.** With `HOME` and `MURAGE_DATA_DIR` pointed at empty scratch
  dirs, `/api/instances` reported `authenticated: true` for **opencodeGo, qwen and hermes**.
  `claudeSignedIn` (`server/drivers/claude.ts:55-70`) trusts `claude auth status --json`'s `loggedIn`
  field, which reports **presence, not validity**. Any health check built on it is worthless.
- Local VM sizing is a hard constant, not an unknown: `server/container-computer.ts:60-61` pins 4 GiB
  and 2 CPUs, and `dockerSecurityIsHardened` REQUIRES it — this kills the plan's "better headless" claim.
- The plan rejects Docker because the `docker` group is root-equivalent, then puts the `murage` user in
  the docker group. Self-contradictory.
- The credential migration story is missing and blocks day one.

### iOS retirement — SOUND_WITH_CHANGES.

- **Removing `GET /api/search` from the allowlist lands CI red**: `companion/test/routes.test.ts:71`
  asserts it. The plan edits only line 36 of that file.
- `companion/` is **not** iOS-free as the plan claims — `companion/src/control.ts:151-153` encodes an
  iOS-only policy.
- The salvage list commits the irreversible mistake the plan's own risk #2 names: it copies out only
  `Sources/CompanionCore` and skips ~15 files under `ios/App/` and `ios/ShareExtension/` it had itself
  identified as reference material.
- Disproven risk (good news): `main` is **not** a protected branch, so removing the iOS CI job cannot
  strand PRs on a required status check.

---

## Decisions Sean has made — do not relitigate

1. **Threat model: single-user, TAILNET ONLY.** No public ingress, ever. Not multi-tenant.
2. **iOS is retired NOW**, before the PWA lands. Zero published releases, so nobody is stranded.
3. **Android is not adopted.** Deferred with a named trigger (see below).
4. **Plan first, cross-audited, then build.** He reviews before code where the plan is new.
5. Order: Chief of Staff → security → PWA → onboarding → iOS retirement → cloud.

---

## LIVE SECURITY ISSUES — found tonight, not yet fixed

**1. `/api/search` is unscoped and allowlisted for paired devices.** Proven live with an
unauthenticated curl: it returned Ember's private DM *and* Bruce's trading thread in one response.
`server/index.ts:6069` sits outside the `/api/internal/` token gate; `server/message-db.ts:196` shows
no `threadId` means an unrestricted scan across every thread, every bot, every branch. It is also
allowlisted in `companion/src/routes.ts:102`, so **the shipped iOS pairing token is already a
full-transcript grep tool.** Loopback-only today, so it is not an emergency — but it becomes the
front door the moment anything is tunnel-reachable. Fix in step 2.

**2. RCE in two requests if the full UI is ever served remotely.**
`PATCH /api/instances/:id` (`server/index.ts:8073`) sets the CLI binary used for every later turn;
`POST /api/cli-test` (`:8051`) spawns a caller-supplied path. Both gated only by a
`content-type: application/json` check whose own comments say it is anti-CSRF for a loopback server —
a same-origin fetch passes it trivially. Both are currently 404'd by the companion allowlist, and
that allowlist is **the entire boundary**: `companion/src/proxy.ts:7-13` says the sidecar speaks to
the harness as itself, satisfying the loopback gate by construction.

**3. Filed against Wayland (not Murage):**
`~/dev/wayland/docs/bugs/2026-09-01-webui-exposed-by-webhook-tunnel.md`. Its webhook tunnel runs
`tailscale funnel` (public internet) against the port that also serves its WebUI, and the tunnel
**bypasses its own loopback binding** — an operator who correctly left remote access off is still
fully exposed. Marked unconfirmed; someone on that team should enable the opt-in and fetch `/`.

---

## What shipped tonight, verified

| | |
|---|---|
| Skill descriptions | fixed in the **parser**, not the converter — 2,237/2,237 parse with real text |
| Packaged skills | `skills-library` now ships in builds; `MURAGE_SKILL_LIBRARY` was referenced exactly once in the whole repo (its own declaration) and set by nobody |
| 57 profiles | live on `murage-teams` beside the 65 teams; Smart Trader carries its 11 tvcontrol skills |
| The 32 missing skills | 8 profiles were shipping half-empty (`coin` declared 11, installed 3) |
| Skills panel | on the Agent profile; 40 tests, up from 14 |
| Catalog cap | 122 entries exceeded a hard limit of 100 — `parseTeamCatalog` **throws**, so it would have emptied the whole library panel |
| Team import | "Replace team" removed entirely — it was the default *and* the primary button |
| Markdown leak | package blurbs rendered `**bold**` literally; 38 of 57 profiles carry markdown there |
| Docs rebrand | every download button, clone URL and "Edit on GitHub" link pointed at an account we don't own |

**Test suite: 2,899 pass / 4 fail this morning → 2,982 pass / 1 fail now.**

---

## THE CONTRACT SPLITS — now at twelve. Assume a thirteenth.

The rebrand keeps renaming one side of an identifier and not the other. Every one was found by
something breaking, except the twelfth.

Schema id · catalog format string · `HERMES_OPENMAUS_*` · team-library URL · update-feed owner ·
SBOM property · DEB maintainer · a sha256 fixture · `runOn: maus` · the credential list (twice) ·
**#11** the docs site's download/clone/edit links · **#12** `window.__ombBrowser`

**#12 is the instructive one.** `rebrand.sh` *excludes* `third_party/`, so `entry.ts` wrote
`window.__ombBrowser` while `browser-surface.cjs` probed `window.__murageBrowser` in eight places.
It stayed hidden because the committed bundle had been **sed-rebranded after generation** — shipped
bytes said one name, the source they came from said the other. Anyone re-running
`build-browser-snapshot.mjs` would silently regress `ensureInjected()` to permanent false: no rich
snapshot, `validateRef`/`hitTestRef`/`boxForRef`/`focusRef` all dead, no error. There is now a guard
test that reads both files and asserts the globals match.

**Why the existing tests could not catch it:** the surface tests stub the CDP call by matching the
reader's own string, so both halves drift together and stay green. Watch for that shape elsewhere.

**Sweep for identifiers another process reads, separately from cosmetic renaming.**

---

## Known follow-ups (Medium — do not let these block the queue)

1. `server/remote-computer.ts:66` — `if (elements.length >= 250) break;` with no truncation signal.
   The same lie `4b71b204` exists to remove, on the remote-box path. Upstream never touched it.
2. Release digest verification was **deliberately weakened** — GitHub computes asset digests
   asynchronously, so upstream's strict check would fail a good release. A missing digest is now a
   notice, not a failure. Reasonable; Sean may want it tightened.
3. Delete residue: deleting a bot leaves `~/.murage/workspaces/` folders and `messages.db` rows.
   Deliberate (it keeps cleanup reversible), but **nothing owns reconciling the three stores**, which
   is why the app cannot clean itself and an external script had to.
4. `book-publishing-house` — 1 of 60 teams still skipped.
5. Two Quiet Money rituals dropped — `RoutineSchedule` is only `once|daily`.
6. Cloudflare account is not a Ferrox account.
7. Composio ceiling built, not deployed (`wrangler deploy` needs Sean's token).

---

## Android — DEFERRED, with a named trigger

44 of upstream's 59 commits. **Do not adopt.** `android/core` is a hand-written second copy of the
Swift CompanionCore — no generator, no IDL; parity is maintained by prose comments citing Swift line
numbers, and it fell behind **four times in three weeks** inside one repo.

It is also pre-loaded with contract split #13: `Connection.kt:409` checks
`token.toByteArray().size != 52`, where `52 = 9 + 43` for `"omb_pair_"`. `"murage_pair_"` is 12 chars,
so the constant must become **55**. Rename the string, leave the number, and every valid QR pairing
code is rejected. Nothing fails to compile.

Deferring is free: exactly **one** Android commit touches anything outside `android/` (a `.gitignore`
line). No security defect was found — the three flagged dissolved into faithful ports of Murage's own
iOS design.

**Flips to adopt:** a commercial Android commitment, someone who owns Kotlin/Compose/Gradle, or the
channel layer slipping a quarter. **Flips to hard skip:** upstream abandoning it — watch `07b7e50c`
(maintainer, empty commit body, −930 lines, deletes a 354-line test file).

---

## Running it

```bash
nvm use 24
node --experimental-strip-types server/index.ts &   # :8799  (webhooks :8800)
npx vite &                                          # :5199
npx electron .
```
Order matters. Electron's `DEV_URL` defaults to **5199** and gives up fast; a stale vite squatting on
5199 gets loaded instead of yours. Check `lsof -nP -iTCP:5199 -sTCP:LISTEN` and confirm its cwd before
starting a second one — agents have left strays.

---

## Gotchas that cost real time

- **`npx tsc` reports SUCCESS when `node_modules` is missing** — it resolves nothing and exits clean.
  A worktree without deps gives a false green. Confirm deps exist before trusting any typecheck.
- **Workflows using `isolation: 'worktree'` can silently skip agents.** One reported "completed" with
  an audit that never ran (`Cannot create agent worktree: not in a git repository`, because the shell
  cwd had reset to a non-repo parent). **Check `agents_done` against what you expected before trusting
  a verdict.**
- **The shell cwd resets to `/Volumes/Mando/WaylandBots`**, which is not a git repo. `cd` into
  `murage-app` at the start of every command.
- **zsh does not word-split unquoted parameters.** `for f in $FILES` over a multi-line string iterates
  once, over the whole blob. Cost a silent no-op tonight.
- A **v2 team manifest deliberately creates no room**. Bot packages do. Use packages.
- **Chromium honours EITHER `scrollbar-width` OR `::-webkit-scrollbar`, never both.**
- **`win.publisherName` does not exist in electron-builder 26** — it lives inside `azureSignOptions`,
  and a stray one fails the config for every platform. Validate against
  `node_modules/app-builder-lib/scheme.json` locally; a CI round trip to learn a field name costs 8 min.
- Signature gates must allowlist vendor signers — we bundle `cloudflared.exe`, signed by Cloudflare.
- Dev Electron is `com.github.Electron`, unsigned; macOS cannot attribute permissions to "Murage"
  until it is the packaged signed app.

---

## Live infrastructure

| | |
|---|---|
| Releases | `FerroxLabs/murage-releases` (public, **zero releases so far**) |
| Teams | `FerroxLabs/murage-teams` (public, 122 catalog entries) |
| Composio broker | `murage-composio.patient-meadow-1a11.workers.dev` |
| Cloudflare acct | `b83123326a4b9ad76831b9cb9365b33b` (admin@imsuccesscenter.com — **not Ferrox**) |
| Azure signing | `ferrox-labs-signing` / profile `ferroxlabs` / eastus, validation Active |
| Apple | Team `PX6SP9GPWJ`, Developer ID cert on this machine, API key verified |

**Release:** macOS green (signed, notarized, stapled), Windows green (Azure Trusted Signing), Linux
was failing at the in-place DEB upgrade — `f7c0d815` is the fix, not yet exercised on Linux CI.
