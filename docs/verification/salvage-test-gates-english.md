# Salvage test-gate English inventory

Owners: salv-tt owns the CI, comparison and engine-probe adapters and their test consumers. MAIN owns real-provider, release and platform qualification; the train cause lanes retain ownership of their product changes.

This inventory covers English added by the tt-T2/T3/T6 and comparison salvage, including its review fixes. These are maintainer diagnostics, CI labels and fixture prompts; they are not translated application copy. Template parameters below retain their source spelling. Test-case titles and fake fixture replies are verification inputs.

## Engine probe (`scripts/smoothness/real-engine.mjs`)

Prompts (sent only to the isolated engine fixture):

- `Run exactly ` + `` `sleep 45` `` + ` in the shell, then reply DONE.`
- `After the command, include STEER_ACK in your reply.`
- `Reply with exactly RECOVERED. Do not use any tools.`
- Bot label: `Nightly ${engine}`.

Diagnostics and verdict values:

- `engine fixture receipt does not match send`
- `engine fixture send refused`
- `engine fixture turn did not settle`
- `unknown real engine`
- `Ask level was not applied`
- `turn ended before an approval card`
- `no approval card observed`
- `approval answer refused`
- `turn ended before steer`
- `engine did not acknowledge a live steer`
- `steer not recorded on a running turn`
- `Stop did not settle`
- `Stop outcome was ${stopped.outcome}`
- `real turn after Stop did not complete with its reply`
- `packaged evidence incomplete`
- `packaged murageSourceSha does not match RC`
- `packaged run or evidence unavailable; inspect private runner logs`
- `REAL-ENGINE: NOT RUN (${engine}: <missing prerequisites>)`
- `REAL-ENGINE: PASS (${engine})`
- `REAL-ENGINE: FAIL (${engine})`
- `REAL-ENGINE: prerequisites present (${engine}; not a verdict)`
- `${engine} binary on PATH`
- `full RC SHA`
- `packaged RC build unavailable`
- `SMOOTH_APP_DIR packaged app`

Credential prerequisite names are the existing provider variable/file names in `prerequisites()`; none is a credential value. The five engine names are Claude, Codex, Gemini, Fuigo and OpenCode.

## Release guard (`scripts/release-ci-gate.mjs`)

- `REAL_ENGINE_EXPLICIT_WAIVER requires workflow_dispatch and '<RC SHA>: <reviewed reason>'`
- `REAL-ENGINE EXPLICIT WAIVER: ${explicitWaiver}`
- `REAL-ENGINE: NOT-RUN (no verdict for RC ${sha})`
- `real-engine nightly for ${sha} is still running`
- `REAL-ENGINE: NOT-PASSED (${engine}: ${job?.conclusion ?? "NOT-RUN"}; explicit verdict required)`
- `real-engine ${engine} verdict is invalid or older than 72 h for ${sha}`
- `all five real engines passed on RC ${sha} within 72 h`
- `${real.reason}; refusing release`
- `${real.reason}; checking again in 60s`

## CI and evidence labels

- `Every Vitest file is classified and every Node test is wired` (.github/workflows/ci.yml).
- `Prepare script-test archives and Chromium` (.github/workflows/ci.yml).
- `Script and native protocol Node tests` (.github/workflows/ci.yml).
- `macOS backup and offline deliverable Node tests` (.github/workflows/ci.yml).
- `push-relay tests (isolated SQLite fixtures)` (.github/workflows/ci.yml).
- `cloud portal journeys (fake control plane)` (.github/workflows/nightly.yml).
- `Retain portal failure evidence` (.github/workflows/nightly.yml).
- `cloud-portal-results` (.github/workflows/nightly.yml).
- `package for real engines (RC SHA)` (.github/workflows/nightly.yml).
- `Build the exact RC package` (.github/workflows/nightly.yml).
- `real-engine-package-${{ github.sha }}` (.github/workflows/nightly.yml).
- `real-engine (${{ matrix.engine }})` (.github/workflows/nightly.yml).
- `Existing engine prerequisites` (.github/workflows/nightly.yml).
- `Require the RC package` (.github/workflows/nightly.yml).
- `real-engine-package-${{ github.sha }}` (.github/workflows/nightly.yml).
- `Real-engine verdict` (.github/workflows/nightly.yml).
- `Preserve per-engine verdict` (.github/workflows/nightly.yml).
- `real-engine-verdict-${{ matrix.engine }}-${{ github.sha }}` (.github/workflows/nightly.yml).

CI archive preparation also reports `${url}: ${response.status}` and `${name}: digest mismatch`. The required jobs are blocking; an unwired test remains an error.

Engine budget labels (`scripts/smoothness/budgets.json`):

- `REAL.cards`: approval card answered.
- `REAL.steers`: live steer acknowledged and recorded.
- `REAL.stopped`: active turn stopped.
- `REAL.stopMs`: Stop to settled (same S8 limit).
- `REAL.completed`: real reply after Stop.

## Node inventory (`scripts/ci-test-tiers.mjs`)

- `--exclude needs a path or glob`
- `unwired node-test file: ${file} (add a blocking CI/nightly Node runner)`
- `run-node matched no test files`
- `ok: ${result.files} Vitest files; ${result.gate} gate, ${result.extended} extended; ${result.nodeFiles} Node files wired`

New or revised gate-list reasons (`ci/gate-tests.txt`):

- `scripts/smoothness/real-engine-api.test.mjs`: required engine probe uses public card actions and bot replies through an isolated server.
- `server/drivers/claude-s2-linux-qualification.test.ts`: Only the reviewed exact Linux native Claude build can retain S2 mounts in production Claude native steering admits only its qualified Linux build and version.
- `server/testing/internal-dispatch-fixture.test.ts`: Fixture capabilities retain verified provenance and reject copied authority Real owner, guest, unknown and stale provenance retain their actual capability authority..
- `server/cloud-home/sentinel-native-resource.test.ts`: Cloud image installs a loadable native resource and proves default enrollment and receipt projection..
- `server/decision/pi-projection-security.test.ts`: Pi projection loss cannot approve a protected edit and No limits checks the full original input for wipes.
- `server/drivers/contracts-legacy.test.ts`: Legacy approval calls remain compatible while missing driver metadata fails closed.
- `server/memory/testing/b34-native-enrollment.test.ts`: Merged regression retains authority, bounded work and exact state transitions..

## Comparison reader (`scripts/test-truth/compare.py`)

- `shard-{index}: source revision differs from requested {expected_sha}`
- `shard-{index}: source is labelled for the wrong comparison side`
- `shard-{index}: completion receipt differs from source or side`
- `shard-{index}: duplicate shard assignment`
- `shard-{index}: corrected-input source check failed`
- `shard-{index}: corrected-input files outside shard inventory`
- `{key}: ambiguous progress name in JSON title metadata`
- `shard-{index}/{progress.name}:{number}: invalid progress: {error}`
- `the full test inventory is empty`
- `No authoritative JSON assertion result; progress observation only`
- `{key}: collected ID absent from authoritative report`
- `<TIMEOUT>`
- `<NO RESULT>`
- `<FILE LOAD/SUITE FAILURE>`
- `Latest JSON passed after an observed failure`

Attempt records expose `code`, `reportFailures`, `timedOut`, `signal`, `missingReports` and `activeTestIds`. Failure counters use the Vitest report keys `success`, `numFailedTests`, `numFailedTestSuites`, `numUnhandledErrors` and `numRuntimeErrorTestSuites`; no exception/provider text is invented. Existing filesystem/JSON errors are passed into the private comparison evidence. Requested-revision CLI descriptions are `Exact requested source revision, independent of result labels`.

The disposable mutation runner retains `KILLED, restored GREEN`, `Baseline is not green or selected no assertions`, `Missing mutation anchor`, `Mutant survived` and `Unknown or empty mutant selection` diagnostics. Its default evidence path is a temporary directory outside the checkout.
