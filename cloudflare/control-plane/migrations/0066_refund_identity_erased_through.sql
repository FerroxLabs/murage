-- SPDX-License-Identifier: AGPL-3.0-or-later
-- An erasure on an objection endures (Astra ASTRA-REFUND4 #1, #3). erased_through is the latest decided_at of an "erase" decision for
-- this person: the codes of every payment they made up to it were deleted and are never recorded again, whatever later happens to the
-- objection itself (a new objection reopens decision/decided_at/notice_sent_at, never this). Captures and enrichment are fenced against it
-- in their own write batch, so a Stripe read that was in flight when the erasure ran writes nothing.
ALTER TABLE refund_identity_restrictions ADD COLUMN erased_through INTEGER;
UPDATE refund_identity_restrictions SET erased_through=decided_at WHERE decision='erase' AND notice_sent_at IS NOT NULL;
