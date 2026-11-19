# Bounded routine proposals in 1.0.19

The proposal path uses a separate guarded transaction in `RoutineManager.commitProposal`. The existing receipt-free `commitScoped` guard is unchanged. Automatic requests use a maintained request-ID map; current definitions and changed open work supply the transaction scope. A current-definition walk is the design's R exception. Retained runs and receipts are excluded from the operation.

## Persistence protocol

`beginRoutineRequest` reserves a stable journal location in the intent's `journalRoutineId`. A routine create reserves its future definition ID. Its definition carries a monotonic `proposalOrder`, derived from current definitions on load, so journal-only creates preserve insertion order across restart and equal or backwards wall clocks. Other routine actions use the target ID supplied by the producer. Webhook intents use a request-derived receipt location; webhook definitions retain their existing request-derived IDs and separate store.

Receipts carry a monotonic `journalOrder` so their newest-first owner projection survives checkpoint and journal file ordering, including equal wall clocks. The next value is derived once at startup; automatic writes allocate it in constant time.

A proposal appends one newline-terminated, fsynced record:

```json
{"$proposal":1,"$gen":"published generation","$receipt":{"requestId":"request","value":{"requestId":"request"}},"$routine":{"id":"routine"},"$runs":[],"$removed":[]}
```

The example abbreviates the receipt and definition payloads. A complete line carries the scoped definition, changed/new live runs and result receipt together. A deleted definition is represented by its ID and `$deleted:true`. A null receipt value deletes that request. `$removed` contains durable failed-append tombstones. Validation precedes replay of every component, so an invalid or torn proposal cannot apply just its receipt. Ordinary run/state journal formats remain readable.

Definition and receipt overlays apply only to the matching published `stateGeneration`. Carried run snapshots and tombstones have the existing run-journal lifetime. Full owner/lifecycle saves checkpoint the complete current definition/receipt projection before changing generation. The published generation invalidates old overlays. `readRoutinesWithRuns`, restore transforms and `foldRoutineStateForDowngrade` include created/deleted definitions and receipts. The downgrade fold publishes the document before rewriting history and is repeatable after interruption. Proposal files stay under the existing backed-up events folder.

Receipts that existed in the base document retain a keyed deletion overlay until a checkpoint. A receipt created and settled entirely in the journal needs no retained logical tombstone: atomic compaction omits its intent and delete together. A receipt-only empty file is retired after its deletion is durable. Same-file compaction retains live receipts and mirrors proposal changes while a bounded copy progresses.

## Durability order and failure handling

1. Persist intent, including the affected definition's undo projection, before action.
2. For a routine, persist the changed definition/live runs and result in one journal line. Publish create/delete membership and abort watch reads only after durability.
3. For a webhook, preserve intent → webhook store save/remove → result. The stores have no new cross-store atomicity. The request-derived webhook ID supports recovery after an action whose result was not recorded.
4. Delete the redundant receipt after durable settlement. Failed cleanup preserves a recoverable receipt.

A failed scoped operation restores the same definition/run objects and the prior keyed receipt. Reconciliation writes the restored scope and any appended-run deletion together. An appended run is unlinked only after the deletion is durable. Failed reconciliation quarantines the append, holds admission and preserves the original error. Quiescent lifecycle recovery checkpoints the restored state before reopening admission. No foreign dirty run is flushed by a proposal.

A crash after a complete fsync can expose the complete new action/result even before the method returns. A crash before reconciliation retains the documented uncertainty window; the action and its receipt remain one atomic unit. A torn line is ignored as a whole.

## Operation ceilings and verification

A successful routine begin/action/cleanup uses three journal appends. A webhook uses three receipt appends and one existing webhook save/remove callback. Run-now can add one changed-live follow-up append. Receipt-only cleanup can add one file unlink and directory sync. Each append touches one declared journal file. Existing compaction ceilings apply: 64 copied records per incremental slice, or at most 256 for a small synchronous replacement. Mirrors add at most one line per proposal append. History snapshots, full commits, full saves and retained-run walks are zero in measured automatic windows.

`routine-proposal-auto.test.ts` drives real decision authority and the actual automatic routine/webhook producer at 100 and 2,000 retained runs and receipts. It also varies settled receipt history independently. `routine-proposal-bounded.test.ts` measures same-file history and compaction progress, keyed cleanup, canonical rollback and foreign dirtiness. `routine-proposal-crash.test.ts` exercises torn writes, complete-line/fsync failures, quarantine, restart and process loss. `routine-proposal-release-red.test.ts` uses the pre-port API for exact-base assertion failures at begin/action/result/cleanup. CI registers every file.

These are isolated manager, journal and fake decision-host tests. The shared control harness has no mapped proposal-persistence fault commands; they are not a UI workflow claim.
