# users.create review fixes

Only the two BLOCK findings from the review of `8cd8ae4fc` are addressed.
Production behavior, the recipient flag, the retirement audit and the existing
acceptance matrix remain as reviewed.

## BLOCK 1: actual outputs and lifecycle scans

The R10 host regression intercepts actual console methods and stdout/stderr
writers. Positive controls use console output in base64 and a literal split
between two stderr writes. The real `HighLevelReviewCards` renderer writes to
the fixture transcript adapter; actual host outcome callbacks and returned tool
results are intercepted at their write boundaries. The old no-op sink loop is
removed. The server-only fake flow has no telemetry sender or Electron IPC;
neither is claimed as executed coverage.

The control fixture observes a fresh provider-bound generated password through
an owned, memory-only test pipe. The parent retains that needle across process
death and checks the entire isolated data/home tree (including hidden files,
transcripts, journals and SQLite/WAL), every server process log and exported
artifacts. Literal grep and leak guard v2 encoded-form scans run before shutdown,
after shutdown, after restart, after restart shutdown and after evidence export.
Empty directories and live Unix sockets have no file bytes; symlinks and unreadable
artifacts fail closed. No needle enters argv, environment or qualified evidence.

`scans.json` records the five clean phases. The fixture made one POST before an
injected settlement interruption and one reconciliation GET after restart, with
zero replacement POSTs. It used the ordinary exact approval card path. The
transport logging mutant must fail with the fixed protected-sink error, without
printing the secret. This qualifies the declared fake-server outputs and disk
artifacts; it makes no additional heap-erasure or packaged-desktop claim.

The first RED control caught Vitest's console facade bypassing process writers.
The capture now observes both. Its preserved RED log has the positive-control
output removed; assertion text remains. A preliminary grep returned exit 2 and
was not accepted as clean. The qualified run passed every phase. Subsequent grep
errors retain diagnostics and still fail the fixture.

## BLOCK 2: behavioral RED on the original starting commit

`users-create-starting.test.ts` imports only modules that exist at `0567676f1`.
Its compatibility owner callback and immediate denial of the old desktop
completion keep the original host path bounded without importing retired code.
The same test file fails two behavioral assertions there and passes on the
redesigned tree: default-off handoff and private completion after ordinary
approval. There are no missing-module or collection failures.

`starting-red.json` preserves the actual assertion failures. The source-integrity
report compares all 14,977 archived files with a fresh `git archive` of the
starting commit; none changed. Only the new regression test is transplanted.
The RED verifier requires two collected tests and both expected assertion
failures. A mutant accepting nonzero collection errors as RED is killed by a
regression covering collection errors, empty runs, signals, setup exits and green
baselines. The runner removes stale reports before invoking Vitest, so an old
assertion report cannot turn an executable failure into RED evidence.

Raw logs, persisted fixture snapshots, baseline source archive and mutant logs
remain untracked under `.test-tmp/afix-bld-hl-userscreate/`. The two new mutants
and all four original mutants must have passing baselines, matching assertion
failures and matching restored source hashes in `mutants.json`.

Full typecheck passed. The broader HighLevel/UI/shared suite passed 15,820 tests
in 59 files. The final RED-verdict changes also receive a focused rerun and all
six mutation checks. Public added-line leak guard v2 reports zero matches.
