# Production control-plane signing key (operator runbook)

DO NOT run until Sean says go. The production JWK is null today, so desktops refuse production homes.

1. Be logged in to the PRODUCTION Cloudflare account: `cd cloudflare/control-plane && pnpm exec wrangler whoami` (account `b83123326a4b9ad76831b9cb9365b33b`).
2. `node scripts/gen-prod-signing-key.mjs`
   - It generates an ES256 P-256 key in memory, pipes the private JWK to `wrangler secret put CLOUD_B3_SIGNING_JWK` on stdin, and prints only the PUBLIC JWK.
   - It refuses if the secret already exists (use `--rotate` only on purpose: every paired desktop must already ship the new public key).
   - Nothing is written to disk, argv or env; nothing private is printed.
3. Paste the printed public JWK into `electron/cloud-control-plane.mjs` as `CLOUD_HOME_CP.prod.jwk` (replace `null`; the production key is pinned there as of 2026-10-17), update the tests that assert prod is null, commit, ship a desktop build.
4. Verify against production with a throwaway home: its `homeKey` envelope verifies with the new public key.
5. Do not enable Cloud for customers until a desktop build with the key is out.
Tested by `server/cloud-home/prod-signing-key.test.ts` against a stub wrangler (never against production).
