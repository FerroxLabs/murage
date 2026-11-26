# S3: production Hermes correlation, r1.2

Base: `dev/1019-toolid-s1` at `12eb1251e6353b6cc4298c6200a12e573274fa91`.
Branch: `dev/1019-toolid-s3`.

S1 already supplied the complete pure `HermesCorrelation` port and the direct
JSONL/reference parity test. S3 connects that machine to the live ACP driver:
raw asks, option-kind answers, execution starts, and updates now enforce tokens,
permission completions, echoes, edit obligations, nested commands, expiration,
and default-mode prompt admission. Permission completions produce no execution
chips. Cards retain the bound driver record and report deny when an unbound
allow is converted to reject. Failed response delivery stops correlation authority.

The hook matcher and correlation share the same C3 names. C1 remains exactly the
seven normative names; C2 remains write_file/patch; C4 accepts only a valid tool
name on the unique host-computer mount. D5 retains the adopted drop default and
the pre-prompt refusal fallback. G5/R1 remains open as specified: the live driver
requires a launcher-provided verified install stamp; it never synthesizes one
from a version banner. This work does not claim to verify the real gate binary.

## Evidence

All runs used `it-remote.sh` with `IT_JOB=bld-toolid-s3`, the S3 worktree, and
`IT_ORIG=/root/fuigo-builds/tools/it-local-generic.sh`. One test container ran at
a time. JSON reports and the isolated server transcript/log are retained at
`/root/fuigo-builds/swarm-b/toolid-s3/evidence/`.

| Group | Result |
|---|---|
| Initial collection | 108 executed, 108 passed |
| RED live-driver baseline | 12 executed, 11 failed, 1 passed |
| Full trace parity | 104/104, zero mismatches |
| Fixture hashes and identity rules | 4/4 |
| Live correlation and hook exclusions | 16/16 |
| Hermes and D5 | 79/79 |
| Legacy tripwire regression | 52/52 |
| Driver-held reload protection | 6/6 |
| Structural inventory | 3/3 |
| Approval delivery | 32/32 |
| Server TypeScript | zero errors |
| Isolated server workflow | 5/5, fake bot response verified, fixture closed |

The final scoped Vitest runs executed 296 tests with no failures. The live tests
load normative frames directly and provide only transport scaffolding (fresh
session IDs and options omitted by synthetic reference asks). The pure parity
suite consumes every original trace and compares result, trip_at, sent, overlay,
and performed with the pinned Python reference; all must-accept traces also
assert no allowed ask remains unperformed. No expectation was changed.

SHA-256 of both the original and checked-in copies:

- `hermes_traces.jsonl`: `b1c99df61d4943a0d1bad58bff648d908dfe95dc2e5882dff237eaa8337d0625`
- `judge_expected.tsv`: `bca5ba97c9d70a49ea7c8d274969b8ec17d79f87b274383c0870c9e405097134`

The isolated workflow used `launchVerificationServer` and the normal control
surface: doctor, new-bot, send, wait, messages. It settled and recorded the bot
response `hello from fake claude`. It used only the fake engine and temporary data.

## Prerequisite marker repair

The required single 180-second blocking loop initially waited on a missing S1
DONE marker. S1's `exit.txt` recorded a successful exit and `last.txt` reported
PUSHED at the exact hub branch tip above. After verifying both, the missing marker
was restored byte-for-byte from S1's final result. The existing loop then exited,
and only then was the new S3 worktree created from that tip.
