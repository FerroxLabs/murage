# RC11 inbox and upgrade progress

Owner: Codex, branch `codex/rc11-inbox`, base `7da331a56`. Coordinator owns commits and build host qualification.

## Contract

Fix the remaining GET `/api/inbox` cost across all card sources and the longest unchanged upgrade progress interval in `probe3.jsonl`. Preserve card contents, counts, access rules, and freshness after same-connection and other-connection writes. Bound request work independently of historical row growth, targeting about 20 ms of main-thread work and post-upgrade p95 below 50 ms. During active upgrade work, count completed work monotonically so progress advances within about 30 seconds. No invented progress during idle or blocked periods.

Only this worktree may be edited. No commits, deployment, owner-data writes, or changes to other performance lanes. The supplied data copy is inspected only with `sqlite3 -readonly`; the normal application data is excluded. Use isolated synthetic fixtures for executable checks. No UI copy or layout changes are planned.

## Packages and checks

1. Inbox: trace the route, base rollup, backup notices, lesson and procedure suggestions, waiting memory, and project decisions. Establish row counts and query plans on the supplied copy. Add cost regressions using statement and visited/returned-row counts at two data sizes, plus write invalidation and card equivalence checks. Run affected inbox and memory tests.
2. Progress: identify the flat interval from phase, ph, phases, storage, and adjacent server log offsets. Add a deterministic fixture that exercises the responsible step and proves completed-work movement and monotonicity with a controlled clock. Run affected lineage and upgrade progress tests.
3. Integration: server TypeScript check, focused lint, isolated server launch and inbox read through the documented control surface where the local environment permits. Record limits separately from source and fixture results. Real-data latency and build host verification remain with the coordinator.

Acceptance and these check categories are fixed before verification. Maximum eight cumulative rounds and eight unsuccessful corrections per package; after two unsuccessful rounds on one issue, obtain the required deeper evaluation before another correction. Stop when both fixes and required local checks are complete, or preserve a concrete unmet gate with evidence and the remaining attempt budget.

## Execution

- Diagnosis: inbox slow samples recur at 30-second intervals, matching the waiting-summary TTL. The copy contains 996 scopes, 186,697 records, nine candidates, zero lessons, zero procedure suggestions, zero project goals and zero work items. The refill prepared/executed a candidate read for each visible scope. Base cards use the existing projection, routine history has a 2,000-row window, backup notices use current requests, lessons seek bot/state, procedures seek their id range, and projects seek group/state.
- Probe plateau: the verdict's 120-second interval is writetime at 6,550,937 / 10,659,521, approximately t+307 to t+427 from the first probe. The log switches the deferred I/O source to memory-upgrade at byte 13,222, then to memory-idle at byte 15,261. The cursor position maps to U1 message rowid 102359, whose root set has 8,095 members. The marker reading also stays at 114,343 / 177,420 from t+487 to t+897 while the log records hundreds of thousands of frontier deletes. The verdict omits that trailing plateau because it breaks at the first post-upgrade probe without closing the open interval.
- Implemented: candidate-only optional index built by the existing worker; candidate-scope discovery and ordered indexed reads; waiting-cache keys include local writes, external commits and complete roster ownership. The pre-index fallback batches scope seeks into one SQL call and preserves results.
- Implemented: persisted marker work shared across connections and committed with the slice; health refresh independent of scheduling; throttled upgrade liveness slices every 15 seconds while owner activity still pauses execution; writetime counts completed rows/member pages instead of rounding their position.
- Inbox: round 2/8 completed, unsuccessful product corrections 0/8. Cost, freshness, schema and the complete existing review suite pass, including read-inside-transaction rollback (44 checks in the final group).
- Progress: round 4/8 completed, one successful product correction, unsuccessful product corrections 0/8. Astra High identified the missing final certificate publication before switching phases. The shared reporting helper corrects it; all 19 lineage-backfill checks now pass. Health ignores provisional transaction counts, and a held marker poll does not add completed work. Round 3 passed 49 checks and found one load-dependent fixture failure: the existing 1k/100k marker cost comparison allowed different work to finish inside an 8 ms real-time deadline. Pinning its clock makes both sizes execute identical work while retaining every row, statement and query-plan assertion. All 11 marker tests then passed. Four rounds remain.
- Local environment: no worktree dependency installation; Vitest 4.1.10 is available through the parent's read-only dependency tree. Loopback binding returns EPERM, so normal suite setup discovers zero tests. Database-only runs use a task-local config that stubs the unused port reservation and retains normal fixture isolation. The HTTP launch check is pending for the coordinator. Missing locked dependencies were restored from the existing content cache into this worktree only.
- Results so far: 24 passing checks in the first executable group; 67 passing checks in the second group; 77 passing checks in the broader group with one progress assertion failure and one suite import failure. These groups overlap where corrections required a rerun; do not add their totals as unique coverage.
- Frozen checks: new RC11 count/freshness/schema and progress fixtures; existing review, inbox equivalence/access/suggestions, lineage progress/backfill, marker and upgrade suites; server TypeScript and focused lint; isolated launch plus inbox HTTP read. Additional reruns only for invalidated checks.
- Final server TypeScript, focused lint and diff whitespace checks pass. No product code changed after those source checks. Temporary verification helpers and restored dependency copies are removed at handoff. No commits were made.

## Handoff report

| Work item | Status | Progress / pending work |
| --- | --- | --- |
| Overall execution goal | ⬜ Pending | Both fixes are implemented and locally verified; actual latency and cadence on the owner copy require coordinator qualification. |
| Inbox implementation | ✅ Done | Candidate-index reads, batched fallback, immediate write invalidation and transaction-aware caching. |
| Upgrade progress implementation | ✅ Done | Committed work counters, independent observation, 15-second throttled slices, correct final phase count, no progress from held polls. |
| Local checks | ✅ Done | Cost, correctness, progress, existing affected suites, server TypeScript and focused lint pass. |
| HTTP and build host qualification | ⬜ Pending | Local loopback bind returns EPERM; coordinator owns the real-data run and commits. |

### Causes

- **Inbox:** base `server/memory/review.ts:128` gathers every scope and `collect` executes a separately prepared candidate read for each visible scope. `waitingSummary` at base line 173 expires after 30 seconds. The probe's post-upgrade slow samples follow that cadence, while its ordinary samples are around 4 ms. The read-only copy has 996 scopes and only nine candidate records, all conversation facts. Their 12 evidence references total 4,367 payload bytes, with the largest payload 912 bytes. Historical scope enumeration and repeated SQL calls dominate this refill; the old cache also misses external-connection and in-place eligibility changes.
- **120-second progress interval:** base `server/memory/upgrade-background.ts:295` applies the I/O deferral as a complete pause. At t+307 the source becomes `memory-upgrade`; at t+427 it switches to `memory-idle` and writetime moves again. The unchanged reading was U1 at 6,550,937 / 10,659,521. `lineage-backfill` also rounded work within a message into 63 fractional steps, which could hide completed member pages.
- **Additional recorded marker interval:** base `server/memory/upgrade-background.ts:159` reads the tracker's old snapshot; its counter update was coupled to the deferred runner. The marker stays 114,343 / 177,420 for 420 seconds until the first completed probe, even while the log reports 776,184 frontier deletes in one minute and 579,355 in another. Base `server/memory/revoke-marker.ts:452` kept the work count only in a per-connection WeakMap. The verdict script fails to close this trailing interval when it encounters the completed probe, so it reports only the earlier 120-second interval.

### Every inbox source inspected

| Source | Route / implementation | Work on this copy and existing bound |
| --- | --- | --- |
| Base cards and counts | `server/index.ts:17594`, `server/inbox.ts:1051` | Derived inbox projection, indexed page reads and retained counts. Existing equivalence/access tests pass. |
| Routine cards | `server/index.ts:4887`, `server/inbox.ts:882` | Recent SQL window limited to 2,000 rows over 14 days; manager history retains 2,000 terminal runs plus outstanding work. Links use per-thread first/newest lookups. |
| Backup notices | `server/index.ts:1180`, `server/inbox-backup-notices.ts` | Current request map and a retained failure notice; keyed message lookups, no historical list read. |
| Lessons | `server/inbox-learning-suggestions.ts:17` | Zero lessons here; indexed bot/state selection, at most 50 returned per bot before the existing global lesson cap. |
| Procedure suggestions | `server/memory/procedure-landing.ts:434` | Zero `psug-` rows here; the earlier id-range fix remains in place. Its existing growth and cross-connection tests pass. |
| Waiting memories | `server/memory/review.ts:128` | The corrected source. New partial index excludes noncandidate history and identity rows, and orders each scope's existing 500-item window. |
| Project decisions | `server/index.ts:11392`, `server/project-goals.ts:639` | Zero goals/work items here; group/state indexes and open-card/branch lookups avoid completed project history. |

### Changed files

- `server/memory/schema.ts:542`: registers the eager optional candidate index with existing off-thread construction, exact-schema validation and downgrade handling.
- `server/memory/review.ts:128`: discovers only scopes with candidates; uses ordered candidate reads; caches against local write count, external data version and complete roster ownership. Reads within a transaction never publish provisional cache entries.
- `server/memory/lineage-backfill.ts:199`: counts completed rows and member pages; the cursor estimates remaining work, and the final certificate records its actual count.
- `server/memory/revoke-marker.ts:458`: persists marker work in the certificate cursor within the caller's transaction, preserving it across runners, pruning and reopen. Held-job polls consume execution budget without increasing completed work.
- `server/memory/upgrade-background.ts:158`: refreshes committed progress without running work; allows a bounded slice every 15 seconds under I/O deferral, still respecting owner work and the writer gate; publishes final writetime counts before marker begins.
- `server/inbox.rc11-cost.test.ts`: three new tests for cost, schema/fallback equivalence and write/ownership freshness.
- `server/memory/rc11-progress.test.ts`: four new tests for member-page counts, throttled scheduling, cross-connection progress with rollback/pruning/reopen, and held-job behavior.
- `server/memory/revoke-marker.test.ts:224`: controls the clock in the existing 1k/100k cost comparison so timing cannot change the measured operation.
- This record: contract, diagnosis, counters, evidence and handoff.

### Verification evidence

- Inbox/refill cost: with 1,000 then 10,000 historical scopes, records, retired lessons and unrelated procedure reviews, ten forced refills after external commits have identical statement and returned-row counts. Each ten-request sample has exactly 90 candidate-index visits and remains below 850 SQL read statements and 850 returned rows. No timing assertion is used.
- Correctness: same-connection text changes, external state/source changes, Later insertion/deletion, reads inside a rolled-back transaction, and roster/task reassignment all refresh immediately. Index-present and index-absent answers agree. Exact-schema validation accepts the index and downgrade registration removes it.
- Progress: a 12,000-member message reports 256 new completed work units per full member page and the exact short final page. Controlled-clock deferral runs one real slice per 15 seconds; 60 seconds of owner activity runs none. Health sees another connection's committed marker work at 10-second observations without running the upgrade queue. Both same-connection and external rollbacks add no published work. Pruning/reopen retain the count; held polls add none.
- Final affected groups: inbox plus full review suite **44/44**; progress/lineage/marker/background/status **50/50**, reusing 39 unaffected passes and the final **11/11** marker run. The earlier optional-index, writetime-schema, upgrade-fast, inbox equivalence/access and RC7 bounds group passed **67/67** with overlapping files; totals are not additive. Existing procedure range/cache, inbox card/backup/rollup, and lineage-within/movement checks also passed.
- `node ../node_modules/typescript/bin/tsc -p tsconfig.server.json --noEmit`: passed on the final source candidate.
- Focused `oxlint` on all eight changed TypeScript files: passed. `git diff --check`: passed.
- Vitest 4.1.10 database runs used `--configLoader runner` and a temporary config retaining `server/testing/setup.ts`. Its preceding setup stubbed only `freePortBlock` to 19600, because these fixtures open no listeners and the environment rejects the suite's otherwise unused port reservation. No networking tests are claimed by these runs.

### Remaining qualification

The actual p95 below 50 ms and about 20 ms main-thread target are **not measured after this change**. The coordinator should run the same owner-copy probes on the build host, confirm `memory_records_waiting_review` has been built, and check both completed-work counters and the longest identical progress signature, including the final interval ending at completion. This workspace cannot bind loopback, so no HTTP fixture or visual runtime result is claimed.

Before the optional index exists, the correct fallback still performs native indexed seeks across stored scopes inside one SQL statement. The index-ready path has the proven flat historical-growth cost. Work remains proportional to current candidates and live cards; the change preserves the existing output caps and does not omit owed items to obtain a faster result. Existing procedure reads remain proportional to the `psug-` range.

No production data was opened or changed. The supplied copy was used only through `sqlite3 -readonly`. All code/report edits remain in this worktree. No other speed lane, release integration, or commit is included.

## Gate review (Claude, 2026-10-14)

- Rollback: `memory_records_waiting_review` is a registered optional index (`optional-index.ts`), so the file stays readable by 1.0.2 with or without it (validation accepts the exact text from v8 on), the downgrade's transaction drops it first (`schema.ts` `dropOptionalIndexes`), and the v10 to v9 step drops `memory_lineage_cert` with the write-time tables, so neither the index nor the `markerWork` count ever reaches 1.0.1.
- `markerSlice` records `markerWork` only into a cursor that is JSON already or belongs to a ready certificate (`WHERE json_valid(cursor) OR ready=1`): an unstarted backfill treats any non-empty cursor as its own position, so its empty default cursor must never become `'{}'`.
- Follow-up for 1.0.3, not this release: the index text embeds `PIP_ALL_KINDS_SQL`; a build that changes that list must accept (and rebuild) the older text, or a 1.0.2 file is refused at open.
