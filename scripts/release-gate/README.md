# Murage 1.0.19 RC gates

On build-host, from this checkout:

```sh
bash scripts/release-gate/gate-1019.sh <candidate-sha>
```

The default comparison base is `1a899c675`; select a different baseline with
`--base <sha>`. `--out <directory>` selects the evidence parent. Each invocation
creates a fresh directory and prints one Markdown table. JSON beside the table
contains the exact commands, failure details and evidence paths. Every
UNVERIFIED row also prints its exact manual command on stderr. Exit status is
1 if any gate fails, otherwise 2 if any gate is unverified, otherwise 0.

`--dry-run` executes the same fake fixtures and both smoothness legs. It makes
one full-suite dispatch attempt rather than waiting for an existing registry
lock. It never substitutes canned PASS results. Both modes leave login and
installed-binary requirements unverified and record manual commands. Missing
candidate harnesses fail, while missing infrastructure is unverified.

For a local-fixture correction after a completed run, `--smooth-from <run-dir>`
explicitly reuses that run's smoothness evidence while rerunning other gates.
It rechecks the candidate, overlay parent, pinned rig files, fixture manifest,
fake-engine/load mode, worker and cleanup exits, seven-day freshness and raw
63-row verdict. Missing or mismatched receipts are UNVERIFIED. The default
command always launches fresh idle and load legs.

The runner checks out the candidate into a disposable local shared clone. It
overlays only the four `server/release-marc-*.test.ts` acceptance fixtures from
the controller checkout, recording their hashes. Product code always comes
from the candidate. HTTP fixtures use `launchVerificationServer` with temporary
homes/data and fake engines, as required by `docs/verification/README.md`.

| Gate | Execution and interpretation |
|---|---|
| FULL | `/work/fuigo-builds/tools/vt-shard.sh <worktree> <sha> --hosts hz`; explicit `VT_WIDEN=0`, `VT_REMOTE_OK=0`, `MAXC=5`. Reuses completed registry results and reports NEW, BASE and FIXED failing assertion lines. FULL is PASS only with no NEW reds; FULL-base-reds separately blocks inherited reds. Incomplete candidate/base registries never pass. |
| SMOOTH-idle / load | Pinned rig `1715ad380105197f58345d1fc4912dae50c8f43c`, the corrected `g8-smooth.sh` from tri-smooth-a's triage. `PREBUILD=1`; idle and load run sequentially even after failures. Collects the worker reports, requires the 63-row verdict and matching worker exit. S10 real-engine proof remains separate. |
| G-NL | Sean ruling 2026-11-12 02:05Z: No limits permits every call except the wipe/catastrophe list, including tainted, unreadable, key-file and protected-path calls. The direct, registered, inheritance, R3 origin/level/wipe and editor tests plus nlsym and both Full access twins are required; missing required files fail the gate. Sean’s 02:50Z webhook ruling applies, guest threads never inherit, and channel-off wins. The fake native replay is `scripts/no-limits-live/truly-proof.mjs`. Candidate replay harness and its receipt verifier. The S3 status explicitly leaves real-engine transport, containment and integration evidence open. Synthetic replay API tests run when present; otherwise the inert Marc policy fixtures run, including wipe controls. Neither qualifies installed engines. |
| G-WEB | Candidate `scripts/web-read-replay/run.mjs --fake --out <new-dir>`. Reads `routeVerdict` separately from release `verdict`; requires the harness exit to agree with its release verdict (0 for PASS, 1 for FAIL/UNVERIFIED); timeouts/crashes fail. Installed native reader/binary proof is always separate and UNVERIFIED until supplied by its lane. |
| G-MARC-ssh-cd / compound | New literal field-command fixtures against the production decision function. Shell strings are never executed. These prove policy behavior; G-NL owns all-engine native transports. |
| G-MARC-seat | New isolated fake ACP creator fixture: a No limits chief creates a seat; asserts its activated level. |
| G-MARC-switch | New isolated fake Claude fixture: establishes a conversation, raises it through the actual preview/PATCH/apply flow, checks bot and conversation levels, then sends an inert ssh tool request through the real driver permission prompt transport and requires zero cards. This does not certify an in-flight installed provider's native posture transition. |
| G-MARC-browser | Existing `server/browser-turn-execution.test.ts` and `server/browser-owner-wait-api.test.ts`: releases reservations during owner waits, fences stale calls, reacquires after sibling turns, and covers cancellation/restart. |
| G-MARC-connector | Existing `connected-app-health.test.ts` and `ReconnectAppsBanner.test.ts` plus new Buffer-specific expired-sign-in fixture; verifies visible reconnect state, owner banner and prompt across later reads. No external connector is called. |
| LEAK-v2 | Requires the shared v2 scanner (including invalid-pattern failure). Uses the repository's redacting adapter against candidate HEAD and base; output stays in the job directory. |
| COPY-review / release-pending | `src/locales/copy-final.test.ts` validates immutable review records and the ledger. `scripts/copy-pending-check.mjs` requires an empty pending list. The repository has no `copy-review.mjs verify` subcommand. |

To dispatch an already installed, reviewed **inert** replay image, add
`--nolim-config /absolute/path/config.json`. The file binds `sha`, `image`
(`name@sha256:...`), `inert: true`, `corpus`, `results`, `pendingReceipt`,
`corpusDigest` and `policyDigest`. The three paths must be allocated under
`/work/fuigo-builds/orph/_ev/nolim-replay/1019/`. The candidate harness enforces
its UID, permissions, immutable image source label, pending receipt and complete
report/coverage oracle. Missing images are never pulled. No private corpus is
created or copied by this kit. Installed-engine proof stays UNVERIFIED even
after an inert replay passes.

All kit test containers use `--network none` and prewarmed dependencies/images.
The budget is five full-suite containers, two local fixtures (including any
configured replay), and one smoothness worker. The kit waits before launch
while host load exceeds 60; the shard scheduler and remote smoothness preflight
also enforce the load guard. Existing unrelated host jobs are not counted as
kit-owned containers. Smoothness uses the existing dedicated Linux worker;
Vultr, the Mac, paid engines and infrastructure provisioning are never used.

The kit removes its local containers and candidate checkout, and the upstream
smoothness worker removes its own source, data, stress process and container.
Evidence includes worker logs and fixture observations, not live app data.
`G-NL-truly-live` requires every row in `truly-rows.mjs` through the isolated
HTTP/SSE fake-native replay. A partial replay, unexpected card, missing wipe
card or wrong native resolution fails, even when a report claims PASS.
Do not delete an active run directory. Interrupt the foreground command to
terminate its exact child process groups; the smoothness worker also has its
own bounded deadline and cleanup trap.

Runner verdict self-tests (no dependencies):

```sh
node --test scripts/release-gate/*.node-test.mjs
```

Interruption cleanup waits for the exact child process groups to stop before
inspecting the full-suite invocation's xtrace. It removes only containers mounted
from that invocation's exported `RUN/src`, then removes that source. The same
cleanup runs on normal completion and SIGINT/SIGTERM. Shared caches, unrelated
containers and other runs are retained.

Regression and mutation verification uses disposable controller repositories and
fake Docker/shard clients **inside** a network-disabled container. No Docker
socket or host tool directories are mounted. The browser row additionally runs
the real existing API fixture, which launches its own fake verification server
and retains `browser-workflow/workflow.json` and `server.log`.

```sh
docker run --rm --init --pull=never --network none --cpus 2 --memory 2g \
  -e GATE_TEST_CONTAINER=1 -v "$PWD:/src:ro" -v "$EVIDENCE:/evidence" \
  -w /src node:24-bookworm bash -euc '
    node scripts/release-gate/mutations.mjs /evidence
    GATE_MUTATION_PROOF=/evidence/mutations.json node --test scripts/release-gate/*.node-test.mjs
  '
```

Each mutant has retained baseline GREEN, assertion RED, and restored GREEN logs.
The proof checker rejects passing-only results, crashes without assertions and
missing/restored-failing runs. `all-findings-red.log` records the five findings
before repair; `mutations.json` binds each implemented mutation to its logs.

Operator English inventory

No shipped application copy is introduced by this kit. The following exact source
literals are operator diagnostics, evidence prose, gate instructions and manual
command templates. Interpolation expressions are retained verbatim. Gate/status
identifiers and paths are technical identifiers, not application UI translations.
The inventory test checks all English-bearing literals in the production runner
and verdict/receipt/cleanup helpers plus the mutation-proof CLI, including shell
preparation text.

gate-1019.mjs

```json
[
  "\"../../server/testing/safe-wipe.mjs\"",
  "\"awk '{print $1}' /proc/loadavg; docker ps -q | wc -l\"",
  "'--dry-run'",
  "'--end-of-options'",
  "'--git-common-dir'",
  "'--no-checkout'",
  "'--nolim-config'",
  "'--smooth-from'",
  "'./owned-shards.mjs'",
  "'./smooth-receipt.mjs'",
  "'./truly-verdict.mjs'",
  "'/work/fuigo-builds/orph/_ev/nolim-replay/1019/'",
  "'/work/fuigo-builds/shared/leak-guard.sh'",
  "'/work/fuigo-builds/swarm-b/bld-gatekit-1019/runs'",
  "'/work/fuigo-builds/tools/vt-shard.sh'",
  "'5 vt-shard containers + 2 local fixture containers + 1 smoothness worker = 8 maximum for this kit'",
  "'BROWSER_WAIT_EVIDENCE=/evidence/browser-workflow'",
  "'COPY-release-pending'",
  "'COPY-review'",
  "'Candidate lacks '",
  "'Candidate or base registry incomplete/locked; no partial green'",
  "'Cannot unpack pinned rig'",
  "'Evidence must be outside /dev and /'",
  "'Exact candidate checkout with pinned rig, isolated fixture and dedicated gate login; manual command can incur engine usage and is never automatically executed'",
  "'FULL-base-reds'",
  "'FULL: registry locked; waiting for existing run\\n'",
  "'G-MARC-browser'",
  "'G-MARC-compound'",
  "'G-MARC-connector'",
  "'G-MARC-seat'",
  "'G-MARC-ssh-cd'",
  "'G-MARC-switch'",
  "'G-NL-fakes'",
  "'G-NL-installed-engines'",
  "'G-NL-replay'",
  "'G-NL-truly-live'",
  "'G-WEB-fake-routes'",
  "'G-WEB-installed'",
  "'Gate box SSH unavailable'",
  "'build host vt-shard tool missing'",
  "'Inert replay receipt verified by candidate harness; installed engine qualification stays separate'",
  "'Installed native-reader exclusions and binary proof missing; fake-route PASS never promotes this gate'",
  "'Invalid inert replay configuration; use the harness allocated paths and exact candidate'",
  "'Leg did not produce evidence; see dispatch error records'",
  "'Missing pinned dependency cache or local node:24-bookworm image'",
  "'Missing prewarmed dependencies/cage/image; refusing networked preparation by vt-shard'",
  "'PASS means no NEW reds; inherited reds are separately blocking below'",
  "'Pinned replay image is not installed; no pull or build attempted'",
  "'Pinned smoothness rig object unavailable'",
  "'Private corpus/receipt and all-engine installed matrix unavailable; synthetic checks below cannot qualify release'",
  "'Real engine login/transport evidence is unavailable; no billable engines invoked'",
  "'Replay harness absent at candidate'",
  "'Required complete wipe-only origin/inheritance HTTP/SSE replay with a fake native engine'",
  "'Run on build-host; never the Mac'",
  "'Runner is stopping'",
  "'S10 rows require dedicated signed-in engines; fake rig does not prove them; no billable calls authorized'",
  "'S3-STATUS.txt; Sean 2026-11-12 02:05/02:50Z: admitted No limits origins, including webhooks, are wipe-only; guests never inherit; channel off wins; all available rig engines'",
  "'SMOOTH-idle'",
  "'SMOOTH-load'",
  "'SMOOTH-real-engines'",
  "'Shared v2 scanner missing'",
  "'Unsafe smoothness receipt directory'",
  "'Unsafe worker evidence path'",
  "'Usage: gate-1019.sh <sha> [--base sha] [--out evidence-parent] [--dry-run]'",
  "'Waiting: host load > 60\\n'",
  "'candidate fixture absent'",
  "'cleanup-error.json'",
  "'copy-pending'",
  "'fake engines only; no login, billable API, live data, Mac, or resource provisioning'",
  "'fixture-overlay.json'",
  "'isolated fake fixture; no installed engine proof'",
  "'mkdir -p /tmp/home /work/node_modules; cp -a /src/. /work/; for f in /nm/* /nm/.[!.]*; do case \"$f\" in */.vite-temp|*/.vite|*/.cache) ;; *) ln -s \"$f\" /work/node_modules/;; esac; done; '",
  "'node scripts/copy-pending-check.mjs'",
  "'nolim-replay.log'",
  "'nolim-truly-live'",
  "'pnpm-lock.yaml'",
  "'release-marc-'",
  "'rev-parse'",
  "'scripts/build-murage-cage.mjs'",
  "'scripts/leak-guard/check.mjs'",
  "'scripts/no-limits-live/truly-proof.mjs'",
  "'scripts/no-limits-live/truly-rows.mjs'",
  "'scripts/nolim-replay/run.sh'",
  "'scripts/prepare-source-cage.mjs'",
  "'scripts/web-read-replay/run.mjs'",
  "'server/browser-owner-wait-api.test.ts'",
  "'server/browser-turn-execution.test.ts'",
  "'server/connected-app-health.test.ts'",
  "'server/decision/no-limits-truly.test.ts'",
  "'server/decision/no-limits-x2-full-access.test.ts'",
  "'server/decision/no-limits-y3b-full-access.test.ts'",
  "'server/no-limits-external-r3.test.ts'",
  "'server/no-limits-inheritance.test.ts'",
  "'server/no-limits-level-r3.test.ts'",
  "'server/no-limits-origin-r3.test.ts'",
  "'server/no-limits-r13-gate.test.ts'",
  "'server/no-limits-symlink-r31.test.ts'",
  "'server/no-limits-truly.test.ts'",
  "'server/no-limits-wipe-r3.test.ts'",
  "'server/nolimits-means-it-1020.test.ts'",
  "'server/nolimits-means-it.test.ts'",
  "'server/powershell-fail-closed-104.test.ts'",
  "'server/release-marc-buffer.test.ts'",
  "'server/release-marc-commands.test.ts'",
  "'server/release-marc-seat.api.test.ts'",
  "'server/release-marc-switch.api.test.ts'",
  "'src/locales/copy-final.test.ts'",
  "'vt-shard.log'",
  "'web-fake'",
  "'| gate | result | evidence path |\\n|---|---|---|\\n'",
  "`# vt-shard result for ${s}`",
  "`${baseRef}^{commit}`",
  "`${gate.replaceAll(/[^a-zA-Z0-9.-]/g, '_')}.json`",
  "`${gate} manual: ${detail.manual}\\n`",
  "`${gate}: ${result}\\n`",
  "`${log}.error`",
  "`${ref}^{commit}`",
  "`${sha.slice(0, 12)}-`",
  "`'${String(s).replaceAll(\"'\", \"'\\\\''\")}'`",
  "`/work/fuigo-builds/shared-base/${s}/out`",
  "`/work/fuigo-builds/tools/cage/${cageKey}/linux-x64/bwrap`",
  "`/work/fuigo-builds/tools/nm/${lock}/node_modules`",
  "`Candidate checkout failed; ${out}/checkout.log`",
  "`Candidate clone failed; ${out}/clone.log`",
  "`Evidence: ${out}\\n`",
  "`Exact ${sha} checkout with the integrated live harness on the dedicated signed-in Linux rig, every available engine selected; isolated fixture data only. Manual command can incur engine usage and is never automatically executed.`",
  "`Exact ${sha} checkout, dedicated signed-in Linux gate user, isolated fixture data; retain binary hashes and native-reader exclusion proof. Manual command can incur engine usage and is never automatically executed.`",
  "`MURAGE_DATA_DIR=\"\\${ISOLATED_SMOOTH_DATA:?fixture copy}\" SMOOTH_WORK=\"$PWD\" SMOOTH_OUT=\"\\${SMOOTH_EVIDENCE:?new output directory}\" SMOOTH_LABEL=gate1019-${sha.slice(0,12)} SMOOTH_ENGINES=real node scripts/smoothness/smooth.mjs`",
  "`PREBUILD=1 G8_HUB=${shellQuote(git('rev-parse', '--git-common-dir'))} G8_RIG=${rig} G8_JOB=${shellQuote(state)} bash ${shellQuote(launcher)} ${sha} ${mode}`",
  "`SMOOTH-${mode}`",
  "`TRULY_ONLY='' node --experimental-strip-types ${trulyReplay} /evidence/replay`",
  "`Unknown option: ${argv[i]}`",
  "`VT_WIDEN=0 MAXC=5 LOADMAX=60 bash ${tool} ${shellQuote(repo)} ${base} --hosts hz`",
  "`VT_WIDEN=0 MAXC=5 LOADMAX=60 bash ${tool} ${shellQuote(repo)} ${sha} --hosts hz`",
  "`WEBREAD_REVISION=${sha} node --experimental-strip-types ${file} --live --out \"$PWD/web-installed-${sha}\"`",
  "`bash ${harness} \"\\${NOLIM_IMAGE:?immutable image for ${sha}}\" \"\\${NOLIM_CORPUS:?isolated inert corpus}\" \"\\${NOLIM_RESULTS:?new allocated directory}\" ${sha} \"\\${NOLIM_CORPUS_DIGEST:?}\" \"\\${NOLIM_POLICY_DIGEST:?}\" \"\\${NOLIM_PENDING_RECEIPT:?}\"`",
  "`bash ${shellQuote(join(here, 'gate-1019.sh'))} ${sha} --base ${base}`",
  "`gate1019-${process.pid}-${name.toLowerCase().replaceAll(/[^a-z0-9-]/g, '-')}`",
  "`git ${args[0]} failed: ${r.stderr}`",
  "`node --experimental-strip-types ${file} --fake --out /evidence/routes`",
  "`node --experimental-strip-types scripts/no-limits-live/run.mjs --live --release --out \"$PWD/nolim-installed-${sha}\"`",
  "`node node_modules/vitest/vitest.mjs run ${files.map(shellQuote).join(' ')} --maxWorkers=1 --reporter=default --reporter=json --outputFile=/evidence/tests.json${pattern ? ' -t ' + shellQuote(pattern) : ''}`",
  "`node scripts/leak-guard/check.mjs --root ${shellQuote(snapshot)} --base ${base}`",
  "`owner=gate1019-${process.pid}`",
  "`registry-${s}`",
  "`run-${mode}.`",
  "`server/${f}`",
  "`smooth-${mode}-collect.log`",
  "`smooth-${mode}-evidence`",
  "`smooth-${mode}.log`",
  "`smooth-${mode}`",
  "`| ${r.gate} | ${r.result} | ${r.evidence} |`"
]
```

judge.mjs

```json
[
  "'Missing or ambiguous 63-row verdict'",
  "'Worker exit and verdict disagree'"
]
```

smooth-receipt.mjs

```json
[
  "'--name-only'",
  "'--no-commit-id'",
  "'Incomplete smoothness worker/cleanup receipt'",
  "'Missing/ambiguous smoothness result'",
  "'Smoothness fake-engine pin mismatch'",
  "'Smoothness fixture manifest mismatch'",
  "'Smoothness overlay changed product code'",
  "'Smoothness overlay parent mismatch'",
  "'Smoothness overlay rig mismatch'",
  "'Smoothness receipt candidate/rig mismatch'",
  "'Smoothness result identity, engine mode or freshness mismatch'",
  "'diff-tree'",
  "'fake-acp-cli.ts'",
  "'fake-claude-cli.ts'",
  "'fake-codex-app-server.ts'",
  "'fake-pi-cli.ts'",
  "'fixture-request.ts'",
  "'ls-tree'",
  "'rev-parse'",
  "`${overlay}:${file}`",
  "`${overlay}^`",
  "`${rig}:scripts/smoothness/fixtures-v7.json`",
  "`fd825341c6cc752318f0433203399db4d434a19c:${file}`",
  "`run-${mode}.`",
  "`smooth-${mode}-evidence`",
  "`smooth-${mode}`"
]
```

owned-shards.mjs

```json
[
  "\"../../server/testing/safe-wipe.mjs\"",
  "'Cannot inspect owned shard containers before source cleanup'",
  "'Could not remove owned shard container; retaining mounts'",
  "'Invalid owned shard container id'",
  "'vt-source-cleanup.json'"
]
```

mutations.mjs

```json
[
  "\"../../server/testing/safe-wipe.mjs\"",
  "\"['server/browser-turn-execution.test.ts', 'server/browser-owner-wait-api.test.ts']\"",
  "\"['server/browser-turn-execution.test.ts']\"",
  "\"return before?.code === 0 && red?.code === 1 && /AssertionError|ERR_ASSERTION/.test(red?.output ?? '') && after?.code === 0;\"",
  "'  // Mutant: accept stale report despite abnormal exit.'",
  "'  // Mutant: omit interrupted shard cleanup.'",
  "'  for (const log of shardLogs) cleanupOwnedShards(log, sha, out);'",
  "'--test-name-pattern='",
  "'--test-reporter=tap'",
  "'./mutation-proof.mjs'",
  "'/tmp/gate-mutants-'",
  "'Unsafe evidence directory'",
  "'Use the isolated test container'",
  "'Waiting for'",
  "'Waiting: host load > 60'",
  "'assertion RED'",
  "'electron/data-dir-lease.mjs'",
  "'electron/windows-native.mjs'",
  "'host load to drop'",
  "'inventory.node-test.mjs'",
  "'mutation-proof.mjs'",
  "'mutation-proof.node-test.mjs'",
  "'orchestration.node-test.mjs'",
  "'return true;'",
  "'scripts/release-gate'",
  "'server/testing/safe-wipe.mjs'",
  "`${finding}-${phase}.log`",
  "`${finding}: ${killed ? 'KILLED; restored GREEN' : 'INVALID PROOF'}`",
  "`Mutation anchor is not unique: ${finding}`"
]
```

mutation-proof.mjs

```json
[]
```

- "'./truly-verdict.mjs'"

- "'G-NL-truly-live'"

- "'Required complete wipe-only origin/inheritance HTTP/SSE replay with a fake native engine'"

- "'nolim-truly-live'"

- "'scripts/no-limits-live/truly-proof.mjs'"

- "'scripts/no-limits-live/truly-rows.mjs'"

- "`TRULY_ONLY='' node --experimental-strip-types ${trulyReplay} /evidence/replay`"
