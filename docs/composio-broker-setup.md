# Composio broker — Ferrox Labs cutover

The broker is a Cloudflare Worker holding **one** Composio API key. Every
Murage install registers against it and proxies its Composio MCP traffic
through it, so end users never need a Composio account.

Until this is done, `DEFAULT_COMPOSIO_BROKER_URL` points at a worker that
is not ours. **Do not ship a build before completing step 6.**

---

## 0. Prerequisites

```bash
npm i -g wrangler
wrangler login          # authenticate to the Ferrox Labs Cloudflare account
wrangler whoami         # confirm the right account is active
```

You also need a Composio account: https://app.composio.dev

---

## 1. Get the Composio API key

1. https://app.composio.dev → **Settings → API Keys**
2. Create a key. It looks like `ak_...`
3. Keep it on the clipboard — it goes in as a *secret*, never into a file.

> One key serves every Murage install. Its quota is your bill.

### API key scopes

Derived from the endpoints the broker actually calls. **One key serves every
install**, so the blast radius of a leak is every user's connected accounts.
Grant the minimum.

| Scope | Read | Write | Why |
|---|:---:|:---:|---|
| Tools | YES | - | tool definitions |
| Session management | YES | YES | `POST /tool_router/session` per install |
| Session tool execution | - | YES | proxying MCP calls (the core function) |
| Connected accounts | YES | YES | list, `/link`, `DELETE ?revoke_on_delete=true` |
| Auth configs | YES | NO | only `GET /auth_configs` |
| Toolkits | YES | NO | catalog read; no install call exists |
| Observability | YES | - | usage summaries, for cost tracking |

Leave OFF entirely: **Triggers**, **Webhooks**, **Tool execution (Legacy)**,
**Proxy execute (Legacy)**, **MCP (Legacy)**. Never click "Write All" —
auth-config write would let a key holder rewrite the OAuth configuration.


---

## 2. Create the D1 database

The committed `database_id` belongs to upstream. Make our own:

```bash
cd cloudflare/composio-broker
wrangler d1 create murage-composio
```

Copy the `database_id` it prints, then edit **`wrangler.jsonc`**:

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "murage-composio",
    "database_id": "<PASTE-NEW-ID-HERE>",   // was 435bcde1-… (upstream's)
    "migrations_dir": "migrations"
  }
]
```

Apply the schema:

```bash
wrangler d1 migrations apply murage-composio --remote
```

Creates the `installations` table (one row per install: id, token hash,
composio_user_id, session_id, timestamps).

---

## 3. Rate limiters

`namespace_id` values are arbitrary integers scoped to *your* Cloudflare
account, so the committed `8261701` / `8261702` are safe to keep — they'll
just be yours now. No action needed unless you want tighter limits:

```jsonc
{ "name": "REGISTRATION_LIMITER", "namespace_id": "8261701", "simple": { "limit": 30,  "period": 60 } },
{ "name": "SESSION_LIMITER",      "namespace_id": "8261702", "simple": { "limit": 120, "period": 60 } }
```

---

## 4. Set the secret

```bash
wrangler secret put COMPOSIO_API_KEY
# paste the ak_… key at the prompt
```

Never put this in `wrangler.jsonc` or `.env` — secrets live only in
Cloudflare.

---

## 5. Deploy

```bash
wrangler deploy
```

Note the URL it prints, e.g. `https://murage-composio.<your-subdomain>.workers.dev`

Verify:

```bash
curl -s https://murage-composio.<your-subdomain>.workers.dev/health
# {"service":"murage-composio","ready":true}
```

`ready: false` means the secret didn't land — redo step 4.

---

## 6. Point the app at your broker

Edit **`electron/main.mjs`** (~line 88):

```js
const DEFAULT_COMPOSIO_BROKER_URL = "https://murage-composio.<your-subdomain>.workers.dev";
```

Per-machine override, for dev:

```bash
export MURAGE_COMPOSIO_BROKER_URL="https://…workers.dev"
```

---

## 7. End-to-end check

```bash
BROKER=https://murage-composio.<your-subdomain>.workers.dev

# register a throwaway install — returns an installation token
curl -s -X POST $BROKER/v1/installations

# use the returned token
curl -s $BROKER/v1/me       -H "Authorization: Bearer <token>"
curl -s $BROKER/v1/catalog  -H "Authorization: Bearer <token>" | head -c 300
```

`/v1/me` returning an `installationId` means the chain works.

---

## 8. COST GUARDRAIL — read before going public

`REGISTRATION_MODE: "open"` lets **any** install register and spend your
quota. Composio's post-2026-08-15 pricing charges **$4 per 1,000 tool
calls** over plan — roughly 14x the old rate, and we are not grandfathered.

| Plan | Included | Cost |
|------|----------|------|
| Free | 100K calls/mo | $0 |
| Pro  | 200K calls/mo | $29 |
| Scale| 2M calls/mo | $229 |
| Over | — | **$4 / 1,000** |

Cloudflare adds ~$5/mo. Private beta lands at **$5–35/mo**; ~1,000 active
users is roughly **$1,200/mo**.

Close registration any time without redeploying code:

```bash
wrangler deploy --var REGISTRATION_MODE:closed
```

Registration then returns `503 registration is temporarily closed`.
Existing installs keep working — only new ones are refused.

**Before public launch:** gate registration behind a licence check and add
a per-install call ceiling. The `installations` table is the right place to
hang the counter.

---

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | liveness + whether the key is present |
| POST | `/v1/installations` | register, returns install token |
| GET | `/v1/me` | echo installation id |
| POST | `/v1/mcp` | proxy MCP traffic to Composio |
| GET | `/v1/catalog` | available toolkits |
| GET | `/v1/connectors` | connection status |
| GET | `/v1/connectors/connected` | connected services |
| GET | `/v1/connectors/:toolkit/authorize` | OAuth link |
| DELETE | `/v1/connectors/:toolkit/accounts/:id` | disconnect |

All `/v1/*` except registration require `Authorization: Bearer <token>`.
