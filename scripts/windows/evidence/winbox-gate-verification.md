# G-WINBOX preparation verification

Join tip: `4d9e2f97cb`; reviewed proof implementation: `ddc5d6bde1`.
The fix round changes only the four BLOCK findings, under `scripts/windows`.
The Windows sampler, packaged workflow, shell fixture and existing 17 driver
tests remain in place. No product behavior or existing winscen pieces changed.

## Behavioral RED and mutation evidence

- `afix-reviewed-red.log`: the two regression tests ran against the unchanged
  reviewed driver before the fix. BLOCK 1 observed PASS instead of FAIL for a
  nonterminal window whose owner was absent from the process snapshot. BLOCK 2
  observed an empty offender list instead of PIDs 40 and 30 after a later invalid
  sample. Both are assertion failures, not load/import failures.
- `afix-base-replay-red.log`: the join-tip Windows scripts were extracted with
  `git archive 4d9e2f97cb scripts/windows`, then the original reviewed driver
  and current regression tests were overlaid. This overlay is necessary:
  **the bare join tip has no G-WINBOX driver**. This is a behavioral replay of
  the original proof implementation on the join-tip snapshot, not a claim
  that the absent module alone proves RED. Original driver cases stay green;
  the new owner, retention and CLI artifact assertions fail.
- `afix-audit-red.log`: the audit tests ran against the old verification report
  and absent string inventory. They fail assertions about missing behavioral
  evidence references and missing inventoried sources.

Each mutant edits a real implementation in an isolated directory, runs the
unchanged test suite, and must exit 1 with `AssertionError [ERR_ASSERTION]`.
The runner rejects missing-module failures and surviving mutants.

| Finding | Mutant | Evidence |
| --- | --- | --- |
| BLOCK 1 | Ignore unresolved visible-owner coverage errors | `afix-mutant-unknown-owner.log` |
| BLOCK 2 | Return an empty offender array whenever validation reports errors | `afix-mutant-discard-offenders.log` |
| BLOCK 3 | Remove terminal-class detection | `afix-mutant-terminal.log` |
| BLOCK 3 | Remove Murage descendant detection | `afix-mutant-child.log` |
| BLOCK 3 | Let self-test emit PASS despite a detected console | `afix-mutant-self-test.log` |
| BLOCK 3 | Omit the browser workflow phase | `afix-mutant-workflow.log` |
| BLOCK 3 | Delete the RED citation from the verification report | `afix-mutant-evidence-citation.log` |
| BLOCK 4 | Delete the new owner diagnostic from the inventory | `afix-mutant-string-inventory.log` |

`afix-green.log` records the 20 driver tests passing after the fixes, including
CLI JSON artifact retention. `afix-final-tests.log` records the final driver
and audit suites (22 tests), plus syntax checks. The string list is
`../winbox-strings.json`: every quoted source fragment in the six harness/test
files, including diagnostics, fixture prompts, visible fixture HTML, commands,
and test labels. The inventory deliberately includes technical tokens too.
No product UI or localization catalog changed.

## Reproduction and isolation

All tests run through `/work/fuigo-builds/tools/it-remote.sh` with
`IT_JOB=afix-winbox-gate`, this worktree as `IT_W`,
`IT_ORIG=/work/fuigo-builds/tools/it-local-generic.sh`, `IT_CAP=2`,
`IT_BOXES='murage-vt1 murage-vt2'`, and `NETARG='--network none'`.
One container runs at a time. Both invoking and test hosts wait while load is
above 60. The exact wrapper commands are retained in
`afix-container-commands.txt`; the evidence runner is
`afix-run-evidence.mjs.txt`. Its inputs and isolated snapshots are retained
untracked in `.test-tmp/afix-winbox-gate/`. Raw logs remain there;
committed log copies trim trailing whitespace only.

`judgeWindows` now fails coverage for visible windows without a matching,
nonzero native owner identity, including the process-snapshot/EnumWindows race.
Later WMI metadata cannot silently grant ancestry. Invalid later samples report
errors while preserving earlier offenders, metadata and observation counts;
subsequent valid samples continue to contribute detections.

No PowerShell, Windows binary, packaged installation, paid provider, live app,
Mac PC or Windows PC was run or accessed. Tests use synthetic process/window
records, fake transports and temporary CLI artifacts. No server/conversation
change is claimed. The memory prelude tool/command and `.ijfw/memory` were
unavailable. No agent delegation was used.

Windows acceptance remains **PENDING**. EnumWindows, installation, Terminal
host delegation, screenshot capture, packaged workflows and scheduled Sentinel
still require the disposable Windows 11 runner. The negative control must
return FAIL with `selfTestPassed: true` before accepting a candidate PASS.
See `../WINBOX-GATE.md` for runner commands and the evidence contract.

## Round 3 malformed-row retention

Starting HEAD `d072371dfeb16ecbcacc94eb239a2ab5924c02e3` is retained as an
ancestor. This round completes the single remaining BLOCK in the subsequent
review: null sample rows survived window judging but crashed timestamp gap
calculation before JSON artifacts could be written.

`afix-r3-red.log` captures three assertion failures against that exact starting
implementation, before source edits: malformed-row handling, the real CLI with
an earlier console followed by a null JSONL row, and the fallback artifact
contract. These are assertion failures with the original TypeError shown;
no missing-module failure is used as evidence.

`afix-r3-green.log` records all 25 driver/audit tests passing. The new matrix
checks null, primitive, array, incomplete, and malformed nested sample records
at the beginning, middle, and end of a run. Malformed rows are counted in
`malformedSamples`, make the verdict FAIL, and preserve earlier and later
window detections. Invalid records cannot advance the sample-order clock.
Coverage calculations and phase endpoints tolerate malformed rows. The CLI
regression asserts both JSON artifacts retain the owner's PID, image path and
command line, and stdout matches the FAIL verdict.

`afix-r3-mutant-unguarded-at.log` kills the required actual source mutant that
restores unguarded `s.at` in gap calculation. Both new behavioral regressions
fail assertions. `afix-r3-mutant-empty-fallback.log` kills a mutant restoring
the old PowerShell fallback. That fallback check is a static source contract,
not a claim of PowerShell runtime validation. The driver now writes the
window artifact before the verdict; fallback loads any existing offender
artifact into its FAIL verdict without overwriting it with an empty list.

The reproducible runner is `afix-r3-run-evidence.mjs.txt`; wrapper commands are
`afix-r3-container-commands.txt`. Raw baseline sources, logs, mutated sources,
and an actual null-row CLI request plus both resulting JSON artifacts remain
untracked in `.test-tmp/afix-winbox-gate-r3/`. Source hashes are recorded in `afix-r3-sources.sha256`. String inventory line
positions and new diagnostics/test strings are refreshed. Syntax checks pass for the
three changed JavaScript files. Tests use the same required network-none
container wrapper, one container at a time, and the load limit above.
No Windows/PowerShell execution, live application, provider or PC was used.
Windows acceptance remains **PENDING** on the disposable Windows 11 runner.
