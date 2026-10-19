// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ControlPlaneAuth } from "./auth";
import { accountSession } from "./auth";
import { HTTPError, json } from "./http";

// GET /v1/homes: the signed-in OWNER's Cloud homes (a Cloud route: the members-area Supabase identity only; customer-identity.ts).
// Owner session only: an installation token or anyone else's session sees nothing of another account's homes.
// Public origin comes from the stored endpoint hostname, the same source pairing uses.
export const HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const NAME = "Cloud home";

export interface HomesDependencies {
  /** The signed-in account id, or null. Default: accountSession (the Supabase identity on this Cloud route). */
  currentAccountId?: (request: Request, auth: ControlPlaneAuth) => Promise<string | null>;
}

interface Row { id: string; status: string; hostname: string | null; door?: string | null }

export async function homesRoute(request: Request, env: Env, auth: ControlPlaneAuth, dependencies: HomesDependencies = {}): Promise<Response | null> {
  if (new URL(request.url).pathname !== "/v1/homes") return null;
  if (request.method !== "GET") throw new HTTPError(405, "method_not_allowed");
  const accountId = await (dependencies.currentAccountId ?? (async (req, a) => (await accountSession(req, a))?.user.id ?? null))(request, auth);
  if (!accountId) throw new HTTPError(401, "unauthorized");
  const endpoint = "LEFT JOIN machine_endpoints e ON e.machine_id=h.id AND e.status NOT IN ('deleting','deleted')";
  // Both reads are independent: one D1 round trip for the pair (staging only has the second one).
  const homesQuery = env.DB.prepare(`SELECT h.id AS id, h.observed_state AS status, e.hostname AS hostname, h.door_version AS door
    FROM cloud_homes h ${endpoint} WHERE h.owner_id=? AND h.desired_state<>'deleted' ORDER BY h.created_at, h.id`).bind(accountId);
  // Staging test machines have no cloud_homes row; their owner is assigned by the admin route (same rule as pairing).
  const staging = (env as { CLOUD_CP0_STAGING?: string }).CLOUD_CP0_STAGING === "1";
  const batch = await env.DB.batch<Row>(staging ? [homesQuery, env.DB.prepare(`SELECT m.id AS id, m.state AS status, e.hostname AS hostname
      FROM machine_owners o JOIN cloud_machines m ON m.id=o.machine_id
      LEFT JOIN machine_endpoints e ON e.machine_id=m.id AND e.status NOT IN ('deleting','deleted')
      WHERE o.owner_user_id=? AND m.id NOT IN (SELECT id FROM cloud_homes) ORDER BY m.created_at, m.id`).bind(accountId)] : [homesQuery]);
  const rows = batch.flatMap((result) => result.results);
  return json({
    homes: rows.map((row) => ({
      id: row.id, name: NAME, status: row.status,
      publicOrigin: row.hostname && HOSTNAME.test(row.hostname) ? `https://${row.hostname}` : null,
      // Door v2 (CLOUD-DOOR-V2-DESIGN.md 4B): "v2" while the home's heartbeats advertise it; the site branches on it.
      door: row.door === "v2" ? "v2" : "v1",
    })),
  });
}
