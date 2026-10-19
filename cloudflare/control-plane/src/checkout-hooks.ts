// SPDX-License-Identifier: AGPL-3.0-or-later
// Cloud checkout WP5: small helpers other packages call.

/** The country of the customer's last CONFIRMED payment (paid_at set), for the account pre-fill (WP4 `billingCountry`). */
export async function lastConfirmedPaymentCountry(env: Env, userId: string): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT COALESCE(effective_country,stripe_country) AS c FROM checkout_consents
    WHERE user_id=? AND paid_at IS NOT NULL AND rejected_at IS NULL ORDER BY paid_at DESC LIMIT 1`).bind(userId).first<{ c: string | null }>();
  return row?.c ?? null;
}
