# Revocation re-walk — round 2, smaller cut

Baseline: `fix/108-revocation-rewalk` at `b4579e28e`. This document records the
accepted implementation scope and authored checks. No builds, tests, fixture
launches, network requests or commits are authorized in this round. Runtime
results, including the empty-queue baseline, remain unverified.

## Review disposition

- **Astra: AGREE**, static review at the baseline, not execution evidence. The
  earlier document's unsupported “Astra AGREE” claim is withdrawn; this verdict
  refers only to the supplied review. Astra recommends the smallest SQL-guard
  cut and deferring per-job `a` markers. It confirms repeated admission and
  trigger amplification, but does not establish a stuck cursor or exact cadence.
- **Fable: REVISE**, requesting the smaller admission check, four SQL guards,
  honest boot cadence, WAL-header validation, and failed-job handling. This
  revision implements that cut as authorized by the user after both reviews.
- No per-job `a` markers, new completion receipts, restore generations, schema
  migrations, or new finalizer. Existing targets and completion paths remain.

## Root cause and scope of the claim

The driver is **boot replay of pending conversation deletions**:
`server/index.ts:7245` calls reconciliation, which calls `deleteThreadRows` for
**every thread of every still-pending entry on each start**
(`server/conversation-deletion.ts:1446`). Entries stay pending while an engine
home is still owed (`conversation-deletion.ts:728-733`), even when memory and
conversation rows have already been cleaned. These references use the baseline.

That reaches `message-db.ts:1441` → `captureThreadDeletion`. Previously,
`capture.ts:229` bumped the epoch before checking the existing write-time
receipt at `:237-238`; that check suppressed only `commitRevoke`. Both branches
still called `applyForgetTombstones` (`:245,249`), which creates a fresh UUID job
(`restore.ts:99`, `memory-revocation.ts:101-102`). Each boot could therefore
re-walk the same evidence under the existing roughly 1 MB/min write throttle.
Multiple evidence spans also revisit the same version within one walk.

The unconditional record UPDATE (`memory-revocation.ts:506`) triggers detail,
owner-tail and key writes (`schema.ts:114,1553,1637`). Cursors and phases do
advance; completed jobs disappear. No stuck-cursor claim is made.
The supplied review reports 147 stop/start cycles and roughly 4.7–4.9k
UPDATE/min in Sean's log. Boot replay is a source-backed driver consistent with
that observation; exact attribution still needs job-ID/cursor traces. A
one-second re-admission pulse is not a reproduction of the observed cadence.

## Implementation

1. In `affect`, guard state/pin updates with
   `AND (state!='deleted' OR owner_pinned!=0)`.
2. Guard projection updates with
   `lexical_status NOT IN ('deleted','delete-pending')`, preserving the existing
   paired-status rule without pending→pending or completed→pending rewrites.
3. Guard scope text scrubbing with `AND text!=''` and `endPlacedSource` payload
   updates with `AND payload!=?1` (baseline `:384` and `:345`).
4. Preserve text scrubbing, learning cleanup, `r` receipt targets, and the
   existing `prior.state` parent-transition rule. SQL guards make repeated
   effects cheap without inserting and deleting a new target for every record.
5. Move the existing deny-plus-FIRST_LSN write-time receipt check ahead of the
   epoch bump in `captureThreadDeletion`. When both exist, inspect system
   `memory-revocation` bindings in **granted and revoked** states whose
   `json_extract(intent,'$.thread')` matches the thread or whose `$.threads`
   contains it. No matching job means return before the epoch, cleanup admission
   and `revokeThreadDisclosures(...includeRevoked)` writes. A granted matching
   job keeps the existing admission path; this cut does not deduplicate every
   in-flight retry. The caller's `BEGIN IMMEDIATE` serializes the decision with
   writers (`message-db.ts:1441`, `database.ts:transaction`).
6. A matching parked/revoked job with the deny and receipt skips re-admission
   and warns once per job per connection. It is retained for attention and is
   not represented as successful cleanup. Unknown-phase parking shares the
   warning suppression, so later admission retries do not repeat its warning.
7. An unreadable job dropped by the runner retains the existing receipt and
   emits one explicit warning per job per connection that cleanup needs
   attention. This selects Fable's **warn-once** option, not receipt removal;
   later admission can skip it, so automatic recovery is not claimed. Warning
   suppression is in memory only and writes nothing to the database.

The receipt proves admission, not completion on its own. The shortcut requires
both deny and receipt plus absence of matching cleanup jobs; parked work is an
explicit exception that remains reported. A deny without the receipt follows
the existing revoke path, including a restored deny whose local receipt was
not imported. Legacy installs where `hasWritetime` is false retain today's
replay path, with redundant record writes bounded by the SQL guards; zero-write
admission is not claimed there. Restore continues to reset projections and
apply tombstones through its existing path, without a new generation protocol.

## Harness and measurement contract

`server/memory/revocation-rewalk-108.test.ts` uses only newly generated temporary
fixtures and pristine copies, the real SQLite implementation and revocation
runner, and bounded drain deadlines. It never opens the user's app or data.

- Before assessing a full runner pass, finish unrelated late-index setup and
  assert an **empty-queue baseline window is zero**. This assertion is also
  independent of the product patch so it can run on the baseline checkout.
  The assertion is authored, not a reported passing baseline result.
- Exercise indexed/fallback duplicate evidence, deleted-but-pinned records,
  nonempty text on deleted records, pending/completed projections, overlapping
  jobs, unchanged placed-source payloads and scope text. Retain ordinary targets
  when isolating repeated effects from legitimate queue bookkeeping.
- The regression **“re-delete an already-cleaned thread on start writes zero
  rows and zero WAL frames”** first cleans and drains, closes/reopens the writer,
  confirms idle work is zero, then performs exactly one deletion admission and
  runner pass, with and without captured sources and with a revoked disclosure.
  Its assertion applies to the memory path, not every boot write.
- Cover both thread selectors for granted and parked jobs, a deny missing its
  receipt, and the unreadable-job warning/retained-receipt behavior.
- Read WAL header bytes **12–23** (checkpoint sequence and salts) on every
  nonempty snapshot. Compare consecutive snapshots and window endpoints; fail
  on generation changes or size shrink. Initial creation of an empty WAL is
  allowed. An actual checkpoint/restart regression must reject flat-size reuse.
- Measure writer `total_changes()` (including triggers), a TEMP callback's
  record UPDATE count, observer `data_version`, WAL bytes and frame count.
  Autocheckpoint is disabled; truncate only before metering. Frame deltas times
  page size estimate SQLite page images, not SSD/NAND wear. Observer changes
  are invalidations, not a reliable count of commits or pages.
- Opt-in 60-second windows: empty-queue baseline, initial deletion, completed
  repeat on **one simulated start**, and idle. Sample once per second, but never
  re-admit on that sampling pulse. Idle pulses only wake the runner. Drain with
  a deadline between deletion windows. Baseline/candidate processes use fresh
  copies with the same seed, SQLite version, page size and WAL settings.

Future authorized command (not run):
`REVOCATION_108_MEASURE=1 pnpm exec vitest run server/memory/revocation-rewalk-108.test.ts -t 'minute measurements'`.
Compare guard-only and full-admission results separately if an intermediate
build is measured. Initial cleanup may write and must drain; completed repeat
and idle windows target zero rows, record UPDATEs, WAL frames and WAL growth.
These are component checks, not full-server verification. Any later server
claim must follow `docs/verification/README.md` with an isolated fixture.

## Registration and limits

The gate-test entry is placed in lexical order beside the other revocation
tests in `ci/gate-tests.txt`. New WAL `openSync`/`readSync` calls are test-only
and explicitly documented in the harness; the attachment read gate excludes
`.test.ts`. No product filesystem reads were added, so
`server/attachment-read-gate.inventory.json` needs no new entry.

This round's permitted validation is static review and `git diff --check` only.
No executed zero-write result, performance reduction, crash/concurrency proof,
restore integration result or live-app success is claimed.
