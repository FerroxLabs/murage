# Composio marketplace pagination port — 2026-09-07

## Contract and provenance

Adapt upstream `45cc2cf07d9ba73abb0ca0cbd63f6002615f98c8` to the current fork's credential-fingerprinted cache, broker selection and request generation protections. Load catalog pages beyond the first 500 for direct and managed routes, with bounded pages/results/time, duplicate/cursor-loop handling, cancellation and identity isolation. Preserve existing privacy and multi-account logic. No server/index.ts, credentials, deployment, full suite or commit changes.

Root clarified before verification: incomplete catalogs must not silently appear complete. The unchanged API has no partial flag, so collected partial results produce a fixed actionable error instead of being returned or cached. First-page failure retains existing curated fallback.

## Implemented

- `server/composio.ts`: 20-page / 10,000-record ceiling, one 15-second timeout shared across pages, optional caller abort signal, URL-encoded bounded cursors, case-insensitive slug deduplication and repeated-cursor stop. Identity is checked before/after page work; aborted or changed-backend observations fall back without publishing/cache. Complete results retain generation-fenced cache behavior.
- Later HTTP/JSON/network failures, invalid/repeated cursors and ceilings after collected data throw only `The app catalog could not be loaded completely. Please retry.` No upstream payload or credential is included. Partial data is not cached.
- `cloudflare/composio-broker/src/index.ts`: validates/forwards catalog cursor while keeping fixed limit=500 and sort_by=usage. Authentication route remains unchanged. This is source integration, not broker deployment.
- `src/components/PluginsPanel.tsx`: upstream `loading="lazy"` on logo/favicon images to avoid fetching the expanded catalog's offscreen icons immediately. Layout unchanged.
- Dedicated `server/composio-catalog.test.ts` and broker boundary tests exercise completeness, pagination, both transport routes, dedup, partial failures, cache retry, cursor/page/record ceilings, shared cancellation budget and backend identity changes.

## Verification round 1

```sh
rtk proxy pnpm exec vitest run server/composio.test.ts server/composio-catalog.test.ts src/components/PluginsPanel.test.ts
rtk proxy pnpm exec vitest run --config cloudflare/composio-broker/vitest.config.ts
```

PASS: 3 files / 36 tests and broker 1 file / 8 tests. Both executed 2026-09-07 10:59:21 tool environment time. These are mocked/local transport and source integration tests, not live Composio or deployed broker proof. No correction was necessary. Passing evidence is reusable; round 2 remains available for a relevant integration correction, not a redundant rerun.

No production endpoint contacted. Main owns combined integration/typecheck and final package disposition. The deployed broker must receive this source change before a managed client can traverse its remote catalog; an old broker replaying page one now fails explicitly through the cursor guard.
