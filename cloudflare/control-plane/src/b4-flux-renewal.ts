// SPDX-License-Identifier: AGPL-3.0-or-later
// B4: tells the root poller when this home's Flux sub-key is due for machine renewal.
// Kept free of other imports so b3-control can use it without a cycle with b4-flux.

export const RENEWAL_WINDOW_MS = 7 * 86_400_000;

/** True only for an active, un-held, un-stopped home whose key is missing, expired or
 *  within the renewal window. Never true for an owner Stop or a billing hold: renewal
 *  must not undo either (the mint path enforces the same rules again). */
export async function fluxRenewalDue(env: Pick<Env, "DB">, homeId: string, now: number): Promise<boolean> {
  const row = await env.DB.prepare("SELECT state, billing_hold, key_expires_at FROM flux_home_keys WHERE home_id=?")
    .bind(homeId)
    .first<{ state: string; billing_hold: number; key_expires_at: number | null }>();
  if (!row || row.state !== "active" || row.billing_hold === 1) return false;
  return row.key_expires_at === null || row.key_expires_at - now <= RENEWAL_WINDOW_MS;
}

/** The operation identity of the renewal attempt the control plane will accept next for this home. */
export function renewalOpId(homeId: string, machineGeneration: number, keyGeneration: number): string {
  return `renew:${homeId}:${machineGeneration}:${keyGeneration}`;
}

/** Answer to the poller's "is renewal due?" question: the op_id it must send with the mint and the ack. */
export async function fluxRenewalStatus(
  env: Pick<Env, "DB">, homeId: string, machineGeneration: number, now: number,
): Promise<{ due: false } | { due: true; op_id: string }> {
  if (!(await fluxRenewalDue(env, homeId, now))) return { due: false };
  const row = await env.DB.prepare("SELECT generation FROM flux_home_keys WHERE home_id=?").bind(homeId).first<{ generation: number }>();
  if (!row) return { due: false };
  return { due: true, op_id: renewalOpId(homeId, machineGeneration, row.generation) };
}
