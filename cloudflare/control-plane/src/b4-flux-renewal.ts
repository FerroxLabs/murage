// SPDX-License-Identifier: AGPL-3.0-or-later
// B4: tells the root poller when this home's Flux sub-key is due for machine renewal.
// Kept free of other imports so b3-control can use it without a cycle with b4-flux.

export const RENEWAL_WINDOW_MS = 7 * 86_400_000;
/** The last minutes of a live key outrank the ack bound (Astra FIRSTKEY-2 P1): two lost answers near expiry must not hold renewal past the expiry.
 *  At most one mint a poll for these 15 minutes; once the key has expired the bound applies again. */
const EXPIRY_OVERRIDE_MS = 15 * 60_000;
export function renewalHeldBack(retryAt: number | null, keyExpiresAt: number | null, now: number): boolean {
  if (retryAt === null || retryAt <= now) return false;
  return !(keyExpiresAt !== null && keyExpiresAt > now && keyExpiresAt - now <= EXPIRY_OVERRIDE_MS);
}

/** What the renewal cue reads, in ONE statement (it runs on every machine desired poll): the home's Flux row (all null when it has none), whether
 *  the home is a paid, live, owned home (the only kind that may take a FIRST key), and when its first-key retry bound next allows an attempt.
 *  Paid and live = the home's entitlement is paid, it is ready or in its canary check (a warm-pool server is no cloud_homes row until claimed;
 *  a deleted, deleting, suspended, refunded or unpaid home is never in these states), it has an owner, and its subscription is active or
 *  trialing. homeOwnerOf answers non-null for exactly these homes, so the mint's ownerOf can never 404 for a cued home. */
export interface RenewalRead {
  state: string | null; billing_hold: number | null; key_expires_at: number | null; generation: number | null; spending_off: number | null;
  paid: number | null; retry_at: number | null; gen_floor: number | null; acked_generation: number | null;
}
/** The paid-and-live test as one scalar subquery over the home id placeholder `p`: the cue reads it, and the first mint's reservation and
 *  commit re-run it in their own guarded statements, so a subscription that went past due during the mint can never take the first key. */
export const paidLiveSql = (p: string): string => `(SELECT 1 FROM cloud_homes h JOIN billing_subscriptions b ON b.home_id = h.id
        WHERE h.id = ${p} AND h.owner_id <> '' AND h.entitlement = 'paid' AND h.desired_state IN ('ready','checking')
          AND b.subscription_id IS NOT NULL AND b.status IN ('active','trialing'))`;
export const readRenewalState = (env: Pick<Env, "DB">, homeId: string): Promise<RenewalRead | null> =>
  env.DB.prepare(`SELECT k.state, k.billing_hold, k.key_expires_at, k.generation, k.spending_off, k.gen_floor, k.acked_generation,
      ${paidLiveSql("?1")} AS paid,
      (SELECT r.next_at FROM flux_first_key_retry r WHERE r.home_id = ?1) AS retry_at
    FROM (SELECT ?1 AS id) x LEFT JOIN flux_home_keys k ON k.home_id = x.id`).bind(homeId).first<RenewalRead>();

/** A home that has NEVER had a key: no Flux row, or state none at generation 0 (a failed first mint leaves exactly this; nothing else
 *  produces state none, and a Stop, a billing stop or an unlink moves it to stopping or stopped). */
export const neverKeyed = (r: RenewalRead): boolean => r.state === null || (r.state === "none" && r.generation === 0);

/** The first-key cue: a never-keyed, paid, live, owned home that is not under a billing hold, not spending off, and past its retry bound. */
export const firstKeyDue = (r: RenewalRead, now: number): boolean =>
  neverKeyed(r) && r.paid === 1 && r.billing_hold !== 1 && r.spending_off !== 1 && (r.retry_at === null || r.retry_at <= now);

/** The bound table serves two waits, both cleared by the ack: a failed first key, and a machine mint (first or renewal) whose key was not acked.
 *  The first-key retry bound: the wait after the nth consecutive failure is 60 s, 2, 4, 8 min, then 10 min (the grant sweep's own interval). */
export const FIRST_KEY_RETRY_MAX_MS = 600_000;
export const firstKeyRetryDelayMs = (failures: number): number => Math.min(FIRST_KEY_RETRY_MAX_MS, 60_000 * 2 ** Math.max(0, failures - 1));

/** True for an active, un-held, un-stopped home whose key is missing, expired or within the renewal window, and for a home that has never
 *  had a key and is paid and live (firstKeyDue). Never true for an owner Stop or a billing hold: renewal must not undo either (the mint
 *  path enforces the same rules again). */
export async function fluxRenewalDue(env: Pick<Env, "DB">, homeId: string, now: number): Promise<boolean> {
  const row = await readRenewalState(env, homeId);
  return row !== null && renewalDueOf(row, now);
}

function renewalDueOf(row: RenewalRead, now: number): boolean {
  if (neverKeyed(row)) return firstKeyDue(row, now);
  if (row.state !== "active" || row.billing_hold === 1) return false;
  if (renewalHeldBack(row.retry_at, row.key_expires_at, now)) return false; // a minted key still waiting for its ack: the same bound as the first key
  return row.key_expires_at === null || row.key_expires_at - now <= RENEWAL_WINDOW_MS || unadopted(row) || unacknowledged(row);
}

/** 8b (2.11): an attempt was dispatched and never adopted (gen_floor above the generation the home holds). The home may hold no live key, so
 *  the cue stays true outside the window too, bounded by the same retry table (a failed attempt is counted there). */
export const unadopted = (row: Pick<RenewalRead, "gen_floor" | "generation">): boolean => (row.gen_floor ?? 0) > (row.generation ?? 0);

/** 8b fix r1 (Astra H1): the adopted generation was never acked by the home (its response or its ack was lost). A delayed ack of an OLDER
 *  generation can move key_expires_at past the window after the replacement's claim, and the commit then makes the attempt adopted; the home
 *  may hold no live key, so the cue stays true outside the window too, bounded by the same retry table (the commit counted that attempt). */
export const unacknowledged = (row: Pick<RenewalRead, "generation" | "acked_generation">): boolean =>
  (row.generation ?? 0) > 0 && row.acked_generation !== row.generation;

/** The operation identity of the renewal attempt the control plane will accept next for this home. */
export function renewalOpId(homeId: string, machineGeneration: number, keyGeneration: number): string {
  return `renew:${homeId}:${machineGeneration}:${keyGeneration}`;
}

/** Answer to the poller's "is renewal due?" question: the op_id it must send with the mint and the ack. */
export async function fluxRenewalStatus(
  env: Pick<Env, "DB">, homeId: string, machineGeneration: number, now: number,
): Promise<{ due: false } | { due: true; op_id: string }> {
  const row = await readRenewalState(env, homeId);
  if (row === null || !renewalDueOf(row, now)) return { due: false };
  return { due: true, op_id: renewalOpId(homeId, machineGeneration, row.generation ?? 0) };
}
