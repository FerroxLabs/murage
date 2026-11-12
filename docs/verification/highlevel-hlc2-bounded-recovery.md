# HighLevel C2 bounded recovery

`afix2-hlc2-rv` starts at `3e87adba6`. Creates no longer require a complete
location collection, or any collection snapshot, before review or dispatch.
The stable `captureRecoveryPreState` hook remains available for integration.

`boundedRecoveryLookup` in `server/highlevel/write-recovery.ts` accepts an
operation adapter with a qualified read and an exact identity comparison.
Adapters prefer provider idempotency/reference lookup. Otherwise they use a
creation-time window after the durable action journal timestamp, at most
15 minutes wide. The helper processes at most three pages of 50 records.
It never follows a response-supplied URL and has no sending callback.

The C2 adapter uses digest-checked email/phone filters or a bounded name query
for contacts, retained pipeline/contact filters for opportunity searches,
and direct record reads where declared. Pipeline and contact note/task lists
have no supported provider window, reference or pagination controls. The C2
adapter returns unknown before issuing any such collection read, including
primary-ID recovery. Creation-time and all approved effect fields are checked
locally for supported searches, including when a provider ignores its filters.
The generic helper still supports a known unique primary ID in a qualified
partial lookup.
Absence still requires complete bounded evidence. Unsupported/missing dates,
old identical records, ambiguous matches, oversized pages, transport errors,
expired windows and incomplete searches leave the outcome unknown. No recovery
path resends a write.

The durable recovery index retains selectors, digests, routes and journal time;
search values remain out of it. A replay search value must match its retained
digest. A read result cannot self-assert completeness: an internal, plan-bound
proof accompanies the response through comparison. Envelope siblings survive
into the structural identity binder before any applied receipt is released.
Legacy create plans without the time bound cannot prove a create after restart.

Evidence is archived outside the worktree at
`/work/fuigo-builds/swarm-b/afix2-hlc2-rv/evidence/`:

- `red.log`: five assertion failures, including blocked creates at 51, 101 and
  100,000 records and a failed populated-location crash fixture.
- `red-primary-id.log`: a primary-ID witness in a partial collection was refused.
- `full.log`, `final-exits.txt`: final HighLevel/related component tests,
  full app/server/conformance typechecks and gate inventory.
- `mutants.json`, `mutant-*.log`: assertion-killed snapshot, cap, timestamp,
  exact-identity, reference, ambiguity and premature-completion mutants.
- `fixture-info.json`, `fixture-doctor.json`, `fixture-server.log`: isolated
  fake-engine startup, explicit-URL Doctor and cleanup.
- `commands.txt`, runner logs: exact container commands and execution hosts.

All tests use fakes in network-disabled containers through `it-remote.sh`,
with one job container at a time. No live provider account, live app data,
billable service or Mac is used. The Doctor fixture proves isolated startup;
the host/transport/journal fakes prove the recovery behavior. They do not claim
an end-to-end live-provider workflow.

The BLOCK 1 fix round (`afix-afix2-hlc2-rv`, starting at `f8f904665`) changes
only the C2 collection adapter in `readWriteRecovery`: it admits the existing
contacts/opportunities search adapters and refuses unsupported collection reads
before transport. Direct record reads and the generic helper are unchanged.
Existing pipeline replay expectations now reflect unknown with zero reads.

Fix-round evidence remains untracked in `.evidence/afix-afix2-hlc2-rv/` and is
archived at `/work/fuigo-builds/swarm-b/afix-afix2-hlc2-rv/evidence/`. The new
host crash/restart matrix covers pipeline, note and task creates against fake
unpaginated collections of 0, 1, 51, 101 and 100,000 records, including an exact
recent witness. All 15 cases fail before the guard and pass after it, with zero
replay reads or resends. Independent pipeline/note/task guard-bypass mutants
were killed by assertions, with five failures each. Existing bounded search, direct record,
primary-ID helper, timestamp, identity and page-cap cases remain in the suite.
