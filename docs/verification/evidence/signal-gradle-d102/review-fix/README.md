# D102 BLOCK fixes — 2026-11-11

Starting HEAD: `fe1784f51d0835156a8e954caf0608d86ca8b960`. This round addresses only the two BLOCK findings in `arev-signal-gradle-verify/REVIEW-from-last.txt`.

Key retrieval now reads one byte beyond the 2,000,000-byte limit and aborts on overflow before writing/importing it. Only retrieval network errors permit the next keyserver or the existing checksum fallback; each failed retrieval retains its diagnostic. Local writes, process creation, GPG import and export errors abort generation. GPG diagnostics are printed before checking its exit status, including failed imports. A nonzero import is conservatively fatal, even when the server supplied an unusable key. No new metadata was generated and the reviewed XML/keyring bytes are unchanged.

`scripts/signal-gradle-verification.test.py` executes the production shell script in a fresh fixture for each case. Upstream source, downloaders, Java, Gradle and normalization are synthetic; actual shell control flow, source extraction, metadata copying, hashing and comparison execute. The synthetic upstream archive has no verification inputs. At each Gradle invocation the fake checks both staged files against the reviewed bytes, strict mode, disabled configuration cache, `installDist`, and its independent Gradle home. Both build attempts and their checksum evidence must exist. A missing reviewed keyring must stop the script before Gradle starts. The existing contract suite invokes these checks, replacing the source-substring assertions about metadata copying. In this container the shell script executes unchanged. For Linux hosts outside Docker, only the container-marker probe is redirected to a fixture file; `host-fixture-mode.log` verifies that path inside the same isolated container.

| Finding | Baseline RED | Killed mutant | Fixed result |
| --- | --- | --- | --- |
| 1: truncation and swallowed errors | `block1-baseline-red.log`: eight new tests against the original retriever, six assertion failures; exit 1 | `block1-mutants-killed.log`: bounded read without overflow detection fails the oversized-response assertion; catching local errors fails the write/process/import assertions | `regressions-green.log`: all eight retrieval tests pass |
| 2: production wiring coverage | `block2-baseline-red.log`: the original contract gate **passes** with the copy command commented out; the regression assertion requiring rejection therefore fails, exit 1 | `block2-mutant-killed.log`: the updated contract gate exits 1 on `missing staged verification-metadata.xml` in the executed production path; all eight retrieval tests pass in that run | Both production fixture tests pass; `signal-runtime-suite.log`: **146 passed, six existing skips** |

The mutation runner exit files contain 0 when their expected rejection assertions pass. The nested tests under mutation intentionally fail. Baseline RED was captured before changing the retriever or the contract checks. Raw logs, original source snapshots, mutant sources and fixture directories remain in `/work/build/afix-signal-gradle-verify/evidence/`; prior evidence folders remain in place.

All execution used one isolated, network-none container on build-host, pinned to `node:24-bookworm@sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4`, with two CPUs and 4 GiB memory. Load was below 60 at launch. Existing local test dependencies were mounted read-only. No app server or user data was involved. `container-provenance.json` records its identity and results. The container and the empty worktree dependency mount directory were removed afterward.

To reproduce, mount the checkout at `/repo`, local test dependencies at `/repo/node_modules` read-only (give Vite temporary cache mounts), and a fresh job evidence directory at `/evidence` in that pinned network-none image. Run:

```sh
python3 /repo/scripts/signal-gradle-verification.test.py
node /repo/node_modules/vitest/vitest.mjs run --config /repo/scripts/signal-runtime.test-config.mjs /repo/scripts/signal-runtime.test.mjs --maxWorkers 2 --no-file-parallelism --no-cache
python3 /repo/docs/verification/evidence/signal-gradle-d102/review-fix/run-key-mutants.py
python3 /repo/docs/verification/evidence/signal-gradle-d102/review-fix/run-wiring-gate.py fixed
```

For the original wiring baseline, extract `scripts/signal-runtime-contract.checks.mjs` from starting HEAD into `/evidence/baseline-contract.checks.mjs` and pass that path as the runner's second argument, using a fresh label. The runner's rejection assertion must fail with underlying gate exit 0. For the original retrieval baseline, point the test module's `RETRIEVER` at the starting HEAD's `enrich-keys.py`, then run its `KeyRetrieval` class; six assertions must fail.

`static-checks.log` records Bash/JavaScript/Python syntax validation, unchanged verification-file hashes and test-tier validation. `inputs.SHA256SUMS` binds the final test and production inputs. The previously accepted native Gradle tamper/build proof, closure counts, D094 exception and release plan are unchanged. No workflow dispatch, release, tag, publication, Mac use or billable service occurred.
