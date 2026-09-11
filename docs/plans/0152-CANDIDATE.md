# Murage 0.1.52 — integration candidate (Q1-T5)

**Written:** 2026-09-11 (Q1-T5, lane map §1 "Q1 — qualification and release")
**Verified tree:** `8150dfc23b545a2f8047d5d307757278b96fb4f5` on `release/v0.1.52`
(this document's own commit sits on top of it and changes no code).
**Base:** `acaee1db` (`fix(concurrency): keep bot turns independent`, the 0.1.51
branch point). 175 commits on top of it: 48 `merge(0152)` merges of 47 lane
branches, plus the four Q1-T5 commits listed in §3.
**Version surfaces:** `package.json` `0.1.52`. `git grep -nE '0\.1\.5[01]\b' -- README.md docs src`
returns nothing. `README.md:23` still reads "Murage 0.1.47 — stable release" (a
publication-time README item per `docs/releasing.md`; see §5).
**Machine:** this Mac (10 cores / 24 GB), Node v24.20.0, pnpm 10.33.0, the only
job on the machine for every run below. Full logs are in the session scratchpad
(`q1t5/*.log`); the joined-scenario evidence is committed at
`.planning/0152-candidate-joined.json`.

## 1. The matrix

Every command was run from `/Volumes/Mando/WaylandBots/murage-0152` with the
lane toolchain (`export PATH=~/.nvm/versions/node/v24.20.0/bin:$PATH`, pnpm via
`node ~/Library/pnpm/.tools/pnpm/10.33.0/node_modules/pnpm/bin/pnpm.cjs`).

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | `pnpm install --frozen-lockfile` (fresh) | **pass** | `Lockfile is up to date, resolution step is skipped … Done in 625ms`. Build scripts still ignored for core-js, onnxruntime-node, protobufjs, sharp, workerd (×2); nothing below needed them. |
| 2 | `pnpm typecheck` (`tsc -b && tsc -p tsconfig.server.json`) | **pass** | exit 0, no output. |
| 3 | `pnpm lint` (`oxlint .`) | **pass** | exit 0; 131 warnings, 0 errors (all pre-existing: `no-control-regex`, `no-useless-spread`, unused vars in companion/broker tests). |
| 4 | `pnpm build` | **pass** | `✓ built in 4.56s` (vite; the usual chunk-size warning). |
| 5 | `pnpm build:server` | **pass** | `dist-server/installation-recovery-worker.js 767.1kb`, `dist-server/installation-recovery.js 764.3kb`, ⚡ Done. |
| 6a | `pnpm test` — `check:contrast` | **pass** | `✓ dark — 37 pairs, none below target`, `✓ light — 37 pairs, none below target`. |
| 6b | `pnpm test` — `vitest run` (full, 570 files) at `08cb0155` (before fixes) | **fail** | `Test Files 13 failed \| 556 passed \| 1 skipped (570)`, `Tests 21 failed \| 7378 passed \| 21 skipped \| 1 todo (7421)`. Classified against the base in §2: 4 new (all fixed, §3), 17 pre-existing (15 unit tests + 2 comms timings). |
| 6b′ | `vitest run` (full) at `8150dfc2` (after the §3 fixes) | see §2.3 | final tally recorded there. |
| 6c | `pnpm broker:test` | **pass** | `Test Files 1 passed (1)`, `Tests 42 passed (42)`. |
| 6d | `pnpm test:electron` (`node --test electron/*.node-test.mjs`) | **pass** | `ℹ tests 378 · pass 377 · fail 0 · skipped 1`. |
| 6e | `pnpm test:packaged-server` | **pass** | `packaged server started with no node_modules in reach ✓`, `all 15 spawned proxy paths resolve inside the packaged server dir ✓`, `packaged MCP stdio server reached the API and flushed its final frames ✓`, `packaged offline backup, inspect, plan, inactive restore and rollback passed ✓`. |
| 7 | `pnpm i18n:check` | **pass** | `locale catalogs valid (8 languages, 525 English strings)`. |
| 8 | `pnpm catalog:check` | **pass** | `library/catalog.json is up to date`. |
| 9 | `pnpm control-plane:test` | **pass** | `Test Files 2 passed (2)`, `Tests 45 passed (45)`. |
| 10 | `pnpm exec playwright test -c src/e2e/chat-header.config.ts` (`MURAGE_E2E_PORT=9950 MURAGE_E2E_UI_PORT=9952`) | **pass** | `15 passed (19.6s)`. |
| 11 | … `media-lightbox.config.ts` | **pass** | `10 passed (8.0s)`. |
| 12 | … `workspace-editor.config.ts` (F4-T7 joined proof) | **pass** | `3 passed (14.1s)`; re-run after the lease fix `3 passed (15.8s)`. |
| 13 | … `media-publication.config.ts` (F5-T5 joined proof) | **pass** | `3 passed (11.3s)`; re-run after the lease fix `3 passed (11.4s)`. The first run logged one harness incident: `Media publication bot's held turn ended with error: MEMORY_CONTEXT_REVOKED before the engine started (attempt 1); sent again after 1500 ms` (§4.1). |
| 14 | Joined scenario `node --experimental-strip-types scripts/qualify-0152-candidate.ts` (§1.1) | **pass 3/3** | at `727db85f` + the committed driver; `ok` on all nine steps each run; incidents per run: 0 / 1 / 2 `MEMORY_CONTEXT_REVOKED` retries (§4.1), 0 refused saves. Run 3 is the committed evidence. |

### 1.1 The joined scenario (plan Q1 frozen matrix)

One isolated fixture per `docs/verification/README.md`: `launchVerificationServer`
gives the child a temporary data dir and HOME, a free port pair, the suite's
fake engine only, and the server suite's image provider fixture
(`server/testing/search-fetch-preload.mjs`) in front of every image origin.
Nothing touches a real app, `~/.murage`, a provider or the network. Memory is
`active`, as it is on a fresh installation. The driver records each step with
its evidence and every retry as an incident; it never waits an incident out.

1. **Fresh isolated profile.** Two bots on two fixture engines (a slow, gated
   "reporter" and a "artist"), the seeded starter bot left alone, the fixture
   image provider selected (`openai` / `gpt-image-2`, fixture key).
2. **Two bots at the same time.** The reporter holds a turn that has already
   written `outputs/weekly-report.md` (nothing is published while it runs; no
   card, no artifact). The artist holds an authority turn; through the real
   mounted agents MCP proxy it generates one image: one attachment, one
   retained original, one saved version, `calls: 1` at
   `https://api.openai.com/v1/images/generations`. **IMG-SEED:** in a second
   held turn (one image attempt per turn by design), `resolve_image_reference`
   prepares the image by attachment id and by saved version pinned to its
   sha256 (`bytes: 68`, no provider call), `/api/media/reference` names the
   same bytes, the edit is approved with "One image from 1 reference image",
   and the provider receives exactly the reference bytes:
   `{calls: 2, url: …/images/edits, references: 1, referenceHashes: [<sha of the fixture PNG>]}`.
   The reporter is still busy throughout.
3. **Stop / revoke one bot while the other continues.** The artist's held turn
   is interrupted; its turn capability is revoked (`/api/internal/image-models`
   with the turn's bearer: 200 before, **401** after; the still-open MCP
   session's next call is refused `unauthorized`). The reporter is still busy.
   Its gate is then opened: the report becomes one saved version
   (`producer: shell-output`, sha256 of the exact bytes), one `registered`
   receipt row and one host card `Saved file: weekly-report.md`; the artist
   owns none of it.
4. **Owner edit.** `POST /api/workspace-files/write` with the read revision
   lands the exact bytes, keeps the replaced revision as a second saved
   version (sha256 of the original report), marks the card's copy `changed`,
   and a write on the stale revision is refused with **409**.
5. **Restart.** `fixture.restart()` over the same data dir. A byte-for-byte
   snapshot taken before and after is identical: bots (ids, threads, message
   ids), host cards, attachments on disk and as served, saved versions and
   their downloaded sha256s, the working file and its revision, receipt rows,
   memory sources, `providerCalls: 2`. Then both bots take a new turn, the
   provider is not called again, the edited report and its two versions are
   untouched.

Committed evidence: `.planning/0152-candidate-joined.json` (run 3 of 3).

## 2. What failed, and what it was

### 2.1 Baseline comparison

Every failing vitest file was re-run in isolation both on the candidate and on
a worktree at the base `acaee1db` (fresh `pnpm install --frozen-lockfile`
there). "Pre-existing" means the identical test fails at `acaee1db`.

| File | Candidate | Base | Verdict |
|---|---|---|---|
| `server/comms.test.ts` — *queues an ask_bot to a busy peer as a delegation and delivers it once the peer frees up* | fail (3/3 runs) | pass | **regression** — fixed, §3.1 |
| `server/comms.test.ts` — *finalizes a delegated turn interrupted by provider reload*; *queues eight helpers in one turn and runs no more than four together* (`expected 3 to be 4`) | fail | fail | pre-existing |
| `electron/companion-authority.test.mjs` — *the real main-process launch blocks share one fresh private token* (`fluxComposioBrokerUrlValue is not defined`) | fail | pass | **regression** — fixture behind FLUXCOMPOSIO, §3.2 |
| `src/components/SkillAffordances.test.ts` — *is visible AT REST on any device with no pointer* | fail | pass | **regression** — fixture behind U0-T2, §3.2 |
| `src/components/SkillAffordances.test.ts` — *2. the agent's own Skills panel offers it* | fail | fail | pre-existing |
| `server/memory/extract.test.ts` — *advertises extraction only with usable credentials* | fail | pass | **regression** — fixture behind local-models spec E4, §3.2 |
| `src/components/RemoteSurface.test.ts` (4 tests) | fail | fail | pre-existing |
| `electron/updater.test.mjs` — *the actual main createWindow and activate wiring retargets the process updater* | fail | fail | pre-existing |
| `server/unattended.test.ts` — *still asks a human when a webhook starts the turn* | fail | fail | pre-existing |
| `src/lib/tokens.test.ts` (2), `src/lib/role-leaks.test.ts` (1), `src/lib/use-active-skin.test.ts` (1) | fail | fail | pre-existing |
| `server/memory/p01.test.ts` (1), `p05.test.ts` (1), `p06.test.ts` (2) | fail | fail | pre-existing |

The 15 pre-existing failures are 0.1.51's (the memory note already records
GitHub `main` red on "Run tests"). They are not 0.1.52 integration failures and
were left alone; they are listed as a gate in §5 because the release branch
"must be green locally before dispatch" (runbook A3).

### 2.2 Found by the joined scenario, not by any suite

- **Workspace writer lease leaked by a turn refused at acceptance** (§3.3):
  after a bot's turn ended with `error: MEMORY_CONTEXT_REVOKED` and the re-sent
  turn completed, every owner save in that workspace answered **423** "A bot is
  working in this workspace right now" until restart. Reproduced
  deterministically with an isolated fixture (provoke a pre-dispatch
  revocation, let the next turn be refused at acceptance, then write): 423
  before the fix, 200 after. The base has no workspace write route, so this
  could not have existed before 0.1.52.
- **`MEMORY_CONTEXT_REVOKED` on a turn's own dispatch** — not fixed; mechanism
  and recommendation in §4.1.

### 2.3 Final full vitest tally at `8150dfc2`

`pnpm exec vitest run` (full, 570 files, 10:42–10:52Z): **7421 tests: 7380
passed, 19 failed, 21 skipped, 1 todo.** The 19 are the 17 pre-existing
failures of §2.1 (15 unit tests + the two comms timings, all identical at
`acaee1db`) plus two order-dependent flakes in `server/index.test.ts` that
pass in isolation (3/3 runs of the file, 237/237 each) and did not fail in the
first full run:

- *harness HTTP API › admits a new task after a delayed body while a sibling
  thread is running* — `expected {…} to match object { busy: true }` (the
  sibling turn had already settled).
- *internal capability authority › revalidates a capability after a delayed
  HTTP body before creating a card* — `expected 4 to be 3` (one extra message
  in the thread; consistent with a §4.1 retry chip landing in the window).

Net effect of the Q1-T5 fixes on the full suite: the 4 tests that were new
regressions at `08cb0155` (§2.1) now pass; nothing that passed before fails
now. The 13 → 12 failing-file count is not a clean comparison because the two
flakes moved a file; the per-test classification above is the one to read.

## 3. Fixes made (four commits on `release/v0.1.52`)

All minimal, each re-verified with the affected suites; no test weakened, no
platform faked.

### 3.1 `aa27b5a3` fix(runtime): retry waiting delegations from the deferred idle release

R1-T2 (A2) defers a direct run's release until the provider confirms its child
closed, so an ACP/Pi bot is still `busy` when `turn.completed`'s
`retryDelegationsWaitingOn` runs, and that retry bails on the busy check. A
handoff that had found the bot busy never got its retry and stayed "waiting —
retry 1/3" forever. The deferred `releaseDirect` is the real idle release, so it
now calls the same coalesced retry hook, as the other explicit idle releases
already do. `server/comms.test.ts` 24 passed (the two remaining failures also
fail at the base); `server/delegations.test.ts`, `server/index.test.ts` pass.

### 3.2 `b64b8e51` test(integration): align three fixtures with merged 0.1.52 lanes

Each test executes real source; only the fixture's assumptions were behind a
merged lane. `electron/companion-authority.test.mjs` now stubs
`fluxComposioBrokerUrlValue()`/`composioLegacyUntilValue()` (FLUXCOMPOSIO,
`31e98d45`) as "off", like the Worker URL it already stubs.
`SkillAffordances.test.ts` pins that the row never mounts a disabled Archive
(U0-T2 `f2878c5f`, #762/#767) instead of the class that used to hide it.
`memory/extract.test.ts`'s "no usable credential" case is a keyless LAN
endpoint (spec E4 makes a keyless loopback endpoint usable, and it now extracts
by design — asserted the other way).

### 3.3 `727db85f` fix(runtime): bind the workspace writer lease before acceptance can refuse a turn

`guardTurnDispatch` stops and resets the provider turn when
`MemoryDispatchReceipt.accepted()` (→ `deliverMemoryDisclosure`) refuses it,
then rethrows; the catch path abandons the lease, but `abandon` keeps a
dispatched lease by design, and the stopped turn's terminal event could not
release it either because `projectTurnLeases.bind` ran only after the
acceptance hook. Both the direct and the room dispatch paths now bind the lease
to the provider turn id inside the acceptance hook, before
`memoryReceipt.accepted()`. `server/index.test.ts`, `project-turn-leases`,
`turn-dispatch-guard`, `workspace-files`, memory dispatch tests, comms,
`workspace-editor` and `media-publication` human specs pass; joined scenario
3/3.

### 3.4 `8150dfc2` test(candidate): joined 0.1.52 scenario driver and its evidence

`scripts/qualify-0152-candidate.ts` + `.planning/0152-candidate-joined.json`
(§1.1). Re-runnable: `node --experimental-strip-types scripts/qualify-0152-candidate.ts [--out <json>]`.

## 4. Known defects carried into the candidate (not fixed here)

### 4.1 `MEMORY_CONTEXT_REVOKED` cancels a turn whose own capture races its dispatch — memory owner's decision

Seen by F4-T7, F5-T5 and the local-models proof, and reproduced here with an
instrumented fixture. The mechanism (traced in `server/memory`):

- Every captured message in a thread refreshes that thread's *checkpoint*
  record (`consolidate.ts refreshMemoryCheckpoint`: the previous version is
  `archived`, a new version is written).
- A turn's dispatch preparation builds a bundle that includes the thread's
  checkpoint at version N; the turn's **own user message** was captured at
  append and its capture job runs in the memory worker meanwhile.
- If the worker finishes inside the dispatch window, acceptance
  (`deliverMemoryDisclosure` → `hydrateMemoryRecord(checkpoint, N)`) finds
  version N archived and throws; `guardTurnDispatch` stops the already-started
  provider turn and the bot ends with the activity
  `error: MEMORY_CONTEXT_REVOKED`. The same guard fires pre-dispatch
  (`assertMemoryAccess`) when the policy revision moves, e.g. a bot is created
  while another bot's turn is being prepared.

It is intermittent (10 sequential plain turns: 0/10, 0/10 on the candidate;
0/10, 1/10 on the base) and more likely when the window is long (two bots, a
slow engine, output publication): 3 incidents across the three joined runs,
1 in one human-spec run. A re-sent turn succeeds. It is **not** a 0.1.52
integration regression (the base shows it), but it is user-visible on every
platform and the lease leak it exposed (§3.3) was real.

**Recommendation:** the memory owner should treat a checkpoint superseded by
the turn's own capture as staleness, not revocation — either exclude the
current thread's checkpoint from the bundle, or retry dispatch preparation once
with a fresh bundle when `assertCurrent`/`accepted` throws
`MEMORY_CONTEXT_REVOKED` before the provider produced output. Both keep the
fail-closed semantics for policy/deletion changes. Repro: the probes in the
session scratchpad (`lease-probe.ts`, `revoke-rate.ts`, `restart-probe.ts`)
or the joined driver with memory active.

### 4.2 Two comms tests fail at the base and on the candidate

*finalizes a delegated turn interrupted by provider reload* and *queues eight
helpers in one turn and runs no more than four together* (`expected 3 to be 4`
within a 30 s deadline). Timing-bound fake-ACP-fleet tests; identical at
`acaee1db`. Not investigated here.

### 4.3 Fixture note (not a product defect)

With memory active the bundle quotes earlier owner statements, so a fake-engine
directive in an earlier prompt (`__fixture_hold_authority__`) reappears in later
prompts and holds them. The joined driver releases the artist's post-restart
turn through the fake's per-process finish gate for that reason; the human
specs only ever hold that bot deliberately.

## 5. Unmerged lanes

`git branch --no-merged HEAD | grep lane/0152` lists exactly one branch:

- **`lane/0152-LINUXFIX`** (`bbc1d3a3`, 6 commits since the LM2 merge, all
  `installer/`): `tailscale up --reset` for a repairable enrolment, the unit
  grants the data dir's parent, `murage status --service-user`, `start` waits
  for tailscaled, an unattended run refused for a missing input creates no data
  dir, README exit-code table. Touches only `installer/**` (408+/46−), which
  no merged lane changed after that point. The lane brief said "Lanes not
  merged: []", so this is recorded, not merged: root should merge it before
  the F2-T6 VPS/DNS/TLS gate, since that gate exercises exactly these fixes.

All 47 other `lane/0152-*` branches are ancestors of the candidate.

## 6. Remaining gates (nothing below was run or waived here)

| Gate | Owner | State | What it needs |
|---|---|---|---|
| Local vitest green | root | **open** | 15 pre-existing failures (§2.1) plus the two comms timings (§4.2). Runbook A3 says the release branch must be green locally before dispatch; either fix or record an explicit waiver per file. |
| `MEMORY_CONTEXT_REVOKED` disposition | memory owner | **open** | §4.1 recommendation; or an explicit "ship as is" with the re-send guidance in the notes. |
| `lane/0152-LINUXFIX` merge | root | **open** | §5. |
| README "Latest release" | Q1-T4 / SD | **open** | `README.md:23` still names 0.1.47; `docs/releasing.md` requires the README review in both `FerroxLabs/murage` and `murage-releases` before publication. |
| Paid image check (F1-T5 `$`) | SD | **not run** | U-10: one live call per provider (OpenAI, xAI, OpenRouter) with a synthetic 256 px input and a spend cap set by Sean. Everything image-related here used the fixture provider. |
| VPS / DNS / TLS matrix (F2-T6) | VPS/CF | **not run** | Private VPS + Tailscale door 8813 (U-19), `--service-user`, nonce-bound `/api/health` (U-20); needs the LINUXFIX merge first. |
| Cloudflare broker + control-plane deploy (F3-T5, D1/D3/D4) | CF/Composio | **not run** | `broker:test` and `control-plane:test` pass in source; deploy only a candidate derived from preserved `f2125411` (U-23); migration 0006 if needed is its own CF gate (U-22). The FluxRouter-hosted broker (FLUXCOMPOSIO) needs its live claim/confirm legs proven. |
| Native Mac helper exit / Keychain / permission smokes (R2-T4 MAC, R2-T5 KC, S1-T2/T3 MAC) | Mac | **not run** | Electron binary not downloaded in this worktree; `test:electron` covers the node side only. |
| Windows installed / taskkill / codec checks (R1-T2 WIN, F5-T3 WIN) | Windows runner | **not run** | Per-platform codec claims for MediaPlayer (F5-T3) and the installed-app checks in the Windows runbook. |
| Mac signing + notarization | SD (Keychain, App Store Connect API key) | **not run** | Runbook §2: `pnpm package:mac` with the Developer ID cert in the login Keychain; `latest-mac.yml` must list all four mac files. |
| Windows signing | SD (Azure Trusted Signing env) | **not run** | Runbook §3: every `.exe` under `release/` carries a valid Authenticode signature; `app-update.yml` `publisherName`. |
| 21 assets / feeds / hashes | root + SD | **not run** | Runbook §1 table sums to 21 files (its heading says 22 — reconcile against `gh release view v0.1.51` before the assemble job, which refuses anything missing or extra): 8 versioned mac files + `Murage.dmg` + `Murage-intel.dmg` + `latest-mac.yml`; `Murage-0.1.52-setup.exe` + `.blockmap` + `Murage-setup.exe` + `latest.yml`; `.deb` + `.AppImage` + their stable names + `latest-linux.yml` + `SHA256SUMS-ubuntu-x64.txt`. |
| Publication approval | SD | **not run** | Separate approval per plan Q1; no deadline-based waiver, no partial release. Release notes draft `docs/plans/0152-RELEASE-NOTES-DRAFT.md` §1 must be refreshed against the frozen SHA (runbook A4). |

Nothing was pushed, deployed, packaged, signed or published from this lane.
