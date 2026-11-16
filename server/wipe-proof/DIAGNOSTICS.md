# Harness diagnostic inventory

Owner: wg-proof owns these developer CLI/fixture diagnostics. They are test
output, not product UI. Replay never emits input rows or arbitrary exceptions.

| Output | Meaning |
| --- | --- |
| `PASS <case>`, `FAIL <case>` | One assertion result; fixed case names only. |
| `PASS/FAIL selftest/<case>`, `PASS/FAIL mutant/<id>-killed` | Harness controls and rollback-mutant results. |
| `UNAVAILABLE <tool/engine/case>` | Explicit qualification gap. |
| `FAIL windows-required`, `FAIL arguments`, `FAIL fixture-setup-or-run` | Unsupported platform, invalid invocation, or fixture failure. |
| `Usage: run.sh [--stub [--mutant-bypass]]` | POSIX invocation error. |
| `Usage: replay.mjs DIRECTORY [--context FILE] [--checker FILE] [--baseline-checker FILE] [--require-zero-new]` | Replay invocation error. |
| `Replay failed; no input rows disclosed.` | Private worker/checker failure. |
| `fixture backend refused unsafe or invalid call` | POSIX backend boundary/operand refusal (97). |
| `fixture refusal 126` | Caught proxy refusal exposed to process assertions. |
| `fixture out`, `fixture err`, `fixture disk backend` | Exact stream-preservation sentinels. |
| `Unsafe external tool resolution`, `Unsafe disk fixture selection`, `Unsafe filesystem fixture selection`, `Native filesystem mutator still available` | Prelude safety assertions; guard is never loaded after failure. |
| `fixture root outside temp`, `fixture outside tree`, `fixture reparse point`, `fixture non-filesystem provider`, `fixture non-function assignment` | Independent PowerShell backend refusals. |
| `wipe guard: refused <fixture target>`, `wipe guard: app unreachable; refused <fixture target>` | Contract stub decisions; targets are generated fixtures. |

Internal exception codes (`unsafe-fixture-root`, `outside-fixture`,
`fixture-symlink`, `checker-contract`, `no-shells`, `nounset-oracle`,
`fast-path-semantics`, `no-powershell`, `mutant-not-applied`) describe harness
invariants. Drivers collapse setup/run exceptions into the fixed failure line;
regression runners may print their disposable fixture stack for diagnosis.

Final JSON objects use fixed kind identifiers `wipe-proof-posix`,
`wipe-proof-windows`, `wipe-proof-selftest` and `wipe-proof-replay`. They contain
counts, statuses, timings, tool availability and fixed case/rule names.
Process `overflow: true` is an explicit failure, alongside `error: true`.
