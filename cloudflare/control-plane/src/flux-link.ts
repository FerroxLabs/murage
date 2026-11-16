// SPDX-License-Identifier: AGPL-3.0-or-later
// Who a home's Flux credits belong to: the home's owner, and the Flux account that owner's link names. ONE lookup, shared by the B4 keys
// client (b4-flux.ts mints a home's key for exactly this account) and the WP5-P4 grants client (flux-grants.ts freezes exactly this account
// as a grant's recipient), so the two can never disagree. A LEAF module: no imports, so the stub-era cutover CLI loads it under Node's type
// stripping.
//
// OWNER ID (wiring step 3, ruling A of ASTRA-WP5-P4-CP-2): every owner here is the MAPPED Cloud account id
// (supabase_identities.user_id = cloud_homes.owner_id). The owner routes resolve it from the bound Supabase member (b4-flux.ts
// defaultAccount), so flux_link_challenges.owner_user_id, flux_links.owner_user_id and flux_link_floor.owner_user_id hold that id.
// One-off, STAGING ONLY: before step 3 the link flow wrote the Better Auth companion id, but only while the Flux route switch
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
 *  Never for an owner who already has a row (linked, or fenced while unlinking), nor without a verified email. An owner who unlinked before
 *  (flux_link_floor) is linked again the same way, with a link_version ABOVE the floor (floor + 1), so the next mint or grant just works. A Flux account already linked to ANOTHER owner is never taken over (the unique
 *  index leaves the insert out). Returns the owner's link row as it stands afterwards. `ensure` errors propagate to the caller (nothing is written, no email).
 *  The first link ever also queues the one Flux welcome email (flux_welcome_mail, keyed by owner, never deleted). */
/** FLUX-ENSURE-EMAIL-VERIFIED (design-ev3 section 3): the address ensure-account sends (trimmed, lower-cased: Flux looks up lower(trim(email))
 *  exactly) and whether THAT address is proven, read in ONE query: true only when email_verified_at is set and email_verified_for equals exactly
 *  the address sent. The only writer of the stamp is the challenge consume (flux-email-proof.ts); never a token claim. */
export async function ownerEmailProofOf(env: Env, ownerId: string): Promise<{ email: string; emailVerified: boolean } | null> {
  const row = await env.DB.prepare("SELECT contact_email,email_verified_at,email_verified_for FROM supabase_identities WHERE user_id=?").bind(ownerId)
    .first<{ contact_email: string | null; email_verified_at: number | null; email_verified_for: string | null }>();
  const email = row?.contact_email?.trim().toLowerCase() ?? "";
  if (!email) return null;
  return { email, emailVerified: row!.email_verified_at !== null && row!.email_verified_for === email };
}

/** A link that could not be written because the state ensure-account was asked on moved while it was in flight (an address change, A -> B -> A
 *  included; a cleared or new proof; an open dispute). Nothing is linked; the next sweep asks again on the current state. Not a failure. */
export const STALE = "stale" as const;
/** ITEM4-PROOF-CURRENT (P-call): the owner's stored address is not proven at its current revision, so Flux was NOT called (no fetch at all).
 *  A local outcome: no 202, no Flux-side hold, no failure, no alert. ensureOwnerAccount maps it to "email_unverified". */
export const UNPROVEN = "unproven" as const;

/** ITEM4-PROOF-CURRENT (P-link): flux_links has exactly two fenced writers (ensureOwnerLinked below, b4-flux.ts linkComplete). THE fence both
 *  INSERTs carry, as one SQL
 *  fragment over the owner id `o`, the address `addr` and the revision `rev` (placeholders of the caller's statement): no link exists, no
 *  dispute is open, and the owner's identity is at that address and revision with a TRUE stamp for exactly that address. test/flux-email-proof
 *  asserts both INSERT sites carry it. */
export const linkFenceSql = (o: string, addr: string, rev: string) => `NOT EXISTS (SELECT 1 FROM flux_links WHERE owner_user_id=${o})
      AND NOT EXISTS (SELECT 1 FROM flux_email_proof_disputes WHERE account_id=${o})
      AND EXISTS (SELECT 1 FROM supabase_identities s WHERE s.user_id=${o} AND lower(trim(s.contact_email))=${addr} AND s.email_revision=${rev}
        AND s.email_verified_at IS NOT NULL AND s.email_verified_for=${addr})`;

/** The alerts a link resolves (alert lifecycle, design-pc2): the wake that ran out of tries and Flux's 202 to a TRUE call. Keyed on the link
 *  row, not on changes(), so it is idempotent. ?1 owner, ?2 now. */
export const LINK_RESOLVES_SQL = `UPDATE cloud_alerts SET resolved_at=?2 WHERE subject='account:'||?1 AND resolved_at IS NULL
    AND kind IN ('flux.email_wake_exhausted','flux.ensure_verified_refused') AND EXISTS (SELECT 1 FROM flux_links WHERE owner_user_id=?1)`;

export async function ensureOwnerLinked(env: Env, ownerId: string,
  ensure: (a: { murageAccountId: string; email: string; emailVerified: boolean }) => Promise<{ fluxAccountId: string; created?: boolean }>): Promise<LinkRow | typeof STALE | typeof UNPROVEN | null> {
  const row = await linkRowOf(env, ownerId);
  if (row) return row;
  // (P-call): ONE snapshot. Flux is called only when it holds a TRUE stamp for the current address at the current revision.
  const snap = await env.DB.prepare("SELECT contact_email,email_revision,email_verified_at,email_verified_for FROM supabase_identities WHERE user_id=?").bind(ownerId)
    .first<{ contact_email: string | null; email_revision: number; email_verified_at: number | null; email_verified_for: string | null }>();
  const email = snap?.contact_email?.trim().toLowerCase() ?? "";
  if (!snap || !email) return null;
  if (!(snap.email_verified_at !== null && snap.email_verified_for === email)) return UNPROVEN;
  let fluxAccountId: string;
  let created: boolean | undefined;
  try {
    // Contract (c): a 200 to an unverified call can only be a replay, so the call is only ever made with emailVerified: true.
    ({ fluxAccountId, created } = await ensure({ murageAccountId: ownerId, email, emailVerified: true }));
  } catch (e) {
    // A 202 (flux-grants.ts FluxEmailUnverified) or a 409 link_email_mismatch carries the revision it was asked on, so what it writes is
    // written only while that revision is still current. It throws BEFORE the insert below: no link row is ever written without an id.
    if (e && typeof e === "object") (e as { revision?: number }).revision = snap.email_revision;
    throw e;
  }
  // (P-link): ONE conditional INSERT, the fence re-checked at INSERT time on the snapshot's address and revision (a TRUE stamp still there, no
  // dispute, no link). Anything else inserts nothing and the caller gets STALE. The alerts a link resolves go in the same batch.
  // The welcome email is queued in the SAME batch, directly after the link INSERT, and only when that INSERT wrote the row (changes()=1, so it
  // must stay the very next statement). flux_welcome_mail is keyed by owner and never deleted, so a re-link after an unlink (link_version above
  // the floor), a second home or a retry never queues it again: one email per Murage account, ever. An owner with a flux_link_floor row was
  // linked before (an unlink leaves the floor), so that link was their first and this one is not. The cron sends it (flux-welcome-mail.ts); a
  // send never blocks this link.
  const now = Date.now();
  const [linked] = await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO flux_links (owner_user_id,flux_account_id,linked_at,link_id,link_version,fenced)
    SELECT ?1,?2,?3,?2,COALESCE((SELECT version FROM flux_link_floor WHERE owner_user_id=?1),0)+1,0
    WHERE ${linkFenceSql("?1", "?4", "?5")}`).bind(ownerId, fluxAccountId, now, email, snap.email_revision),
    env.DB.prepare(`INSERT INTO flux_welcome_mail (owner_user_id,created,queued_at,next_attempt_at) SELECT ?,?,?,? WHERE changes()=1
      AND NOT EXISTS (SELECT 1 FROM flux_link_floor WHERE owner_user_id=?) ON CONFLICT(owner_user_id) DO NOTHING`)
      .bind(ownerId, created === true ? 1 : 0, now, now, ownerId),
    env.DB.prepare(LINK_RESOLVES_SQL).bind(ownerId, now),
  ]);
  // Two first links at once: the one that heard created=false may have queued the row first. Flux made the account, so say so.
  if (created === true) {
    await env.DB.prepare("UPDATE flux_welcome_mail SET created=1 WHERE owner_user_id=? AND sent_at IS NULL AND created=0").bind(ownerId).run();
  }
  const after = await linkRowOf(env, ownerId);
  if (after) return after;
  return (linked.meta.changes ?? 0) === 0 ? STALE : null;
}

/** The only hosts the welcome email may send a person to. */
const FLUX_SIGN_IN_HOSTS = new Set(["fluxrouter.ai", "app-staging.fluxrouter.ai"]);
/** Flux's sign-in page, from FLUX_APP_BASE (staging: the staging app), default https://fluxrouter.ai. Parsed as ensureFluxAccount does
 *  (https, no userinfo, no query or fragment, path "/"), and the host must be one of FLUX_SIGN_IN_HOSTS on the default port; else throws. */
export function fluxSignInUrl(env: Env): string {
  const u = new URL(((env as { FLUX_APP_BASE?: string }).FLUX_APP_BASE ?? "").trim() || "https://fluxrouter.ai");
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || u.pathname !== "/"
    || !FLUX_SIGN_IN_HOSTS.has(u.hostname) || (u.port !== "" && u.port !== "443")) throw new Error("flux_app_base_not_allowed");
  return `https://${u.hostname}/auth/sign-in`;
}

/** The welcome email's words. `created`: Flux made the account just now (no password is set on it); otherwise the account already existed. */
export function fluxWelcomeEmail(env: Env, created: boolean): { emailSubject: string; emailText: string; emailHtml: string } {
  const link = fluxSignInUrl(env);
  const lead = "Your bots run on Fuigo, powered by Flux.";
  const emailSubject = created ? "Your Flux Router account is ready" : "Your Murage Cloud credits are on your Flux Router account";
  const lines = created
    ? [lead, "Your Murage Cloud credits are on a Flux Router account we made for you with this email address.",
      `To see your credits or add more, go to ${link}, type this email address and choose "Send Verification Code". You do not need a password.`]
    : [lead, "We connected the Flux Router account that already uses this email address. Your Murage Cloud credits land there.",
      `Sign in at ${link} with this email address. If you do not use a password, choose "Send Verification Code".`];
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const emailHtml = `<!doctype html><html><body>${lines.map((l) => `<p>${esc(l).replace(esc(link), `<a href="${esc(link)}">${esc(link)}</a>`)}</p>`).join("")}</body></html>`;
  return { emailSubject, emailText: lines.join("\n\n"), emailHtml };
}
