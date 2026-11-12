// SPDX-License-Identifier: AGPL-3.0-or-later
// KMS signing design 10.1, 11 and 12.2: a warm-pool server is never Started or Rebooted for a customer until its enrollment has been consumed.
// An unenrolled pool server's only legitimate power-on is the checked one in the claim path (finishPoolClaim, which re-verifies the image
// first); a bound, stopped home in `checking` whose image was revoked afterwards must not reach it through Start or Reboot.
//
// "Established" = the machine holds a credential (enrollment consumed) or has sent a heartbeat AFTER this claim (so a later credential rotation, which
// clears the credential, never makes a running home look unenrolled; a heartbeat from before the claim, by a once-running home re-bound to a
// server whose enrollment was never consumed, proves nothing about this server). Both are written only by the enrolled server itself.
const ESTABLISHED = `(EXISTS (SELECT 1 FROM cloud_machines m WHERE m.id=w.home_id AND m.credential_hash IS NOT NULL)
  OR EXISTS (SELECT 1 FROM cloud_homes ch WHERE ch.id=w.home_id AND ch.heartbeat_at > w.claimed_at))`;

/** True when a not-yet-destroyed warm-pool row is tied to this home generation and its enrollment was never consumed. Customer routes use this. */
export async function homeOnUnenrolledPoolServer(db: D1Database, homeId: string, resourceGeneration: number): Promise<boolean> {
  const r = await db.prepare(`SELECT 1 AS x FROM warm_pool w WHERE w.home_id=? AND w.resource_generation=? AND w.destroyed_at IS NULL AND NOT ${ESTABLISHED}`)
    .bind(homeId, resourceGeneration).first();
  return r !== null;
}

/** True when this provider server is a not-yet-destroyed pool server whose enrollment was never consumed (an unclaimed one included). The provider's
 *  power methods use this. */
export async function isUnenrolledPoolServer(db: D1Database, provider: string, serverId: string): Promise<boolean> {
  const r = await db.prepare(`SELECT 1 AS x FROM warm_pool w WHERE w.provider=? AND w.server_id=? AND w.destroyed_at IS NULL AND NOT ${ESTABLISHED}`)
    .bind(provider, serverId).first();
  return r !== null;
}
