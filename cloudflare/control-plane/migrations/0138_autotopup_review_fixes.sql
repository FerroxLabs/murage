-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Auto top-up review fixes. pay_started_at fixes the cap month at the first pay call (a retry after midnight never moves it); checked_at and
-- sweep_checked_at make the sweeps examine the least recently checked first; retry_after/retry_fails/notified_reason back off a home whose tax
-- cannot be worked out (one notice per reason); paused_method/recheck_at let the sweep see a card change and lift a pause.
ALTER TABLE topup_attempts ADD COLUMN pay_started_at INTEGER;
ALTER TABLE topup_attempts ADD COLUMN checked_at INTEGER;
ALTER TABLE topup_state ADD COLUMN retry_after INTEGER;
ALTER TABLE topup_state ADD COLUMN retry_fails INTEGER NOT NULL DEFAULT 0;
ALTER TABLE topup_state ADD COLUMN notified_reason TEXT;
ALTER TABLE topup_state ADD COLUMN paused_method TEXT;
ALTER TABLE topup_state ADD COLUMN recheck_at INTEGER;
ALTER TABLE topup_state ADD COLUMN sweep_checked_at INTEGER;
