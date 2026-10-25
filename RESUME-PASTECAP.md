# RESUME: fix/104-paste-capture

Base: 7c5807db7 (feat/104-learn-about-me). Design: 0161/lanes/release104/designs/PASTE-CAPTURE-FIX.md, r2 (line 305 on) supersedes.
Decisions: S8 mask MEMORY.md at load, file untouched. S7 nothing beyond the flux_capture_hold.
Base suite: DONE (31 failures incl. chunk 07 rerun) on build-host lane pc104-base (worktree /Volumes/Scratch/work/104-pastecap-base, results /root/mb-0161-hz/pc104-base/src/full).
build host lane for this branch: pc104 (/root/mb-0161-hz/pc104). Helpers in .hzpc/ (untracked, info/exclude).

## Milestones
- [x] M1 shared/financial-ids.ts + vectors.json + test; redact.ts FINANCIAL_ID rule; redact.test S1, chain idempotence, financial clocks
- [x] M2 record-write.ts: 17 production sites (r2 listed 14; Grok r2 H7 found jobs.ts chunk insert, plus consolidate candidate and LAM remember) + test; import hash over stored text (H5)
- [x] M3 read-time masks: bundle hydrateInPass, search hits (search.ts:171), pip-reflect input, settings record() (every owner-list row passes it) and inspect quotes, MEMORY.md both branches + general notes + guidance sentence
- [x] M4 Flux number hold: flux_capture_hold (messages.db, snapshot allowlist), hold write in both append paths, numberHold decision, fluxCaptureHold set in sendProjectUsageTurn; X1-X5. Hold keys on a real rule match (containsFinancialIdentifier), per Grok r2 on S7
- [x] M5 export paste: detect.ts, capture exclusion + reply exclusion, chat mark (memoryNote) + ExportPasteNote under the user row (1:1 and rooms), LearnAboutMe initialText + lam-handoff, parse mask flag, prompt sentence; C1-C4 (capture-export.test.ts), ExportPasteNote.test, LAM/parse tests
- [x] M6 scrub pass (scrub-pass.ts + scrub-state.ts: versions, records, details, feedback, settle), H5 hash recompute, index.ts rewrite merge debt + finishRewrite (worker message, controller requestFinishRewrite, 120 s ack), upgrade-background job "scrub" after integrity, phases masking/settling (contract, labels, en strings); scrub-pass.test D1-D8 + D16, index-upsert rewrite test
- [x] M7 locales (8) + source-hashes (generate-locale --check passes on the build host), MemoryReview Chat excerpt label, paused sentence (S1); MemoryReview and LearningPausedCard tests
- [x] M8 fail-before: all 16 changed test files fail on base (new-module files at import; others 1 to 4 tests each). Full suite vs base: 19 NEW at first; fixed in 10475d6a2 (scrub log clear via wal-maintenance scrubWalAfterDelete, downgrade drops UPGRADE_104_TABLES, dispatch golden gains the S8 sentence, supervisor seam dep, record-write walker skips hidden fixture dirs); the rest passed in isolation except worker-slices 50 ms and wal-maintenance 256 MB timing, which fail the same way on base under the same load (A/B, 3 runs each). Both typechecks pass. Grok REVIEW.md unchanged at r2 (all handled).

## Departures so far
- Fast path is `\d(?:\D{0,38}\d){3}` (four digits within an id's span), not `\d(?:[ -]?\d){3}`: the r2 shape misses T5a (codice fiscale has no four-digit run), so F1 was red. hasFinancialIdentifier = the r2 shape OR the mask changes the text.
- CARD also finds a card inside a longer grouped run (a card typed before an expiry), row M20.
- Export paste chat line is a mark on the user row (`memoryNote: "export-paste"`, written by writeMessage in the row's own transaction, rendered by ExportPasteNote under the bubble), not a Murage row appended after it. An appended row becomes the active leaf, and writeActiveLeaf then drops direct_turn_inflight, so a crash mid-reply to an export paste would lose the interrupted-turn note (inflightDirectTurns needs the leaf to be the user row); the bot's reply would also parent on the Murage row. No bot-read fixedCopy is needed (nothing new for a bot to read). A mark sent in with a message is dropped.
- Review and keep shows on the desktop app, in a 1:1 chat, for a message typed on the desktop (origin desktop); rooms, phone, companion and channel messages show the line alone (B3, B4).
- Scrub place is `upgrade_scrub_pass` in messages.db (scrub-state.ts, like upgrade_integrity_pass), not `memory_scrub_pass` in schema.ts: a memory_ table would trip the exact memory-schema check and need a schema version bump. Listed in the archive inspector (APP_TABLES + reference schema). A new file is seeded done in the migration's fresh branch; a 1.0.3 file (no row) runs it.
- memory_feedback.correction is its own phase ("feedback") after details, so one integer cursor keeps each place.
- settle waits for pending receipts and the helper's finishRewrite (optimize + TRUNCATE) for at most one hour from settle start, then finishes anyway (D15 bound applied to D16 too): the records are masked in the main file, the merge debt is durable in index_meta, and maintenance pays it. Nothing changed means no settle work.
- Grok r2 H5: a changed payload's content_hash is recomputed in the form that made it (capture content hash, bring-in payload hash, import text hash; none match: capture form), on the version and on memory_sources; import payload.originalHash and the notebook-link intent hash follow; an import tombstone under the old hash gets a twin under the new one.
- Main-file log at the end of the scrub is cleared by wal-maintenance's scrubWalAfterDelete (checkpointer thread, owed until proven, idle retry, start-up TRUNCATE after a crash), not a server-thread TRUNCATE: base guard wal-maintenance.test forbids post-listen TRUNCATE on messages.db.
- Downgrade drops flux_capture_hold and upgrade_scrub_pass (UPGRADE_104_TABLES); a re-upgrade runs the scrub again.
- D8 big payload is about 2 MiB of account lines, not 32 MiB (test time); the mask is linear and timed at 1 MiB in redact.test.ts.
