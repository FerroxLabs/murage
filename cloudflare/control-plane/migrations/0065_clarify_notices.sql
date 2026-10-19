-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Cloud checkout WP10: clarification of an undecided emailed notice (plan 5.3 "Clarification links", "Signed-in clarification").
-- Edited in place in WP10 r1 ONLY because 0065 has never been applied to any database (no deploy since WP10 began); once applied, add a new migration instead.
-- No clarify_tokens table: WP7's verify_tokens already carries purpose='clarify' with its action and classification_rev. A notice only needs to
-- remember WHAT it was settled with (so a second press, or the other button, renders the committed choice) and which cancellation carries its end.
ALTER TABLE withdrawal_notices ADD COLUMN clarified_action TEXT CHECK (clarified_action IN ('withdraw_now','cancel_at_end'));
ALTER TABLE withdrawal_notices ADD COLUMN clarified_at INTEGER;
ALTER TABLE withdrawal_notices ADD COLUMN cancellation_request_id TEXT;   -- the §5.2 cancellation scheduled for this notice (candidate renewal stop, cancel_at_end)
CREATE INDEX withdrawal_notices_cancellation ON withdrawal_notices (cancellation_request_id) WHERE cancellation_request_id IS NOT NULL;
-- r1 (Astra WP10-1 #1): a notice's cancellation is inserted already bound to its notice and frozen contract and is never rematched by email;
-- superseded_by records why it was retired without running to its end ('contract_ended', or 'withdrawal:<notice id>' after an immediate withdrawal).
ALTER TABLE cancellation_requests ADD COLUMN notice_id TEXT;
ALTER TABLE cancellation_requests ADD COLUMN superseded_by TEXT;
CREATE UNIQUE INDEX cancellation_requests_notice ON cancellation_requests (notice_id) WHERE notice_id IS NOT NULL;
-- r1 (Astra WP10-1 #4): a wrong label never suppresses a candidate. candidate_obligation is set whenever a notice is labelled `candidate`
-- (intake, reclassification; in the same statement, no trigger: D1 counts trigger rows in meta.changes) and cleared only by the holder's answer; ask_rev is the revision the outstanding ask links are bound to.
ALTER TABLE withdrawal_notices ADD COLUMN candidate_obligation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE withdrawal_notices ADD COLUMN ask_rev INTEGER;
UPDATE withdrawal_notices SET candidate_obligation=1, ask_rev=classification_rev WHERE classification='candidate' AND clarified_action IS NULL;
-- r1 (Astra WP10-1 #5): the end date read out of the message is kept on the notice; its cancellation is re-dated under the lease.
ALTER TABLE withdrawal_notices ADD COLUMN requested_date TEXT;
