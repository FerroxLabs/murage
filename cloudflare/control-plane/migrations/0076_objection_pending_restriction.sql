-- SPDX-License-Identifier: AGPL-3.0-or-later
-- An objection is recorded at once, never refused or made to wait (Astra ASTRA-REFUND6 #3). Its row restricts the person's codes for
-- every NEW refusal dispatch from that write on (a claim revalidates the refusal and finds it no longer stands: held, never sent), so no
-- later sender can overtake it. A refusal already being handed off when the objection arrived (a refund_refusal_sends row naming the
-- person) is ordered before it and finishes: the objection is then "pending_restriction" (pending_since set). The sender's release, or
-- the billing sweep, finalises it once no dispatch naming the person is left: pending_since is cleared and restricted_at is set.
-- An objection with no dispatch in flight is restricted at once (restricted_at = objected_at).
ALTER TABLE refund_identity_restrictions ADD COLUMN pending_since INTEGER;
ALTER TABLE refund_identity_restrictions ADD COLUMN restricted_at INTEGER;
