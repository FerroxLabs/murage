# Astra review fixes: verification protocol

Reviewed revision: a988f9a7ac. All four findings accepted and fixed; none waived.
No dependency install, live provider request, user-data mutation or billable
resource was needed. Project memory tool and directory remain unavailable.

## Negative controls

The expanded tests first passed 16/16. A controlled run then temporarily
restored the six standalone manifests/locks from the reviewed revision,
removed the incidental-resolution disclosure, selected the locally cached
adm-zip 0.5.18 for the hostile-archive tests, and selected minimatch 10.2.6
for the FileMatcher version assertion. Original bytes were restored in a
finally block before the final verification runs.

Result: **9 expected failures, 7 passes**, no collection failure. See
review-negative.log. Finding 1 fails the standalone Zod assertion; finding 2
fails both Vitest-family assertions and the Capacitor minimatch chain;
finding 3 fails all three symlink extraction cases and the resolved minimatch
assertion; finding 4 fails the disclosure inventory check. Traversal cases
also pass on old adm-zip: the demonstrated behavior regression is symlink
containment, not a claim that every traversal spelling failed before patching.

## Commands

All commands ran in this lane, with TMPDIR pointing to ../scratch/tmp.
The final batch used setsid nohup with stdin redirected from /dev/null and
one blocking shell wait. Jobs ran sequentially; timing thresholds unchanged.

```sh
node_modules/.bin/vitest run scripts/security-dependencies.test.mjs scripts/security-lockfiles.test.mjs scripts/stage-hoisted.test.mjs scripts/staged-tree-check.test.mjs scripts/whatsapp-inventory.test.mjs server/channels/whatsapp/bridge.test.ts src/mermaid-frame/frame-page.test.ts src/mermaid-frame/protocol.test.ts src/lib/markdown-fidelity.test.ts src/lib/markdown-render-cache.test.ts
node_modules/.bin/vitest run --config cloudflare/push-relay/vitest.config.ts test/schema.test.ts test/http.test.ts test/payloads.test.ts test/cbor.test.ts
node_modules/.bin/vitest run --root apps/mobile --config vite.config.ts src/launcher.test.ts src/launcher-wiring.test.ts src/push-contract.test.ts src/push-refresh-contract.test.ts src/invitation.test.ts src/screens.test.ts
NODE_OPTIONS=--max-old-space-size=8192 node_modules/.bin/tsc -p tsconfig.json
NODE_OPTIONS=--max-old-space-size=8192 node_modules/.bin/tsc -p tsconfig.server.json
node_modules/.bin/vitest run server/inbox.hotpath-r4.test.ts server/inbox.hotpath-r5.test.ts server/inbox.hotpath-r6.test.ts server/writetime-s2.test.ts server/writetime-rootsets-turn.test.ts server/writetime-r11c.test.ts server/memory/writetime-integration.test.ts server/memory/writetime-schema.test.ts server/memory/writetime-readers.test.ts server/memory/writetime-live-differential.test.ts server/memory/writetime-differential.test.ts
```

Standalone neighbouring tests use the root's installed Vitest 4.1.12;
standalone node_modules directories are absent. These runs establish source
compatibility for the listed tests, not standalone installation correctness.
The lock regressions separately check metadata, snapshots, and overrides.
No server/conversation implementation changed; there is no new live-app
workflow claim. Prior isolated fixture evidence remains in this directory.

Development checks: the first 16-test run had 13 passes and 3 failures
(two copied optional-peer range mismatches and a foreign Windows-drive
extraction assumption). The package metadata now matches the published
workspace record exactly; the new foreign-drive case accepts safe rejection
on POSIX. The corrected 16-test run passed in full before negative controls.
No pre-existing test or timing threshold was changed.

Final dependency/neighbour rerun after making the hostile-path fixture
portable: 218 passed, 0 failed (10 files). Standalone relay neighbours:
36 passed, 0 failed (4 files). Mobile neighbours: 298 passed, 0 failed
(6 files). Both TypeScript projects exited 0 with no diagnostics; see
review-typechecks.json. The updated negative control again produced exactly
9 expected failures and 7 passes.

The full targeted rig batch ran all 91 cases: 89 passed, 2 timing failures.
r6's concurrent write measured 71.55 ms against its unchanged 50 ms limit;
the synchronous root-set reclaim's longest batch measured 377.49 ms against
its unchanged 250 ms limit. Both failures are retained in review-rig.log.
No inbox/reclaim source, fixture sizes, assertions or timing thresholds were
changed. Isolated follow-up commands (after all other jobs finished):

```sh
node_modules/.bin/vitest run server/inbox.hotpath-r5.test.ts server/inbox.hotpath-r6.test.ts
node_modules/.bin/vitest run server/memory/writetime-integration.test.ts -t "hands the space back"
```

The r5/r6 follow-up passed 10/11, including the original concurrent-write
failure. It instead measured 24.72 ms at r6's unchanged 20 ms locked-apply
bound. The root-set reclaim follow-up passed 1/1 selected test (17 other
cases not selected; all had already run in the full targeted batch).
The locked-apply case was then run alone and passed 1/1 selected test (4
other cases not selected):

```sh
node_modules/.bin/vitest run server/inbox.hotpath-r6.test.ts -t "a 128 MiB bot-text row with an artifact id"
```

Thus each timing failure passed an isolated recheck, but there was no wholly
green combined rig run in this review-fix session. We do not infer the cause
of timing variability or claim a full-suite release gate. No server/inbox or
server/memory implementation or test changed relative to a988f9a7ac. The
four review findings' regression tests and their neighbours pass. Full-suite
BASE18/release comparisons, review approval, and push remain driver gates.
