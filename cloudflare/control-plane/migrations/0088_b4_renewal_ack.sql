-- SPDX-License-Identifier: AGPL-3.0-or-later
-- B4 round 2, hole 11: a renewal mint no longer advances the recorded key expiry. The new
-- key's expiry waits here until the home's poller acknowledges delivery
-- (POST /v1/machines/:id/flux/subkey/ack); without the ack the expiry does not move and
-- renewal stays due. Additive: 0086 and 0087 are already applied.
ALTER TABLE flux_home_keys ADD COLUMN pending_op_id TEXT;
ALTER TABLE flux_home_keys ADD COLUMN pending_generation INTEGER;
ALTER TABLE flux_home_keys ADD COLUMN pending_expires_at INTEGER;
-- The last acknowledged operation, so a repeated ack (a lost response) answers 200 again.
ALTER TABLE flux_home_keys ADD COLUMN last_acked_op_id TEXT;
