// SPDX-License-Identifier: AGPL-3.0-or-later
// Invite-only sales (CLOUD_SALES_OPEN "invite"). A purchase route passes only when the AUTHENTICATED session's verified email is a row
// of sales_invites (migrations/0146_sales_invites.sql). The email comes from the signed-in Cloud account, resolved from the verified
// Supabase token (customer-identity.ts: the token's app_metadata.email_verified must be true or the token is refused, supabase-jwt.ts), never
// from a request body, query or header the caller controls. Run FIRST on each purchase route, before any reserve, D1 write, provider or
// Stripe call; one point lookup, no scan. Outside invite mode it does nothing.
import { salesMode } from "./b5-config";
import { HTTPError } from "./http";

/** Trim and lower-case: both the stored address and the session's are put through this before they are compared. */
export const normalizeInviteEmail = (email: string): string => email.trim().toLowerCase();

export interface InviteSessionUser { email?: string | null; emailVerified?: boolean | null }

/** `decided`: the request's admission decision (customer-identity.ts inviteDecision). Admission made the invite check once, before anything was written, and
 *  later calls read that decision instead of asking sales_invites again (an invite removed mid-request takes effect on the next request). */
export async function assertInvited(env: Pick<Env, "CLOUD_SALES_OPEN" | "DB">, getUser: () => Promise<InviteSessionUser | null | undefined>,
  decided?: { invited: true } | null): Promise<void> {
  if (salesMode(env) !== "invite") return;
  if (decided?.invited) return;
  const user = await getUser();
  // No session, no verified address, or no address at all: not invited.
  if (!user || user.emailVerified !== true || typeof user.email !== "string") throw new HTTPError(403, "not_invited");
  const email = normalizeInviteEmail(user.email);
  if (email === "") throw new HTTPError(403, "not_invited");
  const row = await env.DB.prepare("SELECT 1 AS x FROM sales_invites WHERE email=? LIMIT 1").bind(email).first();
  if (!row) throw new HTTPError(403, "not_invited");
}
