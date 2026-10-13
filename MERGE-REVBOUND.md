# Merge: revbound r3 (4e6e898b7) into the S0 contract (e20a0db4f)

Merge base cf8c9b1c7 (revbound as already in RC f0559322c). Revbound r3 adds three commits (3b6e1071b, 4bb9eb2ab, 4e6e898b7).
Rule applied everywhere: revbound's reader refusal stays as the stricter layer; the RC's surrounding code (LineageAllowance,
`checking`, rendered-withheld roots, turnctx, upgui, lincold2) is kept. The write-time slices (S1 to S5) later replace the lineage
judge; the deny reads here are the layer they replace.

## Conflicts and resolutions

| File | Resolution |
|---|---|
| `server/memory/schema.ts` | No version collision: revbound adds no schema version; its `REVOKE_LATE_SQL` objects (memory_deny, memory_revocation_targets, memory_evidence_by_source, memory_source_origins, memory_late_build, 3 triggers) are made at every open from v8 on by `ensureRevokeLateObjects`, validated with exact text, and kept out of the per-version text. Downgrade: kept S0's v10 -> v9 step and lincold2's v9 -> v8 step; the v8 -> v7 step drops `REVOKE_LATE_DROP + REVOCATION_INDEX_DROP` (revbound). Not moved into the v9 text (revbound's integrator note): v9 is the RC's frozen text and RC-built v9 files exist without these tables, so moving them would make every such file fail validation; v10 likewise keeps WRITETIME_SCHEMA only, with the late objects accepted beside it. |
| `server/memory/replay-lineage.ts` | Imports: both. `replayExclusionsWork` (RC, allowance + statement reuse + `checking`) now applies revbound's wrapper inside the same held pass: a forgotten line is excluded whoever wrote it (and leaves `checking`), then `positionalWithheld`. `capturedMessageWithheld(allowance, ...)` = positional OR the RC verdict; `capturedMessageVerdict` also answers positional lines as withheld (proven, not "checking"). `outputRootsForWork(allowance, lines, home?)`: revbound's cross-thread carried-line roots inside the RC's lineage-limit try/catch; `outputRootsShallow(lines, home?)` keeps the same rule on the unproven fallback. The deny/positional seeks are bounded and run inside the allowance's timed window, not charged as nodes (they sit outside kept verdicts, so the verdict cache needs no new keys). |
| `server/steer-lineage.ts` | RC signature `shownLinesRoots(allowance, lines, renderedWithheld?)` plus revbound's `threadId` (4th arg, defaults to `renderedWithheld.threadId`): a user line carried from another thread counts as a root; the RC's rendered-withheld filter replaces revbound's `capturedMessageWithheld` re-judgement (the decision the prompt was built with). |
| `server/index.ts` | Imports: RC's open-turns import kept, `ensureEvidenceSourceIndex` dropped (revbound superseded it; its after-listen block was already gone). Both `shownLinesRoots` call sites keep the RC's rendered-withheld argument and pass the turn's thread. |
| `server/memory/disclosures.ts` | `fullContinuationCheck`: RC allowance cap AND revbound's `COLD_CHECK_ROWS` bound (`LIMIT min(cap, COLD_CHECK_ROWS)+1`; over cap -> `readTooBig`, rows spent, then over COLD_CHECK_ROWS -> reset "memory-changed (long-session)"). `filterDirectReplay` and `roomReplayWithheld`: RC allowance/`checking` plumbing, revbound's rule that forgotten owner lines are withheld too. |
| `server/memory/readable.ts` | RC `derivationAncestryCurrent(options.allowance, ...)` plus revbound's tombstone-or-denied-scope refusal; both imports. |
| `server/memory/root-set-compaction.ts` | RC restructure kept (owner hand-back, worker, settleReclaim). Revbound's "no VACUUM while a revocation job waits" became `revocationJobWaiting(db)`, checked in `reclaimLineageSpace`, `reclaimLineageSpaceInWorker` and `finishLineageStorageAtStartup` (T12). |
| `server/memory/schema.ts` (follow-up) | The late objects are made from v9 on (not v8), and the v9 -> v8 step drops them with the open-turns objects, so a downgrade to v8 leaves exactly the v8 text the real 1.0.1 inspector reads (open-turns.test). Validation still accepts them, exact text only, on a v8 development file. |
| `server/memory/replay-lineage.ts` (follow-up) | The forgotten-line wrapper reads in batches (`forgottenMessageSources`: one statement per 500 lines, covering the conversation's deny row, deleted or denied sources and tombstones), and the judge seeks a thread's deny row once per judge, not once per batch of roots, not one `messageSourceForgotten` per line: the RC's warm-turn statement caps hold (lineage-cold-turn.test: 234 statements before, under 100 after; continuation-first-check.test: 15,039 before, under 15,000 after). `room-transcript.ts` and `roomReplayWithheld` keep the RC's per-line check for generated lines only; owner lines are covered by the wrapper. |
| `server/memory/lessons.ts` | Both import sets. |
| `server/room-transcript.ts` | RC allowance + `checking`; revbound's rule (owner lines too); a forgotten line leaves `checking`. |
| `server/memory/revoke-window.test.ts` (auto-merged, new) | Ported to the RC's allowance APIs (`LineageAllowance.tool(1e9)` for `shownLinesRoots`, `readableMemoryRecord`, `roomTranscriptWithoutMemory`, `contentRevoked`, `continuationMemoryRevoked`). Assertions unchanged. |

## Tests revbound deliberately changed

- `server/memory/open-turns.test.ts`: the v8 upgrade's added-object list leaves out revbound's late objects (made at every open, beside the versioned text).
- `server/memory/lineage-allowance-reads.test.ts`: `SOURCE_LOOKUP` is revbound's lookup text (it reads the deny facts too); assertions unchanged.

- `server/room-transcript.test.ts`: the forgotten owner line `m-owner` is now withheld (with `m-dax`); call keeps the RC allowance.
- `server/memory/pip-p2-b1.test.ts`: inventory takes revbound's counts (capture.ts gone, evolution-forgetting.ts 2) and the RC's owner-list.ts 6.
- `server/memory/learning-wiring.test.ts`: fixture at v10 (S0) and calls `ensureRevokeLateObjects`.
- `server/memory/revoke-bounded.test.ts`, `server/memory/msearch-review.test.ts`: revbound's edits, auto-merged.

## Open

- `server/memory/p05.test.ts` Q12 ("without changing the original") is intermittent on the merge (failed 3 of 4 runs; passed on base e20a0db4f in its one run). Diagnosis so far: when `originalHash` is taken after `closeDatabase()`, the original's rows are still in its WAL (a byte copy of the main file then holds no tables), so a later checkpoint changes the main file. Waiting for the forget's revocation job and stopping its runner before the close did not fix it. The test is left as the RC wrote it.
