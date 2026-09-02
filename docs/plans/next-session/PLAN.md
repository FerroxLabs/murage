# Next session — plan v2, cross-audited

**Status:** cross-audited twice (feasibility · completeness), corrections applied.
Written 2026-09-02 at `b6f44e79`. Supersedes `HANDOFF.md` §NEXT in full.
**Inputs:** three audits of today's ten commits — security, experience (Playwright
against the real renderer, geometry measured), integration (every seam between the
four lanes) — then two adversarial audits of the v1 plan. Every file:line below was
verified against the tree.

## The finding that shapes everything

Ten commits, four lanes, every lane's suite green, all four typechecks clean — and
the audits found two Criticals, seven Highs, and a web UI no phone can reach.

> the seams are green precisely because no test crosses a lane boundary.

And the orchestrator's end-to-end proof was `curl`. It proved the route; the person
was never consulted. So this plan changes how before what — and the cross-audit
found the v1 "process changes" were theatre with no mechanism. The mechanisms are
now in Wave 0 and enforced by CI and by LANE DISCIPLINE, or they do not exist.

**Honoured without action, so nobody re-checks:** `hosted` re-rank shipped
(`995c37c3`); smart-trader is published, never re-run; tailnet-only, never funnel;
accept configures the bot you are in; installs are a keyboard decision;
Cloudflare/accounts kept dark, not deleted.

## What today got wrong, owned — corrected by the cross-audit

| Claim | Truth | Source |
|---|---|---|
| "Three wires and the web UI works" | ~3–4 days on a critical path, and the door 404s the entire intake on a phone (zero library/skills routes on either surface) | integration §9, §6.2; C-B3 |
| `ccc5f07d` "the cloud installer" | Runs no sidecar, so no door exists on a box; `DEFAULT_PORT` 8799 with a test asserting it; the correction was written into the plan and not applied | integration §3.1, §3.2 |
| "All four gates exit 0" | `installer/` is a fifth package with no gate — not in `pnpm test`, not in `ci.yml` | integration §7.1 |
| "Agent cannot drive another agent's skill install — desktop-only" (two commit messages) | Door gate, not principal gate; any local process with `curl` passes `?surface=desktop`. The named `delegate_bot` vector is closed; the general claim is false | security #1 |
| "Intake verified end-to-end" | Route-level only. "hi" → 8 pre-ticked junk skills in a 1379 px card on a 937 px viewport, no scroll; fires on Sable and would rename her | experience §1 |
| "Nine assistants got their skills" | *Applied*, not proposed, from a scorer a one-profile spot check broke twice; `tiktok-creator` at 0.40 for a Word form builder | experience §5; C-M2 |
| "line-editor struck, developmental editor clean" | `write-book-chapter` — same wrong-craft error — on **five** book profiles, not one (verified) | C-M1 |
| "One action, two entry points" (`388ae731`) | "Add a skill" opens on **Teams** with Load buttons and no mention of Bruce; "Add to Bruce" offered for skills Bruce has, with an unfollowable error | experience H3, H4 |
| "Pairing copy fixed" | `PhoneSetupFlow.tsx:1158` still says "Open MurageMobile"; the whole flow still promises a phone the `murage://` QR cannot deliver | experience §6 |
| `HANDOFF.md` §NEXT | Items 1, 2, 2b-1 and 3's "unbuilt" list all shipped; a fresh agent would rebuild them | C-B1 |

None of this reverses the value. Four execution routes gated and negative-
controlled, a live shell injection closed, the door holds under attack, the org
chart proven. "Done" was claimed at the route level.

**Protocol note (decision 7).** Sean's rule: fix Critical and High, record
Medium/Low. This plan schedules some Mediums and Lows — each under an hour, in a
file a lane already owns. That is a change to his rule, surfaced below, not decided.

---

## Wave 0 — first two hours, serial, orchestrator only

| # | Fix | Where | Note |
|---|---|---|---|
| 0.1 | Rewrite `HANDOFF.md` §NEXT **in full** (`:84-203`) to point here. Keep §THE ONE THING verbatim — it is Wave 2's spec. Record the security overclaim plainly in §SECURITY | `HANDOFF.md` | C-B1 |
| 0.2 | Strike `write-book-chapter` from **all five** `book-*` profiles; rebuild `library/catalog.json` | `bot-library/builtins/book-{copy-editor,developmental-editor,publisher,nonfiction-architect,story-architect}.json` | verified |
| 0.3 | "Open MurageMobile" → names no client (G rebases over this) | `PhoneSetupFlow.tsx:1158` | |
| 0.4 | **Not** `DEFAULT_PORT`. Add `DOOR_PORT = 8813` (env `MURAGE_BROWSER_PORT`) used only by `enrolTainet` (`:222`) and `status` (`:439`); harness stays 8799; test that `buildServeArgs` targets 8813; **serve enablement gated on `GET 127.0.0.1:8813/enter` answering** — which lands with 3.1 | `installer/bin/murage.mjs`, `installer/lib/tailscale.mjs` | F-B1 |
| 0.5 | Duplicate `x-murage-companion`: Node joins to `"1, 1"` — a string — so `=== "1"` reads desktop. Treat **presence** as remote | `server/sse-visibility.ts:74`, `index.ts:9293` | LOW, decision 7 |
| 0.6 | **Write the seam file both lanes consume:** `src/lib/surface.ts` exporting `isDesktopSurface()` (from `/api/config`, which the door already serves). ~10 lines. Orchestrator-owned so Wave 1 and Wave 2 have no dependency on each other for it | new | C-B3, F-B3 |
| 0.7 | Append every Medium/Low no wave schedules to `HANDOFF.md` §KNOWN MEDIUMS, file:line each: quiz title leaks into sidebar preview · "Find it" wraps <840 px · `book-production` ranks `write-book-chapter` 0.609 · the scorer's confidence is not a confidence (class, not instance) · `THEME-COLLAPSE.md` superseded by `28dabbce` | `HANDOFF.md` | C-B2 |
| 0.8 | Record **Electron → Tauri: not now** in §SEAN'S DECISIONS — 23k lines of shell, zero releases cut, size already accepted at 59 MB/arch; the one real lock-in is the agent's browser tools on `webContents.debugger`; decouple those to an external Chromium first, then Tauri is a branch experiment. Revisit at 5.2 | `HANDOFF.md` | C-M6 |
| 0.9 | The three test bots (`Seam Audit Probe` ×2, the test Smart Trader) — **only if Sean says delete** | `~/.murage` | outside autonomy |

## Wave 0b — Playwright bootstrap, 0.5–1 day, orchestrator. Unbudgeted in v1.

Nothing in Wave 1 or 2 can be verified as a person without it, and it did not exist:
no `playwright` in `package.json`, no config, no `e2e/`. The experience audit used
the MCP browser by hand.

- `@playwright/test` + chromium; `playwright.config.ts` with two `webServer`s
  (harness via `pnpm dev:server`, Vite 5199), projects `desktop` 1440×900 and
  `mobile` 390×844 `hasTouch` no-hover.
- **Scratch data, never live:** `MURAGE_DATA_DIR=<scratch>` with seeded fixtures —
  a blank bot, a titled bot with 0 skills, a bot from the `smart-trader` profile.
  v1's script would have stripped skills off Sean's own bot.
- `pnpm test:human` = `playwright test src/e2e/*.human.spec.ts`; **CI job in
  `ci.yml` after `pnpm test`**; `check:contrast` wired into `pnpm test` in the same change.
- Wave 2's mobile project starts the sidecar itself (`MURAGE_BROWSER_BIND=loopback`,
  `MURAGE_COMPANION_DIR=<scratch>`), opens a pairing window via `POST 127.0.0.1:8811/pairing`,
  and **runs `vite build` first** — `dist/` is from 06:20 and predates the intake;
  "when `dist/` exists" would test a bundle without it.
- **LANE DISCIPLINE gains a rule:** a UI lane's brief names its `*.human.spec.ts`
  path; the orchestrator does not commit a UI lane whose diff lacks that file;
  cross-lane seams get a test under `test/seams/`, written and committed by the
  orchestrator before the lanes launch.

---

## Wave 1 — make the intake safe. ONE lane. 2–2.5 days.

Owns: `src/components/{BotIntakeCard,TeamLibraryPanel,BotSkillsPanel,Sidebar,ChatView}.tsx`,
`src/lib/{onboarding-intake,bot-skill-count}.ts`, **`src/state/store.tsx`** (H3 needs
a `view: "skills"` field — unlisted in v1), `server/index.ts`. Consumes `surface.ts`.

**Critical**
- **C1 — the fallback.** Root cause is one line: `intakeTopicTokens` drops ≤2-char
  tokens, `chooseIntakeProfile` returns null on empty, and the server falls to
  `searchSkills(q, 8)` ungated (`index.ts:6661`, `INTAKE_FALLBACK_SKILLS = 8`).
  Fix: empty tokens → `skills = []`. Then for non-empty: the same relevance gate,
  cap **3**, default **unchecked** (`BotIntakeCard.tsx:93`), button counts only
  checked. Zero clear → honest empty state, one action "Browse the library" → panel
  on **Skills** with this bot preselected.
- **C2 — the card never exceeds the viewport.** `ChatView.tsx:1408`: bounded
  max-height inside the composer dock, inner scroll, question and dismiss sticky.
  **Most likely to blow its estimate** — the dock's height feeds `useKeyboardInset`
  (`:1398`) and iOS visual-viewport is the path the handoff already calls fragile.
  Measure at 390×844 and 1440×900 for every fixture input.

**High**
- **H1 — configured bots are not asked.** `needsSetup` also requires no `title`, no
  `description`, <3 user messages. `bot: Bot` already carries all three — no fetch.
  `ChatView.tsx:740` `intakeOwnsTheQuestion` moves in lock-step (`bot-skill-count.ts:6-11`).
  **But:** a configured, skill-less bot still gets the **collapsed "Set X up" chip**,
  never nothing — or this recreates the one-way door the card exists to prevent
  (F-M4). Rewrite `bot-skill-count.test.ts:18-22,51,81-82`. Sable is the test.
- **H2 — vague input.** Not the 4-char prefix (`charts→chart`, `invoices→invoice`
  depend on it, `onboarding-intake.test.ts:121-122`). Root cause: `stuff`, `thing`,
  `things` absent from `INTAKE_STOPWORDS` (`:38-44`). Add them; require ≥2 token
  hits or one whole-word hit before a profile wins (`intakeProfileMatches` is
  `some()` today, `:91`). No score crosses the `TeamHit` boundary — do not add one.
  **"chasing invoices" — the card's own example — is the regression test, written first.**
- **H3 — "Add a skill" opens on Skills, naming the bot.** `TeamLibraryPanel` has no
  tabs, only `activeFacet`/search (`:372-374,710,1064`). Add `view: "skills"` to
  `state.teamLibrary` (`store.tsx:465,542,783`); heading "Skills · for Bruce" before
  any search; zero Load buttons on that view.
- **H4 — "Add to Bruce" hidden for installed skills.** Read the bot's set; render
  "Added ✓" disabled. `server/skills.ts:1200`'s error is never shown to a person.
- **H5 — keep the name.** Checkbox "Keep the name Bruce", **default checked** when
  the bot has a custom name — decided from evidence: the live workspace has a bot
  hand-named "Bruce (Smart Trader)".
- **H6 — the phone.** Via `isDesktopSurface()`: when false, Accept and "Add to
  Bruce" render "Add this on your desktop" and fire no request. Today they 404 and
  the card renders the raw error (`BotIntakeCard.tsx:132,142`). Consistent with
  "installs are a keyboard decision" — only if the UI says so.

**Medium — decision 7**
- M1 `BotSkillsPanel.tsx:271` `invalidateSkillCount` on remove.
- M2 `BotSkillsPanel.tsx:483` delete "Use /learn in chat to add another."
- M3 `⋯` visible at rest under `(hover: none)` — **all three sites** `Sidebar.tsx:929,945,832`,
  or iPad landscape still fails on archive.
- M4 typo: on empty result retry the prefix form (`toMatchExpression` appends `*`),
  label "Did you mean…". Defer fuzzy.
- M5 picker: secondary line with title or skill count — the live workspace has
  "Bruce", "Bruce (Smart Trader)" and two "Seam Audit Probe".

**Verification — `src/e2e/intake.human.spec.ts`, written before the lane starts,
against scratch fixtures:** types `hi` · `help me with stuff and things` ·
`chasing invoices` · `tradng` · `trading` · `I want help building a pitch deck`;
asserts per input: card ≤ viewport, question visible, dismiss visible,
checked count, profile named or honest empty. Opens the titled fixture: **no card,
chip present**. Creates its own smart-trader fixture, removes its skills, asserts
the card returns **without reload**. Mobile project: Accept reads "Add this on your desktop".

---

## Wave 2a — the door reaches a phone. ONE lane. 1.5–2 days. Parallel with Wave 1.

Owns: `companion/**`, `electron/**`, `src/components/{PhoneSetupFlow,Onboarding}.tsx`,
`src/lib/{companion-pairing,phone-setup}.ts`, `src/types/muragebox.d.ts`,
`scripts/capture-companion-fixtures.mjs`. **Not** `BotIntakeCard` — that is 2b.

| Step | What | Files | Est. |
|---|---|---|---|
| **A** | Door allowlist, reads only: `GET /api/bots/:id/skills` (without it the phone's count is −1 and the quiz shows), `GET /api/library/suggest`, `GET /api/library/search`, `GET /api/team-library/*` (or Browse is an empty panel). Writes stay desktop-only. Pin in `routes.test.ts` | `companion/src/routes.ts:253` | 1–2 h |
| **B** | Electron names and exposes the door: `BROWSER_PORT = 8813`, `MURAGE_BROWSER_PORT/BIND/SCHEME` in the fork env, `browser: {scheme,host,port}` on `/state` — through `ControlOptions` (`control.ts:23-43`), `companionState()` (`:190-207`), `CompanionState` type, `companion.mjs` off/error shapes (`:367-391`), fixtures, 38 tests. **While here: take `preparePhonePairingRoute()` and `cb0d376`** (both queued, both this lane's files) | as listed | 0.5–1 d |
| **C** | QR carries `/enter#<token>`: `companionBrowserLink()` beside `companion-pairing.ts:294`. **Parallel with B** — `/state` already carries `tailnetName`/`hosts`; default `http`/8813 until B lands. Token shape already redeems (`devices.ts:308`) | `companion-pairing.ts`, `PhoneSetupFlow.tsx:776` | 2–3 h |
| **D1** | Tailnet bind, **no sidecar restart**. `index.ts:334` is the only tailnet-bound listener: close and re-`listen()` that one server after `refreshTailnetName()` resolves. Devices, streams, pairing window, origin socket untouched. Auto mode: tailnet if present at bind, else loopback; `MURAGE_BROWSER_BIND` stays operator override. **Bind the address `tailscale ip -4` reports, cross-checked against the interface table; refuse on disagreement** — `listener.ts:62-68` picks the first 100.64/10 interface, the selector the handoff flagged as able to bind a LAN address | `companion/src/index.ts:334`, `browser.ts:909` | 3–4 h |
| **E** | "Check for Tailscale again" — one text button in the `!tailscaleAvailable` branch, calls existing `refreshTailscale`; no "optional"/"secure HTTPS" copy | `PhoneSetupFlow.tsx:1059` | 1 h |
| **F** | Dev: `MURAGE_STATIC_DIR=dist` when present — in `electron/harness-resources.mjs:17`, not `main.mjs`; and the Playwright webServer builds first | | 0.5 h |

**D2 (`tailscale serve` + HTTPS)** is after D1: 1–1.5 d, CLI hunt, privileged
subprocess, certs on the tailnet. **D1's cost, stated:** under plain HTTP every
`navigator.clipboard` call is dead — five sites (`ChatMarkdown.tsx:108`,
`ChatView.tsx:162`, `ConnectionDetail.tsx:27`, `EngineSetup.tsx:48`,
`SettingsPrimitives.tsx:64`) — and PWA install is impossible. D2 fixes both.

## Wave 2b — serial, AFTER Wave 1 merges. 1–1.5 days.

- **G — the pairing flow rewritten for what exists.** It promises a phone that
  "reads and replies" via an app. It is now: scan → your phone's browser opens
  Murage. Onboarding leads with the two questions: enable the web UI (off by
  default) · connect a device. `PhoneSetupFlow.tsx` is 1213 lines with a 20-test
  state machine in `phone-setup.ts` — **1 day, most likely to blow.**
  **The account UI ("Email me a code" / "Try secure access again") is decision 3,
  and its removal is gated on a real-phone pass of C+D1** — "delete nothing until
  its replacement ships."
- `src/e2e/phone.human.spec.ts`, mobile project, sidecar-driven, built `dist/`:
  follows `/enter#<token>`, lands in the app, opens the blank fixture, sees the
  **intake card** (requires A), Accept reads "Add this on your desktop", Browse is
  not empty. Then a real phone on the tailnet.

---

## Wave 4 — security defence-in-depth. 1 day. **Before Wave 3**, per the settled order.

Runs after 2a clears `electron/`.

| # | What | Why |
|---|---|---|
| 4.1 | **Per-launch desktop secret** — Electron main mints, renderer holds, `requestSurface` requires it for `desktop`; agents and MCP servers never receive it. `COMMS_TOKEN` pattern, `index.ts:340`. **With a dev-only injection** (env read when `!app.isPackaged`, exported to the Playwright webServer) or Wave 1's script dies the day this lands | security #1; F-M5 |
| 4.2 | Gate the remaining execution-class routes at the harness: `local-computer/*`, `computer/{provision,sleep,remove,screenshot}`, `PUT/PATCH /api/config` | security #2 |
| 4.3 | Contract split #13: `computerProxyEnv` passes `MURAGEBOX_BOX_API` from the parent's `BOX_API`; both readers require `https:` | security #4 |

## Wave 3 — the cloud installer, finished. 3–4 days **+ Sean's auth key**.

| # | What |
|---|---|
| 3.1 | `murage start` runs the **sidecar** (second systemd unit, `MURAGE_COMPANION_DIR`, `MURAGE_BROWSER_BIND=loopback`); this is what makes 0.4's serve guard pass |
| 3.2 | Verify 8813 answers before "secured" |
| 3.3 | `murage pair` against `control.ts` — a headless box has no Phone panel. **Most likely to blow** |
| 3.4 | `installer/` into `pnpm-workspace.yaml`, `pnpm test`, CI |
| 3.5 | `MURAGE_TRUSTED_PROXY`: `classifyClientTrust()` reads it and nobody calls it. Either the harness gains loopback-is-not-operator and reads the flag, or the installer stops writing it and README:55 / cloud-deploy T7 are corrected |
| 3.6 | systemd unit newline guard (LOW, decision 7) |
| 3.7 | One real `murage setup` on a droplet with an ephemeral key **Sean supplies** |

## Wave 5 — the queue, in order

| # | What | Note |
|---|---|---|
| 5.1 | Phase C — every hover-only control gets `(hover: none)`; six per-message actions at opacity 0 on a phone | Makes Wave 2 usable |
| 5.2 | **First release.** The updater exists (`electron/updater.mjs`, feed → `murage-releases`), never run. **Prerequisite:** `release.yml`/`package-win.yml` need a Fuigo gate or it ships an unverified 59 MB binary. Win32 ARM64 explicitly not this edition | "Auto-update" is "release once" |
| 5.3 | Engine auto-update — does not exist; `resolveFuigoCli()` is the seam it wires | Design first |
| 5.4 | **Skill review, all of it.** The lane writes `docs/plans/next-session/skill-review.md`: the 40 shipped mappings and the 8 below-threshold, profile → skill → score → keep/strike. Sean reviews once. The **10 product-mechanic profiles** (`cli-setup`, `cowork`, `game-3d`, `moltbook`, `moltbook-skills`, `morph-ppt`, `morph-ppt-3d`, `planning-with-files`, `star-office-helper`, `word-form-creator`) stay empty by design — stated so nobody re-derives them | Content |
| 5.5 | `officecli-*`: ten Office playbooks say "follow the `officecli-*` skill exactly"; no such skill exists | Decision 4 |
| 5.6 | Playbooks get a surface — read-only on the Agent profile first, edit second (HANDOFF §2b.3, Sean's directive idea) | |
| 5.7 | The assistant that notices a gap and asks (§2b.4) — after 5.6 | |
| 5.8 | Composio billing — one line in `activeBroker()` when billing exists | |

---

## Decisions for Sean

1. **Fallback** — confirm: gate + cap 3 + unchecked + honest empty state. Decidable from "profile-first, retrieval as fallback"; a confirm, not a question.
2. **First phone front** — D1 plain HTTP under WireGuard (my pick, 3–4 h), **accepting Copy and PWA install are dead on the phone until D2** (1–1.5 d)?
3. **Account UI** — hide "Email me a code" behind the existing control-plane-configured condition (my pick — nothing deleted, reachable the day `accounts.murage.ai` exists), or remove the JSX?
4. **`officecli-*`** — author the skill, or rewrite ten playbooks?
5. **The three test bots** — delete?
6. **Paid tier** — this quarter or someday. Still the question that reorders Wave 4.
7. **Protocol** — allow the Medium/Low items in Waves 0, 1, 3, 4 fixed in-lane (my pick — each under an hour in an owned file), or record and fix Critical/High only, per your rule?

## Sequencing and honest totals

```
Wave 0   (2 h, serial, orchestrator)
Wave 0b  (0.5–1 d, Playwright; scratch data dir; vite build in webServer)
   ├─ Wave 1  intake        (2–2.5 d) ──────────────────────────────┐
   └─ Wave 2a A ∥ B ∥ C → D1-relisten → E → F   (1.5–2 d) ───────────┤
         └─ Wave 2b  BotIntakeCard phone copy + G + mobile spec  (1–1.5 d, after Wave 1)
                └─ real-phone pass gates decision 3
   Wave 4   (1 d, after 2a clears electron/, with the dev-only secret)
         └─ Wave 3  installer  (3–4 d; 3.7 waits on Sean's key)
   Wave 5   ongoing
```

| | v1 said | Honest |
|---|---|---|
| Wave 0 | 1 h | 2 h |
| Playwright | — | 0.5–1 d |
| Wave 1 | 1 d | 2–2.5 d |
| Wave 2 | 1.5–2 d | 3–4 d |
| Wave 4 | 1 d | 1 d, moved earlier |
| Wave 3 | 2–3 d | 3–4 d + key |
| **Total** | **≈6.5–8 d** | **≈10–12 d** |

Wave 1 and 2a are genuinely parallel. 2b is serial. v1's "1 day" for Wave 1 was
the least honest number in it; the Playwright line was the largest omission.
