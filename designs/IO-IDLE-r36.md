# IO-IDLE-DRAIN-1018 r3.6b design: the pace on MEASURED commits (P dropped), a fixed commit cap, the macOS writer-bytes reader

Supersedes the r3.6 design 0ed87c4c5 (Astra BLOCK hz iodrain3/r36/astra-r36d.md: 6 High + 2 Medium, the third BLOCK in a row). Built on
b13k 93c461f1f (branch fix/1018-io-idle-drain-r36; r3.5 cherry-picked as f857bb124). MurageMain rulings R1-R3 and "remove mechanism, do
not add it" (2026-11-07 ~20:40Z) are binding. The watchdog exempts nothing (r3.5 index.ts and its static guard unchanged). No table, index or
schema changes.

## 0c. r3.6c (Astra acct4 BLOCK on 23052973e: H-a and the restart High). Mechanism REMOVED
| Finding | Repeat of | Removed | Kept or added |
|---|---|---|---|
| H-a runner waits for ever on copy debt with no checkpointer | r3.5 H1, r3.6d H-a | the walMaintenanceReady() branch; waiting on an external checkpoint; salt/lastFrame/per-salt proofs | the drain's own PASSIVE after every COMMIT and at every wait decision; a 60 s bound (ruling 2) |
| Restart rule undercharges | r3.5 H3 | the restart rule (a new generation is never the drain's) | a no-wait TRUNCATE reset of a log the drain proved copied (ruling 1) |
| Medium: weak promise asserts | r3.6b | the 1 MB and rebalance-slack bounds in the promise tests | per-minute pace bytes <= 0.8 MB + (cap + 512) x 2W, printed in the gate rows; the split copy retained, then settled |

P-training does not exist (dropped in r3.6b); nothing to re-assess. The cap sweep is re-run on this tree (section 4).

## 0. Repeat Highs, and what was REMOVED for each
| r3.6d finding | Blocked before? | Fix: mechanism removed |
|---|---|---|
| H-a runner holds for ever on copies | yes, r3.5 H1 (runner liveness) | the pace-row admission (P x rows room, "alone" rule, paceAlone) is gone; admission is one test, paceAdmits(); every wait decision settles copies first |
| H-b caps input rows, not changed rows | yes, r3.5 H4 (jobs not sized) | the per-branch rows x B pace charge is gone; ONE transaction-wide cap (changes since BEGIN); fan-out is measured at the COMMIT (R2) |
| H-c copies expire by timer | yes, r3.5 H5 (reservation expiry) | the 10-minute hold timer is gone (fix b): debt until nBackfill, a new salt or a full checkpoint; one entry per salt |
| H-d two over-line minutes | new (accepted by R1) | no mechanism added: the promise is the write minute and the copy minute |
| H-e owner inline walks | new | out of scope (R3); the pace no longer charges them at all (rows x C ledger only) |
| H-f oversized flips override the cap | yes, r3.5 H1 (flip cap) | the Math.max(want, cap) override is gone; flips are cut at planning (fix c) by the existing wildcard hold |
| M ROLLBACK trains P | new | P is gone |
| M >60 s charges vanish at COMMIT | yes, r3.5 Medium / r3.4 Medium (expiry) | the pace has no provisional tagged entries left to age; the ledger's are taken before currentTx clears (fix e) |

## 1. Can P be dropped for "PASSIVE checkpoint after each COMMIT + a fixed row cap"? Yes.
P existed to predict a commit's bytes before it ran. With a fixed cap the most one commit can cost is known without any estimate:
(cap + 512) x 2W. The measurement at the COMMIT already charges every byte at once, and the PASSIVE self-checkpoint after the COMMIT makes the
copy happen, and be proven, in the same minute in the normal case. So the only thing admission needs is "room for what the last commit
cost". Numbers:
- On the 5000-receipt storm the drain measures 30.0 MB for 110,517 rows (271 B a row). P converged to the same figure, so the pace's
  throughput is the same: about 0.8 MB of measured bytes a minute either way. M1 at each cap: section 4.
- Removed: P, its floor (frame/32), cap (4W), seed (one frame), memory (1024 rows), the COMMIT-only training rule, the OS-unknown 2W bound,
  the rows x B up-front charges and their tags, the provisional-vs-measured "only adds" step, the alone rule and paceAlone/paceExcess.
- Kept: the measurement itself (unreadable component, or a new salt: rows x W), the copy debt (fix b), the self-checkpoint, the rows x C
  ledger (1.0.3, unchanged), MARKER_STEP_RESERVE (512, unchanged).

## 2. The rules (server/memory/revoke-budget.ts)
- CAP. A drain-owned transaction (runner tick, bounded drain) changes at most REVOKE_PACE_COMMIT.rows rows in all (txRows: changes since
  its BEGIN), the marker's step reserve past it at most. Job steps and late builds take the rows left as input rows (revokePaceRows).
- ADMIT. Only when the pace is empty, or when the last minute's measured bytes + outstanding copies + the previous commit's measured bytes
  fit REVOKE_PACE (0.8 MB). An empty pace always admits: nothing waits for ever. The wait (revokePaceWaitMs) uses the same need, so a refused
  admission always has a wait of at least 1 ms (copies: a 1 s re-look); the runner never spins.
- CHARGE. At the COMMIT, at once: write = max(OS bytes, frames), copy = frames; an unreadable component or a new salt is rows x W. The sum
  is the next admission's need (a ROLLBACK only raises it).
- NO RESTART RULE (r3.6c, Astra r3.6b High on revoke-budget.ts:441). It is deleted. A commit's frames count only under the salt its
  BEGIN mark read; ANY salt change between the mark and the read after its COMMIT is rows x W, both halves (r3.5 H3), never the new
  generation: another connection can copy the drain's frames and restart the log smaller after its COMMIT. The normal path needs no
  restart: the drain's own copy resets a log it has proven copied (no-wait TRUNCATE, below), so its next commit appends under the salt
  it marked.
- COPY DEBT, PROVEN BY THE DRAIN ITSELF (r3.6c, Astra r3.6b High H-a). One number (copyHeld) and when it was last added (copySince).
  - Proof: the log is COMPLETELY copied now: the drain's own `wal_checkpoint(PASSIVE)` result (checkpointed >= log, read from its own
    call), or the log index (nBackfill >= mxFrame). Every frame of every generation is then in the main file. Late copies also
    retain the coalesced landing mark described below; no per-salt list is kept.
  - The drain runs that PASSIVE itself right after EVERY COMMIT (the walMaintenanceReady() branch is deleted: a checkpointer thread is
    never relied on), and again at every wait decision outside a transaction (revokePaceNeed: the runner tick, the bounded drain before
    each BEGIN, the send fence's settle), so a debt a reader pinned is proven by the drain once the reader ends. It copies only a tail
    of at most its own debt plus one commit at the ceiling: the serving thread never copies another writer's backlog.
  - Reset (MurageMain ruling 1): a log so proven copied is reset by `wal_checkpoint(TRUNCATE)` with busy_timeout 0 for that one call,
    restored in a finally. The guard checks the copy proof again; foreign commits after that guard are detected and charged under section A.
    A reader or writer can make it return busy (logResetsBusy); any copy in that call is accounted for as on success.
  - BOUND (MurageMain ruling 2): COPY_PROOF_MAX_MS = 60 s (one window) after the latest commit that added debt. Unproven by then (a
    pinned reader), the debt is dated then: that minute is its copy minute, it holds the pace one more minute, and the drain runs on.
    Justification: the drain cannot move a reader; a longer bound only stops the drain longer behind it, a shorter one would date
    copies a checkpointer is still making. The copy is also kept as a LATE copy and charged AGAIN in the minute it actually lands (the
    next look that proves its frames copied), so the minute it lands is counted; the watchdog counts that minute's OS bytes too.
  - The wait while copies alone fill the pace re-looks every 1 s, or at the bound if sooner; never 0, never for ever.
  - Ruling A: the reset guard still skips a changed or incompletely copied log (logResetsSkipped). Section A below replaces the residual window claim.
  - Ruling B (22:33Z, Astra r3.6c High B): LATE copies get a landing proof again, as ONE coalesced record (bytes summed, the newest
    lapse's salt, lastFrame max under it), never a list. It is charged on nBackfill >= lastFrame under that salt, a salt change, or the
    log completely copied. Coalesced, a late copy that landed before a later one is charged at the later one's landing. Test "ruling B
    two readers".
  - Before each drain transaction (every wait decision outside one: the runner tick, the bounded drain before each BEGIN) a log another
    connection's checkpoint left completely copied is reset the same way (readyLog), so the next drain commit does not restart it. If the
    reset meets a writer, that commit's restart is rows x W.
- FLIP CUTOFF (fix c). revokeFlipCutoffRows = min(revokeMinuteChanges, cap + 512). revoke-commit.ts receiptPlanTooBig uses it, so a bigger
  plan hangs on the wildcard pair. Plans are read again when a flip drains, so persisted flips are cut the same way.

### A. The reset is charged for what it copied (replaces the "at most one commit" residual)
The window is no longer bounded or described as one commit. It is detected and charged.
1. `resetCopiedLog` reads `PRAGMA data_version` (dv0) BEFORE the guard's wal-index read, and the per-OS counter (os0, below) right after the guard.
2. It runs the TRUNCATE (busy_timeout 0, restored in a finally; unchanged). Then, whatever the result (busy or not, because a busy TRUNCATE has still run the copy step), it reads os1 and dv1.
3. If dv1 equals dv0, no other connection committed between the guard and the end of the call. The guard proved the log completely copied, so the call copied nothing foreign and nothing is charged. This is exact, not a bound.
4. If dv1 differs from dv0, one or more foreign commits landed, however many. Their frames may have been copied by this call:
   - if os0 and os1 are both trusted and os1 - os0 > 0: charge (os1 - os0) to the pace, now, as a copy (meter `resetForeignMeasured`);
   - otherwise (unknown, a counter that fell, or a ZERO delta, because a zero with a foreign commit is UNKNOWN, not zero): charge rows x W with rows = max(the drain's last commit's rows, cap + 512). It is never 0, including a readyLog reset before any drain commit (Astra r36d High). This is the MANDATED FALLBACK (MurageMain 23:06Z), not exact accounting: no row count bounds arbitrary foreign writes. The watchdog's OS floor (linux, and darwin once proven) still counts the real bytes (meter `resetForeignUnknown`).
   - A data_version read that fails BEFORE the call skips the reset (logResetsSkipped). One that fails AFTER the call counts as "changed" with an UNKNOWN counter, so it takes rows x W. Missing samples are never treated as equal.
   - The busy path is accounted exactly like success: the copy step may have run.
   A commit that lands after the call but before the dv1 read is a false positive. It is overcharged, never undercharged.
5. Verified on hz (sqlite3 3.x via python3 -I, scratch r36/sqlt):
   - the TRUNCATE's own result is 0|0|0, so it cannot count the copy;
   - data_version is unchanged by our own TRUNCATE, unchanged by a quiet TRUNCATE, and changed after two foreign commits followed by a TRUNCATE.

#### The per-OS counter (same sources as the shipped charge; WINIOB worker-controller.ts:711-716 takes the larger of fsWrite blocks and WAL bytes, and treats blocks as 0 on win32)
- linux: `/proc/thread-self/io` write_bytes (txOsBlocks; the TRUNCATE runs on this thread). Trusted.
- darwin: the addon's `diskWritten` (proc_pid_rusage ri_diskio_byteswritten), via darwinWrittenBytes: null on any failure or a fall. NOT getrusage ru_oublock / process.resourceUsage().fsWrite, which reads ~0 on macOS (the gate lane's io finding; the os-disk-written.ts header). Trusted only once gate lane a6aeaf0b's io verdict (~00:15Z) confirms that diskWritten moves for a checkpoint's writes on the gate Mac. Until then darwin counts as UNKNOWN, so a detected foreign commit is charged rows x W.
- win32 and everything else: no OS counter, so UNKNOWN (rows x W on a detected foreign commit).

#### One deviation from the ruling's wording, for reviewers and MurageMain
The ruling says to skip the reset where the counter is unknown. With data_version, a reset with no foreign commit is proven to copy nothing foreign on every OS, so the counter only matters once a foreign commit is detected, and then the unknown case already takes rows x W. Skipping every reset on win32 instead would bring back the ~2,000 min M1 (no reset means each commit meets a log it must restart). That would be a platform hold.
Recommendation: reset on every OS; unknown is charged rows x W only when dv changed.
**MurageMain ruling 23:11Z (APPROVED):** "The deviation is approved: reset on every OS. The data_version check makes it fail closed. Unchanged means nothing foreign (exact); changed with an UNKNOWN or zero counter means rows x W. Skipping win32 would be a platform hold, which is not allowed." Conditions: (1) a test for data_version changed + counter unknown -> rows x W on a faked win32, with mutant "trust unknown as 0" going RED; (2) a test that data_version sees a commit from ANOTHER connection in the same process, not only from another process; (3) this wording sits in s6 for both reviewers.

### B. Medium :537 (Astra) / Low (Fable): an unmeasured copy keeps a landing mark
Today, an unmeasured commit stores copyMark {salt: null, lastFrame: 0}. After it lapses, only a full copy charges it.
- The landing mark no longer depends on the byte measurement: the post-COMMIT `walIndexMark` is read even when the OS counter or the frame bytes are unknown. Only an unreadable index gives no mark.
- With no readable index at the commit, the mark is DEFERRED. Rev 3 (Astra r36d2): there is NO baseline shortcut, because an earlier mark cannot prove which generation the commit wrote in (the log can restart at the commit's first write). The first recovered mark is always ADOPTED conservatively as the record's {salt, lastFrame = its mxFrame}. It lands only on later evidence (nBackfill >= lastFrame under that salt, a later salt change, or a full copy).
  - No claim is made that the first recovery proves a restart. If a restart came before recovery, the charge is later than the true landing, never skipped.
- Coalescing (ruling B) is unchanged: one record, bytes summed, the newest salt, lastFrame max under it.

### THE PROMISE (R1)
A commit that costs more than the one before it costs at most its write minute and its copy minute over the pace, each by at most
(REVOKE_PACE_COMMIT.rows + MARKER_STEP_RESERVE) x 2W (16.9 MB at 512, 10.5 MB at 128, 9.5 MB at 64). Its bytes are charged at its COMMIT, so
the next admission waits. The watchdog counts every byte; nothing is hidden. Test: "R1 split copy" (a reader pinned across the misestimated
commit splits its copy into the next minute; at most those two minutes are over).

### R2: job steps and late builds
The per-commit row bound covers marker slices. A job step or late build is bounded per INPUT row: one input row can fan out (a late build's
broughtFrom origins). Its rows are measured at the COMMIT and charged at once, and the next step waits for room.
- Largest single-row origin fan-out on Sean's data copy (hz rh3-data/pristine/messages.db, read-only, immutable): 0. The file has 157,327
  source versions and none in the bring-in range, and no payload carries broughtFrom. No revocation job rows are queued. One row's charge
  alone does not break the line on Sean's data.
- Test: "R2 huge origins" (one input row with 40,000 origins: charged at once, the next step waits, then resumes).

### R3: owner inline walks are out of scope
revoke-commit.ts markInline (`only`) runs inside the owner's own transaction under the inline deadline. It is charged in the rows x C
ledger only, not in the pace. Shipped gap, listed below.

## 3. The macOS writer-bytes reader (unchanged from 0ed87c4c5, Astra found no blocker)
exclusion.c disk_written() under #ifdef __APPLE__ (proc_pid_rusage(getpid()).ri_diskio_byteswritten); DARWIN_ADDON_FUNCTIONS enforced at
after-pack; os-disk-written.ts darwinWrittenBytes() returns null on any failure or a count that went down; io-budget readProcess (darwin)
and the unknown minute (never calm, x1/2, sample invalid, one line an hour). Coverage = self + threads, as linux RUSAGE_SELF.

## 4. M1 cap sweep (5000-receipt storm, full scale; ship the smallest cap whose M1 stays under 86 min)
| cap (rows a commit) | M1 minutes | finished | trips (1 MB idle) | max minute | measured bytes |
|---|---|---|---|---|---|
| 512 | 68 | yes | 0 | 0.90 MB | 48.8 MB |
| 128 | over 90 (the test's cap) | no | 0 | 0.83 MB | 66.4 MB by minute 90 |
| 64 | over 90 (the test's cap) | no | 0 | 0.85 MB | 67.3 MB by minute 90 |

Shipped: 512 (REVOKE_PACE_COMMIT.rows unchanged). Smaller commits cost more bytes a row (shared pages are written and copied once per commit),
so they pace slower. hz out/m1/iodrain-m1-{512,128,64}.log, linux, the production pace 0.8 MB.

## 5. Tests by rule (server/io-budget-revoke-bounds.test.ts, server/io-budget-revoke-pace.test.ts)
cap; (i) one misestimate; R1 split copy; (ii) unreadable = W; H1 alone + no spin; H4 rows left + charged; H4 wiring; R2 huge origins;
(c) flip cutoff; H5 pinned reader; Medium (tx open 3 min); R1 darwinWrittenBytes; R2 unknown minute; M1; M1 mutant; M2; M3.

r3.6d: reset charges foreign commits (includes the former ruling A window); reset zero counter is unknown; reset quiet; ruling A guard;
ruling B two readers; ruling B two lapsed copies; unavailable mark recovery; reset unknown counter win32; data_version same-process connection;
reset busy copies foreign; readyLog before first commit; data_version unreadable; deferred mark after restart; deferred mark partial landing;
darwin diskWritten cross-check (darwin only).

## 6. Shipped gaps
- Owner inline walks are outside the pace (R3).
- Job-step and late-build fan-out is bounded per input row, not per commit (R2); 0 on Sean's data.
- A reader pinned past 60 s: each lapse dates at most one commit's copy (at most (cap + 512) x W) without proof; that copy is charged
  again when it lands, but the drain may have run more commits meanwhile, so the landing minute can hold several late copies. Counted
  in full by the pace and the watchdog, not prevented (MurageMain ruling 2: never block for ever).
- The drain's own copy runs on the serving thread: one PASSIVE (and its fsync) per drain commit, on a tail of at most its debt plus one
  commit's frames at the ceiling, whoever wrote them. In the send fence (drainRevokeMarkerBounded, the owner's 40 ms budget) that copy and
  its fsync run after each slice's COMMIT and the deadline is checked only between slices, so one slice's copy can run past the fence's
  40 ms (accepted under ruling 1; Fable seat 2 Low 3).
- Children (memory worker fork, avatar encoder) are in no OS floor; their database writes reach the watchdog as WAL frames.
- win32 has no OS floor (WIN-IOB-QUICK, unchanged).
- Reset foreign writes with an unknown, falling or zero counter, or an unreadable post-call data_version, take the MANDATED FALLBACK:
  max(lastCommitRows, cap + 512) x W. This is MurageMain's required charge, not exact accounting or a bound on arbitrary foreign writes.
  A commit after the call but before the final data_version read can be overcharged. Linux's OS floor still counts the real bytes.
- Darwin reset counters remain UNKNOWN until the gate Mac proves diskWritten counts checkpoint writes. DARWIN_RESET_COUNTER_TRUSTED
  stays false; enabling it is a separate one-line follow-up gated on the darwin diskWritten cross-check. win32 has no OS counter.
- An unreadable COMMIT index defers the landing mark. The first recovered mark is adopted without a baseline shortcut; if a restart
  preceded recovery, the charge can be later than the actual landing. Later backfill, salt change or a full copy lands it.

**MurageMain ruling 23:11Z (APPROVED):** "The deviation is approved: reset on every OS. The data_version check makes it fail closed. Unchanged means nothing foreign (exact); changed with an UNKNOWN or zero counter means rows x W. Skipping win32 would be a platform hold, which is not allowed." Conditions: (1) a test for data_version changed + counter unknown -> rows x W on a faked win32, with mutant "trust unknown as 0" going RED; (2) a test that data_version sees a commit from ANOTHER connection in the same process, not only from another process; (3) this wording sits in s6 for both reviewers.
