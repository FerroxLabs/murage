// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import { healthSchema, recordHealth } from "./ops-monitor";
import { LEASE_FRESH_MS, LEASE_SKEW_MS, LEASE_TTL_MS, WIRE, machine } from "./b3-control";
import { b3Enabled } from "./b3-config";
import { signPayload } from "./b3-signatures";
import { HTTPError, json, readBoundedJSON } from "./http";
import { sha256 } from "./installations";

// Control link for CP0 machines (no cloud_homes row), same wire and credential as the B3 routes.
// Mounted only where staging opts in (CLOUD_CP0_STAGING=1). A machine that has a cloud_homes row is
// owned by the B3 routes and is never answered here.
const generation = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const leaseSchema = z.object({ generation, holder: z.string().regex(/^[\w-]{1,128}$/) }).strict();
const heartbeatSchema = z.object({ generation, health: healthSchema.optional() }).strict();
// No subscription engine is enabled by the control plane for CP0 until a gate source exists.
const GATES_CLOSED = { claudeAgent: false, codex: false, grokAgent: false, kimiAgent: false, opencodeGo: false };
interface Row { id: string; generation: number; state: string; public_origin: string; }
interface Control { generation: number; expires_at: number; heartbeat_at: number | null; }

async function body<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await readBoundedJSON(request));
  if (!parsed.success) throw new HTTPError(400, "invalid_request");
  return parsed.data;
}

async function lease(request: Request, env: Env, row: Row) {
  const input = await body(request, leaseSchema);
  if (input.holder !== row.id) throw new HTTPError(403, "forbidden");
  if (input.generation !== row.generation) throw new HTTPError(409, "stale_generation");
  if (row.state !== "active") throw new HTTPError(409, "home_inactive");
  const token = /^Bearer ([^\s]+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
  const now = Date.now();
  // Credential, generation, state and source IP are re-checked in the write itself.
  const result = await env.DB.prepare(`INSERT INTO cloud_cp0_control (machine_id,generation,expires_at,renewed_at,heartbeat_at)
    SELECT ?,?,?,?,NULL WHERE EXISTS(SELECT 1 FROM cloud_machines WHERE id=? AND generation=? AND state='active'
      AND credential_hash=? AND EXISTS(SELECT 1 FROM json_each(bound_ips) WHERE value=?))
    ON CONFLICT(machine_id) DO UPDATE SET generation=excluded.generation,expires_at=excluded.expires_at,renewed_at=excluded.renewed_at,
      heartbeat_at=CASE WHEN cloud_cp0_control.generation=excluded.generation THEN cloud_cp0_control.heartbeat_at ELSE NULL END
    WHERE cloud_cp0_control.generation<=excluded.generation
    RETURNING expires_at`)
    .bind(row.id, row.generation, now + LEASE_TTL_MS, now, row.id, row.generation, await sha256(token),
      request.headers.get("CF-Connecting-IP") ?? "").first<{ expires_at: number }>();
  if (!result) throw new HTTPError(409, "lease_conflict");
  return json({ wire: WIRE, installationId: row.id, holder: row.id, generation: row.generation,
    expiresAt: result.expires_at, renewAfterMs: LEASE_FRESH_MS, ttlMs: LEASE_TTL_MS, skewMs: LEASE_SKEW_MS });
}

async function heartbeat(request: Request, env: Env, row: Row) {
  const input = await body(request, heartbeatSchema);
  if (input.generation !== row.generation) throw new HTTPError(409, "stale_generation");
  if (row.state !== "active") throw new HTTPError(409, "home_inactive");
  const token = /^Bearer ([^\s]+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
  // As in lease(): a rotation or revoke landing while the body is read must
  // not let the old credential's heartbeat through.
  const result = await env.DB.prepare(`UPDATE cloud_cp0_control SET heartbeat_at=? WHERE machine_id=? AND generation=?
    AND EXISTS(SELECT 1 FROM cloud_machines WHERE id=? AND generation=? AND state='active'
      AND credential_hash=? AND EXISTS(SELECT 1 FROM json_each(bound_ips) WHERE value=?))`)
    .bind(Date.now(), row.id, row.generation, row.id, row.generation, await sha256(token),
      request.headers.get("CF-Connecting-IP") ?? "").run();
  if (result.meta.changes !== 1) throw new HTTPError(409, "lease_required");
  await recordHealth(env, row.id, input.health);
  return json({ wire: WIRE, accepted: true });
}

async function desired(env: Env, row: Row) {
  const control = await env.DB.prepare("SELECT generation,expires_at,heartbeat_at FROM cloud_cp0_control WHERE machine_id=?")
    .bind(row.id).first<Control>();
  const now = Date.now();
  const active = row.state === "active";
  const leaseValid = !!control && control.generation === row.generation && control.expires_at > now;
  const fresh = !!control && control.generation === row.generation && control.heartbeat_at !== null && control.heartbeat_at + LEASE_FRESH_MS > now;
  return json({ wire: WIRE, homeId: row.id, generation: row.generation,
    // Only an active machine runs; every other state is stopped and can never open the home gate.
    desiredState: active ? "ready" : "stopped", engineSubscriptionGates: GATES_CLOSED,
    lease: control ? { holder: row.id, generation: control.generation, expiresAt: control.expires_at } : null,
    executionAllowed: active && leaseValid, heartbeatFresh: fresh, heartbeatEveryMs: LEASE_FRESH_MS,
    homeKey: await signPayload(env, { type: "murage-home-key-v1", homeId: row.id, generation: row.generation,
      homeKey: `cp0:${row.id}`, publicOrigin: row.public_origin, issuedAt: now, expiresAt: now + LEASE_TTL_MS }),
  });
}

export async function cp0ControlRoute(request: Request, env: Env): Promise<Response | null> {
  if ((env as { CLOUD_CP0_STAGING?: string }).CLOUD_CP0_STAGING !== "1") return null;
  const match = /^\/v1\/machines\/([\w-]{1,128})\/(desired|heartbeat|lease)$/.exec(new URL(request.url).pathname);
  if (!match) return null;
  const [, id, operation] = match;
  // With B3 on, homes are answered by b3Route (same 401 for every unauthenticated case). With it
  // off, a home row must not change the answer, so cp0 handles every id.
  if (b3Enabled(env) && await env.DB.prepare("SELECT id FROM cloud_homes WHERE id=?").bind(id).first()) return null;
  const row = await env.DB.prepare("SELECT id,generation,state,public_origin FROM cloud_machines WHERE id=?").bind(id).first<Row>();
  if (!row) throw new HTTPError(401, "unauthorized");
  await machine(request, env, row, { allowInactive: true });
  if (request.method !== (operation === "desired" ? "GET" : "POST")) throw new HTTPError(405, "method_not_allowed");
  if (operation === "lease") return lease(request, env, row);
  if (operation === "heartbeat") return heartbeat(request, env, row);
  return desired(env, row);
}
