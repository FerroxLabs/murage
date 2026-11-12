# Busyloop executable port

Job `bld2-busyA2`, baseline `0b05fa2a437fd29a7011659faaf0724cec72774e` on
`dev/1019-busyloop`. HEAD and origin matched before editing.

The binding folder changed during the build. `SPEC-VERSION-NOTICE.txt` directs
builders to A2.2, the delta appended to `refusal-contract-A2.1.md`. This port follows
that delta. The original 124-row TSV is retained byte-identically as
`server/__fixtures__/flux-refusals/spec/busyloop_expected.v21.tsv` (SHA-256
`1ebb1e47e685ccf2034b560d2ec3f7db27152c812dcf08f273188585e2d069fb`).
The directly loaded current TSV has 126 rows, SHA-256
`951a3b878684280577a8f18b1563911e7f283198eee672322e1e6ab849829ba4`.
The reference Python source has SHA-256
`d38a0661457f97406a86ce0c2d3a67cac0b0affd2f2de5d3223ede9c5d27b84e`.

`shared/flux-busyloop.ts` ports the ordered vocabulary, extraction, decision
steps, upstream adapter and prompt state machine. HTTP, ACP and Claude readers
attach the resulting decision before sanitizing their display text. The direct
submission guard, routine/channel prompt identities and room-goal retry policy
keep STOP/PAUSE terminal. Only keyRevoked marks a Flux key rejected. The card
keeps each cause separate and carries known waits and copy-only reset dates.

The A1 checkpoint supplied the byte-identical production fixture import; the A2
RED table evidence is retained. The corpus includes 93 fixture leaves, with
siblings and defensive/home-gate rows distinguished by the pinned TSV. M0 walks
all leaves, including target-654 when present. No expectations are transcribed
to JSON. The Python helper generates **inputs only** for contract ACP frames;
expectations always come directly from the TSV. Trace expectations are loaded
directly from the pinned executable spec.

Verification uses the container wrapper `it-remote.sh`, with the supplied
`it-local-generic.sh` fallback, at most two containers. The second container uses
an isolated source snapshot for source mutation and type checks. All HTTP flows
launch temporary fixtures through `launchVerificationServer`; no live app,
account or model endpoint is used. Claude tests use the real Murage frame handler
and a fake CLI. These tests do not claim to measure vendor-CLI internal retries.

RED evidence includes the pinned baseline transport readers failing all 124
original rows, and the A2.2 delta failing exactly X22/X23 before the adapter began
reading `upstream.codes`. Initial missing-module/dependency setup failures are
retained but are not behavioral RED evidence. Mutation logs contain assertion
failures, and every mutation runner restores the production source in `finally`.

Evidence is retained under
`/work/build/bld2-busyA2/evidence/` and the worktree's
`evidence/busyloop-a21/`. The validation commands are in
`scripts/busyloop-validate.sh`; mutation runners are `scripts/busyloop-mutants.py`,
`scripts/busyloop-reset-mutant.py` and `scripts/busyloop-guard-mutant.py`.

The reference checker explicitly reports `target-654: ABSENT`. Current-fixture
parity does not establish #654 target coverage. Published Fuigo 1.0.42 capture,
bundle qualification and the two vendor-Claude capture versions remain with
their capture/release lanes. This build does not relabel contract frames as
captures or claim a full-repository rig result.

Final port evidence: 299 classifier/guard/trace/projection tests pass, including
direct classification against both TSV versions; the three-reader loop passes
126 rows; the two fixture-integrity tests pass. The isolated HTTP suites pass
4 tests. All 24 reference mutants and the additional B8 guard-removal mutant
are killed by assertion failures, with restored source compared byte-for-byte
afterward. The reference checker reports zero mismatches and 25 passing traces.
The broader neighboring suites pass 1,120 tests across 13 files, with two
existing Claude tests skipped. The captured-replay/provenance suites pass 18
tests and fail the two R3 missing-capture assertions described below.
Client, server and stream-conformance TypeScript checks and the gate-file
validation all pass. `validation-summary.txt` records their exit statuses.

The existing captured-replay suite still requires two unavailable Fuigo 1.0.42
capture files (`R3`, S1 and S2). Those tests remain active and fail explicitly
when the release evidence is absent. The retained run distinguishes this from
the passing 1.0.41 replays and provenance checks. Its S4 expectation now uses
the executable classifier's `credit` card for the captured 402 response.
