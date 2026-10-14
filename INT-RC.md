# INT-RC: Murage 1.0.2 release candidate merge (int/1.0.2-rc)

Base a615157df (merge-glue baseline). Merged in order: pubclean 8b2a1827f, upgui f4017aa48, wal3 46b1f0edf, pm-sends 0fa501d69,
lincold2 d94b0ffb4, evhand be4be3815, revbound cf8c9b1c7, turnctx 2793682f0, msearch2 6d7b21181. Local only, nothing pushed.

## Decisions (each a merge of intent, no silent guesses)
- Allowance API (lincold2) is the shape everywhere: `allowance` is the FIRST parameter (workingContext*, outputRootsBad, replayExclusions,
  capturedMessage*, copyOriginWithheld). turnctx's optional trailing allowance was moved first (its MERGE-NOTE option b); turnctx's `trigger` kept.
  working-context.ts = turnctx's file; judgeReply uses `capturedMessageVerdict(allowance,...)`.
- upgui's `why` out-param ("checking", large-set proofs in memory, notProvenYet) kept and threaded behind the allowance:
  `outputRootsBad(allowance, set, why?)`, `handleSound(allowance, handle, why?)`. upgui's background proof slice (proveSlice) pays from its own
  `LineageAllowance.warm(chunk*4+256)`.
- Memory schema: v8 = upgui (optional memory_disclosures_state and memory_scopes_owner indexes), v9 = lincold2 open-turns tables created empty
  (cold-lineage indexes gone). The v8->v9 step runs `MEMORY_SCHEMA` minus both optional indexes. `repairOutputRootBackfill` keeps upgui's generator
  and gains lincold2's `deadline`/`now`/`unfinished`. `openTurnsBound/openTurnsDiffer` added before validateMemorySchema; the open-turns check
  runs in the full (non-structural) branch. revbound's evidence-source index is dropped with the revocation index drop.
- Start-up: upgui's background upgrade wins over lincold2's blocking budgets (finishLineageStorageAtStartup budget/VACUUM cap, blocking search
  backfill). The `budgetMs/vacuumMaxBytes/now` options and STORAGE_STARTUP_BUDGET_MS remain in root-set-compaction.ts but start-up no longer calls
  them; lincold2 tests that pin those budgets are expected red and are lincold2/upgui to reconcile.
- Interrupted memory turns: lincold2's open-turns table (reconcile after listen) replaces upgui's rowid sweep call in index.ts; upgui's sweep
  functions stay exported in settlement.ts but index.ts no longer calls them (direct-turn sweep in store.ts kept).
- evhand moved the ask-bot, delegate-bot, check-delegation routes, finalizeDelegationWatch and deliverSharedResult into handoff-boundary.ts.
  pm-sends deltas ported there: handoffRequest id, authorizeWork "deliver" edge first then the result gate, finishHandoff transaction with
  completeRoomAsk/afterRoomCompletion ports, `request.id` as the receipt id, twin/repeated hand-off replies (`repeatedHandoffReply` now returns
  statuses), `source_deleted` in the queue refusal map. evhand statuses ported into pm-sends' dispatch: ending/diagnostic through SharedRun.finish,
  recordRefusedStart after a rejected startTurn, `receipt_*` statuses for the fixed receipt words (new keys receipt_deleted/restart/dismissed/
  unreadable/request_gone/uncertain/held_*; their words equal the old constants so stored receipts compare equal).
- result-egress source scan test removed (evhand replaced it with the type-level bot-egress checks); egress deps ask lineage under `LineageAllowance.tool()`.
- stale peer card sweep: upgui's open-card page sweep with EVENT_LIMIT_TOOLS (more_handoffs, more_new_bots) added to the kinds.

## Not guessed / open
- The full vitest suite has NOT been run on this commit (only the real 48 GB rig, per brief). Expect lane-own reds from the SEAMS.md tables.
