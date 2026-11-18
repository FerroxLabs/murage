# ACCEPTANCE PACK: boot tolerance (read-only start), amended after the reproduction (build round 1)
PURPOSE: A nearly full disk must leave chats readable while refusing writes and preserving every recovery input for a writable restart.
USER PROMISES: Read-only starts change no data bytes; refused recovery stays pending; a fresh normal start settles it without duplication.
Owners: pack r3 + design = fprod2-bootdesign3; this amendment, every row's test, mutant and fix = fprod2-bootbuild1 (the fix lane MAIN seated 2026-11-17T00:55Z).
it-remote IT_DOCKER_EXTRA (host tooling, T0) = fprod2-bootbuild1. Floor producer (wal-maintenance.ts worker statfs, 64 MiB) = scperf-p1; the edits this lane makes there
(the shared FLOOR_BYTES constant and the `DiskFloorRefusal` type at the admission throw) are owned by fprod2-bootbuild1 and reviewed by scperf-p1. Copy = MAIN ruling text.
Base = dev/1019-int-train5 @ 4edfcd8956. Design = BOOT-TOLERANCE-DESIGN.r3.md, as corrected by the amendments below (section "Design corrections").

Rules for every row: real code paths, no production test hooks, no raised limits. Space is made scarce only with a real small filesystem (`--tmpfs /strict:size=<N>m`,
row T0) plus a ballast file. Logs go to the lane job dir, never the tree. A row passes only if its test is GREEN at the fix head and its named mutant (applied alone,
`node scripts/typecheck-budget.mjs full` clean) turns it RED by assertion. Every row has a mutant (Astra 9, Fable 6). Anything outside this pack is a follow-up.

**Snapshot** (Astra 4): for every table in `sqlite_master` (type='table', `sqlite_%` excluded) the sha256 of all rows ordered by the table's primary key columns
(`pragma table_info` pk order; rowid only for rowid tables without a declared key; `WITHOUT ROWID` tables by their key), read by a separate read-only connection after
the server stops; plus the inventory of the data dir (every regular file's relative path and size, `-wal`/`-shm` excluded) and the sha256 of every `*.json` file.
Two snapshots are equal only if all three parts are equal.

**Owner copy** (MAIN ruling 1 and the build order, exact en text): "Your disk is almost full. Chats are read-only. Free some space, then restart Murage."
It is the Inbox read-only line, the one notice body, and the `error` of every read-only refusal (so the phone, which shows `body.error`, reads it too: ruling 2).

## R0: the reproduction (MAIN 00:55Z item 1; Astra 1, Fable 1-2). RUN AT BASE BEFORE ANY FIX COMMIT: done, REPRO-POSITIVE.
| row | runnable test (file > case) | setup | pass condition at the fix head | base result (it-remote, tmpfs 256m) | mutant |
|---|---|---|---|---|---|
| R0a | server/low-disk-repro.test.ts > R0a free below the 64 MiB worker floor before the start | fixture start with ample space (2 bots via API), stop, ballast to 40 MiB free, start | health 200 within 60 s, process alive; ballast removed: `integrity_check` ok, next start serves with the same bots | RED: exit 1 in 3.5 s, uncaught `DatabaseBusyError("wal-recovery")` from `ReplyState.boot` (index.ts:10883 > reply-state.ts:167 > database.ts:506 > wal-maintenance.ts:72) | MS1 (mode always normal) |
| R0b | same > R0b about 0 bytes free before the start | ballast until ENOSPC | as R0a | RED: exit 1, `DataDirLeaseError LEASE_IO` (index.ts:1478 > data-dir-lease.mjs:484), before the database opens. **Open: QUESTIONS-FOR-MAIN 4** (the data-dir lease cannot be written at 0 bytes; serving without it is a data-safety ruling). Until ruled, R0b stays RED at the fix head and is reported as such; its assertion is not changed | MS1 |
| R0c | same > R0c the disk fills to 0 during the start | ample at spawn; ballast to ENOSPC at the server's first output line | as R0a | RED: exit 1, uncaught `SQLITE_FULL` (errcode 13) at database.ts:531 from `ReplyState.boot` | MB1 (bootStep rethrows low-disk) |
| R0d | same > R0d the disk crosses the 64 MiB floor during the start | ample at spawn; ballast to 40 MiB at the first output line | as R0a | GREEN (the worker had not sampled before boot's writes) | MS1 is not expected to kill R0d; R0d is a pin and is paired with R0a |
| R0e | same > R0e about 1 MiB free before the start (Fable 2) | ballast to 1 MiB free | as R0a | to be run at base before the fix commit that greens it | MS1 |

## Rows (r3 rows kept unless amended; amended text is marked with the reviewer item it answers)
| row | runnable test (file > case) | setup | pass condition | mutant that must turn it RED |
|---|---|---|---|---|
| T0 | host: tools/it-remote.test.sh (lane job dir t0/, run against the installed it-remote.sh) | fake ssh/rsync on PATH | `IT_DOCKER_EXTRA="--tmpfs /strict:size=<1..2048>m"` reaches the remote docker command; `--privileged`, `-v`, `--cap-add`, a second flag, any other mount path and a size over 2048m each exit 64 with no ssh call; unset adds nothing (Fable 6: sizes 96m..1024m are all in range) | pass-through accepts any flag |
| A1 | server/read-only-start.test.ts > decides once from the nearest existing directory | temp dirs on /strict (real statfs; skipped where /strict is not a mount) | DATA_DIR missing: the decision reads statfs of the nearest existing ancestor and DATA_DIR still does not exist afterwards. Free < START_FLOOR_BYTES (128 MiB) gives `read-only`; >= gives `normal`. A second call after free changes returns the first answer | MS2 (re-decide on every call); MS4 (statfs of DATA_DIR itself, Fable A1) |
| A2 | server/low-disk-strict.test.ts > read-only start serves reads and refuses every write | tmpfs 256m; fixture F built by a normal start, stopped; ballast to 100 MiB free | Health 200 with `diskLow.mode="read-only"`. Thread list and 5 thread bodies equal the pre-stop capture. POST /api/bots, POST a message, PATCH a setting and DELETE a thread each return 503 with `code:"DATABASE_BUSY"`, `reason:"read-only-start"`, `retryable:false`, no Retry-After, and `error` = the owner copy (Astra 2, Fable 3). The process is alive after the refusals and its output has no `unhandledRejection` line (Astra 2). `[startup] writes since open=0`. Serves 35 s (Fable 5) with a routine due at start: no turn starts. Snapshot unchanged after the 35 s and the refused writes | MS1; MG2 (request-edge refusal removed); MG4 (the refusal thrown from the gate call outside the handler's try, as the r3 design wrote it: the first refused write kills the process) |
| A2b | same > a read-only start leaves the browser files alone (Astra 3) | fixture F plus the two browser states that write JSON at boot: a migrated-owner profile record and a failed-close record (`browser-control.ts:104`, `:179`) | In A2's run, both JSON files' bytes and the data-dir inventory are unchanged; the browser recovery is listed in `skippedAtStart`. R0e covers the zero-free case for the same files | MG5 (bootStep around the browser recovery at index.ts:3705 removed) |
| A3 | same > a read-only start is an ordinary start to the shell | the A2 server | `electron/server-boot-probe.mjs`'s classifier (the function behind :160-175) classifies the A2 health response as ready | MS3 (read-only start answers 503 on health) |
| A4 | same > writes return only through a fresh start | after A2 | Ballast removed: still read-only, POST is 503 read-only-start, `diskLow.mode` unchanged. SIGTERM, restart: mode normal, POST /api/bots is 201, every fixture class settled (one assertion per class) | MS2 |
| A5 | same > read-only start with the required index missing writes nothing | fixture F with messages_turn dropped, ballast 100 MiB | Exit before listen with `TurnIndexNotReadyError` and `[startup] read-only start: required index missing`. Snapshot unchanged, index absent. Free space, restart: index ok, serves | MI (read-only start builds the index) |
| A6 | server/read-only-start.test.ts > no migration starts read-only | the existing pre-v4 schema fixture | With mode read-only, openDatabase throws `DiskFloorRefusal("start-migration")` before any snapshot file exists; schema version unchanged | MM (guard removed) |
| B1 | server/boot-step.test.ts > a low-disk failure switches the start to read-only | unit, real errors: a `DiskFloorRefusal`, a real SQLITE_FULL from a full /strict database, a real ENOSPC from a write on /strict | each returns the fallback, mode becomes read-only, the step and every later step are listed in `skippedAtStart`; SQLITE_BUSY and a plain Error are rethrown; in read-only mode a step's run is never called | MB1 (catch rethrows low-disk) |
| B2 | server/low-disk-strict.test.ts > disk fills during the open path's index build (Fable 6 sizing) | tmpfs 1024m; fixture F plus 1.5 M message rows (row count and index size measured and logged), messages_turn dropped, ballast so free is above 128 MiB but below the build's need | Start check `normal`. The build fails SQLITE_FULL, the process exits before listen with `[startup] low disk during start`, snapshot unchanged. Two more starts behave the same | MB2 (a failed open-path build is caught and the start listens): the snapshot changes or health answers, RED |
| B3 | electron/main-startup-failure.node-test.mjs > a child that exits before listen ends in the failure state | the launcher's startup failure path (main.mjs:2904-2953), stub child exiting before its first health answer | After the finite retries the launcher reaches its failure state, no further spawn; the serving-child supervisor (1526-1529, 2930-2933) is not consulted | ML (retry count unbounded) |
| C1 | server/low-disk-classify.test.ts > a worker-published floor refusal keeps its type through both wrappers | (Astra 5, Fable 6) tmpfs 512m: a NORMAL start check (free > 128 MiB), one committed write so `-wal` exists, then ballast to < 64 MiB and wait for the worker's verdict | `withBusyBudget(…,"boot-mark",…)` and `transaction(…)` both throw `instanceof DiskFloorRefusal`, `isLowDisk` true, mode is still `normal` (the refusal is the worker's, not the sticky mode). Negative control on the container's own /tmp (no tmpfs, ample free): `-wal` >= WAL_ADMISSION_BYTES while the checkpointer lags gives `DatabaseBusyError` that is NOT a `DiskFloorRefusal` | MP (rethrow at database.ts:497 removed); MW (the `copiedBytes < 0n` branch removed) |
| D1 | server/low-disk-strict.test.ts > read-only state stays visible after space returns | A2, then A4's ballast removal | /api/health and the desktop Inbox GET carry `diskLow.mode="read-only"` before and after the ballast is removed | MN1 (`diskLow` attached only while the live floor refuses) |
| D2 | src/components/Inbox.disk.test.tsx > renders each mode in every locale, with the restart button (Astra 10, Fable 4) | render | read-only and refusing each render the section title and their line in 8 locales, no raw key, no English outside en. Read-only shows a "Restart Murage" button when `window.muragebox.restartForFluxKey` exists; clicking calls it once; when it is missing or rejects, the line shows the quit-and-reopen fallback text | MN2 (client renders only `refusing`); MR (button never calls the relaunch action) |
| D3 | server/low-disk-strict.test.ts > one owner notice, nothing written | A2 server, two websocket clients in turn | exactly one `{kind:"notify"}` frame with id `disk.read-only-start` per process, body = owner copy; snapshot unchanged | MN3 (notice per connection) |
| D4 | server/low-disk-strict.test.ts > a runtime floor is shown and clears (Astra 7, narrowed) | tmpfs 512m, normal start of F, then ballast to < 64 MiB after health | `diskLow.mode="refusing"` on health and Inbox, POST is 503 with `reason:"disk-floor"`. Ballast removed and one worker sample later: `diskLow` absent, POST 201. No claim is made about boot recoveries finishing in this process: they run at the next start (A4) | MN4 (`refusing` never reported) |
| D5 | server/boot-step-callers.test.ts > a caught boot failure switches the start (Astra 6) | C1 setup (normal mode, worker floor refusing), the real `recoverOwnerSends` caller and the real venue recovery caller, each run with its production catch | each caller's refusal switches the mode to read-only and names the step; the send row and the venue row are unchanged | MG3 (bootStep inside recoverOwnerSends' catch removed: mode stays normal); MG1 (bootStep inside the venue recovery catch removed) |
| E1 | server/venue-post-held.test.ts > composed recovery is all or nothing | C1 setup (Astra 5); a `posting` row with its card | `recoverAndSettleVenuePosts` throws `DiskFloorRefusal`, row still `posting`, card unanswered. Ballast removed (normal process, worker floor clears): the next call settles both | MV (move outside the transaction) |
| E2 | server/routine-run-card.test.ts > a failure between the unread mark and the card loses nothing, group and task (Astra 8) | a group's routine run AND a task's routine run, status completed; the unread write made to fail for real (groups.json's dir read-only; for the task, the task-turn-state path read-only; the container runs as uid 2001, Fable 6) | first call throws and writes no card; writable again: next call writes the card, sets unread in the right store, sends one notification | MW2 (card before unread) |
| E3 | server/boot-settle-109.crash.test.ts > deterministic deaths at named points (Astra 8) | child pattern of boot-settle-108: the child prints `REACHED <point>` and exits 9 at: `card:after-unread` (group), `card:after-unread` (task), `venue:after-move` (inside the transaction, before settle), `readonly:after-listen` | each death asserts its point was reached; the next normal start settles every class; one more start changes nothing (snapshot equal) | MV; MW2 |
| E4 | server/team-identities-switch.test.ts > a refused roster save switches to read-only, disk to the next start (Astra 5) | tmpfs: normal start check; the roster's `writeFileAtomic` (team-lifecycle.ts:137-143) fails for real with ENOSPC after the in-memory mutation (ballast to 0 before the step) | the start switches to read-only and serves; bots.json lacks the change; after restart with space it has it | MB1 |
| F1 | src/locales/disk-copy.test.ts > copy promises only what exists | locale files and db-busy | the keys exist in 8 locales; en read-only line, notice body and the read-only 503 body equal the owner copy; no en disk string contains later, automatic, continue, queued, saved for, resume, try again, moment (Fable 3) | MC (en refusal body "Busy for a moment, try again") |
| G1 | src/state/send-delivery.disk.test.ts > a send refused read-only is not retried for the life of the process (Fable 3) | the real client send path against a stub fetch answering A2's 503 body | the send is marked failed with the owner copy after its first refusal; no re-post within 30 s; the settings write shows the owner copy and is not repeated. After a restart (fresh client state) the failed send is not re-posted by itself | MG6 (client treats `retryable:false` 503 as retryable) |

## Design corrections adopted by this amendment
1. Request edge (Astra 2): the read-only refusal is answered inside the handler's `try`, never thrown from the pre-`try` call at index.ts:28012. That call keeps
   method AND path (the second call at :28016 is removed or given the path), so READ_ONLY_POSTS still works. `busyJson` serializes `reason` and, for
   `read-only-start`, `retryable:false`, no Retry-After, and the owner copy as `error`.
2. Every boot recovery that writes files, not only SQL, is a `bootStep` (Astra 3): the browser recovery (index.ts:3705), `ownWriteHolds.recover` (index.ts:39649, Fable 5),
   and `routines.start()` (index.ts:40049, Fable 5) do not run read-only. Inbound channel receivers do not start in a read-only process, so nothing is acknowledged
   upstream and then refused (Fable 5); if a receiver cannot be held back, it is listed in QUESTIONS-FOR-MAIN.
3. `bootStep` sits inside each swallowing catch (Astra 6), so a caught low-disk failure switches the mode visibly.
4. D4 makes no claim that recoveries finish in the same process (Astra 7).
5. The copy is the MAIN owner copy, with the existing relaunch action as a button (Astra 10, Fable 4).
6. Ownership of wal-maintenance.ts edits is stated in the header (Fable follow-up).
7. Citation: the startup directory initializer is config.ts:709-714 (Astra follow-up).

## Build round 1 status (fprod2-bootbuild1)
- R0 mutants, corrected by run: a read-only start is guarded by two layers (the start check and the boot-step switch), so no single-layer mutant kills R0a/R0e.
  R0a/R0e: MX (start check always normal AND bootStep rethrows low disk). R0c: MB1. R0d: MU (bootStep removed from `projects.linkLegacyRuns`, a step after the
  mid-boot switch). All RED by assertion; R0b stays RED pending QUESTIONS-FOR-MAIN 4.
- GREEN with mutants killed: T0 (host), R0a/c/d/e, A2 core (owner copy 503, `reason`, `retryable:false`, no Retry-After, process alive, reads served; MS1, MG2, MG4).
- Unit only so far: A1 decision (no /strict cache leg yet, MS2/MS4 not run), B1 with constructed errors.
- Not built yet: A2 full (fixture F, snapshot, 35 s, write trace), A2b, A3-A6, B2, B3, C1, D1-D5, E1-E4, F1, G1.

## Operator log lines added by this lane (English, stderr only; never shown to the owner, so not in the locale catalog)
Owner: the boot-tolerance fix lane. The owner-facing words are the owner copy above; these two lines are for logs and for the tests that read the output.
| line | written by | when | witnessed by |
|---|---|---|---|
| `[startup] read-only start: required index missing` | server/read-only-index-gate.ts (before the lease), server/database.ts (open path) | a read-only start finds the turn index missing and stops before listen | A5 |
| `[startup] low disk during start: the database could not be opened; nothing was changed` | server/database.ts (open path's catch) | a build or write in the open path met a full disk; the statement rolled back | B2: the snapshot (every table, the inventory, every json file) is equal after each of three such starts, which is what "nothing was changed" claims |

## Copy inventory (MAIN: review owned by MAIN / claude-copyrev)
The five keys below exist in eight locale catalogs. The 35 translated values await external review; this lane does not approve them.
- `ux.l2b.disk.section`
- `ux.l2b.disk.readOnly`
- `ux.l2b.disk.refusing`
- `ux.l2b.disk.restart`
- `ux.l2b.disk.restartFallback`

The imported owner-facing English sentence `OWNER_PERMISSION_REPLY_TOO_LARGE` (`server/permission-reply.ts`) is also in scope for the English inventory:
"That reply was too large to deliver, so nothing was confirmed. Ask for a smaller change and try again."
The operator-only line `health checks: delivery ledger did not open` (`server/sentinel/server-host.ts`) reports a deferred ledger open failure.
The operator-only line `[startup] read-only start: table <table> is not in this file; it reads as empty and the next normal start creates it`
(`server/read-only-start.ts`) names a missing lazy table without writing it.

## GAP-CHECK (one adversarial pass, continuation n5)
Fixed:
- Rule conflict: an owner starts read-only with lazy tables or first-run files absent; Q4 forbids creating them. Empty reads and the unchanged-directory witnesses cover that start.
- Failure path: an owner has cut-short recovery inputs beyond the original fixture seeds; each remaining fixture-F class now has its own before/after assertions.
Parked:
- None added. The inherited acceptance rows and MAIN rulings remain binding; pending evidence is tracked in the lane handoff.
