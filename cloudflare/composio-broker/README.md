# Murage connected-apps broker

This Worker keeps the shared Composio project key out of desktop builds. Each
installation receives a random bearer token stored only as a SHA-256 hash in
D1. The Worker gives that installation its own Composio user/session, proxies
MCP traffic, and returns short-lived Connect Links to the local app.

The desktop never receives the project key. Authorization links are returned
only on demand and are never persisted in chat messages.

Deployment for this repository:

1. `pnpm broker:types`
2. `pnpm exec wrangler d1 migrations apply murage-composio --remote --config cloudflare/composio-broker/wrangler.jsonc`
3. For an existing Worker, run `pnpm exec wrangler secret put COMPOSIO_API_KEY --config cloudflare/composio-broker/wrangler.jsonc`, then `pnpm broker:deploy`.
4. For the very first deploy, put `COMPOSIO_API_KEY=...` in the ignored `.dev.vars.production` file and run `pnpm exec wrangler deploy --config cloudflare/composio-broker/wrangler.jsonc --secrets-file .dev.vars.production`. Delete the file immediately afterward.

Forks should create their own D1 database and rate-limit namespaces, replace
the IDs in `wrangler.jsonc`, deploy under their own Worker name, and set
`MURAGE_COMPOSIO_BROKER_URL` in their packaged build. Running only the local
server with a Composio project key remains the no-Cloudflare self-host path.

The committed `vars` in `wrangler.jsonc` are the live state after FluxRouter
rollout step 8 (the day the 0.1.52 desktop moves to FluxRouter): registration
closed, claims open, `MIGRATION_GATE` on, a 15-minute claim grace, the 7-day
issuance fallback, the call ceiling off, and no cut-off yet
(`LEGACY_BROKER_UNTIL` and `CLAIM_UNTIL` are set at step 9). A `--var` override
lasts only for that deploy: the next plain `pnpm broker:deploy` ships the
committed values again, so commit any value you mean to keep.
`src/wrangler-config.test.ts` fails if `CLAIM_MODE` or `REGISTRATION_MODE`
drifts back.

- `REGISTRATION_MODE` `closed` stops issuing new installation tokens without
  affecting existing users; `--var REGISTRATION_MODE:open` reopens it.
- Pause claims: `--var CLAIM_MODE:closed` (add `--var MIGRATION_GATE:off` if
  they stay paused longer than 7 days).
- FluxRouter broker dark: `--var MIGRATION_GATE:off` in the same step, so every
  install with a Worker token is served again, claimed or not.

Registration is throttled per source address as Cloudflare observed it
(`cf-connecting-ip`): IPv4 exactly, IPv6 by its /64, IPv4-mapped IPv6 as
IPv4. Client-controlled headers such as User-Agent do not contribute to the
limiter key, and a missing address shares a single bucket.
`registrationActorKey` in `src/index.ts` is the only place that derives
registration identity, so an authenticated identity layer can replace it
later.
