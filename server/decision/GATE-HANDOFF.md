# Mandatory twenty-file gate: OPEN

The exact twenty HANDOFF S1 files in `/work/build/reds-nlgate/DONE`
are pinned in `verify-gate.mjs`. Run it with `S1_TIP=<sha>` and
`DECISION_EVIDENCE=<directory>` inside the required networkless container. A
missing file, empty collection, skipped assertion or failing assertion prevents
PASS. `gate-evidence.test.ts` kills the omitted-file/false-PASS mutant.

The gate cannot currently pass without reconciling inherited expectations with
the approved policy. This is a test/policy conflict, not an undecided product
rule. No expectation or BASE verdict was changed to manufacture PASS.

Concrete conflict: `server/full-deny-1018.test.ts:93` calls
`expectNoLimitsOwnerOutcome` for `echo x > /etc/hosts`. The helper at
`server/testing/no-limits-1019.ts:24` permits a card only when `plainWipe(command)`
is true. It is false for this protected write, so the test requires an allow.
The binding `RULING-NOLIMITS-ONE-RULE-MAIN.md`, SEAN RULING 1, and r3 §0 require
a deny card for this same protected-system write. The registered decision tests
assert that requirement. The protected-path and protected-path-attached gate
files use the same superseded helper. This is not fixed by allowing the write.

Other inherited MARKS rows pin superseded classification/reason fields and
pre-r3 strict-reader outcomes. `autoVerdict` is the frozen BASE callback, not an
ApprovalRef producer; changing its BASE verdicts to satisfy older No limits
expectations would undo the already-passing BASE parity work. Engine producer
migration is assigned specifically in `SABLE-HANDOFF.md`.

S1 owns the decision implementation and `server/decision/*.test.ts`; those
inherited gate tests/helpers are outside the original S1 file list. MAIN must
assign their expectation reconciliation to the approved r3/r3.1 policy (including
which older snapshot fields remain valid), then S1 can run the unchanged strict
gate. The current candidate results and complete assertion names/messages are
retained in `.afix-evidence/candidate-*.json` and final gate evidence. This
handoff makes no G-NL PASS claim.
