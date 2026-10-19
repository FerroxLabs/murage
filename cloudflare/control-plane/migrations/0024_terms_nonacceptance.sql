-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Changed terms never accepted: the accepted terms run to the end of the paid period, then the plan does not renew
-- (cancel_at_period_end set at the effective date). Reminders at notice, 7 days before the period ends and when it ends.
-- Accepting before the period ends lifts the cancellation. A renewal is never an acceptance.
ALTER TABLE terms_change_notices ADD COLUMN cancel_set_at INTEGER;      -- we set cancel_at_period_end because of non-acceptance
ALTER TABLE terms_change_notices ADD COLUMN cancel_skipped_at INTEGER;  -- the plan was already ending (the customer cancelled)
ALTER TABLE terms_change_notices ADD COLUMN period_end INTEGER;         -- the end of the paid period the old terms run to
ALTER TABLE terms_change_notices ADD COLUMN reminder7_at INTEGER;
ALTER TABLE terms_change_notices ADD COLUMN end_notice_at INTEGER;
ALTER TABLE terms_change_notices ADD COLUMN lifted_at INTEGER;          -- accepted in time: the cancellation was taken back (or never needed)
CREATE INDEX terms_change_notices_due ON terms_change_notices(effective_at) WHERE lifted_at IS NULL AND end_notice_at IS NULL;
