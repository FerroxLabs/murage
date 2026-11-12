-- SPDX-License-Identifier: AGPL-3.0-or-later
-- FLUX-ENSURE-EMAIL-VERIFIED (design-ev3 r3 section 4, Grok r3 High 1): the first-key bound table also holds a TYPED hold. A home whose owner's
-- Flux account waits for the email check (ensure-account answered 202 pending_verification) gets a row with failures 0, hold='email_unverified'
-- and next_at = now + 15 min: no failure is counted, and the poller asks at most 4 times an hour. A real failure (hold NULL) still needs
-- failures >= 1; a real failure on a held row clears the hold (b4-flux.ts retryBumpSql). The wake-up (flux-email-proof.ts) deletes only
-- hold rows; real-failure rows keep their backoff.
-- 0139 is applied, so the table is rebuilt here (never edited in place), keeping every row.
CREATE TABLE flux_first_key_retry_new (
  home_id TEXT PRIMARY KEY,
  failures INTEGER NOT NULL CHECK (failures >= 0),
  next_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  hold TEXT CHECK (hold IS NULL OR hold = 'email_unverified'),
  CHECK (failures >= 1 OR hold IS NOT NULL)
);
INSERT INTO flux_first_key_retry_new (home_id, failures, next_at, updated_at, hold)
  SELECT home_id, failures, next_at, updated_at, NULL FROM flux_first_key_retry;
DROP TABLE flux_first_key_retry;
ALTER TABLE flux_first_key_retry_new RENAME TO flux_first_key_retry;
