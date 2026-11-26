> Binding amendment: RULING-l8-1019.md (2026-11-10) overrides this historical r2 text. Slice 0 is seated by the l8r0 task. The original F7 review is recovered in evidence/F7-review-original.md and mapped in evidence/l8-provenance.md. Schema/type stubs belong to the separate Slice I0. All implementation and final proof gates remain open for their assigned slices.

# L8 TURN-STATE build brief, revised for odr2-l8
Revision: r2 plus binding RULING-l8-1019; Slice 0 seated as l8r0. Final implementation review remains required before release.

Companion and normative contracts: [DESIGN-r2.md](DESIGN-r2.md). This replaces the r1 deferred implementation brief. No code changes or tests were performed in this design job. All scope, performance, historical proof and G9 gates remain mandatory.

Port onto `c12aaad9341e8f87126a193f35b5c2768f0aa66f`. Recover L4B code from `571b3212b`, F7 draft from `304e59c7b`, M2 tests/history from `13315e2a7`, and L13 comparison fixtures from `5b0a0a1eb` / `19ef45264`. `29f17944b` is proof provenance only; `7c5cbfc3e` is unverified history. Never merge a span-era tree wholesale. Current lifecycle/security/restore contracts take precedence.

The original F7 review is recovered verbatim in `evidence/F7-review-original.md`; `evidence/l8-provenance.md` maps all six High and eight Medium/Low findings to the binding ruling and named tests. M2 r1.3 remains rejected. Ruling R1 supersedes the missing-review prerequisite, R2 the resend compatibility contract, R3 retained-context downgrade, R4 the separate schema Slice I0, and R5 the seating order.

The first build-job test execution is the entire `src/e2e/help-ask-fixture.human.spec.ts`, including 7b, with its matching fixture/config, against a packaged help-fixture Electron app under xvfb in a Hetzner container. A launch failure is blocked baseline, not behavioral RED. Record source/package/config identities. L13 rows 5/8 remain NOT FIXED until the final combined-head proof is reviewed.

One integration owner owns every shared schema edit and `server/index.ts`. Parallel seats are future builder allocations, not agents launched during this design job. The following test matrix and final slices are reproduced from DESIGN-r2 for a self-contained builder handoff; contract sections referenced below are in DESIGN-r2.

## 10. RED-first matrix and acceptance evidence

All base-RED claims below are predictions from source reading, NOT RUN. A test must reach the behavioral assertion on `c12aaad9341e8f87126a193f35b5c2768f0aa66f`; missing imports/routes/harness startup cannot count as the behavioral failure. Restore/recover a compatible harness first. R = expected behavioral RED on this base; G = regression that may already pass; M = mutation proof; P = measurement/historical acceptance, never advertised as base RED. Every row names the future test file exactly; new files are proposals, not claims that they exist now.

| Test names | Exact file(s) | Assertion and evidence class |
|---|---|---|
| ISO-11, ISO-12, ISO-15 | `server/ux-l4b-isolation-api.test.ts` | Admission queues behind Help; held ordinary steer rechecks replacement isolation and clears dispatched marker; only verified own-card answer bypasses FIFO. R; existing wrong-card checks G. |
| ISO-13 | `server/ux-l4b-isolation.test.ts`, `server/loop-nudge.test.ts` | Inventory all actual steer/write sites; held nudge cannot enter a newly isolated run. R behavior plus source inventory. |
| ISO-14 | `server/send-store.test.ts`, `server/independent-thread-runs.test.ts`, `server/steer-queue.test.ts` | Singleton both positions, takeover/resend/restart preserve flag, next ordinary run clears it. R. |
| F7-RECEIPT, F7-CAS | `server/send-attempt-state.test.ts` | Unique scoped send/line/action constraints; atomic transcript linkage; stale generation/binding/revision cannot settle replacement; duplicate terminal event does not drain twice. R. |
| F7-RETRY, F7-ACTION | `server/send-failure-lifecycle.test.ts` | Lost acknowledgement for failed-with-line returns original; repeated explicit action creates exactly one new send/line; changed fingerprint/target/fence rejects; no automatic resend. R plus existing Stop/restore controls G. |
| F7-DB-GATE, F7-INVOKE, F7-ID-NOT-ACK, F7-MULTIWRITE | `server/turn-dispatch-guard.test.ts`, `server/send-failure-lifecycle.test.ts` | Failed receipt write prevents actual adapter invocation/write; unfenced invocation uncertainty precedes call; allocated ID is not submitted; second-write refusal/notWritten cannot erase earlier uncertainty. R. |
| F7-SETUP, F7-REBUILD | `server/send-failure-lifecycle.test.ts` | Synchronous pre-admission throw, ACP async setup failure, post-return background failure, postwrite failure and final rebuild terminal each reach shared receipt lifecycle; intermediate/stale rebuild does not terminate current binding. R. |
| F7-DB-TERMINAL | `server/send-failure-lifecycle.test.ts` | Terminal commit failure publishes no terminal event, releases no generation, drains no sibling; recovered persistence replays effects once. R. |
| F7-CRASH | `server/send-failure-recovery.test.ts` | Child crash after acceptance/link, before/after gate commit, after possible write, before/after terminal commit/publication/release; restart visits started/failed/uncertain and never auto-resends possible delivery. R. |
| F7-STOP-GAP | `server/ux-l4b-isolation-api.test.ts` | Deterministic barriers between queue selection/start, rebuild and late error; target sealed before write; next generation unaffected. Mixed R/G, record which assertion fails. |
| F7-REPLAY, F7-WARM, F7-COPY, F7-LEGACY | `server/memory/send-replay-exclusion.test.ts`, `server/memory/lineage-warm.test.ts` | Capture real adapter inputs in fresh/native/resumed/rebuilt paths; all failed unsent lines/copies excluded; cached warm proof invalidates; retained cursor seals; ordinary historical context remains. R for new exclusion; ordinary legacy G. |
| F7-PRUNE, F7-DELETE, F7-RESTORE | `server/send-failure-recovery.test.ts`, `server/installation-restore.test.ts` | Pruning retains replay/dedup; deletion creates nonreversible scoped fences before receipts disappear; old backup cannot revive retired send/action; no receipt text retained. R. |
| STATE-1, ACTION-1 | `server/ask-turn-state.test.ts` | Send-keyed state rejects foreign hint; restamp follows current binding; every state/delivery/action combination maps to frozen wire; same-action retries never retarget. R. |
| CANCEL-16 | `server/ux-l4b-isolation-api.test.ts`, `src/components/help/HelpAsk.test.tsx` | Every authorized 404 state and 5xx/legacy/timeout outcome; started/sending never become Done. R. |
| STOP-AWAITS, STOP-RESULT, STOP-SIBLINGS, STOP-MALFORMED | `server/ux-l4b-isolation-api.test.ts` | Swap generation after each browser/provider/final-frame await including catch; no stale approval/idle/release; explicit match/confirmed/unconfirmed result; siblings untouched; malformed scoped body never executes broad branch. R. |
| DOOR-1, LEGACY-CAP | `companion/test/turn-state-door.test.ts`, `server/route-policy.test.ts`, `server/bot-read.test.ts`, `server/channel-queue.test.ts` | Phone/browser proof+subject through every new GET/DELETE/POST, foreign/hidden/group denial before receipt access, chat-only Remove denied, absent capability sends no scoped interrupt. R for new allowed paths, existing denials G. |
| T-PLAN-1, T-PLAN-2, T-SCALE-1 | `server/turn-index.test.ts` | Both production readers seek exact turn; parsed/work counts flat with 1,000/20,000 unrelated later rows and no derived line scan. R. |
| T-RAW-NONNULL, T-MUTATIONS | `server/turn-index.test.ts` | Raw change of JSON turn while stale non-null column remains; raw turn column mutation; insert/replace/update identity/delete/rowid-gap writes; dirty read returns not_ready then exactly full-parse oracle. R for maintenance contract; baseline ordinary correctness G. |
| T-DAMAGE, T-BYTES | `server/turn-index.test.ts` | Malformed/non-string/empty identities preserved byte-for-byte; repaired row becomes discoverable; BLOB-byte and oversized/multibyte batch rules. G for preservation controls, R for maintenance. |
| T-SNAPSHOT, T-READY, T-SCHEMA | `server/turn-index.test.ts` | Two connections interleave readiness/read; never mixed snapshot; wrong same-name index/trigger, absent state and incomplete census cannot publish ready; final row validation before clearing marker. R. |
| T-BACKFILL-CRASH, T-CLOCK, T-OLD | `server/turn-index-recovery.test.ts` | Interrupted bounded pass resumes committed cursor; writes behind cursor/old rowid gaps found; clock rollback creates no scan allowance; older writes exact on upgrade. R for protocol, G for atomic SQLite controls. |
| T-CONSUMERS, T-WIPE, T-PRODUCTION | `server/turn-index-consumers.test.ts` | Loaded/unloaded Store rows/replies/tools equal authoritative DB after raw writes; line/turn_first wipe cannot create incomplete reads; child with VITEST unset handles not_ready. R. |
| T-TERMINAL, T-STOP-LOCK, T-BACKLOG, T-CLEARANCE | `server/turn-index-stop.api.test.ts` | Not-ready terminal persists owed tools; actual worker writer lock still permits authenticated provider interruption for direct/dispatching/project-card turns; cleanup write failure does not strand Stop; ready unrelated threads admit while old-thread backlog retained; clearance during failed worker honored. R plus existing scoped-tool behavior G. |
| T-WORKER-SPAWN, T-WORKER-EXIT, T-WORKER-PARENT | `server/turn-index-recovery.test.ts` | Never-created releases immediately; error/success/termination request cannot release running worker ownership before observed exit; parent crash recovers lock/progress. R. |
| T-WORKER-PACKAGE | `src/e2e/turn-index-worker.human.spec.ts` | Packaged Mac/Windows/Linux Node worker opens DB, batches/builds/exits; no external CLI/process-mode assumptions. P. |
| T-DOWN, T-BACKUP, T-RESTORE, F7-DOWN-REPLAY | `server/installation-downgrade-117.test.ts`, `server/installation-database-snapshot.test.ts`, `server/installation-restore-preparation.test.ts` | Actual old inspector accepts controlled export; actual old replay excludes projected failed inputs; rollback/second open preserve JSON/seq; receipt metadata/fences roundtrip; raw restore writes invalidate index. R/G by fixture, actual old-runtime rehearsal P. |
| T-WRITE-1, T-SMOOTH-1, F7-STORAGE | `server/turn-index.perf.test.ts`, `server/send-attempt-storage.perf.test.ts` | Three quiet identical final-pair insert/update budgets, <250 ms smoothness, real data migration and measured receipt/fence growth. P; historical expression-index write failure is retained, not relabelled current RED. |
| UI-F5, UI-F6 | `src/components/help/HelpAsk.test.tsx` | Mounted unload/reload retry reset, exact pinned-chat handoff closes overlays and shows true Stop in long chat. R. |
| UI-INPUT, UI-PREVIEW, UI-KEYBOARD | `src/components/help/HelpAsk.test.tsx`, `src/lib/screen-envelope.test.ts` | 1–400 Unicode chars, exact typed payload/fixed title, no private interpolation; held/IME Enter cannot duplicate or confirm resend; focus restoration. R. |
| UI-STALE, UI-EXTERNAL-CANCEL, UI-UNKNOWN, UI-CAP | `src/components/help/HelpAsk.test.tsx` | Account/opening/attempt/action/restamp guards; post-close errors remain observable; other-surface Remove; unknown/timeouts retain chat, no false failure/completion; capability absence. R. |
| UI-INDEX-RELOAD | `src/state/send-delivery.test.ts`, `src/components/help/HelpAsk.test.tsx` | 503 maintenance before dispatch preserves text/attachments/reply/sendId across reload; same-ID retry after ready executes once; unknown action response never mints resend. R. |
| L13-5, M5a, M5b, L13-8, M8a, M8b, M8c, M8d, M8e | `src/e2e/help-ask-fixture.human.spec.ts`, `src/components/help/help-ask-fixture.test.ts` | §7 package observation assertions; M5a/b and M8a–d intended mutations fail; M8e equal reads/behavior demonstrated GREEN. M/P, not missing-harness RED. |
| UI-LAYOUT, UI-G9 | `src/e2e/help-ask-fixture.human.spec.ts`, `evidence/l8-g9-clicks.md` | §8 light/dark/320px/focus screenshots and exact click table; Fable/Sean/new-user/20+bot cross-platform proof. P with automated layout assertions where supported. |

Run gates appropriate to final files, compare zero NEW reds with the supplied integration base and release run `42028153798`, and register selected behavioral gates in `ci/gate-tests.txt`. Historical reports are provenance only. Quiet performance and packaged human review follow behavioral implementation; repeat on final combined SHA after meaningful integration changes. No READY-to-ship claim until every fixed-scope behavior and proof gate is satisfied.

## 11. Ordered build slices to seat in parallel

This is the final build order and ownership contract. Sizes include tests, not measured line counts. Total remains a provisional 9–12 builder-sessions plus 1–2 design/review sessions. Seat one integration owner I for **all shared schema files and server/index.ts**. A2 supplies exported schema definitions/patches; I alone edits `server/message-tables.ts`, `server/database.ts`, snapshot/downgrade/restore files. All owners use the frozen interfaces below; a change to one requires coordinated review before dependent seats continue. New source/test files are explicitly proposed by this revision. No agent delegation is performed by this design job.

Frozen interfaces: F1 = §3 receipt/BindingKey/CAS/terminal effects; F2 = §3.2 throwing submission gate; F3 = §4 replay eligibility/revision/isolation; F4 = §5 capability/state/action/auth wire; F5 = §6 TurnRead/dirty/readiness/worker; F6 = §8 exact UI copy/identity/layout; F7 = §7 packaged fixture observations/mutation identities. Contracts may be represented in proposed `shared/help-turn-state.ts`; only I owns that shared file, exporting the wire enums/types without runtime authority decisions.

### Slice 0 — serial provenance and packaged baseline (S, 0.5–1 session)

Owner I. Exact files: `src/e2e/help-ask-fixture.human.spec.ts`, `src/e2e/help-ask-fixture.config.ts`, `src/components/help/help-ask-fixture.ts`, `src/components/help/help-ask-fixture.test.ts`, `src/components/help/help-ask-port.ts`, `src/components/help/help-ask-build.test.ts`, `scripts/check-help-fixture-absent.mjs`, `playwright.config.ts`, recovered matching package/fixture wiring in `src/components/help/HelpAsk.tsx`, `package.json`; design-only manifests `DESIGN-r2.md`, `BUILD.md`, `evidence/l8-provenance.md`, `evidence/l8-baseline.md`, `evidence/F7-review-original.md`. Recover source wiring via the historical diff; do not substitute current product fixes before baseline. Build package from the matching recovered historical tree in an isolated workspace, with its recorded config.

Depends on F7 and header reviews/MAIN seating, exact historical source identities, recovery of F7 original review with all six High/eight Medium/Low mappings. First test execution: entire **`src/e2e/help-ask-fixture.human.spec.ts`**, including 7b, in a Hetzner container against packaged Electron under xvfb. Preserve both L13 reports. A failed launch blocks baseline; it is not RED. After baseline, separate Slice I0 lands shared `shared/help-turn-state.ts` and schema contract stubs; Slice 0 does not edit those files. Exit: source/package/config hashes and observed baseline recorded; rows 5/8 still NOT FIXED pending final proof.

### Slice A1 — parallel wave A, durable lifecycle and isolation (L, 2–2.5 sessions)

Exact production files: `server/send-store.ts`, `server/steer-queue.ts`, `server/independent-thread-runs.ts`, `server/turn-dispatch-guard.ts`, `server/admitted-turn.ts`, proposed `server/send-attempt-state.ts`, proposed `server/send-attempt-compat.ts`. Exact test files: `server/send-store.test.ts`, `server/steer-queue.test.ts`, `server/independent-thread-runs.test.ts`, `server/turn-dispatch-guard.test.ts`, `server/send-attempt-state.test.ts`, `server/send-failure-lifecycle.test.ts`, `server/send-failure-recovery.test.ts`, `server/send-attempt-storage.perf.test.ts`. Schema registration and index.ts call sites are patches handed to I, not concurrent edits.

Depends on F1/F2/F3/F4 and current ownership/restore contracts; uses F5 not-ready union for owed effects without waiting for A2 implementation. RED first: **ISO-14; F7-RECEIPT; F7-CAS; F7-RETRY; F7-ACTION; F7-DB-GATE; F7-INVOKE; F7-ID-NOT-ACK; F7-MULTIWRITE; F7-SETUP; F7-REBUILD; F7-DB-TERMINAL; F7-CRASH; F7-STOP-GAP**. Then F7-PRUNE/DELETE/RESTORE and storage measurement. Exit: terminal receipt is the sole release authority; failed durable recording never permits engine write.

### Slice A2 — parallel wave A, exact turn storage (L, 1.5–2 sessions)

Exact production files owned by A2: `server/message-db.ts`, proposed `server/turn-index-state.ts`. Exact shared schema file supplied as a reviewed patch for I: `server/message-tables.ts`. Exact tests: `server/turn-index.test.ts`, `server/turn-index-recovery.test.ts`, `server/turn-index.perf.test.ts`, `src/e2e/turn-index-worker.human.spec.ts`. No app-wide migration file is edited by this seat.

Depends on F5, stable `(thread_id,id)` identity, I's schema registration and current worker ownership primitives. RED first: **T-PLAN-1/2; T-SCALE-1; T-RAW-NONNULL; T-MUTATIONS; T-SNAPSHOT; T-READY; T-SCHEMA; T-DAMAGE; T-BYTES; T-BACKFILL-CRASH; T-CLOCK; T-WORKER-SPAWN/EXIT/PARENT**. Then T-OLD, packaged worker acceptance and unchanged T-WRITE-1/T-SMOOTH-1. Exit: no unresolved dirty marker can coexist with a ready read; full-parse oracle exactness and final-row validation proven. Performance is a gate, not assumed by the physical choice.

### Slice A3 — parallel wave A, Help panel and retained send UI (M–L, 1–1.5 sessions)

Exact production files: `src/components/help/HelpAsk.tsx`, `src/components/help/HelpPanel.tsx`, `src/state/store.tsx`, `src/state/send-delivery.ts`, `src/lib/screen-envelope.ts`, `src/locales/en-ux/l4b.json`. Exact tests: recovered `src/components/help/HelpAsk.test.ts` (pure regression suite), `src/components/help/HelpAsk.test.tsx` (mounted suite), `src/state/send-delivery.test.ts`, `src/lib/screen-envelope.test.ts`. Do not concurrently edit the packaged fixture spec; B3 owns it after baseline.

Depends on F4/F6 and shared wire types, existing pinned-thread loading/chat navigation/outbox interfaces. RED first: **UI-F5; UI-F6; UI-INPUT; UI-PREVIEW; UI-KEYBOARD; UI-STALE; UI-EXTERNAL-CANCEL; UI-UNKNOWN; UI-CAP; UI-INDEX-RELOAD; CANCEL-16**. Mounted tests exercise unload/reload, close/reopen, account/action/restamp guards, exact preview, precise handoff and external cancellation. Exit: every §8 state has exact copy/actions/focus behavior; no old server receives scoped Stop.

### Slice B1 — parallel wave B, state API and authorization (M, 0.75–1 session)

Starts after A1/F1 and A2/F5 stabilize. Exact production files: proposed `server/ask-turn-state.ts`, `server/route-policy.ts`, `server/sse-visibility.ts`, `companion/src/routes.ts`. Exact tests: `server/ask-turn-state.test.ts`, `server/route-policy.test.ts`, `server/bot-read.test.ts`, `server/channel-queue.test.ts`, `companion/test/turn-state-door.test.ts`. I owns all route/config/Stop wiring in `server/index.ts` and shared type changes.

Depends on F1/F4/F5, current authorization/proof/visibility policy. RED first: **STATE-1; ACTION-1; CANCEL-16; DOOR-1; LEGACY-CAP**, including wrong bot/thread/send/hint, hidden subjects and proof checks for every route. Exit: authorization precedes receipt access, state derives from current send receipt, legacy compatibility explicit.

### Slice B2 — parallel wave B, replay and recovery integration (M–L, 0.75–1 session)

Exact production files: `server/memory/turn-replay-inputs.ts`, `server/memory/lineage-warm.ts`, `server/memory/disclosures.ts`, `server/memory/replay-lineage.ts`, `server/turn-context.ts`, `server/branch-store.ts`. Exact tests: `server/memory/send-replay-exclusion.test.ts`, `server/memory/lineage-warm.test.ts`. index.ts replay/rebuild wiring and snapshot/restore registration go to I; A1 retains ownership of recovery test files until handoff.

Depends on F1/F3/F5 and current lineage/session proof rules. RED first: **F7-REPLAY; F7-WARM; F7-COPY; F7-LEGACY** plus integrated F7-PRUNE/RESTORE after A1 handoff. Exit: captured fresh/resumed/native/rebuilt inputs exclude all failed-unsubmitted/uncertain attempts; warm proof invalidates and ordinary legacy history survives.

### Slice B3 — parallel wave B, L13 proof work (M, 0.75–1 session)

Exact files: `src/e2e/help-ask-fixture.human.spec.ts`, `src/e2e/help-ask-fixture.config.ts`, `src/components/help/help-ask-fixture.ts`, `src/components/help/help-ask-fixture.test.ts`, `src/components/help/help-ask-port.ts`, `src/components/help/help-ask-build.test.ts`, `scripts/check-help-fixture-absent.mjs`, `playwright.config.ts`, `evidence/l8-l13-mutations.md`, `evidence/l8-g9-clicks.md`. Mounted additions to `src/components/help/HelpAsk.test.tsx` transfer from A3 only after its wave-A work is committed; no simultaneous editing.

Depends on F4/F6/F7, baseline artifact identities and A3 UI handoff. Mutation RED first: **L13-5/M5a/M5b; L13-8/M8a/M8b/M8c/M8d** against rebuilt packages. **M8e remains GREEN demonstrated equivalence** with equal read counts. Then UI-LAYOUT/UI-G9, full unmutated fixture including 7b. Exit: concrete package/React observations and mutation evidence, rerun on final combined head; MAIN may close rows 5/8 only after review.

### Slice I — serial integration and acceptance (L, 1.75–2 sessions; same sole integration owner)

Exact production/shared files: `shared/help-turn-state.ts`, `server/index.ts`, `server/store.ts`, `server/loop-nudge.ts`, `server/steer-lineage.ts`, `server/message-tables.ts`, `server/database.ts`, `server/branch-index.ts`, `server/memory/optional-index.ts`, `server/installation-database-snapshot.ts`, `server/installation-app-schema-downgrade.ts`, `server/installation-memory-downgrade.ts`, `server/installation-restore.ts`, `server/installation-restore-preparation.ts`, `ci/gate-tests.txt`. Exact tests: `server/ux-l4b-isolation-api.test.ts`, `server/ux-l4b-isolation.test.ts`, `server/loop-nudge.test.ts`, `server/turn-index-consumers.test.ts`, `server/turn-index-stop.api.test.ts`, `server/installation-downgrade-117.test.ts`, `server/installation-database-snapshot.test.ts`, `server/installation-restore.test.ts`, `server/installation-restore-preparation.test.ts`. Exact evidence files: `evidence/l8-combined.md`, `evidence/l8-performance.md`, `evidence/l8-g9-clicks.md` (B3 handoff). Each producer's schema patch is integrated here by I; integration test harness REDs may be authored before wave A but executed only after Slice 0's mandated first run.

Depends on all F1–F7 and all completed producer handoffs. RED first: **ISO-11/12/13/15; STOP-AWAITS/RESULT/SIBLINGS/MALFORMED; T-CONSUMERS; T-WIPE; T-PRODUCTION; T-TERMINAL; T-STOP-LOCK; T-BACKLOG; T-CLEARANCE; T-DOWN; T-BACKUP; T-RESTORE; F7-DOWN-REPLAY**. Assert actual downgrade inspector and restored raw-writer cycle. Then combined cross-turn/crash/Stop/restart tests; three quiet honest performance/smoothness runs; real-size migration/downgrade/storage measurements; final rebuilt packaged L13/mutations, real-engine and full G9 evidence. Record final combined SHA and zero NEW reds against both required baselines. Independent Astra and Fable reviews plus MAIN disposition are required before release; an evidence gap or failed fixed-scope gate is never a scope cut.


# Binding MAIN amendment (verbatim)

# RULING: l8 (turn state: L4B-F7 receipts, L13, M2, Murage 1.0.19)

Status: BINDING Opus ruling. Closes the second Astra DISAGREE (swarm-b/odes2-l8/last.txt) on `orph/l8/DESIGN-r2.md` and `orph/l8/BUILD.md`.
Base: int/1019 `c12aaad93`. Scope is unchanged: F7 durable attempt receipts, isolation, scoped Stop, M2 turn index, L13 rows 5 and 8, Help UI, G9. Nothing is deferred.
Builders build DESIGN-r2 as amended here. Where this ruling and DESIGN-r2 or BUILD.md differ, this ruling wins. No question is left for a builder or for Sean.

Open points closed: 4 (review points 1 to 3 plus the builder clarification). Point 1 closes all 14 historical F7 findings, including the 8 Medium/Low that DESIGN-r2 reserved as F7-ML1 to F7-ML8.

---

## R1. The original F7 review is recovered and every finding is mapped (review point 1, Blocking)

### Evidence of recovery

The review DESIGN-r2 could not find (`scratchpad/l4b-f7-astra-d1.md`) is recovered verbatim from the Codex session log that produced it:
`/fixture-home/.codex-acct4/sessions/2026/11/07/rollout-2026-11-07T06-19-15-01a1b328-c04b-7992-864f-f0ac07558596.jsonl` (session `01a1b328-c04b-7992-864f-f0ac07558596`, started 2026-11-06T23:19:15Z, cwd `wt-1018-rb-l4b-phone-turnstate`, final `task_complete` message, `VERDICT: BLOCK`). It reviews `designs/L4B-F7-SEND-FAIL-1018.md` (R1 to R6, tests 1 to 6) and has exactly 6 High, 7 Medium and 1 Low findings, matching the handoff (`_ev/handoffs/HANDOFF-1018-l4b-phone-turnstate-m2.md:248`: "BLOCK, 6 Highs ... Plus 8 Medium/Low"). Line numbers in it refer to the 1018 L4B worktree; current int/1019 anchors are given below.

The full text is Appendix A of this ruling. Slice 0 copies Appendix A to `orph/l8/evidence/F7-review-original.md` with the source path above. DESIGN-r2 section 1.1 item 1 and section 9.2's "not enumerated / NOT VERIFIED" paragraph are replaced by this section. The claim "no implementation decision remains pending" is now true, because every finding below has a contract decision and a named test.

### High findings (items 1 to 6): DESIGN-r2 mapping confirmed

| F7 item | Contract paragraph in DESIGN-r2 | Named tests |
|---|---|---|
| 1 High: all definitively unsubmitted failed lines (ordinary and lateRefused) leave replay | section 3.1 `send_replay_exclusions` (every new attempt starts excluded), section 4 | F7-REPLAY, F7-WARM, F7-COPY |
| 2 High: ACP setup failure after a returned turn id bypasses onDispatchError | section 3.3 shared terminalizer (ACP setup failure, background failure after `startTurn`) | F7-SETUP (rejected dispatch and accepted ACP turn whose setup later fails) |
| 3 High: late rebuild terminal (`settleWithCard`) never settles the batch | section 3.1 binding epochs, section 3.3 "final rebuild exhaustion" | F7-REBUILD (exhaustion, rejected redispatch, Stop during rebuild) |
| 4 High: restart skips started/failed rows | section 3.3 Restart row | F7-CRASH at every committed boundary |
| 5 High: Stop and drain gap lets another turn replay a not-yet-failed line | section 3.3 Stop row, section 3.1 "begins excluded" | F7-STOP-GAP, STOP-AWAITS |
| 6 High: pruning erases retry and exclusion facts | section 3.4 pruning paragraph | F7-PRUNE, F7-DELETE, F7-RESTORE |

### Medium/Low findings (items 7 to 14): new binding decisions

Each row is now F7-ML1 to F7-ML8 in the provenance manifest.

**F7-ML1 (item 7, Medium): room routes.** Anchors on base: `server/channel-queue.ts:13` (owner_sends channel drain), `server/index.ts:28531-28593` (group POST route reopens failed/refused rows and calls `sendStore.retire(stale.seq)`).
Decision: the receipt rule is universal. (a) The owner_sends channel drain creates and settles attempts only through the section 3 terminalizer; room question-card answers ride the same path. (b) The group POST route no longer reopens or retires a failed or refused row by itself: a same-ID request returns the immutable receipt (as for bots); an explicit resend uses the group action route in R2 below. `sendStore.retire` may not be called on any row whose attempt has a linked line. Owner: A1 adds `server/channel-queue.ts` and `server/channel-queue.test.ts`; the `server/index.ts` group-route change is a patch to I.
Tests: `F7-ML1-GROUP-SAMEID` (same-ID retry after a failed-with-line group send returns the receipt, no rerun, no retire), `F7-ML1-GROUP-RESEND` (explicit group resend creates exactly one replacement), `F7-ML1-CHANNEL-DRAIN` (channel drain failure settles the attempt and excludes the line).

**F7-ML2 (item 8, Medium): give-back path may leave no explanation.** Anchor: `server/index.ts:14596-14604` `giveBackAdmittedTurn(..., onDispatchError)`.
Decision: the terminalizer owns the explanation. On a terminal failed or refused outcome it checks whether an activity explanation already exists for `(attempt_id)`; if not, it writes exactly one, keyed by `(attempt_id, terminal_revision)` so repeats are no-ops. The receipt commits first; the explanation is an owed effect of kind `publication` in `turn_cleanup_owed`, retried if writing throws. A thrown explanation never blocks or reverses settlement.
Tests: `F7-ML2-GIVEBACK-LINE` (give-back path with no prior line produces exactly one line), `F7-ML2-LINE-THROWS` (writer throws; receipt still terminal; line appears on the owed-effect retry), `F7-ML2-NO-DUPLICATE` (setup already wrote its line; none added).

**F7-ML3 (item 9, Medium): an existing failed receipt answers as success.** Anchor: `server/index.ts:16670-16682` (`accepted.kind === "match"` returns `{ok:true, ...steered}` whatever the row's state); `src/state/send-delivery.ts` treats that as acknowledged; the Help callback in `src/state/store.tsx` gets no failure field.
Decision: a same-ID retry whose attempt is terminal and not completed returns `200 {ok:false, existing:true, threadId, receipt:{state, attemptId, receiptRevision}}` where `state` is the section 5.2 wire state (`failed`, `refused`, `removed`, `stopped`, `unknown`). `send-delivery.ts` treats `existing:true` with a terminal non-completed receipt as definitive: it stops retrying and hands the receipt to the caller; the Help reader receives `failure: receipt.state`. Completed or in-flight receipts keep today's `ok:true` shape.
Tests: `F7-ML3-LOSTACK-E2E` (server route, real `send-delivery.ts` outbox and real store reducer: first POST commits then the response is dropped; the retry gets the failed receipt; Help shows the failed state and Send again), `F7-ML3-COMPLETED-UNCHANGED`.

**F7-ML4 (item 10, Medium): a cancelled receipt maps to missing.** Decision: the Help receipt mapper maps a confirmed cancelled receipt to `removed`, never `missing`; the server's turn-state check for a cancelled attempt runs before any missing-messageId return. Owner: A3 (Help UI) and B1 (`server/ask-turn-state.ts`).
Tests: `F7-ML4-ACKED-QUEUED-REMOVE` (acknowledged queued send removed on another surface shows Removed and stops following), `F7-ML4-LOSTACK-AFTER-REMOVE` (lost acknowledgement retry after removal returns removed).

**F7-ML5 (item 11, Medium): sends without a send id stay started.** Decision: `send_id` is never null. When a request has no client sendId, the server mints `srv-` plus a UUID inside the acceptance transaction and returns it. Batch settlement is keyed by the attempt ids captured on the binding at queue selection, never by looking up a transcript line's sendId.
Tests: `F7-ML5-ANON-BATCH` (batch of one client-id send and one anonymous send fails; both attempts terminal and excluded), `F7-ML5-ANON-RETURNS-ID`.

**F7-ML6 (item 12, Medium): exclusion query scale.** Decision: replay eligibility is evaluated only for the bounded replay candidate set, one primary-key lookup per candidate on `send_replay_exclusions(thread_id, message_id)`. No query scans failed rows or `owner_sends` by status for replay.
Tests: `F7-ML6-QUERY-PLAN` (EXPLAIN QUERY PLAN shows `SEARCH send_replay_exclusions USING PRIMARY KEY`, no SCAN), `F7-ML6-FAILED-ROWS-INVARIANT` (lookup count identical with 0, 10,000 and 100,000 failed rows in the thread).

**F7-ML7 (item 13, Medium): test honesty.** Decision: every test in DESIGN-r2 section 10 carries a label in `evidence/l8-baseline.md`: RED-ON-BASE (fails on base for the stated defect) or GUARD (passes on base and protects existing behavior). Known GUARDs: Help retry budget reset after a successful load; same recorded `actionId` returning `existing`. F7-REPLAY must force replay into a fresh session (not a resumed one). UI tests must exercise the callback wired by the mounted component, not a source assertion.
Test: `F7-ML7-LABELS` is a check in Slice I that every section 10 test has a label and every RED-ON-BASE test was observed failing on base.

**F7-ML8 (item 14, Low): state-table accuracy.** Decision: DESIGN-r2 section 3.1 already says a `dispatchedIn` stamp never proves delivery. Add to section 3.4 migration: legacy `started` plus `dispatchedIn` imports as `delivery=uncertain`, never `submitted` and never `failed-not-submitted`. Legacy replacement rules (fingerprint, restore, Stop and action-token checks in `server/send-store.ts:606-616`) remain the guard for legacy flags (see R2).
Test: `F7-ML8-LEGACY-DISPATCHED-IMPORT`.

### Seating order

Slice 0 now has this content in hand, so the recovery is done, not a prerequisite left open. Slice 0 still records it in `evidence/F7-review-original.md` and `evidence/l8-provenance.md` before any product seat.

---

## R2. Immutable receipts and the existing chat Send again (review point 2, Required)

### Evidence

- `src/state/store.tsx:4781-4800` is the send delivery owner. `src/store.tsx` does not exist on base. DESIGN-r2 sections 3.4, 5.3, 8, A3 and BUILD.md must say `src/state/store.tsx`.
- `src/components/Composer.tsx:1481-1491` Send again on a refused chip re-dispatches `send`/`sendGroup` with the OLD `sendId`, `resend: true`, a fresh `actionId` per press and the chip's `stopGen`/`restoreGen`.
- `server/send-store.ts:606-616` honors that legacy shape today (restore-held, Stop and action-token rules).
- DESIGN-r2 section 3.4 makes every terminal receipt immutable for its sendId, and section 5.3 defines `POST /api/bots/:id/send-actions` with `replacementSendId`. Composer was not migrated, so an ordinary failed-without-line or restore-held chip could never run again.

### Decision

1. Composer migrates to the action contract. In `onResend`:
   - Mint `actionId` and `replacementSendId` (both `crypto.randomUUID()`) once per press and persist them in the outbox entry for the chip before any request (same outbox the store already uses). A network retry resends the byte-identical body.
   - Bot chat: `POST /api/bots/:id/send-actions` with the section 5.3 body `{contract:1, actionId, threadId, sendId: old, attemptId, receiptRevision, bindingEpoch, kind:"resend", replacementSendId, stopGen?, restoreGen?, confirmDuplicate:false}`.
   - Room chat: new `POST /api/groups/:id/send-actions` with the same body and the same semantics, under the same route policy entries as the bot route (listed in `server/route-policy.ts` and `companion/src/routes.ts`).
   - `attemptId`, `receiptRevision`, `bindingEpoch` come from the chip's receipt (the refused entry now carries them from the state API).

2. Replacement chip reconciliation (store reducer in `src/state/store.tsx`): on 200/202 `{replacementSendId, replacementAttemptId, receipt}`, remove the old refused chip entry for `old` and add the replacement as queued/sending under `replacementSendId`; release the old outbox copy (existing `releaseRecoveredSend`). The old receipt stays as history. On `stale_action`, `stop_required` or `duplicate_confirmation_required`, the chip stays and shows the existing action error; nothing is re-sent.

3. Dismissal is preserved: Dismiss on a refused chip keeps calling `DELETE /api/bots/:id/queue/:queueId` (and the group equivalent) exactly as today. A resend action whose target was dismissed returns 409 `target_dismissed`; the store shows nothing further and keeps the chip gone.

4. Legacy explicit-resend compatibility (older clients, phone, any caller still sending `resend:true` with the old sendId on the bot or group send route):
   - With an `actionId` and current fences: the server converts it into the same send action with `replacementSendId = "r-" + actionId` (deterministic, so a lost-acknowledgement retry of the same press finds the same action and returns the same replacement). Exactly one replacement is created. The response is the send-route shape for the replacement message.
   - Without an `actionId`, with a stale fence, or with a different fingerprint: no rerun; the route returns the immutable receipt (R1 F7-ML3 shape).
   - Automatic same-ID retries without `resend:true` always return the original receipt.

5. Ownership: A3 owns `src/components/Composer.tsx`, `src/state/store.tsx`, `src/state/send-delivery.ts` and their tests. I owns the `server/index.ts` group action route and legacy conversion (A1 supplies the send-store functions).

### Tests (RED first)

- `F7-COMPOSER-RESEND-FAILED-NO-LINE`: mounted Composer, refused chip from a failed-without-line receipt; press Send again; exactly one replacement attempt, chip moves to the replacement. RED: the old-id request returns the immutable receipt.
- `F7-COMPOSER-RESEND-RESTORE-HELD` and `F7-COMPOSER-RESEND-STOP-HELD`: with the current fence, one replacement; with a stale fence, `stale_action` and no send.
- `F7-COMPOSER-LOSTACK`: first action response dropped; retry returns the same replacement ids; one engine turn.
- `F7-COMPOSER-RELOAD`: reload between press and response; the persisted action finishes once.
- `F7-COMPOSER-DISMISS`: Dismiss still works; resend after dismiss returns `target_dismissed`.
- `F7-LEGACY-RESEND-ONE-REPLACEMENT`: old-shape `resend:true` plus `actionId` creates exactly one replacement; repeat returns it.
- `F7-LEGACY-RESEND-NO-ACTIONID`: returns the receipt, no rerun.
- `F7-GROUP-RESEND`: room chip through the group action route.

---

## R3. Downgrade clears retained provider context (review point 3, Required)

### Evidence

- `server/installation-memory-downgrade.ts:380-383`: retained cursors are reset only when `to < 10 && reclaimHasRun(db)` (`resetRetainedSessionCursors`) or `to < 12` (`resetIncarnatedSessionCursors`). A downgrade to 1.0.17 (`to117`) runs neither.
- `server/installation-memory-downgrade.ts:39-63` `resetRetainedSessionCursors(root)` clears `resumeCursors`, `resumePolicies`, `replayPending` and `resumeSeals` on every bot, task and group holder in `bots.json` and `groups.json`, but silently skips a file that does not parse.
- An uncertain write may already sit inside a retained provider session. Converting its transcript row to activity (DESIGN-r2 section 3.4) does not remove it from the provider's own context, so the old build would resume the session and the engine would still see the excluded input.

### Decision

1. New exported function in `server/send-attempt-compat.ts` (A1 owns the module; I wires it):

   ```ts
   export function clearRetainedContextForAmbiguousAttempts(root: string, db: Database): { ambiguous: number; cleared: number };
   ```

   - `ambiguous` = count of `send_attempts` rows with `delivery = 'uncertain'`, or `phase <> 'terminal'`, or `terminal_outcome = 'abandoned_uncertain'`, or a `send_replay_exclusions` row whose attempt's delivery is not `not_submitted`.
   - If `ambiguous > 0`: clear retained context on every holder (bot, each task, each group) in `bots.json` and `groups.json`, with the same fields as `resetRetainedSessionCursors` plus `resumeIncarnations`. This is deliberately install-wide and fail-closed (no fragile thread to holder mapping). Engines start fresh sessions; no message is lost.
   - Strict: a missing file is fine; a file that does not parse, is not an array, or cannot be written atomically THROWS. A throw fails the downgrade or export.
   - Idempotent.

2. In-place downgrade: call it in the downgrade sequence for every target including `to117`, after the receipt/compat export step and before `settleSearchIndexForDowngrade` and the memory schema stamp (so a stopped run repeats it). A throw leaves the stamp up and the downgrade reports failure, as other steps do.

3. Archive export (`send-attempt-compat.v1` path): apply the same clearing to the archive's staged `bots.json` and `groups.json` copies; if that cannot be established, the export fails and no archive is produced.

4. Ordering against recovery: the function runs whether or not normal startup recovery ran after a crash. It does not need the process to have reconciled bindings first; it reads durable rows only.

5. Amend DESIGN-r2 section 3.4 downgrade paragraph and `F7-DOWN-REPLAY` accordingly.

### Tests (RED first), `server/installation-downgrade-117.test.ts` (Slice I)

- `F7-DOWN-RETAINED-SESSION`: seed a bot with a retained `resumeCursors` entry and an attempt with `delivery='uncertain'` (simulate possible delivery, then crash with no recovery); downgrade to 1.0.17; assert all retained context fields are gone; then drive the real 1.0.17 inspector/start path (existing harness) and a subsequent send: a fresh session is used and the old input is not in the captured provider input. RED on base: cursors survive.
- `F7-DOWN-NO-AMBIGUOUS-KEEPS`: no ambiguous attempts; cursors stay (no needless context loss).
- `F7-DOWN-UNPARSEABLE-FAILS`: ambiguous attempt plus corrupt `bots.json`; downgrade fails, stamp not lowered.
- `F7-EXPORT-RETAINED-SESSION`: archive export clears the staged copies; corrupt copy fails the export.
- The existing fresh-replay projection test (`F7-DOWN-REPLAY`) stays alongside.

---

## R4. Schema registration lands before A2 integration tests (builder clarification)

### Decision

Add **Slice I0** (owner I, serial, about 0.25 session) between Slice 0 and wave A. I0 lands, with no behavior:
- `shared/help-turn-state.ts` wire enums and types (F4, F6 shapes);
- `server/database.ts` and `server/message-tables.ts` registration of the F7 tables (section 3.1) and the M2 tables (section 6.1) using the frozen DDL from DESIGN-r2, plus the snapshot reference registration in `server/installation-database-snapshot.ts`;
- typed stub exports in `server/send-attempt-state.ts` and `server/turn-index-state.ts` that throw `not implemented`.

A1 and A2 then own the bodies of their modules; DDL changes after I0 go to I as patches, as DESIGN-r2 says. A2's integration tests depend on I0, not on final I. Final Slice I stays serial and owns combined-head integration.

---

## R5. Ordered slices (binding)

Serial prerequisite, then parallel A1/A2/A3, then parallel B1/B2/B3, then serial integration, as the review confirmed:

1. **Slice 0** (serial, owner I, 0.5 to 1 session): DESIGN-r2 Slice 0 plus write `evidence/F7-review-original.md` from Appendix A and the F7-ML1 to F7-ML8 manifest. First test execution remains the full packaged `src/e2e/help-ask-fixture.human.spec.ts` including 7b, under xvfb in a Hetzner container. L13 rows 5 and 8 stay NOT FIXED until final proof.
2. **Slice I0** (serial, owner I, 0.25 session): R4.
3. **Wave A, parallel:**
   - A1 (2.5 to 3 sessions): DESIGN-r2 files plus `server/channel-queue.ts`, `server/channel-queue.test.ts` and the `clearRetainedContextForAmbiguousAttempts` body in `server/send-attempt-compat.ts`. RED first: DESIGN-r2 A1 list plus F7-ML1, F7-ML2, F7-ML5, F7-ML6, F7-ML8, and the server half of F7-ML3 and the legacy resend tests.
   - A2 (1.5 to 2 sessions): unchanged (`server/message-db.ts`, `server/turn-index-state.ts`, F5), now testing against I0's registration.
   - A3 (1.5 to 2 sessions): store path corrected to `src/state/store.tsx`; add `src/components/Composer.tsx` and its resend/dismiss tests; `src/state/send-delivery.ts` F7-ML3 client handling; Help mapper F7-ML4. Freeze the corrected F4/F6 resend compatibility before implementation. Help UI files are those recovered in Slice 0 (`HelpAsk.tsx` from the L4B branch; `HelpAskChief.tsx` is the current base fallback).
4. **Wave B, parallel:** B1 (adds the F7-ML4 server ordering in `server/ask-turn-state.ts` and the group action route policy entries), B2 (replay: F7-ML6 query plan proof with F7-REPLAY in a fresh session), B3 (L13 proof; M5a/M5b and M8a to M8d mutation failures preserved; M8e stays demonstrated equivalence). Unchanged otherwise.
5. **Slice I** (serial, 1.75 to 2.25 sessions): DESIGN-r2 Slice I plus the group action route, legacy resend conversion, downgrade wiring of R3, `F7-DOWN-RETAINED-SESSION`, `F7-EXPORT-RETAINED-SESSION`, and `F7-ML7-LABELS`. Independent Astra and Fable reviews plus MAIN disposition before release.

Estimate: 10 to 13 builder-sessions plus 1 to 2 review sessions (DESIGN-r2's 9 to 12 plus about one for R1 to R3).

## Decisions for Sean

None. All points are technical and closed above. (R2 keeps every existing Send again and Dismiss behavior; no copy change is introduced.)

---
