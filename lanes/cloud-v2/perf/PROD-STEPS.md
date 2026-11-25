# Production D1 latency: steps (need Sean's go; do before launch, while prod is empty)

Why: a D1 primary far from the Worker costs one ocean round trip per query (staging: primary in APAC/SIN, Worker at
EWR, 260 ms per query, 15 sequential queries = 3.9 s). Moving the primary to ENAM took the same 15 queries to
p50 140 ms / p95 191 ms from a New Jersey host (staging, 2026-10-10). Read replication alone left 12% of requests on
the SIN primary (3.9 s each), so it does not meet p95 < 500 ms by itself.

Status: not checked. No credential for the production account (b83123326a4b9ad76831b9cb9365b33b) exists on this Mac, so the
current location of `murage-control-plane` (5b7763a9-6674-451e-a5ba-4ba49ab30014) and its row counts are unknown.
Step 0 below finds out. Use a token scoped to that account; never print it.

0. Read-only check: `GET /accounts/<prod>/d1/database/<id>` -> `running_in_region`; row counts per table with
   `SELECT count(*)` (counts only). If it is already ENAM, stop; only steps 4-5 apply.
1. Create: `POST /accounts/<prod>/d1/database` `{"name":"murage-control-plane-enam","primary_location_hint":"enam"}`.
   The location cannot be changed later, only set at creation.
2. Schema and data: with prod empty, `wrangler d1 migrations apply murage-control-plane-enam --remote` (all of
   `cloudflare/control-plane/migrations`). If prod holds rows: `wrangler d1 export <old> --remote --output dump.sql`, then
   `wrangler d1 execute <new> --remote --file dump.sql`, and compare per-table counts (staging copy matched on all 75 tables).
3. Binding: in `cloudflare/control-plane/wrangler.jsonc` (top level, not `env.staging`) set `database_name` and `database_id` to the
   new database; deploy. Keep ALLOWED_ORIGINS and secrets as they are. Keep the old database until verified.
4. Replication: `PATCH /accounts/<prod>/d1/database/<new>` `{"read_replication":{"mode":"auto"}}`. The Worker code already
   reads `GET /v1/account/cloud` and `GET /v1/homes` through the Sessions API (see src/d1-session.ts).
5. Verify from a US host: Server-Timing header shows d1 time and query count; target p95 < 500 ms.
6. After a week of clean running, delete the old database (Sean).

Code needed in prod: branch cloud-v2/perf (sessions + Server-Timing + parallel summary + batched homes).
