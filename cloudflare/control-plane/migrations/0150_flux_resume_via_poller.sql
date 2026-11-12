-- SPDX-License-Identifier: AGPL-3.0-or-later
-- 8b (SPENDING-RESUME-VIA-POLLER rev 1.5.3, sections 2.1 and 5): spending back ON goes through the home's own poller. Additive: seven nullable
-- INTEGER columns and two partial indexes. 0149 is taken on the consent line (0149_updates_consent_v5), so this is the next number unused on both lines.
ALTER TABLE flux_home_keys ADD COLUMN pending_lifecycle_version INTEGER;
ALTER TABLE flux_home_keys ADD COLUMN acked_lifecycle_version INTEGER;
ALTER TABLE flux_home_keys ADD COLUMN acked_generation INTEGER;
ALTER TABLE flux_home_keys ADD COLUMN resume_lv INTEGER;
ALTER TABLE flux_home_keys ADD COLUMN resume_from_generation INTEGER;
ALTER TABLE flux_home_keys ADD COLUMN resume_at INTEGER;
ALTER TABLE flux_home_keys ADD COLUMN stop_checked_at INTEGER;
CREATE INDEX flux_home_keys_resume_open ON flux_home_keys(resume_at) WHERE resume_lv IS NOT NULL AND acked_lifecycle_version IS NOT resume_lv;
CREATE INDEX cloud_alerts_resume_open ON cloud_alerts(raised_at) WHERE kind='flux.resume_undelivered' AND resolved_at IS NULL;
-- Backfill, one pass, never at request time. Step 1: every active row already holds the key the home acked (before this change an active row's
-- key was the one the home had).
-- Step 2 (the owner-resumed repair) is gone (fix r2, Astra cp-r2 Medium). Selecting those rows needs the provenance of the current key, and the
-- pre-8b code never stored it: the mint journal row has a random op id and only {generation, lifecycleVersion}, and the owner op id went only to
-- Flux. No timestamp stands in for it (a Stop captures its time before its write). Prod has 0 key rows and staging has 0 candidates, and the roll
-- precondition covers any home that appears before the roll. So this migration writes only the acked_* backfill below.
UPDATE flux_home_keys SET acked_lifecycle_version=lifecycle_version, acked_generation=generation WHERE state='active';
