# Murage — session handoff

> **Read this section, then §NEXT. Everything below `--- HISTORY ---` is the
> record of earlier sessions and is not a to-do list.**

## THE PROTOCOL — Sean set this explicitly, follow it exactly

For every item in §NEXT:

1. **Research it properly.** Verify every claim against the code before planning
   on it. This repo has produced *nine* cases where measurement contradicted a
   written plan. Assume the same until you have checked.
2. **Cross-audit the plan** before building — independent agents, different
   angles (feasibility · experience · local-first & security). One generic
   reviewer finds one class of problem.
3. **Execute.**
4. **Cross-audit the result, ONCE.**
5. **Fix only Critical and High.** Record Medium and Low; do not fix them.

**Swarm it.** Parallel subagents on strictly disjoint files. That is not
optional flavour — it is the only thing that made the last two sessions fast.

## LANE DISCIPLINE — this cost real time twice, do not relearn it

- **Assign every agent an explicit file list, and an explicit forbidden list.**
  Two agents in one file produced duplicate imports and a silently-clobbered
  288-line change.
- **Agents never run a git command that writes.** The orchestrator commits, by
  explicit path, after checking `git diff --cached --name-only` for strays.
- **After adding a file, re-run the suite for the lane you touched.** A commit
  shipped red because the server suite was run after a *renderer* test landed.
- **A workflow whose `.output` file is 0 bytes is RUNNING, not dead.** Check
  with `TaskStop`/`TaskOutput`, never file size. Believing otherwise started
  the collision above.
- **Negative-control every test**: make it pass, revert the production change,
  confirm RED, restore, report per test. Several controls have come back GREEN
  and been rewritten — that is the discipline working. A test nobody has seen
  fail is not a test.

## STATE — everything is committed and pushed to `main`

Suite **3224 passed / 1 failed**. The one failure is `server/control-murage.test.ts`,
environment-only: it hardcodes `["claude"]` and this machine has a real `qwen`
on PATH. All four gates exit 0 — `tsc -b`, `tsc -p tsconfig.server.json`,
`tsc -p tsconfig.companion.build.json`, `node scripts/check-skin-contrast.mjs`.

Landed this session, newest first: light-theme surface inversion · the usage
meter · the light-mode wordmark · **the local skill-install route** · Composio
through the broker · the library state lift · FTS search over 2,237 skills ·
local-first catalog (122/122 offline) · stale skills copy + un-dismiss · the
three-tier org model.

---

## NEXT — in this order

### 1. Skill assignment, both directions — START HERE, fully unblocked
Sean's design: **one action, two entry points.** From the library, pick a skill
→ "Assign to agent". From an agent's Skills panel, "Add a skill" → opens the
browser with that agent already chosen. Both collapse to `assign(skillId, botId)`.

Everything it needs now exists:
- `POST /api/bots/:id/skills/library` (`server/index.ts`, commit `2dab7893`) —
  desktop-surface-only, bounded at 25, traversal-gated, records provenance as
  `library:<id>@<version>`, arrives enabled.
- `showTeamLibrary` action + `state.teamLibrary.botId` (`97f507f0`).
- `TeamLibraryPanel` already accepts `preselectedBotId` and `SkillRow` already
  has an action slot rendering nothing.
- `BotSkillsPanel` needs `onBrowse?: () => void` — a 4-line change the copy
  lane described precisely and deliberately left out.

**Constraints.** No right-click-only affordance — `Sidebar.tsx` exposes its bot
menu solely via `onContextMenu` and iOS fires no `contextmenu` event; that is a
live defect, not a hypothesis. Button says the outcome ("Add to Bruce"), not the
category. With exactly one bot, skip the picker entirely.

### 2. The self-assembling assistant
Plan at `docs/plans/self-assembling-assistant/PLAN.md`. **Three audits rewrote
its sequence — read them before the plan**, in `scratchpad/audit-{feasibility,experience,local}.md`.

The single most important finding: **profile-first, retrieval as fallback.**
Narrowing to a matched profile's own declared skills gave **11/11 correct with
zero noise and no model judgement**, where free search put `car-buying-guide` at
rank 3. That makes the expensive half also the unnecessary half — **~60–85 h
profile-only, not 187**.

Known-broken in the plan as written, all measured:
- **Accept creates a NEW bot** via `/api/teams/import` (`seedMessages: false`)
  and auto-selects it, while the assembled path configures the bot you are in.
  Same button, two outcomes, 5s toast, no Undo. **Decide this first — one
  sentence settles everything downstream.**
- The precision@8 gate is unsound four ways (n=20 → CI ~[0.38,0.82]; undefined
  at variable k; no recall term; mean hides that 3/10 sentences scored ≤50%
  **with junk at rank 1–2**).
- No query sanitiser: **13 of 20 realistic inputs throw** FTS5 syntax errors,
  and natural sentences return 0 rows because the implicit operator is AND.
- The install route takes bare ids with no provenance argument, so §3's
  first-party boundary does not exist in the API. And `delegate_bot` →
  `mirrorExchange` can put agent text in a fresh bot's thread — the intake
  trigger. **An agent must not be able to drive another agent's skill install.**

### 2b. Give the skill-less assistants their skills — Sean's directive idea
**Measured, not assumed: 27 of 57 local profiles declare ZERO skills, and every
one of them has exactly one playbook.** The distribution is bimodal — a profile
has 5–11 skills or it has none. Two authoring styles landed in one library.

`bot-library/builtins/smart-trader.json` is what "good" looks like: 11 declared
skills **plus** an 11,492-char playbook. Note it exists locally and was never
published to the catalog — which is why searching "trading" finds nothing.

**The primary directive Sean wants already exists — it is the playbook, plus the
agent's `title` and `description`. Do not add a field. Make it readable.**

Sequence:
1. **Derive at build time, not runtime.** Feed each of the 27 playbooks through
   the FTS retrieval (`server/skill-search.ts`), take candidates, have a human
   approve once, bake the result into the profile's `skills` array. Deterministic,
   reviewed once rather than per install, zero runtime cost, works offline and on
   a small local model because the matching already happened.
   A playbook is a far richer query than "trading" — the ~50% noise the audit
   measured was on two-word queries. Expect much better, verify anyway, and keep
   the human gate.
2. **Measure the gap, then author.** Some directives will have no match in 2,237
   skills. Find out which before writing any. Authoring speculatively is the
   expensive mistake.
3. **Surface playbooks in the UI — arguably the real bug.** They have NO surface
   anywhere (every `playbook` string in `src/` is preview copy or a delete
   warning; installed ones live only in `server/installed-playbooks.ts`). Even a
   fully-skilled assistant's directive is invisible and uneditable.
4. **Then the runtime version, which is the best one and is now buildable:** an
   assistant that knows its own directive notices a gap and *asks* — "you keep
   asking about options flow, I found two skills, want them?" This is the
   revealed-preference item, and it beats the intake for feeling understood.

Also: **publish smart-trader** so "trading" matches something. Generic prompt and
the 11 published `@ferroxlabs/tvcontrol` skills only — nothing from Rebel Scanner
or REGIME-GATE, ever.

### 3. Phase B — the browser door / WebUI. **Worst current state in the app.**
`PhoneSetupFlow.tsx:1061,1136,1141` still says *"Open Murage on your iPhone"*
and *"Scan with your iPhone"* about an app that no longer exists. Retiring iOS
without B7 left the product advertising a dead thing.

Unbuilt: `companion/src/browser.ts` on **8813** (8812 is taken), sessions with
the credential in the URL **fragment**, registering the browser stream with
`connectedDeviceTracker` so revocation kills it, **B7 onboarding** (two separate
questions: "enable the web UI?" off by default, and "connect a device?"), and
the Tailscale ACL — 5 peers, none today.

**Design change since the plan:** front it with `tailscale serve` rather than a
hand-rolled listener reading cert files. Tailscale then owns TLS *and renewal*.
The cert expires **30 Nov 2026** and Tailscale renews only when something asks;
`serve` asks, a file-reading listener does not. `serve` is tailnet-only —
`funnel` is the public one and Murage must never use it.

### 4. Phase C rows C2 / C6 / C7 — the phone is still half-broken
C6 is the sharpest: **six per-message controls measure opacity 0** at 390px with
`any-hover: hover` false — Copy, Regenerate, Reply, Pin, Speak, Archive. The
entire per-message action set, invisible and unreachable. C7: the bot row menu
and TaskPicker rename are `onContextMenu`-only, dead on iOS. C2: 52 tap targets.
Also queued: sidebar near-alignment (rows x=8 vs x=12, icons x=21 vs x=24) and
the settings nav hiding 6 of 8 sections behind a scroll with no affordance.

### 5. Auto-update — engines and the app, with a release announcement
Sean's ask, OpenMaus-style. Fuigo is bundled and pinned by SHA-256; the hybrid
is ship-bundled then update quietly in the background so nobody ever waits.

### 6. Composio billing
Everything runs through Ferrox's broker on Sean's key, deliberately. `activeBroker()`
in `server/composio.ts` is the single decision point and `brokerRequest` takes
`cfg` so no caller can route around it — **flipping to own-key-wins is one line.**
Nothing in the UI says which mode is active; fine while free, a real problem the
day it is not.

---

## OPEN — needs Sean, not code

- **The skill-less profiles now have a plan — see §2b.** Corrected count: 27 of
  57 local profiles, each with exactly one playbook. Content *and* code.
- **Fuigo artifact size**: ~59 MB compressed added per mac arch.
- **`fuigo-win32-arm64@1.0.1` is unpublished** (registry 404s). **Not a blocker** —
  the app ships Windows x64 only and Windows-on-ARM emulates x64. Only affects
  someone running `npx fuigo` directly on ARM.
- **`docs/plans/skins/THEME-COLLAPSE.md` is stale** — it documents the old
  panel/app assignment, fixed in `28dabbce`.

## GOTCHAS THAT COST TIME

- Use `rtk proxy npx vitest …`. A bare `npx vitest` is swallowed by a shell hook
  and prints nothing. `rtk`'s cached `sed`/`grep`/`git` output has also gone
  stale mid-session — prefer `Read` and `rtk proxy git` when it matters.
- Dev mode does **not** start the harness. Electron loads Vite on 5199 and you
  run `node --experimental-strip-types server/index.ts` yourself. Chasing this
  as a bug cost ten minutes.
- `pkill -f murage-app` also kills Vite — it runs from the same directory.
- Renderer fetches must carry `x-murage-surface: desktop` or they silently see
  nothing (`src/lib/desktop-surface.test.ts`).
- The route `/skills/([a-z0-9-]+)` matches `/skills/library`. Ordering matters.
- `findDelegationReceipt` returns `null`, not `undefined`.

## AUTONOMY BOUNDARIES

Approved: merging to `main` and pushing `FerroxLabs/murage`; killing and
restarting the local app; scratch instances under the scratchpad.
**Not approved:** pushing `FerroxLabs/murage-teams`, publishing a release,
deleting anything under `~/.murage` without a backup first, force-push, or
touching `~/dev/smarttrader` — read-only reference, and nothing from the Rebel
Scanner or REGIME-GATE ever enters this repo or a build artifact.

--- HISTORY ---


## OVERNIGHT 2026-09-02 — nine commits, pushed to `main` at `94ef6689`

Suite: **src 539/539 · electron 375 · companion 223 · server 1919/1**. The one failure is
`control-murage`, environment-dependent — it hardcodes `["claude"]` and this machine has a real
`qwen` on PATH. All four typechecks exit 0. Contrast script exits 0 on both palettes.

### Landed
| Commit | What |
|---|---|
| `5756fdd0` | `GET /api/search` and `POST /api/connectors/:slug/authorize` out of the companion allowlist |
| `c08ad64d` | Routines were the way around the computer-provision denial (`runOn: "cloud"` → `provisionBox`) |
| `4b57fd3b` | A room's delegation queue is multi-sender; one Stop must not empty it |
| `a3ef2b36` | iOS retired, salvage hash-verified against HEAD |
| `3fc050c9` | The endpoint list dropped the bare tailnet address — the one a browser can reach |
| `62232f2c` | Fuigo bundled |
| `359f0a15` | Phase C responsive: C1, C3, C4, C5, measured |
| `c82c009f` + `637f9de7` | `/api/events` scoped, and every route that could rebuild the firehose |
| `427936d6` + `94ef6689` | Four skins collapse to Light / Dark / Automatic |

### The D1 decision, and how it was made
Three models were asked independently whether to scope `broadcast()` or drop `/api/events` from the
device surface. **2–1 for scope.** The deciding fact: `/api/events` is not a UX nicety on that
surface — it is the device-presence signal *and* the in-flight revocation lever
(`companion/src/proxy.ts:418-431`), so dropping it trades a confidentiality hole for the loss of the
one control that matters when a phone goes missing. The dissent (GPT-5.6) is worth keeping: the
control plane should not ride on the application event bus at all, and a dedicated device-session
stream carrying no thread ids would be the cleaner long-run shape.

All three agreed on the condition that actually mattered, which no plan contained: scoping the push
side while the pull side authorises on thread id alone is **theatre**. So the pull side was closed
too — including `/api/bots`, which nobody's list named and which was the widest transcript read on
the port.

**Polarity is inverted from `plan-security.md`: scoped is the default, the desktop opts out.** The
cost is that the renderer must say so in three places (`src/lib/live-events.ts` via query string —
EventSource cannot set headers — plus `api()` and `InspectorPanel`'s raw fetch). Pinned by
`src/lib/desktop-surface.test.ts`, negative-controlled 4/4. Miss one in future and it goes red
rather than quiet.

### Tailscale — unblocked
HTTPS certificates enabled. A real Let's Encrypt cert mints for
`seans-macbook-pro.tail0a48a4.ts.net`, **expires 30 Nov 2026**. `isSecureContext` is now true, so
the PWA half can run at all. **Renewal is a live design constraint**: Tailscale renews only when
something asks. `tailscale serve` does; a hand-rolled listener reading cert files does not, and will
serve an expired cert in late November with no obvious cause.

### Needs Sean
1. **Publish `fuigo-win32-arm64@1.0.1`** — declared an optionalDependency of `fuigo@1.0.1`, registry
   answers 404. Windows ships x64 so nothing breaks here, but `npx fuigo` is broken on Windows ARM.
2. **Artifact size** — the bundled Fuigo binary is 165–174 MB per mac arch on a ~177 MB app, roughly
   doubling each artifact. A release decision, not a technical one.
3. **CT logs** — enabling certs published the machine hostname publicly. Rename before a PWA is
   pinned to that origin if that matters.

### Queued, deliberately not done
- **Phase C rows C2 (tap-44), C6 (hover-only), C7 (touch-unreachable), C8, C9, C10.** C6 is the
  sharpest: six per-message controls measure opacity 0 at 390px with `any-hover: hover` false.
- **Sidebar near-alignment** — rows at x=8 vs x=12, icons at x=21 vs x=24. Pre-existing, cross-cuts
  desktop, belongs in C10. One value, three sites.
- **`GroupView.tsx:1030`** likely has ChatView's header collapse, unverified — this dataset has zero
  rooms, so it was not blind-fixed. Add to C3's site list and measure with a room.
- **Settings nav** hides 6 of 8 sections behind a scroll with no affordance (`scrollWidth 917` vs
  `clientWidth 388`), and Search eats the first 37%.
- **CoS**: two Mediums and two Lows from the audit, unfixed per the Critical/High rule. E5 (UI) not
  built, so electing a workspace Chief still needs a hand-rolled PATCH. **E6 stays unbuilt.**
- **`scripts/check-skin-contrast.mjs`** still has dead `BASELINE_FLOORS` rows keyed `midnight|…`,
  and `check:contrast` is not wired into `pnpm test`.
- **Fuigo CI gates**: `release.yml` and `package-win.yml` have per-resource gates for cloudflared and
  none for fuigo. Rated the most important follow-up by the agent that built it.
- **`resolveFuigoCli()` is exported, tested, and called by nobody** — wiring Fuigo in as a selectable
  engine needs `server/drivers/**` and `src/**`.

### Process notes, honestly
- A workflow whose `.output` file is 0 bytes is **running, not dead**. I misread that, dispatched an
  overlapping agent, and two agents edited `server/store.ts` and the delegation tests at once.
  Repaired, nothing lost. Check with `TaskStop`/`TaskOutput`, never file size.
- Commit `4b57fd3b` swept in 288 lines of `server/index.ts` that were another agent's in-flight
  work, not its own six-line fix. Stage by explicit path when lanes are live.
- I committed `c82c009f` red — re-ran the server suite after adding a renderer test and never re-ran
  `src/` or `tsc -b`. Fixed in `42b425d8`. Run the suite for the lane you actually touched.
- Three agents died together on Anthropic 522s. Restart with a "what is already on disk" brief so
  they verify rather than redo.

---

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

## MASTER PLAN — landed. `docs/plans/universal-client/MASTER-PLAN.md`

It re-ran the three load-bearing claims itself. **Two hold, one is false as I stated it.**

**(a) Room turn at hop 0 — TRUE.** Booted the harness; injected agents env carried
`MURAGE_TURN_DEPTH="0"` with `MURAGE_THREAD_ID` equal to the ROOM thread. `server/index.ts:4190`
passes literal `0`; `:3474` mounts on `hop < MAX_COMMS_DEPTH`. Chief of Staff design is solid.

**(b) Companion proxy serving static — FALSE on the existing port.** `dist/index.html` loads its
bundle with `<script type="module" crossorigin>`, a CORS-mode fetch that sends `Origin` **even
same-origin**, and `companion/src/proxy.ts:236-242` 403s any `Origin` *before* the token check and
before `denyReason` runs. The app's own entry bundle would be refused. Needs a **new listener**, and
**port 8813 — not 8812**, which `electron/companion-origin-gateway.mjs:12` already owns.

**(c) Headless BYOK auth — TRUE.** An unlogged-in `claude` in an empty `HOME` completed a real turn
via env vars alone: `{"is_error":false,"result":"HEADLESS_OK"}`. Zero new code. But
`claude auth status --json` returns `{"loggedIn": true}` for a **fake** token, so the cloud plan's
health monitor never fires for the failure it exists to catch. Coverage is 3 of 13 engines.

### The finding that outranks the security plan

**`GET /api/events` is an unfiltered firehose.** `server/index.ts:1087-1090` broadcasts every
persisted message to every SSE client; the only filter is `screen` (`:1202`). It is allowlisted today
(`routes.ts:57`). **Scoping `/api/search` does not close transcript exposure** — it removes a grep and
changes nothing about what is reachable. I told Sean the search fix was the answer; it is half of one.

### Verdicts

| Track | Verdict |
|---|---|
| iOS retirement | **BUILD** |
| Chief of Staff | **BUILD** steps 0–5 · **DO NOT BUILD** step 6 (its cycle controls are reset by any connector/secret resume and by a restart) |
| Security | BUILD WITH CHANGES — 4 defects incl. the 8812 collision and a tailnet selector that can silently bind a LAN interface (`listener.ts:26-29`) |
| PWA | BUILD WITH CHANGES — the service worker as specified is **measured broken**: offline, `#root` empty, both cached assets `ERR_FAILED`, recovery script then unregisters and lands on `chrome-error://` |
| Cloud | BUILD WITH CHANGES, but **defer** |

### Effort, honestly

**252–305 h total — 8–10 weeks for one engineer.** The five plans summed to 165 h, so they were
collectively **~40% under**. A phone in Sean's hand that is safe and works (Phases A+B+C) is
**144–172 h, five to six weeks**. If only three weeks exist: A + C — a responsive Murage over an SSH
forward with the live holes closed and no new attack surface.

### DO FIRST — 3–5 h, safe, unblocked, closes live holes

1. Delete `GET /api/search` from `companion/src/routes.ts:102` **and `companion/test/routes.test.ts:71`**
   — the plan's edit without the test line turns CI red; the auditor proved it.
2. Delete `POST /api/connectors/:slug/authorize` from `routes.ts:132` — a paired phone can currently
   bind a Google account to this machine.
3. Decide `/api/events` (§0b, decision D1). **Do not ship the browser door before this is answered.**
   8–14 h if `broadcast()` is scoped per client.

Retirement is the one moment removing the search route costs nothing: no client will exist to call it.

### Confirmed live, worth knowing

- `POST /api/cli-test {"cli":"/bin/echo"}` → `200 {"ok":true}`. The RCE primitive is real.
- The SPA fallback returns `200 text/html` for `/assets/index-NOPE.js`, `/sw.js`,
  `/manifest.webmanifest` and `/icons/*.png` — an allowlist that denies a path still serves the shell.
- No `nosniff` on any static response.
- **`CertDomains: null` — Tailscale HTTPS is OFF.** A blocking PWA prerequisite (`isSecureContext`).
- `delegations.ts:311-316` silently deletes room-sourced delegations.

**Every `server/index.ts` line citation in three of the five plans is STALE.** Real anchors are in
MASTER-PLAN §8. Trust the master plan's line numbers over the individual plans'.

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
