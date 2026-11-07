# DEP-AUDIT-RESIDUAL-1018 reachability and disposition

2026-11-06. Fresh workspace `pnpm audit --json` against BASE18's manifest,
workspace configuration and lockfile reports 6 high, 11 moderate, 1 low.
The final root workspace lockfile reports **0 critical/high/moderate/low/info**, no muted
advisories. See audit-base.json and audit-head.json. There are no remaining
reported workspace advisories requiring a reachability exception. Standalone
packages are covered by the review correction below. This is registry audit
evidence, not the driver's required Grok reachability approval.

Each finding is fixed in 1.0.18; none is accepted on non-reachability grounds.
Installed-package references below are relative to the named package root
under node_modules/.pnpm; repository references are relative to this checkout.

| Advisory | Reachability before the fix | Fix |
| --- | --- | --- |
| GHSA-xcpc-8h2w-3j85 | onnxruntime-node/script/install-utils.js:11,156 loads adm-zip during installation; pnpm-workspace.yaml:15-21 excludes this postinstall from the build allowlist | adm-zip 0.6.1 |
| GHSA-7q85-xj36-vmfc | Same installer load and constructor at install-utils.js:11,156 | adm-zip 0.6.1 |
| GHSA-rcw4-f5rp-g42v | Same installer load and constructor at install-utils.js:11,156 | adm-zip 0.6.1 |
| GHSA-j5f4-cc29-5x44 | Same installer load and constructor at install-utils.js:11,156 | adm-zip 0.6.1 |
| GHSA-8238-w5pm-2374 | Same installer load and constructor at install-utils.js:11,156 | adm-zip 0.6.1 |
| GHSA-vwc7-r8mq-g2x9 | Same installer load and constructor at install-utils.js:11,156 | adm-zip 0.6.1 |
| GHSA-p634-w6r4-rjp2 | Same installer load and constructor at install-utils.js:11,156 | adm-zip 0.6.1 |
| GHSA-c6fg-446q-cg94 | Same installer load and constructor at install-utils.js:11,156 | adm-zip 0.6.1 |
| GHSA-mrhx-c7xc-m3w5 | @jimp/plugin-color/dist/esm/index.js:5 constructs the collection schema; server/channels/whatsapp/bridge.ts:1047-1048 imports Jimp; baileys/lib/Utils/messages-media.js:159-162 decodes/crops/resizes image inputs | All root-workspace Zod consumers resolve 4.6.7; no Zod 3 package remains in that lock |
| GHSA-82fw-gwwq-j7x9 (vitest and @vitest/mocker) | vite.config.ts:2,23 configures the test runner; cloudflare/control-plane/vitest.config.ts:3,25 configures Worker tests. The advisory's public mocker plugin is not registered by the application's vite.config.ts:17 | Vitest and its runner/mocker family 4.1.12 in both projects |
| GHSA-qxg6-89mg-rqv8 | Same development/test entrypoints at vite.config.ts:2,23 and cloudflare/control-plane/vitest.config.ts:3,25 | Vitest/mocker 4.1.12 |
| GHSA-xp26-3454-mjgp | Same test entrypoints, including the former 4.1.11 Worker runner; Windows redirect-path bypass requires the mocker registration path | Vitest/mocker 4.1.12 |
| GHSA-q2hr-2g5m-vwhr | app-builder-lib/out/fileMatcher.js:69,76,82 constructs minimatch patterns for package file selection; expansion occurs within minimatch | brace-expansion 5.0.12 floor |
| GHSA-g3hv-75wg-m249 | app-builder-lib/out/fileMatcher.js:69,76,82 and @electron/universal/dist/cjs/index.js:131,241 match build patterns | Affected minimatch 7–10 consumers resolve 11.0.1 |
| GHSA-238p-pmpm-9mq7 | src/mermaid-frame/frame.ts:39,105 loads Mermaid and renders diagram input; mermaid/dist/chunks/mermaid.core/chunk-VPRB5NB3.mjs:5479 loads KaTeX for math | All KaTeX consumers resolve 0.18.7 |

Plain-name adm-zip and Zod overrides are intentional: scripts/staged-tree-check.mjs:29
reads plain-name overrides and validates the staged version against their range.
No range check is disabled. The synthetic conflicting-Zod fixture explicitly
opts out of repository overrides; the new real-package test uses the real
repository policy and validates both staged graphs. It also exercises ESM/CJS
Jimp image operations, invalid input rejection, and ONNX's ZIP extraction API.
Additional real-consumer checks exercise Electron's FileMatcher, universal's
minimatch call and Mermaid's KaTeX renderer.

http-cache-semantics 4.2.0 remains in the build dependency graph, but neither
fresh baseline nor head audit reports an advisory for it. The historical
handoff supplies no advisory identifier for that package; no waiver or claim
of a patched release is made here.

## MurageCloud relay (driver to deliver, input FIX-LEDGER.md:2762)

CP-BETTER-AUTH-177 remains MurageCloud's deployment responsibility in 1.0.18.
BASE18 already pins better-auth 1.7.7 at cloudflare/control-plane/package.json:7.
cloudflare/control-plane/migrations/0111_account_issuer_nullable.sql:2-6 states
migration/deploy order; migrations-later/0112_account_drop_issuer.sql is the
later schema step after old Workers are retired. Reconcile the ledger's stale
1.7.1 source claim and provide staging/new-account/existing-account phone
sign-in proof plus approved deployment evidence. This lane did not deploy or
call real provider APIs. Neither fresh workspace audit reports better-auth.
No accessible MurageCloud messaging tool is configured; this payload is for
the verify driver to relay along with the final SHA.

## Comparison and gates

1ca72c64d is already an ancestor of BASE18. No duplicate cherry-pick.
Fresh head audit has zero NEW versus BASE18 and removes all 18 reported
vulnerabilities. Full-suite zero-NEW comparisons against BASE18 and release
run 42028153798 remain the driver's runner gates. The local release commit
2b388bae112a97d3aaf90a456cc87dd262663c69 audit reports 1 critical, 13 high,
15 moderate and 3 low (32 total), versus head zero; see
audit-release-source.json. This is zero NEW against that source lockfile,
but this checkout has no
verified run-to-SHA mapping or result artifacts for that run. Source comparison
cannot establish its test baseline. Grok/Astra reviews, push/ls-remote, and
integrator #13 notification are driver-owned; no READY row is asserted.

Project memory prelude tool is not configured and .ijfw/memory is absent.
No billable resources or containers were created.

## Review correction: standalone package coverage (2026-11-06)

The original zero-advisory audit above covers the **root workspace only**.
Its “All Zod consumers” claim was incorrect for standalone packages. The
portal and push-relay manifests and locks now pin Zod 4.6.7. Runtime inputs
reach it at cloud-portal/app/sign-in/actions.ts:11,20 and
cloudflare/push-relay/src/relay.ts:48. Neither input path is waived.

The standalone locks were repaired offline using the exact package metadata
and SHA-512 integrity records from the audited workspace lock. The offline
pnpm resolver lacked @peculiar/x509 metadata; no install or network access
was used. The lock regression checks verify manifest/importer alignment,
Vitest package metadata equality, dependency snapshot closure, and the
Capacitor-to-minimatch chain. This is static advisory-range coverage, not a
new registry audit or a standalone frozen-install claim.

| Advisory | Standalone execution path / exposure | Resolution |
| --- | --- | --- |
| GHSA-mrhx-c7xc-m3w5 | Portal email form actions.ts:11,20 and relay JSON relay.ts:48 call safeParse on untrusted runtime input | Both Zod 4.4.3 copies replaced with 4.6.7, including npm/pnpm integrity records |
| GHSA-qxg6-89mg-rqv8 | apps/mobile/package.json:11 and cloudflare/push-relay/package.json:19 invoke Vitest; mobile CI .github/workflows/ci.yml:588 installs independently of root overrides. The mocker is a test-runner dependency, not an app runtime route | Both full Vitest families 4.1.12; no public mocker plugin in apps/mobile/vite.config.ts:5 or cloudflare/push-relay/vitest.config.ts:6 |
| GHSA-xp26-3454-mjgp | Same runner entrypoints; Windows redirect handling requires exposing the mocker middleware. Inspected standalone configs register no such plugin; attacker-triggered operation was not demonstrated | Same 4.1.12 patch, no exposure exception |
| GHSA-g3hv-75wg-m249 | apps/mobile/scripts/sync-native.mjs:3 invokes Capacitor sync; apps/mobile/pnpm-lock.yaml:990,1559,1442 records Capacitor → rimraf → glob → minimatch. Build cleanup glob patterns can reach matching; no route accepts remote glob patterns | Standalone override and locked minimatch 11.0.1; no reachability waiver |

## Incidental resolution disclosure

incidental-resolutions.json lists all eight review-identified workspace
changes with old/new versions, exact snapshot consumers, and retention
rationale. These came from the previous depth-Infinity Vitest update resolving
compatible ranges, rather than eight additional security fixes. We retain
and disclose them because the installed graph and prior verification used
them. Other consumers can still use earlier compatible versions. The new
standalone updates preserve their existing compatible transitive versions;
they do not copy the workspace's incidental bumps.

Regression coverage now includes real hostile ZIP entry bytes (traversal,
absolute, Windows-style names), and pre-existing symlinks for synchronous,
asynchronous and single-entry extraction. Resolved FileMatcher, universal
and brace-expansion versions are asserted at their actual consumer roots.
The earlier benign extraction and image tests remain unchanged.

standalone-advisory-coverage.json compares all three standalone locks with the
already captured advisory ranges in audit-base.json. None of those known
ranges matches a remaining standalone package. It does not claim a new
registry-wide audit or cover advisories absent from that captured input.

Mobile's minimatch 11.0.1 also requires @isaacs/nonrecursive-glob-match 1.1.0;
its package/snapshot and integrity are copied from the workspace lock. This
is the new matcher's required dependency, not an unrelated upgrade. Mobile's
existing brace-expansion 5.0.12 and balanced-match 4.0.4 are preserved.
