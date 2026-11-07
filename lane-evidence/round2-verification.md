# Review-fix relaunch, 2026-11-06

Reviewed HEAD: 23196b5e20. Both findings accepted and fixed; no waivers or deferrals.

- Medium: control-plane Vitest manifest pinned to 4.1.12, matching the workspace importer.
  Regression: `pins the control-plane Vitest manifest to its workspace importer`.
- Low: persistent standalone overrides and lock resolutions now enforce sharp 0.35.5,
  undici 7.30.1 and source-map-js 1.2.2 wherever present. Sharp platform binaries
  and libvips 1.3.4 use the existing workspace integrity metadata. Sharp's optional
  Node types peer resolves to the relay's existing 26.6.3 and propagates through
  miniflare and wrangler. Mobile has only source-map-js among these packages.
  Regression: both cases of `enforces workspace security floors throughout standalone %s`.
  The existing graph-closure test and new importer checks reject dangling references.

`standalone-advisory-coverage.json` now separately records workspace floors;
these are independent of audit-base.json, not newly discovered audit results.
No install or registry/provider request was used. No test was weakened and no
threshold was changed. Memory prelude tool and memory directory are unavailable.

## Negative control

Ran the new regression tests against the reviewed manifests and standalone locks,
restored with `git show 23196b5e20:<path>`. Saved working bytes were restored in a
finally block. Result: 5 passed, 3 expected failures (one Medium, two Low cases),
with no collection failures. See round2-negative.log. Each finding therefore has
a regression that demonstrably fails without its fix.

## Verification

All tests use the installed root Vitest 4.1.12. TMPDIR was set to the lane-local
repo/.test-tmp directory; control-plane also used lane-local XDG_CONFIG_HOME and
WRANGLER_SEND_METRICS=false. Control-plane tests use the isolated workerd fixture
and its test-only bindings. No server/conversation implementation changed and
no live application workflow is claimed. Standalone installs were not performed;
lock tests verify metadata and graph consistency, not installation reproducibility.

| Run | Passed | Failed | Files |
| --- | ---: | ---: | --- |
| Dependency regressions and neighbours | 56 | 0 | 5 passed |
| Control-plane targeted neighbours | 5 | 0 | 2 passed |
| Relay targeted neighbours | 36 | 0 | 4 passed |
| Mobile targeted neighbours | 298 | 0 | 6 passed |
| Additional broad relay run | 124 | 0 executed tests | 8 passed, 5 collection failures |
| Additional broad mobile run | 848 | 7 | 22 passed, 2 failed |

The broad relay collection failures all report missing @peculiar/x509. The broad
mobile failures are one Capacitor node_modules path check and six host-safety
checks requiring unavailable lsof. These broader runs are not green; their full
logs are retained. The focused neighbour runs above all pass. These environment
gaps do not waive either review finding or modify any existing tests.

Both `tsconfig.json` and `tsconfig.server.json` passed (exit 0, no diagnostics),
using NODE_OPTIONS=--max-old-space-size=8192. Results are in round2-typechecks.json.

## Commands

```sh
node_modules/.bin/vitest run scripts/security-lockfiles.test.mjs scripts/security-dependencies.test.mjs scripts/dependency-floors.test.mjs scripts/stage-hoisted.test.mjs scripts/staged-tree-check.test.mjs
node_modules/.bin/vitest run --root cloudflare/control-plane --config vitest.config.ts test/schema-shape.test.ts test/retention-config.test.ts
node_modules/.bin/vitest run --config cloudflare/push-relay/vitest.config.ts
node_modules/.bin/vitest run --root apps/mobile --config vitest.config.ts
node_modules/.bin/vitest run --config cloudflare/push-relay/vitest.config.ts test/schema.test.ts test/http.test.ts test/payloads.test.ts test/cbor.test.ts
node_modules/.bin/vitest run --root apps/mobile --config vitest.config.ts src/launcher.test.ts src/launcher-wiring.test.ts src/push-contract.test.ts src/push-refresh-contract.test.ts src/invitation.test.ts src/screens.test.ts
NODE_OPTIONS=--max-old-space-size=8192 node_modules/.bin/tsc -p tsconfig.json
NODE_OPTIONS=--max-old-space-size=8192 node_modules/.bin/tsc -p tsconfig.server.json
```
