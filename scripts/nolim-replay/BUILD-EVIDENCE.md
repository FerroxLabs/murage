# Replay build evidence

P0: `server/no-limits-replay-1019.test.ts` first failed collection on the missing
contract (P0 harness RED, not product behaviour). After implementation, 19
admission tests and 81 release-workflow tests passed in the prescribed offline
container; server tsc exited 0. Raw logs are retained in the job's private
`.nolim-evidence/` directory. The initial missing-Vitest attempt is separately
labelled infrastructure failure.

The shipped baseline source is the private commit
`6e4dda8afd788c113f348a29033ead128ac103c1`, resolved in the hub. FIX-LEDGER rows
4849 and 5834 link it to public `fc3782abe` and release run 42621615653, release
439265857. The public full SHA in row 5834 is malformed (39 hex characters),
and absent from this hub; exact public-source/artifact equivalence still needs
MAIN's release receipt. `int1018/pin54b` is a later test-only change, not the
shipped baseline. Never claim verified artifact mapping from a symbolic pin.

Policy remains two exceptions only. Hook reconciliation is unresolved; no
release PASS may be sealed. The owner deny inventory has found no store in
AutoApprover/config/routine permissions: only allow grants and reader flags.
`server/shell/marks.ts` ownerDeny is not an owner-authored rule store. Any
claimed owner deny remains inadmissible until a real store/matcher is audited.

P1 RED: the blocking Python wrapper failed on the absent extract.py; its missing
interpreter/file control passed. GREEN: 19 fabricated-data Python tests passed.
The first neighbour run exposed the new Python gate inventory not being counted
by release-workflows; the checker now binds every Python file to the mandatory
wrapper instead of passing .py paths to Vitest. Python 3.11 is declared in the
shared blocking CI runtime. Chunk loss from MAIN's grep-only ruling remains an
explicit completeness blocker, never a timestamp inference or quiet scope cut.

P2 source baselines: candidate allow assertions failed on both c12aaad93 and
private shipped-source 6e4dda8afd788c113f348a29033ead128ac103c1 (3 named
assertion failures, 25 passes on the initial four ordinary/five wipe probes).
The first truncated probe did not reproduce a hold until the actual GrantCall
truncated flag was supplied; do not claim that earlier passing probe was RED.
The 36-case literal corpus adds owner phone/channel/continuation/delegation/
routine variants, dirty destructive/prompt cases, virtual FS failures, wipe
forms, origin controls, level parity and hook conflict probes. Candidate fields
are literal and remain unreviewed until P5; no candidate output updates them.
The harness-only target passed 27 assertions; the candidate target remains RED
on this policy base (33 failures, 34 passes). These are distinct evidence types.
Product policy finalization belongs to the NOLIM lane. This build does not patch
it, turn failures into expected-fail passes, or represent synthetic cases as
Sean's recovered calls. Public-source/artifact mapping is still unverified.

P3 RED: the first observer target failed on the absent observer module. Named
mutation assertions subsequently pass (swallow, deny, transient/deleted card,
double answer, late notification, missing audit/barrier, duplicate frame and
executor attempt). Genuine listener RED is recorded for ACP, Codex, Pi, Muse
and Antigravity: each inserts one stored ordinary-owner card where zero is
required. Claude and OpenAI complete this key-file scenario without a card.
ACP's initial timeout was an infrastructure failure: its fixture did not send
Grok's MCP-ready notification. Supplying the real protocol notification gives
a genuine card assertion failure, not a timeout. The harness-only observations
pass; the candidate suite intentionally remains RED on old product policy.
Server tsc passed. Logs: P3-observer-red, P3-wiring5, P3-final2 and P3-acp-local.
The final filtered ACP run has six filtered-out scenarios, not six release
passes. The existing host-power test seam is limited to inert CLIs; native
power protection and packaged G9 are not certified here.

P3 outstanding scope: actual phone/channel/continuation/delegation/routine
triggers, partition/draft/cwd/catch/routine-record failure wiring, process-wide
network/process tripwires, faithful arbitrary request frames/context and
correlated conversion audit. Their inventory remains binding. The release
collector refuses to substitute desktop command-only scenarios for these
witnesses. The index observer seam still requires joint NOLIM review. No P3
full-scope GREEN or private replay PASS is claimed.

P4 RED: missing release-gate/verifier modules failed the new harness tests.
Separately, the actual old publishDraft accepted complete asset digests with no
real replay/source attestation; the new assertion failed with “Missing expected
exception” (P4-publication-red.log). GREEN: 212 release/CI/Python-wrapper Vitest
assertions, 13 node release-digest assertions and server tsc passed. After
strengthening sealing tests, the positive fixture exposed unsupported nullable
JSON-schema type lists (3 errors); the validator was fixed. Final focused check:
98 assertions passed, including all 81 release-workflows assertions, 15 status/
workflow binding assertions, and the wrapper running 22 extractor plus 5 receipt
unittests with no skips. Logs: P4-final, P4-seal-final (RED), P4-seal-green.
Production neighbours: 327 passes and five genuine old-policy card failures;
all four neighbouring files passed. No product RED was relabelled GREEN.

P4 implements source/asset binding, exact newest authenticated status selection,
full pagination, pending/readback, non-waivable checks at CI and publication,
Python discovery, immutable artifact digests, UID allocations and bounded
network-none runner command. The Linux Docker boundary leg is required by CI;
it has not been executed in this builder's prescribed nested test containers.
The publisher ID is not guessed: an empty allowlist blocks all publication.
The collector is deliberately INCOMPLETE pending faithful P3 frame/context and
trigger replay; it cannot issue COMPLETE from the seven synthetic CLI probes.
The report/containment path is not claimed end-to-end GREEN. The remaining
P3/P4 scope is listed explicitly in P5-INTEGRATION.md.
