// SPDX-License-Identifier: AGPL-3.0-or-later
// Who a home's Flux credits belong to: the home's owner, and the Flux account that owner's link names. ONE lookup, shared by the B4 keys
// client (b4-flux.ts mints a home's key for exactly this account) and the WP5-P4 grants client (flux-grants.ts freezes exactly this account
// as a grant's recipient), so the two can never disagree. A LEAF module: no imports, so the stub-era cutover CLI loads it under Node's type
// stripping.
//
// OWNER ID (wiring step 3, ruling A of ASTRA-WP5-P4-CP-2): every owner here is the MAPPED Cloud account id
// (supabase_identities.user_id = cloud_homes.owner_id). The owner routes resolve it from the bound Supabase member (b4-flux.ts
// defaultAccount), so flux_link_challenges.owner_user_id, flux_links.owner_user_id and flux_link_floor.owner_user_id hold that id.
// One-off, STAGING ONLY: before step 3 the link flow wrote the Better Auth companion id, but only while CLOUD_FLUX_ROUTES_ENABLED
// was "1", which no deployed environment ever set, so none should exist. Check before turning the switch on:
//   SELECT owner_user_id FROM flux_links WHERE owner_user_id NOT IN (SELECT user_id FROM supabase_identities);
// (same for flux_link_challenges and flux_link_floor). Any row found is a companion-id link; delete it from those three tables
// (the owner links again through the members area). Such a row is unreachable from homeOwnerOf (below) only because the CP0
// staging fallback accepts a machine_owners owner that is a mapped Cloud account (a supabase_identities.user_id); before that
// check (Astra FLUX-STEP3 #2) a companion-owned machine_owners row could route a grant to a leftover companion link.

/** The owner of a live home: the MAPPED Cloud account id (supabase_identities.user_id) or null. On the CP0 staging rig only, a
 *  home that is not a live cloud home falls back to its machine_owners assignment, and only when that owner IS a mapped Cloud
 *  account: a Better Auth companion id there is no owner (Astra FLUX-STEP3 #2), so no key and no grant ever resolve to a
 *  leftover companion link. ONE query whatever the configuration and whatever exists (Astra FLUX-STEP3 #3): an unknown home
 *  and somebody else's cost the same round trips, so a count (Server-Timing) cannot tell them apart. */
export async function homeOwnerOf(env: Env, homeId: string): Promise<string | null> {
  const staging = (env as { CLOUD_CP0_STAGING?: string }).CLOUD_CP0_STAGING === "1" ? 1 : 0;
  const row = await env.DB.prepare(`SELECT
      (SELECT owner_id FROM cloud_homes WHERE id=? AND desired_state<>'deleted') AS home_owner,
      (SELECT m.owner_user_id FROM machine_owners m JOIN supabase_identities s ON s.user_id=m.owner_user_id
        WHERE m.machine_id=? AND ?=1) AS staged_owner`)
    // Plain ? only: the cutover CLI's D1 adapter (scripts/flux-grants-cutover.mjs) inlines them in order.
    .bind(homeId, homeId, staging).first<{ home_owner: string | null; staged_owner: string | null }>();
  return row?.home_owner ?? row?.staged_owner ?? null;
}

export interface LinkRow { flux_account_id: string; link_id: string; link_version: number; fenced: number }

export async function linkRowOf(env: Env, ownerId: string): Promise<LinkRow | null> {
  return env.DB.prepare("SELECT flux_account_id,link_id,link_version,fenced FROM flux_links WHERE owner_user_id=?")
    .bind(ownerId).first<LinkRow>();
}

/** The Flux account of a link that is in force: a fenced (being unlinked) link counts as no link. */
export async function linkOf(env: Env, ownerId: string): Promise<string | null> {
  const row = await linkRowOf(env, ownerId);
  return row && row.fenced === 0 ? row.flux_account_id : null;
}

/** The Flux account a home's credits go to (the account its key is minted for), or null: no live home, no owner, or no unfenced link. */
export async function fluxRecipientOf(env: Env, homeId: string): Promise<string | null> {
  const owner = await homeOwnerOf(env, homeId);
  return owner === null ? null : linkOf(env, owner);
}

/** Lane H1, item 1: the owner's verified sign-in email (supabase_identities.contact_email: written only from a Supabase token whose
 *  app_metadata says the email is verified). Read only to ensure the owner's Flux account; never logged. */
export async function ownerEmailOf(env: Env, ownerId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT contact_email FROM supabase_identities WHERE user_id=?").bind(ownerId).first<{ contact_email: string | null }>();
  const email = row?.contact_email?.trim() ?? "";
  return email ? email : null;
}

/** Lane H1, item 1: AUTO-LINK. Before the first subkey mint and the first grant of an owner that has NO flux_links row, the owner's Flux
 *  account is ensured (`ensure`: FluxMain's ensure-account, idempotent on the Murage account id) and the link row written here (link_id = the
 *  Flux account id, link_version = 1), so the keys client and the grants client keep resolving the same account through this one lookup.
 *  Never for an owner who already has a row (linked, or fenced while unlinking) or who unlinked before (flux_link_floor: an explicit unlink is
 *  never undone automatically), nor without a verified email. A Flux account already linked to ANOTHER owner is never taken over (the unique
 *  index leaves the insert out). Returns the owner's link row as it stands afterwards. `ensure` errors propagate to the caller. */
export async function ensureOwnerLinked(env: Env, ownerId: string,
  ensure: (a: { murageAccountId: string; email: string }) => Promise<{ fluxAccountId: string }>): Promise<LinkRow | null> {
  const row = await linkRowOf(env, ownerId);
  if (row) return row;
  if (await env.DB.prepare("SELECT 1 AS x FROM flux_link_floor WHERE owner_user_id=?").bind(ownerId).first()) return null;
  const email = await ownerEmailOf(env, ownerId);
  if (email === null) return null;
  const { fluxAccountId } = await ensure({ murageAccountId: ownerId, email });
  await env.DB.prepare(`INSERT OR IGNORE INTO flux_links (owner_user_id,flux_account_id,linked_at,link_id,link_version,fenced)
    SELECT ?,?,?,?,1,0 WHERE NOT EXISTS (SELECT 1 FROM flux_links WHERE owner_user_id=?) AND NOT EXISTS (SELECT 1 FROM flux_link_floor WHERE owner_user_id=?)`)
    .bind(ownerId, fluxAccountId, Date.now(), fluxAccountId, ownerId, ownerId).run();
  return linkRowOf(env, ownerId);
}
