# Routine wake and linear native evidence

The wake binding captures the event boundary before starting its isolated routine.
It identifies the original routine turn and the peer's delivered result. A PASS
requires a different turn in that routine thread, from the same provider and
instance, starting strictly after delivery. That turn must complete with `ok:true`.
Its engine-authored assistant-text event must match a durable provider message
with the same turn and engine identity. Inbound messages, copied messages and
`dres-*` IDs cannot supply the provider output. The returned observation includes
both turns and the final messages; the witness names the delivery, original turn,
wake turn, output message and start/output/end events. Initial turn failure and
new ledger or stream errors remain failures.

Public events are indexed incrementally by thread using the append-only client
array. A later read visits only appended events and selects the requested threads.
Tool starts and ends are indexed in one event pass by their full native identity;
completion membership is a map lookup. Duplicate starts/ends, wrong input,
provider mismatch and unsuccessful completions still fail.

`hard-gate-r3.node-test.mjs` exercises the installed binding, including delivery
without resume, copied result only, real provider wake and invalid identities,
ordering, completion and provenance. Visit counters cover 10,000 prior public
threads, repeated reads and 2,000 tool operations. It imports a module namespace
so the pre-r2 characterization can run without r2-only named exports.

The baseline loader substitutes exact Git blobs without editing candidate files.
Against the job's starting `91c4d404`, the wake and performance assertions fail
behaviorally. The separate `R2 baseline permission` assertion runs against
`b071c65b`, before the r2 APIs existed, and fails because a permission receipt
incorrectly counts a start without a successful completion. These are assertion
failures, not missing-module failures.

Evidence is retained in `evidence/hard-gate-r3/`; `summary.json` records commands,
results, source hashes and raw evidence locations. The native proof uses only
fresh servers, temporary data/HOME and fake Claude, Codex and Fuigo engines inside
a network-none container. Its real product turns are unbillable fixture turns.
The full release gate, private corpus and other OS rigs remain unclaimed.

Run through the assigned container runner:

```
node --experimental-strip-types --test scripts/no-limits-live/hard-gate-r3.node-test.mjs scripts/no-limits-live/hard-gate-r2.node-test.mjs scripts/no-limits-live/afix-review.node-test.mjs scripts/no-limits-live/audit-fixes.node-test.mjs
node --experimental-strip-types scripts/no-limits-live/hard-gate-native.mjs NEW_OUTPUT_DIRECTORY
```
