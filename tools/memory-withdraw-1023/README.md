# One-time memory clean-up for one install (q1023-cleanopus)

Owners: the script and its proof = q1023-cleanopus; the app modules whose effect it reproduces = the revoke marker
(server/memory/revoke-marker.ts undoStep, pruneFinished, clearOrphanPending; revoke-commit.ts undoRevoke); rulings = MAIN.

For a store whose revoke queue never drains (thousands of open revoke jobs, tens of thousands of pending windows), so every owner turn
reads "Memory wasn't ready" (fence cause=checking: deny-read.ts memoryPendingSince, the install-wide pending rule). Needs only the
sqlite3 that ships with macOS: no node, no npm, no new app build.

## What it does
`murage-withdraw-hidden-rules.sql` withdraws every open revoke in one transaction, with the same effect as the app's own undo of each one
(undoRevoke, then the marker's undoStep and pruneFinished, then clearOrphanPending and the cover sweep), including the folded, audience and
deletion revokes the app's undo refuses (foldRefusesUndo). The owner waived that guard: content those revokes would still have hidden may
show in memory again.

It keeps every message, record, source, tombstone, evidence and lineage row, and it keeps the deleted-conversation rules (memory_deny) and
each deletion's receipt line (memory_deny_line at FIRST_LSN, 'delete-conversation'). capture.ts captureThreadDeletion treats a deletion as
committed only while both stand. Without them the start-up deletion replay commits a new revoke job and pending windows, so the backlog
comes back at the next start. The owner's own clean-up jobs (memory_scope_bindings 'memory-revocation') are left for the app's runner.

## Steps (Murage quit)
1. Quit Murage (Murage > Quit). Put both files in one folder.
2. `bash murage-withdraw-hidden-rules.sh` (or `bash murage-withdraw-hidden-rules.sh /path/to/data-dir`). It refuses while Murage runs.
   ONE sqlite3 session (`-bail`) holds the store with an exclusive lock for the whole run (an app started meanwhile cannot open it),
   makes a consistent backup (`messages.db.before-withdraw`) and checks it (quick_check on the attached copy) BEFORE any change, runs
   the clean-up, and checks it: sqlite3 exit 0, 0 open jobs, 0 pending, quick_check ok, and the counts of messages, records, sources,
   tombstones, evidence, deny rules and deletion receipts unchanged. If any check fails it restores the checked backup by itself in
   the SAME session, under the same exclusive lock, so an app started meanwhile can never open the store between the clean-up and the
   restore (q1023-cleanfix): the attempt is saved as `messages.db.failed-withdraw-<time>`, then `.restore` copies the backup into the live
   file in one transaction (messages.db is never missing or half-written). An error before the commit rolls the clean-up back as the
   session closes (the store is unchanged). Proof: `bash witness-wrapper.sh <scratch-dir>` (an injected failure, and an app that opens
   the store the moment the session ends). Counts only.
3. Start Murage. If memory is off, turn it on in Settings > Memory.

Rollback: quit Murage, then `bash murage-withdraw-hidden-rules.sh --rollback [data-dir]` (same locked `.restore`). It puts back the store as it was before
the clean-up: anything written since (new messages included) goes with the store it replaces, which is kept as
`messages.db.after-withdraw-<time>` (a new name each time: a second rollback never overwrites the first one's copy). Only one run of the
script at a time: it takes `.murage-withdraw-running` in the data folder (atomic mkdir) before it checks, makes or removes a backup.

## Proof files (they run in the test container on a copy, never on a live store)
- `undo-module.ts`: the same withdraw through the app's modules (markerSlice -> undoStep), the reference the sql is compared to.
- `digest.sh`: per-table row count plus a digest over every column, used to compare the two results table by table.
- `bk-drain.ts`: what the app's runner does with the kept clean-up jobs on the cleaned copy (counts only).
- `witness.ts`: W-JOBS (no open job or pending row), W-CHECK (memoryLookup reads an unscoped card and live records "shown", not
  "checking"), W-REPLAY (replaying every deleted conversation through captureThreadDeletion commits no new job or pending row).
