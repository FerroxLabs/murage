# OpenMausBot control plane

This directory is an isolated Cloudflare Worker for cloud account identity and
installation ownership. It does **not** store or move local bots, chats, SQLite
state, prompts, tool output, or tunnel configuration.

## What is included

- Better Auth 1.7.1 with email OTP, signed bearer sessions, hashed OTP storage,
  and D1-backed IP plus recipient rate limits.
- A Cloudflare Email Sending binding that produces both HTML and plain-text OTP
  messages. Authentication responses remain generic even when delivery fails;
  email addresses, OTPs, secrets, and provider errors are never logged.
- Owner-scoped desktop installations and independently revocable
  `omb_install_…` credentials. Account bearer tokens are never accepted as
  installation credentials, or vice versa.
- Exact-origin CORS, bounded JSON bodies, redacted errors, and `no-store` on
  every response.

The D1 schema is pinned in `migrations/`. `0001_better_auth_1_7_1.sql` was
generated from the exact Better Auth configuration. `0002_installations.sql`
contains only cloud ownership and credential metadata. `0003` adds a
recipient-scoped OTP limiter whose keys are HMACs rather than email addresses,
plus an authenticated installation-creation limiter.

## API surface

| Method | Path | Authentication |
| --- | --- | --- |
| `GET` | `/healthz` | none |
| any | `/api/auth/*` | Better Auth |
| `GET` | `/v1/me` | account bearer |
| `GET`, `POST` | `/v1/installations` | account bearer |
| `POST` | `/v1/installations/:id/credentials/rotate` | owning account bearer |
| `DELETE` | `/v1/installations/:id` | owning account bearer |
| `GET` | `/v1/installations/self` | installation credential |

Installation registration requires a stable `clientInstanceId`, a display
`name`, and a `platform` of `darwin`, `windows`, or `linux`; `appVersion` is
optional. A client ID is unique among one account's active installations. After
revocation, that account may register the stable ID again. Other accounts may
independently use the same client ID. An account may have at most 100 active
installations, matching the complete management-list limit. Creation is also
limited to 100 attempts per account per hour.

Raw installation credentials contain a random lookup ID plus 32 random bytes.
Only a SHA-256 digest is stored, and the raw value is returned only when an
installation is created or its credential is rotated. Credentials expire after
90 days even if they are not revoked; the response includes their expiry so a
signed-in desktop can rotate ahead of time. `/v1/installations/self` rejects
expired credentials and records both credential use and installation
`lastSeenAt`. Rotations are serialized with a one-minute cooldown, so concurrent
requests cannot both return credentials while one invalidates the other.

## Local checks

Install from the repository root, then run:

```sh
pnpm control-plane:check
pnpm control-plane:test
pnpm control-plane:dry-run
```

For local manual development, copy `.dev.vars.example` to `.dev.vars`, replace
`BETTER_AUTH_SECRET` with at least 32 cryptographically random bytes, apply the
migrations locally, and start Wrangler:

```sh
pnpm --filter @openmausbot/control-plane exec wrangler d1 migrations apply DB --local --config wrangler.jsonc
pnpm --filter @openmausbot/control-plane exec wrangler dev --config wrangler.jsonc
```

Do not commit `.dev.vars`.

## Production blockers

The checked-in Wrangler file is intentionally non-deployable production
scaffolding. No remote resource was created or changed while preparing it.
Before a production deployment, an operator must:

1. Choose and route an HTTPS hostname, then replace `BETTER_AUTH_URL`. The
   Worker has `workers_dev` disabled and no production route in this PR.
2. Generate a strong production `BETTER_AUTH_SECRET` and add it with Wrangler's
   interactive secret command. The `secrets.required` declaration validates the
   binding name and generates its type; it does not contain or upload a value.
3. Create the D1 database, replace the all-zero `database_id`, review the pinned
   migrations, and apply them to that database.
4. Complete Cloudflare Email Sending domain onboarding, replace the placeholder
   sender in both `EMAIL_FROM` and `allowed_sender_addresses`, and grant the
   deployment identity access to the binding. The Cloudflare session used while
   preparing this code could not list Email Sending (`2036 Unauthorized`), so no
   domain or binding activation was attempted.
5. Replace `ALLOWED_ORIGINS` with a comma-separated allow-list of exact HTTPS
   application origins. Wildcards are deliberately unsupported.

This foundation does not provision a Cloudflare Tunnel and does not collect
marketing consent. Those are separate, explicitly scoped changes.
