Memory fix-round verification

Run in the prescribed network-none test container. Historical dependency
snapshots and mutation logs were archived to the job evidence directory. The
commands below describe the earlier bridge-based unit verification and need
those archived inputs restored; they do not qualify the real boundary gate.

- `node server/memory/verify-policy.mjs`: install the isolated S1 production
  dependency snapshot, run the field fixture, then restore every source in
  `finally`. The manifest checks every dependency's SHA-256. No policy verdict
  is mocked. S1's in-progress snapshot predates the synchronous CONTRACT-ADD;
  `policy-sync-bridge.fixture.txt` supplies only those synchronous operations
  using S1's private registered entry, final recheck and captured delivery call.
  It does not claim to qualify the eventual S1 synchronous implementation.
- `node server/memory/verify-start.mjs`: restore the exact e9500850 memory
  implementation and run the binding/queue probe. Expected result: 12 assertion
  failures. The driver invokes the historical activation signature on that
  baseline; it does not fail on a missing import. Queue cases first exercise
  the actual historical save route, then inspect its durable pending requests.
  The baseline has none, so the absent recovery input is itself the RED result.
- `node server/memory/verify-start.mjs field`: the same baseline with the real
  S1 policy fixture and actual RoutineManager creation/dispatch. The test entry
  forwards to the historical route without adding an authority the caller did
  not provide. Expected result: all 30 ordinary field cases fail by assertion.
- `pnpm exec vitest run --config server/memory/baseline-binding.config.mjs`:
  the same 12 behavioral probes against the candidate; expected GREEN.
- `node server/memory/afix-mutation-check.mjs`: authority omission, prototype
  rejection, missing request binding and missing durable queue must be killed.

The field fixture uses fake provider identity, a real isolated Store/database,
real capability issuance, real policy and a real RoutineManager. It never
executes shell examples or calls an engine or external service. Assertions cover
Bash, Write, MCP and heredoc/redirect shapes following web/earlier-turn/cloned
folder reads, memory saves/corrections, routine provenance (six unit cases only), deny/wipe exceptions,
and guest/Ask/Auto/Full BASE. This is memory-slice integration evidence; the full
five-engine release replay remains the integration gate's responsibility.

The six RoutineManager callback cases are memory claim under routine provenance (unit).
They are excluded from Field 7 end-to-end evidence. The real boundary gate is
`field-replay.e2e.test.ts`; see `field-replay/README.md`.
Archived dependency snapshots now live in the bld-s2m-r4 job evidence directory.
