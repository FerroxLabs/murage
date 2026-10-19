// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import { machine } from "./b3-control";
import type { CloudflareFetch } from "./cloudflare-api";
import type { ControlPlaneConfig } from "./config";
import { getMachineEndpoint, machineIssuanceFence, provisionMachineEndpoint } from "./endpoints";
import { HTTPError, readBoundedJSON } from "./http";
import { sha256 } from "./installations";

// Managed tunnel endpoint for a cloud machine. Authenticated exactly like the
// other machine routes: the machine credential, its current generation and the
// source IP (CF-Connecting-IP) must be one of the machine's bound IPs. An
// account session or an installation credential has no way to reach this.
const generation = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const provisionSchema = z.object({ generation }).strict();

export async function machineEndpointRoute(
  request: Request,
  env: Env,
  config: ControlPlaneConfig,
  fetcher: CloudflareFetch,
  requestId: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  const match = /^\/v1\/machines\/([\w-]{1,128})\/endpoint$/.exec(url.pathname);
  if (!match) return null;
  const id = match[1] as string;
  if (request.method !== "GET" && request.method !== "POST") throw new HTTPError(405, "method_not_allowed");
  const row = await env.DB.prepare("SELECT id,generation,state FROM cloud_machines WHERE id=?")
    .bind(id).first<{ id: string; generation: number; state: string }>();
  if (!row) throw new HTTPError(401, "unauthorized");
  // Credential, then bound IP (401/403). A non-active state is answered below
  // with 409 so a fenced machine learns why, and never reaches a token.
  await machine(request, env, row, { allowInactive: true });
  if (request.method === "GET") {
    const asked = url.searchParams.get("generation");
    if (asked !== null && asked !== String(row.generation)) throw new HTTPError(409, "stale_generation");
    return getMachineEndpoint(env, id);
  }
  const parsed = provisionSchema.safeParse(await readBoundedJSON(request));
  if (!parsed.success) throw new HTTPError(400, "invalid_request");
  if (parsed.data.generation !== row.generation) throw new HTTPError(409, "stale_generation");
  if (row.state !== "active") throw new HTTPError(409, "home_inactive");
  const token = /^Bearer ([^\s]+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
  return provisionMachineEndpoint(env, config, fetcher, requestId, id,
    machineIssuanceFence(id, row.generation, await sha256(token), request.headers.get("CF-Connecting-IP") ?? ""));
}
