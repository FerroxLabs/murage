# INT-RC2: Murage 1.0.2 release candidate 2 (int/1.0.2-rc2)

Base 48b9a76db (fix/1.0.2-writetime: RC f0559322c + S0 contract + revbound r3, see wt-s0/MERGE-REVBOUND.md).
Merged in order, one merge commit each: upgui e8ee52160, rigfix 6d2a00c50, evhand 2a79e4ba3. Local only, nothing pushed.
Rules carried from INT-RC.md: the lincold2 allowance API is the shape everywhere (`allowance` first parameter); both sides' behaviour kept.
After each merge: both typechecks (`tsc -p tsconfig.json`, `tsc -p tsconfig.server.json`) on build-host via hz-test.sh. Full suite not run here.

## 1. upgui e8ee52160 (2 commits past f4017aa48: c83ebe735, e8ee52160)

| File | Resolution |
|---|---|
| `server/memory/replay-lineage.ts` badSets | upgui's time-boxed-slice deferral (a set over one chunk not proven whole -> `deferSet(id, true)`) kept before the handle read; the handle read keeps the RC's `allowance.meter(threadId)`. |
| `server/memory/replay-lineage.ts` replaySetBad | upgui's `chunkBad` and `deferSet` helpers and its proven-as / large-or-boxed deferral; RC's `keepEntry = keep` parameter kept on the signature; RC's `rowsOf` ("x" deps of every set read) kept alongside upgui's `memberWork` count and `yieldIfLate()`. |
| `server/memory/replay-lineage.ts` judgeCapturedMessages | Both guards: a batch's verdicts are kept only when no allowance limit was hit (RC `limitHits`) AND no set was deferred only for a slice's time box (upgui `boxDeferred`); `noteUnkept` stays silent for either. |
| `server/memory/replay-lineage.ts` proveSlice | upgui's reader-aware chunk loop (per-reader proofs, `LineageYield`, waits on nested proofs, Q-key handoff) with the RC's per-chunk `LineageAllowance.warm(chunk*4+256)`, passed to `lineageJudge(allowance, ...)` and `flatRootsBad(allowance, ...)` and closed in the finally. |
| `server/memory/replay-lineage.ts` sourceAwaitsProof | Takes the allowance first; answers through `capturedMessageVerdict(allowance, ...)` so revbound's positional rule (withheld, proven) is never "awaiting proof". |
| `server/memory/consolidate.ts` | RC's `LineageAllowance.tool()` and `reply-unchecked` reason (allowance ran out -> retry in 60 s) plus upgui's retry when the reply waits for a large-set proof (`reply-withheld` with `retryAfter`). |
| `server/memory/schema.ts` | RC's downgrade signature (to 1..9, from up to v10) kept; `UPGRADE_DERIVED_TABLES` gains upgui's `LEGACY_UPGRADE_TABLES` (the preview proof table). |
| `server/installation-database-snapshot.ts` | Reference schema creates upgui's legacy upgrade tables AND keeps the RC's `initializePendingDelegations` (evhand). |
| `server/index.ts` | RC's `ownerTurnLive` helper and `onReady` log kept; the revocation backfill's `busy` also yields to `ioBudget.shouldDefer("memory-upgrade")` (upgui). |
| `server/memory/upgrade-fix-r9.test.ts` (new, upgui) | Ported to the allowance API: `retainedSessionInvalid(LineageAllowance.turn(1e9), ...)`, `replayExclusions(LineageAllowance.tool(1e9), ...)`, `capturedMessageWithheld(LineageAllowance.tool(1e9), ...)`. Assertions unchanged. |

Typecheck: app OK, server OK.

## 2. rigfix 6d2a00c50 (77d4ec7d6, 6d2a00c50 past the RC)

No conflicts (scale rig files only). Typecheck: app OK, server OK.

## 3. evhand 2a79e4ba3 (d39bb090e, 09e3bfab6, 62045d0b0, 2a79e4ba3 past be4be3815)

Merged whole, as asked. Its lineage plumbing (turn sources, ranges, the hold log `turn_source_holds`/`turn_source_copies`, `rangeHolds`)
is superseded by the write-time slices (DESIGN-WRITETIME 7: "`textHolders` overlap as the privacy basis" closes in S2 by prefix carry).

| File | Resolution |
|---|---|
| `server/steer-lineage.ts` | evhand's `RunningTurnLineage` (`botId`, `sources`, `ranges`) and its new functions (`turnSources`, `addSourcesToRunningTurn`, `addRangesToRunningTurn`, `addShownToRunningTurn`, `runningTurnSources/Ranges`, `promptForTurn`, `beginTurnLineage`); the RC's `ShownLine.quoted`, `RenderedWithheld` and `shownLinesRoots(allowance, lines, renderedWithheld?, threadId?)` kept. Steer fence: RC's allowance and `.finally(close)` plus evhand's `addSourcesToRunningTurn` for the quote. |
| `server/room-transcript.ts` | evhand's always-bounded room read (no `WHOLE_ROOM_MESSAGES`/`largeReceiptThread` branch; `promptCandidates` walks newest-first with `WALK_ROWS` and fetches pin/quotes `byId`; `whole` option for a direct window) with the RC's allowance first parameter, `checking` set and `threadHasForgottenSource` gate. |
| `server/index.ts` | Imports: both (evhand's steer-lineage and turn-source-holds names); `writeActivityRow` dropped from the index import (its users moved to handoff-boundary.ts in the RC). `roomTranscriptWithoutMemory` call sites: RC allowance + `renderedWithheld`/`roomRenderedView` kept, evhand's `{ whole: true }` / `{ byId }` options added. Shared request turn: RC's `beginSharedRun(request, claim)` kept (pm-sends x evhand glue from INT-RC), the prompt now built through evhand's `promptForTurn`. |
| `server/database.ts` | upgui's start-up shape kept (only the migration blocks; history reads in the background). evhand's `initializeTurnSourceHolds` runs right after `initializeMessageTables`. evhand's one-time `backfillTurnSourceCopies` (one read of every message row) runs in the blocking section beside the legacy delegation import, under `upgrade.blocking("backfill", ..., "indexing")` with its heartbeat, skipped once its marker is set. Until it runs a turn's conversation is named line by line (fail closed). |
| `server/memory/forget.ts` | revbound's bounded forget (`applyForgetTombstones` on this forget's `ended` targets, the rest in the job) kept; evhand's `holdForgottenSources` holds the target and the inline `ended` sources. |
| `server/memory/memory-revocation.ts` (no conflict, follow-up) | `supportingTombstones` with a job also calls `holdForgottenSources` for the sources it ends, so sources past the inline rows are held too (evhand's rule over revbound's job split). |
| `server/added-table-lifecycle.ts`, `server/installation-app-schema-downgrade.ts` | Union: RC's entries plus evhand's `turn_source_copies` (trigger-kept) and `turn_source_holds` (marker), its 4 triggers and 2 indexes. |
| `server/installation-database-snapshot.ts` | Reference schema: RC's initializers (integrity pass, upgrade app tables, legacy upgrade tables, pending delegations) plus `initializeTurnSourceHolds`. |
| `server/room-replay-limit.test.ts` | evhand's assertions (only the prompt window is checked, at most 31 lines) with the RC's `LineageAllowance.tool(1e9)`. |
| `server/handoff-r10.test.ts` (new, evhand) | Ported to the allowance API (`LineageAllowance.tool(1e9)` first). Assertions unchanged. |

Typecheck: app OK, server OK.

### evhand overlap with the write-time slices (files both change; merge-time attention)
- S1 (ddef19b74): `server/index.ts`, `server/steer-lineage.ts` (turn lineage begin/steer; S1 owns both).
- S2 (4247d3a2e): `server/project-cards.ts`, `server/project-memory-tools.ts`, `server/project-notes.ts`, `server/room-transcript.ts` (evhand's note recorder and `textHolders` basis; S2 replaces the basis with prefix carry).
- S3 (2878c997a): `server/memory/forget.ts` (evhand's `holdForgottenSources` call sits where S3 writes the deny marks).
- S4 (b2d827594): `server/result-egress.ts` (evhand's copy walk; S4 swaps steps 2-3 for `denyLookup`).
- S5: none. evhand-only lineage files S6 should delete with the rest: `server/turn-source-holds.ts`, the range parts of `server/released-text.ts`.

## 4. Conflict forecast for the lanes still in progress

`git merge-tree --write-tree --name-only HEAD <lane head>` against this branch head (lane heads as of 2026-10-12):

| Lane | Head | Files that conflict |
|---|---|---|
| wal3 | b1f14b645 | none (clean) |
| pm-sends | 7f28cf52b | `server/index.ts`, `server/shared-provenance-schema.ts` |
| msearch2 | 5e16ad19c | `server/index.ts`, `server/memory/schema.ts`, `server/memory/pip-p2-b1.test.ts`, `server/provider-route-submission-join.test.ts`, and the scale rig against rigfix: `scripts/scale/{budgets.json,gate.mjs,gate.test.mjs,rig-config.mjs,rig-config.test.mjs,rig.mjs,run-container.sh}` |
| hotpath | 1cd49da8c | `server/database.ts`, `server/index.ts`, `server/installation-restore-preparation.ts`, `server/message-db.ts` |
| bgwork | 1631cf018 | `server/index.ts` |
| turnctx | 41101333d | none (clean) |
| writetime S1 | ddef19b74 | `server/index.ts`, `server/steer-lineage.ts` (evhand's turn lineage) |
| writetime S2 | 4247d3a2e | `server/project-cards.ts`, `server/project-memory-tools.ts`, `server/project-notes.ts` (evhand's note recorder) |
| writetime S3 | 2878c997a | none (clean; `forget.ts` auto-merges, check the `holdForgottenSources` line by hand) |
| writetime S4 | b2d827594 | `server/memory/consolidate.ts` (upgui's `sourceAwaitsProof` retry), `server/result-egress.ts` (evhand) |
| writetime S5 | d7639aa8b | none (clean) |

## 5. MERGE-REVBOUND open item: p05 Q12 (fixed)

Cause: `closeDatabase()` stops the WAL checkpointer without waiting (`void stopWalMaintenance()`, wal3). The checkpointer's connection is then
the last one and checkpoints as it closes, so (a) the original's main file changes after `originalHash` was taken, and (b) a read of the original
right after the close can meet "database is locked" (seen while fixing: the sibling test "does not resurrect deleted records" read 0 merged rows
the same way). Fix in `server/memory/p05.test.ts`: every close is followed by `await stopWalMaintenance()` (beforeEach, the restore test, Q12),
the same pattern message-search-restore.test.ts uses; and Q12 compares the original by what SQLite reads (user_version, application_id, schema,
every row, through a read-only connection that never checkpoints) instead of the main file's bytes. The archive (a `backup()` copy, no WAL)
keeps its byte hash. Assertions otherwise unchanged. Result: p05.test.ts 4/4 then 6/6 passing (all 9 tests each run).

## 6. MERGE group from RC-FAILURES.md (MurageMain, 2026-10-12)

| # | Item | Cause found | Fix | Result |
|---|---|---|---|---|
| 1 | comms e2e 12/13 + dispatch family | NOT pm-sends x evhand glue. turnctx 6fc6fc930 (in the RC) stopped remembering that an engine build sends no MCP-ready notification, so every first prompt of a silent build waits the full `MCP_REQUIRED_WAIT_MS` (15 s). The fake ACP CLI sends none by default; every fake Grok turn sat 15 s after `session/set_model`, past the tests' windows (traced: fake stdin log, server events, no `/api/internal/*` call from B). turnctx's head 41101333d does not fix it (its fake connect mode is opt-in; comms stays 12 red with it merged). | Fixtures make the fake Grok engines announce `_x.ai/mcp_initialized` as the real Grok Build does (`GROK_MCP_READY`): comms, steer-queue, branching, project-review-engine-api. Production code unchanged. | comms 36/37; steer-queue, branching, project-review-engine-api green; event-limit green |
| 1b | delegations "1.0.1-shape queue" | pm-sends imports delegations.json once, when messages.db opens; the evhand test wrote the file after the open | test closes messages.db (and waits for the checkpointer) before writing the file | green |
| 1c | project-lifecycle-api (4) | ECONNRESET only when run beside other files; passes alone and in the isolation set | none | green |
| 2 | desktop-only routes 404 | `--import` (the fixture instrumentation) is inherited by every worker thread the server starts (WAL checkpointer, counts worker): the fixture ran again in each, a second Store made a second fixture bot and overwrote the fixture file with ids the server never loaded | `scripts/control-murage.ts`: the preload imports the fixture source in the main thread only | thread-snooze, task-activity, incident-diagnostics green; thread-paging 19/20 |
| 3 | scans of index.ts for moved code | code moved to handoff-dispatch.ts / handoff-boundary.ts / shared-work.ts, or gained its kept status | re-anchored, same strictness: bot-egress.allowlist (recordRefusedStart), pm-sends-102-r27, handoff-r9 R9-04 and F3, send-state-r6, send-steer-r7. handoff-boundary.ts no longer imports database.ts (new `handoffRequestId` port) | all green except the row_could_not_start scan (see open) |
| 4 | lifecycle and downgrade | upgui's app_rev_* temp triggers outlived app_write_revision; turnctx's artifacts_bot_date and project_work_items_assignee were unlisted; pm-sends' shared_ready_teams and shared_drain_sweep had no lifecycle or fence entry | downgrade drops the counter triggers first and lists both indexes; lifecycle entries; RESTORE_NOT_PENDING_WORK entries | added-table-lifecycle, pm-sends-102-r21, r22, restore-fence green |

Isolation set (thread-snooze, task-activity, comms, steer-queue, delegations, room-responder-pin, project-lifecycle, event-limit, pmup-r2) on
9ee41e0fd: 7 files green; 2 red, both outside the MERGE group:
- comms "mirrors a delegation that could not start into the channel" and bot-egress.allowlist "row_could_not_start": pm-sends lane-own. No code
  emits `row_could_not_start` any more; the source chip of a hand-off that could not start is gone. Red on pm-sends 0fa501d69 and on its current
  head 7f28cf52b alone.
- room-responder-pin crash recovery: SEAMS B (lincold2 x upgui start-up), left as asked.
- thread-paging "a page that reaches back to the open request card" (1 of 20): the open-card index is built in the background since upgui; upgui-own.
Typechecks on 9ee41e0fd: app OK, server OK.
