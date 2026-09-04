# Upstream sweep — EXECUTION PLAN (2026-09-04)

Companion to `UPSTREAM-SWEEP-2026-09-04.md` (the triage: what and why). This is
the how: lanes with disjoint file ownership, per-item acceptance criteria, the
rebrand table, the rules executors must obey, and the verification that gates
a merge. Written to be run by an Opus workflow (`UPSTREAM-SWEEP-2026-09-04.workflow.js`
sits beside this file) or by a person, item by item.

**Nothing in this plan is applied yet.** Landed before it: Fable 5.1 (`6b668c1f`).

---

## 0. Ground rules for every executor

1. **You work in your own git worktree on your own branch** (`sweep/<lane>`).
   You never touch `main`. You never `push`. You never `--force`, `rebase -i`,
   `reset --hard` anything you did not create. The orchestrator merges.
2. **Upstream is read-only.** `upstream/main` is fetched. Use `git show <sha>`,
   `git cherry-pick --no-commit <sha>` in YOUR worktree, `gh pr view <n> -R milind-soni/OpenMausBot`.
3. **One item = one commit**, message in this repo's prose style (what/why, cite
   `file:line`, name the upstream sha). Squash groups are named per item.
4. **Tests are the acceptance.** Run the named vitest paths. For every
   production change that a test covers, run the **negative control**: revert
   the production hunk, confirm the test goes RED with real failure text,
   restore, confirm GREEN. Controls sharing a rule are not independent — run one
   at a time. A control that stays green means the TEST is wrong.
5. **Verify by booting, not by tests, when the item changes what the harness
   serves**: `MURAGE_PORT=18877 node --experimental-strip-types server/index.ts`
   then `curl :18877/api/instances` (or the relevant route). Registering a thing
   is not creating a thing.
6. **Known flaky at baseline, not yours to fix:** `server/drivers/antigravity.test.ts`
   (stdin-size timeout), `server/index.test.ts` (assertion varies per run),
   `computer-proxy` (load). Re-run once in isolation before believing a red.
7. **`npx vitest` is rewritten to `rtk vitest` by a hook** and the summary line
   is filtered. Grep for `PASS|FAIL|Tests ` in the output; a 0-byte log means a
   running suite, not a dead one.
8. **The shell cwd resets** to `/Volumes/Mando/WaylandBots`. `cd` into the
   worktree at the start of every command.
9. **Threat model is absolute:** single-user, tailnet-only, no public ingress.
   Any new HTTP route that spawns a process or writes config deciding what gets
   spawned is gated `requestSurface(req.headers, url.searchParams) !== "desktop"`
   → 404, exactly like `server/index.ts:9472-9480`. No exceptions, no "later".
10. **No upstream identity ships.** No `OpenMausBot`, `omb`, `ogb`, `openmaus`,
    `milind-soni`, their Discord, their docs URL, `MausState`, `"maus"`. Grep
    your diff for each before you commit.
11. **Don't touch what isn't yours.** Files owned by another lane (table in §2)
    are off limits. If an item needs one, stop and report — do not improvise.

### Rebrand substitution table (apply to every upstream hunk)

| upstream | Murage |
|---|---|
| `OMB_*`, `OGB_*`, `OPENMAUS_*` env | `MURAGE_*` |
| `~/.openmausbot`, `.openmausbot` | `~/.murage`, `.murage` |
| `omb-` tmpdir/test prefixes | `murage-` |
| `<openmaus-goal>` | `<murage-goal>` |
| `runOn: "maus"` | `runOn: "ember"` |
| `MausState`, `MAUS_COLORS` | `EmberState`, `EMBER_COLORS` |
| UI noun "MAUS" | "Ember" |
| `src/types/ogb.d.ts`, `window.ogb` | `src/types/muragebox.d.ts`, `window.muragebox` |
| `window.__ombBrowser` | `window.__murageBrowser` |
| `/opt/ogb`, `/opt/OpenMausBot/openmausbot` | `/opt/muragebox`, `/opt/Murage/murage` |
| `milind-soni/openmausbot-releases` | `FerroxLabs/murage-releases` (via `RELEASES_PAT`) |
| `RESERVED_MCP_NAMES` `"ogb"`, `"openmausbot_connectors"`, `"openmausbot_phone"` | read our current list in `server/config.ts` and match it |

### In-flight Murage work you must not regress

| work | commit | rule |
|---|---|---|
| Composer is now TWO ROWS (textarea on top, controls row beneath, send/mic `ml-auto`) | `096ac113` | Any composer hunk is placed against THAT layout. The Goal chip is at `Composer.tsx:771-786`, below the textarea. Pickers are `absolute bottom-full` and unaffected |
| Composio is own-key only; managed broker plan dropped | `771d55df` | Do not touch `server/composio.ts` `activeBroker()` or the Connections card |
| Service worker + PWA install | `489de0e2` | Do not touch `public/sw.js`, `src/lib/register-sw.ts`, `companion/src/routes.ts` |
| Voice route + 10s billing floor | `a67f1972` | Do not touch `server/voice/*` |
| Fuigo is the default engine, via `server/drivers/acp/core.ts` | — | Any change to `acp/core.ts` or `server/testing/fake-acp-cli.ts` runs `server/drivers/acp/fuigo.test.ts` AND `server/drivers/acp/acp.test.ts` as acceptance |
| Flux image tool is UNSTARTED | — | The image chain (items 9-10) is its foundation. Do not build the tool in this sweep; do leave `assistant_image` as the contract |
| Model catalogs updated today (Claude/Gemini/Codex/Box) | `6b668c1f` `286ff5d0` `d5e63256` + codex | Do not edit `STATIC_*_MODELS` lists |

---

## 1. Items, grouped into lanes by disjoint file ownership

Lane = one worktree, one branch, one executor, items in the order shown.
Items are numbered as in the triage doc so the two can be read together.

### LANE S — `sweep/server` (SERIAL; owns `server/index.ts`)
Owns: `server/index.ts`, `server/index.test.ts`, `server/notify.ts`, `server/workspace.ts`,
`server/workspace.test.ts`, `server/delegations.ts`, `server/delegations.test.ts`,
`server/screen-frame-gate.ts` (new), `server/generated-image.ts` (new), `server/store.ts`,
`server/contracts.ts`, `src/state/store.tsx`, `src/components/ChatView.tsx`,
`src/components/GroupView.tsx`, `src/components/Composer.tsx`, `src/components/ComposerQueuedMessages.tsx` (new),
`src/lib/composer-commands.ts` (new), `server/drivers/codex.ts`, `server/drivers/codex.test.ts`.

| # | item | sha(s) | acceptance |
|---|---|---|---|
| 1 | MEMORY.md atomic write | `006c977f` + `7fa78666` squash | `workspace.ts:39,:103` use `writeFileAtomic` from `./atomic.ts`. Test: `server/workspace.test.ts`. Control: revert one call → the new atomicity test red |
| 2 | Screenshot settles only when screen changed | `48ed8acb` | New `server/screen-frame-gate.ts` + test. `index.ts:1873` poke uses `touchesScreen()`; `:2592` no longer unconditional; `finalScreenFrame` refuses identical hash. Tests: `server/screen-frame-gate.test.ts`, `server/index.test.ts` (run twice if red). Boot check: not needed |
| 3 | "Bot couldn't start" notification | `2689be08` + `bfe6df25` + `bb0a36d9` **as ONE commit** | `notify.ts` gains `turn-failed`; catch at `index.ts:~3228` notifies only when `automationSource === undefined && !commsDepth && !cardContinuation`; body wrapped in `redactSecretsInText`. Drop `bfe6df25`'s test hunks for the two cloud-desktop tests we don't have. Rebrand `OMB_COMMS_TOKEN`→`MURAGE_COMMS_TOKEN` in the new test. Control: remove the redact wrapper → the redaction test red |
| 8 | Delegation live status (STATUS HALF ONLY) | `e1f4207e` partial | Take: `startedAtMs` on `delegationWatch`, `summarizeDelegatedActivity`, `formatDelegationElapsed`, the `check_delegation` payload (`index.ts:~6205`), `agents-proxy.ts` rendering, the two prompt-copy edits. **Do NOT take** `wakeDelegationSource`, `pendingDelegationWakes`, `drainDelegationWakes`, `DelegationWakeBudget`, `buildDelegation*Prompt`. **Delete outright** the `console.error(\`[omb-turn] …\`)` line — it logs 70 chars of every prompt. Tests: `server/delegations.test.ts` (adapt EOF-append), `server/index.test.ts` |
| 9 | Generated images + composer queue | `8be0d3fb` | New `server/generated-image.ts`; `assistant_image` in `contracts.ts`; `Message.attachments` in `store.ts` + `state/store.tsx`; `generatedImagesByTurn` staging folded on `turn.completed`; codex log redaction. Ghost-tail moves from `ChatView.tsx:~1602` / `GroupView.tsx:~1349` into new `ComposerQueuedMessages.tsx` rendered inside the Composer's controls row region — place it ABOVE the textarea in our column layout. `codex.test.ts` conflicts: our file is reworked (+158); re-apply the two image cases by hand. Tests: `server/generated-image.test.ts`, `server/drivers/codex.test.ts`, `src/components/*.test.ts`. Typecheck must pass |
| 10 | ACP image blocks | `e8869da2` | ONLY after #9 (false-clean: references `generatedImagesByTurn`). Adds `image` mode to `fake-acp-cli.ts` — coordinate: LANE E also edits that file (#7). Rule: LANE S lands #10 first; LANE E rebases #7's `| image` doc-token conflict onto it. Tests: `server/drivers/acp/acp.test.ts`, **`server/drivers/acp/fuigo.test.ts`** |
| 11 | Composer slash menu `/goal` `/learn` | `3ba0ba0d` + `eac313db` squash | New `src/lib/composer-commands.ts` + test. `pickerOpen`→`mentionPickerOpen` at `Composer.tsx:309,557,698`. Goal-chip hunk hand-placed at `:771-786` (content is position-independent). `effectiveText`/`effectiveChannelMode` replace `text`/`channelMode` at `:289,377,409,425,435,438`. The listbox is `absolute bottom-full left-2`; verify it renders above the whole two-row bar. Tests: `src/lib/composer-commands.test.ts`, `src/components/` suite. **Manual check:** open the app, type `/` in a room, see the menu; type `/goal x`, chip lights |

Order inside the lane is fixed: 1 → 2 → 3 → 8 → 9 → 10 → 11. #3 before #8 (same catch block). #9 before #10. #9 before #11 (both edit Composer).

### LANE E — `sweep/engines` (parallel with S; owns ACP core + picker)
Owns: `server/drivers/acp/core.ts`, `server/testing/fake-acp-cli.ts` (shared with S#10 — see rule),
`server/harness/registry.test.ts`, `src/components/ModelPicker.tsx`.

| # | item | sha(s) | acceptance |
|---|---|---|---|
| 6 | Catalog refresh button + offline hardening | `3ab2426d` → `4a72db5a` | `ModelPicker.tsx:133` gains `refreshingRef` guard + button; `.catch()` keeps last catalog offline. Tests: `server/harness/registry.test.ts`, `src/components/` suite. Boot check: open picker, click refresh, no double-fire |
| 7 | ACP handshake timeouts + null `session/load` guard | `ed7a1515` adapted | `core.ts:~612` becomes `if (sessionResult) sessionId = cursor` (or equivalent); the four timeouts read `MURAGE_ACP_INIT_MS` / `MURAGE_ACP_SESSION_CONFIG_MS` / `MURAGE_ACP_SESSION_NEW_MS` / `MURAGE_ACP_SESSION_LOAD_MS` (name them after upstream's, prefix swapped) with defaults **60_000–90_000, not 300_000**. Test: `server/drivers/acp/acp.test.ts` (add a case: `session/load` returns `null` → `session/new` is called). Control: revert the guard → that case red. Then run **`fuigo.test.ts`** and `hermes.test.ts`. If LANE S has landed #10, rebase the `fake-acp-cli.ts` doc-comment conflict onto it; otherwise apply and let S rebase |

### LANE D — `sweep/desktop` (parallel; owns electron/ + scripts + CI)
Owns: `electron/main.mjs`, `electron/window-state.cjs`, `electron/desktop-viewer-permissions.mjs` (new) + node-test,
`scripts/prepare-cloudflared.mjs`, `.github/workflows/*`, `docs/releasing.md`.

| # | item | sha(s) | acceptance |
|---|---|---|---|
| 4 | Windows `rmSync` retry on cloudflared staging | `509a34b2` | `prepare-cloudflared.mjs:265,:269` gain `{ maxRetries: 10, retryDelay: 200 }`. Test: `node scripts/prepare-cloudflared.mjs --current` still stages. |
| 5 | Viewer permission policy + keyboard | `9f27177a` → `4eedf162` | New `electron/desktop-viewer-permissions.mjs` + `.node-test.mjs`; `main.mjs:~1279-1285` wires both handlers and `viewer.once("ready-to-show", …show(); focus(); webContents.focus())` with `isDestroyed()` guard. Test: `pnpm test:electron`. **Manual check:** open a Box viewer, type — keystrokes land in the viewer, not the composer |
| 13 | Calmer first-launch window | `7fc09de4` | `window-state.cjs` DEFAULT 1100×780, MIN 840×620; `main.mjs:~1563` imports `MIN_BOUNDS` instead of hardcoding. Test: `pnpm test:electron`. Taste item — skip if Sean says so |
| 21 | Release version prep | `2ba2dff0` HAND-PORT | New `.github/workflows/prepare-release.yml` rewritten for `FerroxLabs/murage-releases` + `RELEASES_PAT`, PR body says Murage; `release.yml` gains `push: paths: [package.json]` + `should_release` fail-closed guard + `ref: github.sha` + `fetch-depth: 0` on OUR single-step prepare job (`:56`); `ci.yml` gains `workflow_dispatch`. Acceptance: `actionlint` clean if present, else YAML parses; **no** `milind-soni` string anywhere in `.github/`. Do NOT run the workflow |

### LANE U — `sweep/sidebar` (parallel; owns Sidebar)
Owns: `src/components/Sidebar.tsx`, `src/components/SidebarMoreMenu.tsx` (new).

| # | item | sha(s) | acceptance |
|---|---|---|---|
| 12 | Fold utility rows behind one chevron | `de7f0232` | New `SidebarMoreMenu.tsx`; footer at `Sidebar.tsx:~1923-2016` restructured. **Keep our `desktop === true` gate on BOTH `SidebarPhoneButton` sites** (`:1981-1987`, `:2000-2006`) and the comment above them. Icon-rail density unchanged. Tests: `src/components/` suite. **Manual check:** both densities, failed-routine red dot shows on the trigger |

### LANE R — `sweep/routines` (SERIAL; runs AFTER LANE S merges)
Owns: `server/routines.ts`, `server/routines.test.ts`, `server/routine-requests.ts` (+test), `shared/routine-run.ts`,
`shared/routine-request.ts`, `shared/group-goal-run.ts`, `server/group-goal-run.ts`, `server/group-goal-run.e2e.test.ts`,
`server/group-goal-wait-cap.e2e.test.ts` (new), `server/room-chat-wait.e2e.test.ts` (new), `src/lib/turn-tail.ts`,
`src/lib/routines.ts`, `src/lib/routine-calendar.ts` (+test), `src/lib/sidebar-layout.ts`, `src/components/RoutineCalendarPage.tsx`,
`src/components/RoutineRunCard.tsx`, `src/components/GoalRunCard.tsx`, `server/bot-package.ts`, `server/calendar-calls.ts`,
`server/drivers/agents-proxy.ts`, `server/store.ts` (goal reconciliation only), **and `server/index.ts` — only after LANE S is merged**, plus `GroupView.tsx` for #17.

| # | item | sha(s) | acceptance |
|---|---|---|---|
| 14 | Durable room goals | `ac41eb81` + `2c4e5b70` + `bd59135e` squash | `RoutineTarget`, `patchMessage` goal card, `store.reconcileInterruptedGroupGoals`, `mdb.workingGoalRunMessages`, `waitForGroupGoalBot` + `AbortController`, `"paused"` status across `shared/group-goal-run.ts`, `GoalRunCard`, `RoutineRunCard`, `sidebar-layout.ts`. All `"maus"`→`"ember"`. Do NOT port the dead legacy loop. Tests: `server/routines.test.ts`, `server/group-goal-run.e2e.test.ts`, `server/index.test.ts`, `server/package-export.test.ts` |
| 15 | Wait cap + reassign | `cd67a557` | `MURAGE_GOAL_WAIT_MAX_MS` **default 5 min** (Sean's box is single-user; upstream's 30 is for teams), unref'd timer; `GROUP_GOAL_MAX_WAIT_EXHAUSTIONS = 3`; busy coordinator ends `blocked`. New `group-goal-wait-cap.e2e.test.ts` rebranded. Control: revert the cap → the cap test red |
| 16 | Rooms wait for busy member | `803ba1cc` + `f4a6b89a` + `d9099fbe` squash | **GATED: requires Sean's YES (recommended).** If not yet decided, skip #16-17 and report. `waitForGroupMemberBot` + `onWaiting` callback; responder loop at `index.ts:~4419` waits; `runGroupMemberTurn` threads `operation`. New `room-chat-wait.e2e.test.ts`. Tests as named + the 1:1-survives case |
| 17 | Name the awaited member | `ecf211aa` | `turn-tail.ts` `awaitedMemberId()`; `GroupView.tsx:~940-948,:977,:1330` presence. Only with #16 |
| 18 | Five-minute floor (part a ONLY) | `3e23961d` partial | 15→5 in `routines.ts:~380`, `routine-requests.ts:~102,264`, `calendar-calls.ts:~83,157`, `bot-package.ts:~100`, `agents-proxy.ts:~177`; `CALENDAR_SLOT_MINUTES` 15→5; `visualEnd()` in the calendar. **Do NOT take part (b)** (Automations/Sidebar/SettingsPanel/WebhooksPanel restructure). Tests: `server/routines.test.ts`, `server/routine-requests.test.ts`, `src/lib/routine-calendar.test.ts`, `server/bot-package.test.ts` |
| 19 | Interval schedules | `50ddda4d` + `75b7c154` (web hunks) squash | `{ type: "interval"; everyMinutes: 5-1440; anchorAt }`, `nextOccurrence`/`latestIntervalOccurrence`, overlap suppression, receipt realign, no `updatedAt` bump on ticks, `timeoutMinutes` 5-240 enforced in `tick()` via `interruptGoal`/`interruptTurn`, soft `MAX_RUNS`, live receipts bypass the 12-cap trim. `agents-proxy.ts`: field rename `duration_minutes`→`timeout_minutes` + `clear_timeout`. Skip every android/ios/docs path. Hand-port the interval hunks out of `routines.ts` — they interleave with #14's. Tests: all routines tests + `src/state/store.test.ts` + `server/drivers/agents-proxy.test.ts`. **Boot check:** create an interval routine via the API, confirm the next occurrence and that a running one skips the next tick |
| 20 | Interval editor | `e74e85c1` web hunk | `RoutineCalendarPage.tsx:~585-655` preset `<select>` + Custom, "starting <date> at <time>", generic date/time hidden for `interval`. Copy "aligned from"→"starting". **Manual check:** create a 5-min and a custom 37-min routine |

Order fixed: 14 → 15 → (16 → 17 if decided) → 18 → 19 → 20. If Chain A (#14-17) is deferred, #18-20 still apply but become a fuller hand-port of `routines.ts`.

### LANE M — `sweep/mcp` (SERIAL; runs LAST, after S and R merge)
Owns: `server/mcp-registry.ts` (new), `server/mcp-probe.ts` (new) + tests, `src/components/McpServersPanel.tsx` (new),
`src/components/PluginsPanel.tsx`, `docs/custom-mcp-servers.md`, `server/config.ts` (mcpServers refactor only), and route
registration in `server/index.ts`.

| # | item | sha | acceptance |
|---|---|---|---|
| 22 | Custom MCP server management | `074d2f7e` adapted | **DECIDED: take.** Port `mcp-registry.ts`, `mcp-probe.ts`, `McpServersPanel.tsx`, the `config.ts` refactor + `saveConfig` support. **Drop** `server/request-auth.ts` and its test entirely. Rebrand `RESERVED_MCP_NAMES` to our current list. **All six routes** (`GET/POST /api/mcp/servers`, `PUT/PATCH/DELETE /api/mcp/servers/:name`, `POST /api/mcp/servers/:name/test`) gated `requestSurface(…) !== "desktop"` → 404, same shape as `index.ts:9472-9480`. Tests: new `mcp-registry.test.ts`, `mcp-probe.test.ts`, plus a gate test: each route from a non-desktop surface → 404. Control: remove one gate → its test red. **Boot check:** from the desktop, add a server, `test` it, see tools listed; `curl` the same route with a phone surface header → 404 |

### NOT IN ANY LANE (defer/reject — do not touch)
`d2635669` (profile menu — needs Ferrox URLs), `ed2ddb69` (attachment previews — feature build), `e1f4207e` wake half,
`3e23961d` part (b), `6dbe5ae8`/`95d27799`/`54e3edfb` (antigravity stays as-is), `8a6aeee4`, `d8716d96`, `6420ab36`, `6de9eba2`,
`24fcea6c`, `3b63c4bc`, `79b0ff55`, `d3250783`, all `android/`, all `ios/`.

---

## 2. File-ownership matrix (collision guard)

| file | S | E | D | U | R | M |
|---|---|---|---|---|---|---|
| `server/index.ts` | **owner** | — | — | — | after S | after S,R |
| `server/drivers/acp/core.ts` | — | **owner** | — | — | — | — |
| `server/testing/fake-acp-cli.ts` | #10 | #7 (rebase onto S) | — | — | — | — |
| `src/components/Composer.tsx` | **owner** | — | — | — | — | — |
| `src/components/ModelPicker.tsx` | — | **owner** | — | — | — | — |
| `src/components/Sidebar.tsx` | — | — | — | **owner** | — | — |
| `src/components/GroupView.tsx` | #9 | — | — | — | #17 after S | — |
| `electron/main.mjs` | — | — | **owner** | — | — | — |
| `server/routines.ts` & friends | — | — | — | — | **owner** | — |
| `server/config.ts` | — | — | — | — | — | **owner** (mcpServers only) |
| `.github/workflows/*` | — | — | **owner** | — | — | — |

Phase 1 (parallel): S, E, D, U. Phase 2: R. Phase 3: M. Merge order into
`upstream-sweep-2026-09`: S → E → D → U → R → M.

---

## 3. Verification (per lane, then integration)

**Per lane, before reporting done:**
```
cd <worktree>
npx tsc -b && npx tsc -p tsconfig.server.json        # both must be clean
npx oxlint .                                          # clean
npx vitest run <the lane's named test paths>          # green
git diff main --name-only                             # ONLY files in your ownership row
git diff main | grep -iE "openmausbot|milind|omb_|ogb|openmaus|maus\"|MausState"   # must be EMPTY
```
Plus the manual/boot checks named per item. Report: branch name, commits (sha + item #), test counts, every negative control run with its failure text, anything skipped and why.

**Adversarial verify (separate agent per lane, read-only):** read the lane's full diff against `main`. Refute, don't confirm. Specifically hunt: an ungated route that spawns; upstream identity strings; a `"maus"` that survived; a `console.error` leak; a squash rule violated (e.g. #3's first commit landed alone); a test that passes without the production change; a file outside the ownership row; any edit to the in-flight-work files in §0. Verdict per lane: SOUND / FIX-LIST / REJECT.

**Integration (orchestrator, after every lane is SOUND):**
```
git checkout -b upstream-sweep-2026-09 main
git merge --no-ff sweep/server && git merge --no-ff sweep/engines && …   # in §2 order
pnpm typecheck && pnpm lint && npx vitest run                              # full suite
MURAGE_PORT=18877 node --experimental-strip-types server/index.ts &        # boot
curl -s :18877/api/instances | python3 -c "…fuigo present, models>0…"
```
Then Sean reviews the staging branch. Fast-forward to `main` is Sean's call, not the workflow's.

---

## 4. Decisions still open at write time

| # | item | default if undecided |
|---|---|---|
| 16-17 | rooms wait for busy member | **skip**, report |
| 13 | window size | take (taste; trivially revertable) |
| 5 | clipboard-read grant to Box viewer | take (needed for the viewer to type) |

Everything else is decided: enterprise rejected; antigravity stays as an option; MCP UI taken with the gate; peer-wake deferred.
