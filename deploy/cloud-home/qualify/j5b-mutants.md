# J5b mutant definitions (DESIGN-J5b-r7.md section 8.1; r6 definitions stand)

A mutant is a one-line break of the finished code. The test named in the last column must fail on it. MU-1 to MU-47 are defined in DESIGN-J5b-r5.md section 8
and unchanged, except MU-15, MU-38 and MU-47, which r7 redefines below. "Killed by" is the r7 assignment.

## r7 additions and redefinitions

| Id | Definition | Killed by |
|---|---|---|
| MU-15 (redefined) | retire the old pending entry in memory before the overflow record is durable | P21b |
| MU-38 (redefined) | extended mode still serves the `eventSpoolFailures` counter | T7 |
| MU-47 (redefined) | the duplicate path runs an unguarded detail UPDATE | C5 |
| MU-58b | the detail UPDATE runs outside the batch WITHOUT the NOT EXISTS guard | C6 (fault b) |
| MU-72 | tombstones ignored when choosing `at` | T14 |
| MU-73 | tombstones not reloaded at boot | T14 |
| MU-74 | a reassigned key is sent before its `add` is durable | P7c |
| MU-75 | an id is removed from the map after a failed `done` | T15 |
| MU-76 | the retire gate is removed | T15 |
| MU-77 | durable accepted ids are listed in both lists | P25 (D1 build) |
| MU-78 | 512 ids per list instead of 512 in total | P25 |
| MU-79 | a dirty `sent` is retried alone while later keys get their own records | P24 |
| MU-80 | the body ignores the remaining dirty capacity | P18 |
| MU-81 | the app reader accepts more than 512 ids, or an id in both lists | T16 |
| MU-82 | the advertisement is kept across a failed heartbeat (PIN of base behavior) | P5b |
| MU-H1 | the app holds new events in memory without setting `outboxDegraded` and without raising the failure alert (MurageMain r7 ruling 8) | T18 (flag half), P27 (alert half), C8 (the alert has an owner) |

## r6 definitions (MU-48 to MU-71)

MU-48 `homeEventsHealthFields` ignores the advertisement; MU-49 legacy mode clears held items on each render; MU-50 the advertisement write moved after the first
intake; MU-51 a pending entry is removed after a failed heartbeat; MU-52 a retry re-runs key allocation including the entry's own key; MU-53 the map insert comes
before the outbox fsync; MU-54 boot skips the outbox load; MU-55 the DIRTY_MAX check is removed; MU-56 prune `ORDER BY first_seen DESC`; MU-57 the `accepted` list is
ignored; MU-58 statement 2 runs after the batch; MU-59 restore items capped at 32 instead of 31; MU-60 control pending cap 64 plus the slot; MU-61 ACK ids = newest 512;
MU-62 `good_len` repair only at load; MU-63 CRC not checked; MU-64 one record per op; MU-65 the dir fsync after the marker rename is removed; MU-66 the stuck id is
derived from `at`; MU-67 intake on the main loop; MU-68 an overflow folds into an existing failure item; MU-69 control folds into its pending failure entry;
MU-70 the app `good_len` repair is removed; MU-71 the legacy migration id is random.

## r8 additions (DESIGN-J5b-r8.md section 8.1)

| Id | Definition | Killed by |
|---|---|---|
| MU-57 (redefined) | `accepted` ignored, only `acked` retires | T4b-1 |
| MU-83 | compaction drops tombstones without writing or raising `floor` | T14c, T17f |
| MU-84 | key choice ignores `floor` | T17f |
| MU-85 | appended records omit `retiring` `done` ops | T15b |
| MU-86 | control appends through the old descriptor after the rename when the directory fsync fails | P28 |
| MU-87 | the app does the same | T19 |
| MU-88 | the fstat/stat identity check is skipped before a `done` claim | T19b |
| MU-89 (r8b) | admits a response that crossed the receipt publication boundary | Admission pending/published cases |
| MU-90 | a second hold item in one episode after a control restart with a working journal | P27 (restart case) |
| MU-H1 | the app holds an item without counting it in `outboxDegraded` (and so in `opsAlertsWaiting`) | T18, T20s |
| MU-H1b | control ignores `outboxDegraded` | P27 |
| MU-H1c | home.event_spool_failed left in the digest tier, or its action text omits the owner | C8 (CP side) |
| MU-H2 | the customer line is never shown | T20 |
| MU-H3 | the customer line does not clear at 0 | T20 |
| MU-91 | the legacy spool file is unlinked although its `add` is not durable | LegacySpoolMigration (journal refusing writes) |
| MU-92 | the poll path reads the legacy folder again (journal_owns_legacy off: the file is carried and consumed by the heartbeat health path) | LegacySpoolMigration |
| MU-10 (r8 form) | a new id whose key is retained is not moved to at + 1 (control `take`; app `chooseAt`, MU-10a) | P7c, P26 and P17 (control); T14, T17f, T13 (app) |

Why MU-86 and MU-87 die only in their combined form (accepted by MurageMain): two layers each refuse a stale descriptor. Layer 1 is the relink gate
(after a compaction rename the old descriptor is closed and nothing is appended until the new inode is open). Layer 2 is the identity check (fstat of
the descriptor against stat of the path before every append and every `done` claim). With only the gate removed, the identity check still refuses the
append; with only the identity check removed, the gate still closes the descriptor. The single-layer mutants survive by design, so MU-86 (control) and
MU-87 (app) remove both layers, and P28 and T19 die. MU-88 removes the identity check alone before a `done` claim; it dies alone because T19b reaches
the claim with the gate already satisfied, so no second layer covers that path.



## r8b qualification

The built r8 P25 fixture already has 512 durable candidates plus 32 accepted ids. T17f already creates 300 later items and checks the missing tombstone and covering floor. C7c-bound tests the oldest retained key, and T19b replaces the inode without a relink fault. These are existing guards at the r8 build heads, not new RED claims.

| Mutation | Discriminator |
|---|---|
| M2-send-gate | probes and durable admission continue during a blocked memory-only send |
| M2-admit-pending | an in-flight response cannot enter during unpublished receipt state |
| M2-publication-finish | a response begun during the ACK write is invalidated when publication completes |
| M2-positive-gate | positive degradation probes still raise a hold while receipt publication is blocked |
| M3-owned-ack | a control-generated hold can reach CP without an app ACK |
| M2-stale-generation | an in-flight response cannot enter after a newer receipt was published |
| M4-reload-zero | an unresolved reloaded add keeps degradation positive |
| M4-pass-reloaded | a later append cannot pass an unresolved reloaded add |
| M4-no-completion | recovery, compaction, restart and a second episode |
| M4-eager-completion | a refused end append cannot close the episode in memory |
| M5-historical-count | the real customer count clears after a recovery record |
| M5-no-loss-report | rejected admissions produce a durable failure report on recovery |
| M3-no-reservation | a hold reaches CP with 32 ordinary dirty receipts |
| M3-displace-hold | the pending failure slot remains owned by the hold |
| M3-spend-reservation | ordinary traffic cannot consume the extra hold receipt |
| M1-newest-only | actual retained membership, including the interval before pruning |
| M7-short-deadline | a hold just after a heartbeat arrives on the next normal cadence |
| M7-captured-recovery | recovery is polled again until zero |
| LOW-H33 | 96 + H reaches the strict retention boundary at H = 32 |

MU-78, MU-83, MU-84, MU-88 and CP MU-45 are also run individually. Each mutation starts from the restored source bytes and restores those bytes in a finally block. The scripts and logs are retained in the r8b job evidence, outside the commits.
