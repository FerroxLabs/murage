# Routine history work proof (design v2)

Contract owners: **rhist-s1b** owns fixtures, probes and assertions;
**rhist-h1** owns the H1 accessor/route fix in 1.0.19; **MAIN** owns scheduling
of the deferred H2–H8/F1/W1/R1 work in 1.0.20. H1 is implemented here.

Run the green fixtures, equivalence and bounded per-turn checks:

```
pnpm exec vitest run server/routines-history-h1.test.ts server/routines-history-probe.test.ts server/routines-history-bound.test.ts server/routines-history-equivalence.test.ts server/routines-history-bound-http.test.ts
```

Run every known-red design assertion:

```
pnpm exec vitest run --config server/testing/routine-history-bound.config.mjs
```

The skip-free inventory is `routine-history-RED.json`. H1 lives independently
in gated `server/routines-history-h1.test.ts`, with its original assertions
and an additional zero-rebuild check. The other reds
remain in their explicit config, outside normal `*.test.ts` discovery. No
expected-failure wrapper, skip or disabled assertion implements this convention.
The red config measures every counted path at all three sizes; the green HTTP
suite additionally runs the uninstrumented timing pass and real provider turns.

The HTTP population is always three bots × twenty tasks plus two rooms × ten
tasks, C=80. Runs occupy the same ten chat threads at every size, include a deep reused
thread, and otherwise use
threads outside the chat population. Pending receipts all finish at the same
fixture time, inside one 24-hour protection window. Each measured operation
checks exact cardinality before and after; run creation/deletion declares its
±1 change. A fixture output outage keeps seeded pending deliveries protected
when owner actions emit run changes; new real-turn IDs use the original adapters.
Cold samples replace the canonical store outside the timed window;
warm samples follow without writing; after-write samples follow one tracked,
scoped persisted write. There are twenty uninstrumented samples for every H1
state, route and size, plus separate counted samples at all three sizes.
Heap is reported after seeding; forced GC availability is recorded and no heap
threshold gates acceptance. The original turn-built fixture remains available
for its existing callers; it is not used to construct 10,000 protected runs.

Production seams are identity-only `labelWorkCollection` calls on both store
allocations and every `RunIndexes` field at construction. These WeakMap entries
cover fields added by H1 and replacements during a measurement. No production
iterator or callback counts work. The probe patches builtins only inside a
measurement window and restores them before assertions or output. It counts
Map/Set enumeration, run-array visits/comparisons, serialization, clones,
materializations, transaction, journal and trie work. A self-test replaces the
store *inside* a window and enumerates both its store and its new index fields.
Live index iteration is counted separately from retained ID/dispatch maps.
The older general collection probe retains its store-label compatibility alias
and both `manager.indexes.runsById` / `manager.indexes.indexedRuns` aliases.
The HTTP probe counts actual `chatRoutineOf` invocations, including repeated
calls from the same candidate; the pre-H1 callback count is only a fallback.

H1 forbids all index enumeration, trie enumeration, store visits and clones;
lookup calls are C for list and 2C for search, with identical counted work at
10, 2,000 and 10,000. Refresh notifications are recorded at emit time and
drained through actual HTTP requests, never by calling a deleted cache helper.
An ordinary owner turn fetches chats at start and completion after warming it;
a routine Run now turn fetches once per broadcast. The real run is observed
through its completed broadcast: normal result delivery then retires it above
the run cap, restoring exact N while all protected seed receipts remain.
The report names this model:
client cadence is not inferred from broadcast count.

The equivalence suite keeps an independent pre-H1 map and owner closure.
It executes the actual current production `chatSource` closure extracted from
source, compares every field of all pages and full search rows for desktop,
phone and all filter cases, then repeats after 200 deterministic mutation steps.
It covers failed scoped append/reconciliation quarantine, scoped/full rollback,
retirement, replacement, and reloading persisted state. It passes before H1
and calls the new accessor when present. Ties, channel exclusions, room and bot
owner collisions, saved names, NaN, archived/deleted owners and statuses have
explicit witnesses. Crash snapshots before journal open and after fsync are
reloaded before surviving-process reconciliation can affect their files. Timed
index repair, first requests and turns after restart, and an index-independent
persisted-script snapshot extend that proof. The mutation driver compares the
actual bytes from the fixed script with its startup-index-disabled control.

Bounded manager fixtures retain N historical receipts plus the fixed live
stimuli created by genuine dispatches; each measurement checks the exact
before/after count and its declared delta. Settled dispatch-map entries are
seeded from an actual dispatch, so an empty map cannot hide a history sweep.
The 2,000-run retirement threshold adds a constant guard above the cap; tests
report raw trie calls and compare other trie work after subtracting that
separately measured guard. Compaction preserves the existing 256-line small
file / 64-line large-file slice ceilings. F2 uses three genuinely pending owed
runs with a fixture output outage; its backlog work must be identical at every
retained-history size. Startup and diagnostics are measured and intentionally
not asserted history-independent.

HTTP measurements use index-harness's isolated temporary home and fake engine,
never a live application. The loader exposes exact current setup, inbox,
project-close, workspace and channel callbacks. Roster and permissions use
real HTTP routes. A missing proposed runs-page route returns a negative status
witness and fails a red assertion, never a TypeError. Logs and REPORT.md belong
outside the repository, in the job directory.
