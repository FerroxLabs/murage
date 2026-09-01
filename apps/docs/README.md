# Murage documentation

The public documentation site is a Next.js 16 + Fumadocs app. User-facing content lives in `content/docs`; the repository's top-level `docs` folder remains available for implementation notes and detailed platform records.

## Develop

From the repository root:

```bash
pnpm install
pnpm docs:dev
```

The site opens at `http://localhost:3000`.

## Verify

```bash
pnpm docs:build
pnpm --filter @murage/docs types:check
pnpm --filter @murage/docs lint
```

The changelog reads published releases from `FerroxLabs/murage-releases` and
caches the result for five minutes. If GitHub is temporarily unavailable, the
page links straight to the releases instead of failing the build.

## Deploy to Vercel

This deploys only the public documentation. It does not deploy the Electron app,
local harness, credentials, agents, or user data. The changelog page uses Next.js
incremental regeneration so published releases appear without a source commit.

Create a second Vercel project beside the existing `murage.com` project:

1. Import the `FerroxLabs/murage` repository.
2. Set **Root Directory** to `apps/docs`.
3. Keep the detected **Next.js** framework settings.
4. Set the production branch to `main` and deploy.
5. Add `docs.murage.ai` under **Settings → Domains**.

Vercel will build the Next.js docs app, publish every push to `main`, and create
preview URLs for documentation pull requests. Keep `murage.com` on the existing
marketing project and add a Docs link there after the new domain is live.
