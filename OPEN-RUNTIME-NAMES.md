# Runtime names awaiting MAIN ruling

Open hit count: **50** (one production environment name, multiple uses).

The user requires production configuration and environment names to stay
unchanged. These are executable references, declarations, deployment bindings,
or test inputs exercising that same contract. The reader is
`cloudflare/control-plane/src/b4-flux-config.ts:56`; the policy constant is in
`cloudflare/control-plane/src/env-policy.mjs:67`.

MAIN ruling is **pending** for every row. MAIN must resolve the public naming
policy with the shared-guard owners or separately authorize a compatible
runtime migration. This inventory does not waive the guard. No shared pattern
was edited, no exclusion was added, and the release gate continues to fail.
Matched values are deliberately omitted; only locations and patterns follow.

| Location | Shared pattern | Role |
| --- | --- | --- |
| `cloudflare/control-plane/src/b4-flux-config.ts:26` | `FLUX_[A-Z0-9_]*_ENABLED` | Production environment contract |
| `cloudflare/control-plane/src/b4-flux-config.ts:41` | `FLUX_[A-Z0-9_]*_ENABLED` | Production environment contract |
| `cloudflare/control-plane/src/b4-flux-config.ts:56` | `FLUX_[A-Z0-9_]*_ENABLED` | Production environment contract |
| `cloudflare/control-plane/src/b4-flux-config.ts:71` | `FLUX_[A-Z0-9_]*_ENABLED` | Production environment contract |
| `cloudflare/control-plane/src/b4-flux-config.ts:82` | `FLUX_[A-Z0-9_]*_ENABLED` | Production environment contract |
| `cloudflare/control-plane/src/b4-flux-config.ts:90` | `FLUX_[A-Z0-9_]*_ENABLED` | Production environment contract |
| `cloudflare/control-plane/src/b4-flux-config.ts:98` | `FLUX_[A-Z0-9_]*_ENABLED` | Production environment contract |
| `cloudflare/control-plane/src/env-policy.d.mts:24` | `FLUX_[A-Z0-9_]*_ENABLED` | Production environment contract |
| `cloudflare/control-plane/src/env-policy.mjs:67` | `FLUX_[A-Z0-9_]*_ENABLED` | Production environment contract |
| `cloudflare/control-plane/src/flux-live-hooks.ts:75` | `FLUX_[A-Z0-9_]*_ENABLED` | Production environment contract |
| `cloudflare/control-plane/test/b3-control.test.ts:281` | `FLUX_[A-Z0-9_]*_ENABLED` | Test input using the production environment contract |
| `cloudflare/control-plane/test/b3-control.test.ts:286` | `FLUX_[A-Z0-9_]*_ENABLED` | Test input using the production environment contract |
| `cloudflare/control-plane/test/b4-flux.test.ts:325` | `FLUX_[A-Z0-9_]*_ENABLED` | Test input using the production environment contract |
| `cloudflare/control-plane/test/b4-flux.test.ts:501` | `FLUX_[A-Z0-9_]*_ENABLED` | Test input using the production environment contract |
| `cloudflare/control-plane/test/b4-flux.test.ts:530` | `FLUX_[A-Z0-9_]*_ENABLED` | Test input using the production environment contract |
| `cloudflare/control-plane/test/b4-flux.test.ts:546` | `FLUX_[A-Z0-9_]*_ENABLED` | Test input using the production environment contract |
| `cloudflare/control-plane/test/b4-flux.test.ts:707` | `FLUX_[A-Z0-9_]*_ENABLED` | Test input using the production environment contract |
| `cloudflare/control-plane/test/b4-flux.test.ts:735` | `FLUX_[A-Z0-9_]*_ENABLED` | Test input using the production environment contract |
| `cloudflare/control-plane/test/b4-flux.test.ts:903` | `FLUX_[A-Z0-9_]*_ENABLED` | Test input using the production environment contract |
| `cloudflare/control-plane/test/b4-flux.test.ts:2932` | `FLUX_[A-Z0-9_]*_ENABLED` | Test input using the production environment contract |
| `cloudflare/control-plane/test/b4-flux.test.ts:3177` | `FLUX_[A-Z0-9_]*_ENABLED` | Test input using the production environment contract |
| `cloudflare/control-plane/test/b4-flux.test.ts:3235` | `FLUX_[A-Z0-9_]*_ENABLED` | Test input using the production environment contract |
| `cloudflare/control-plane/test/b4-flux.test.ts:4528` | `FLUX_[A-Z0-9_]*_ENABLED` | Test input using the production environment contract |
| `cloudflare/control-plane/test/b4-flux.test.ts:4685` | `FLUX_[A-Z0-9_]*_ENABLED` | Test input using the production environment contract |
| `cloudflare/control-plane/test/b4-launch-gate.test.ts:44` | `FLUX_[A-Z0-9_]*_ENABLED` | Test input using the production environment contract |
| `cloudflare/control-plane/test/b5-billing.test.ts:41` | `FLUX_[A-Z0-9_]*_ENABLED` | Test input using the production environment contract |
| `cloudflare/control-plane/test/b5-billing.test.ts:537` | `FLUX_[A-Z0-9_]*_ENABLED` | Test input using the production environment contract |
| `cloudflare/control-plane/test/door-mint.test.ts:2106` | `FLUX_[A-Z0-9_]*_ENABLED` | Test input using the production environment contract |
| `cloudflare/control-plane/test/door-mint.test.ts:2712` | `FLUX_[A-Z0-9_]*_ENABLED` | Test input using the production environment contract |
| `cloudflare/control-plane/test/edge-limits.test.ts:181` | `FLUX_[A-Z0-9_]*_ENABLED` | Test input using the production environment contract |
| `cloudflare/control-plane/test/flux-email-proof.test.ts:86` | `FLUX_[A-Z0-9_]*_ENABLED` | Test input using the production environment contract |
| `cloudflare/control-plane/test/flux-email-proof.test.ts:756` | `FLUX_[A-Z0-9_]*_ENABLED` | Test input using the production environment contract |
| `cloudflare/control-plane/test/flux-email-proof.test.ts:840` | `FLUX_[A-Z0-9_]*_ENABLED` | Test input using the production environment contract |
| `cloudflare/control-plane/test/flux-email-proof.test.ts:1392` | `FLUX_[A-Z0-9_]*_ENABLED` | Test input using the production environment contract |
| `cloudflare/control-plane/test/flux-live-hooks.test.ts:26` | `FLUX_[A-Z0-9_]*_ENABLED` | Test input using the production environment contract |
| `cloudflare/control-plane/test/flux-live-hooks.test.ts:28` | `FLUX_[A-Z0-9_]*_ENABLED` | Test input using the production environment contract |
| `cloudflare/control-plane/test/flux-live-hooks.test.ts:69` | `FLUX_[A-Z0-9_]*_ENABLED` | Test input using the production environment contract |
| `cloudflare/control-plane/test/flux-live-hooks.test.ts:77` | `FLUX_[A-Z0-9_]*_ENABLED` | Test input using the production environment contract |
| `cloudflare/control-plane/test/grants-d1-d3.test.ts:30` | `FLUX_[A-Z0-9_]*_ENABLED` | Test input using the production environment contract |
| `cloudflare/control-plane/test/grants-d1-d3.test.ts:691` | `FLUX_[A-Z0-9_]*_ENABLED` | Test input using the production environment contract |
| `cloudflare/control-plane/test/h1-flux-fence.test.ts:122` | `FLUX_[A-Z0-9_]*_ENABLED` | Test input using the production environment contract |
| `cloudflare/control-plane/test/h1-flux-fence.test.ts:682` | `FLUX_[A-Z0-9_]*_ENABLED` | Test input using the production environment contract |
| `cloudflare/control-plane/test/legal-flows.test.ts:430` | `FLUX_[A-Z0-9_]*_ENABLED` | Test input using the production environment contract |
| `cloudflare/control-plane/test/step-up-email.test.ts:120` | `FLUX_[A-Z0-9_]*_ENABLED` | Test input using the production environment contract |
| `cloudflare/control-plane/test/topup-cap.test.ts:21` | `FLUX_[A-Z0-9_]*_ENABLED` | Test input using the production environment contract |
| `cloudflare/control-plane/test/topup-charge.test.ts:784` | `FLUX_[A-Z0-9_]*_ENABLED` | Test input using the production environment contract |
| `cloudflare/control-plane/test/topup-charge.test.ts:857` | `FLUX_[A-Z0-9_]*_ENABLED` | Test input using the production environment contract |
| `cloudflare/control-plane/test/topup-grant.test.ts:34` | `FLUX_[A-Z0-9_]*_ENABLED` | Test input using the production environment contract |
| `cloudflare/control-plane/wrangler.jsonc:118` | `FLUX_[A-Z0-9_]*_ENABLED` | Deployment binding read by production |
| `server/cloud-home/flux-renewal-e2e.test.ts:73` | `FLUX_[A-Z0-9_]*_ENABLED` | Test input using the production environment contract |
