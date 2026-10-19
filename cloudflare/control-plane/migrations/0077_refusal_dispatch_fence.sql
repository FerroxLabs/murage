-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Fenced ownership of a refusal email's dispatch (Astra ASTRA-REFUND6 #2). A timer cannot prove a sender stopped (an HTTP Worker has no
-- duration bound), so a refund_refusal_sends row no longer expires by itself: it stands until its sender releases it or a takeover
-- reconciles it. The claim of a "not_first_payment" refusal notice records the dispatch as 'dispatching' with a fence token
-- (dispatch_fence = the sender's holder id, the same id as its refund_refusal_sends rows). Right before the EMAIL call the sender moves it
-- to 'handed_off' (fenced on its token); after the call it finalises the notice (sent, or backed off), again only with its token.
-- A takeover (the billing sweep, or a new claim of the same notice) may act on a dispatch only after its `until` has passed, and first
-- reconciles it in one write: the fence is revoked (a late handoff or finalise by the old sender is refused) and a dispatch that had been
-- handed off becomes 'unknown' (sent or not, nobody can tell): the refusal is then revalidated like any queued one (held while an
-- objection is open, cancelled when obsolete, sent again only while it still stands), and an objection pending on it records
-- dispatch_unknown_at. A dispatch that never reached the handoff is known not to have been sent and can no longer be.
ALTER TABLE billing_notices ADD COLUMN dispatch_fence TEXT;
ALTER TABLE billing_notices ADD COLUMN dispatch_state TEXT CHECK (dispatch_state IN ('dispatching','handed_off','unknown'));
ALTER TABLE refund_identity_restrictions ADD COLUMN dispatch_unknown_at INTEGER;
