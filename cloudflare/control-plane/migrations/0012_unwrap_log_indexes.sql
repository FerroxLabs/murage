-- SPDX-License-Identifier: AGPL-3.0-or-later
-- The unwrap alert counts recent successes per home; the retention sweep
-- deletes by age.
CREATE INDEX cloud_unwrap_log_home_outcome_at_idx ON cloud_unwrap_log(home_id, outcome, at);
CREATE INDEX cloud_unwrap_log_at_idx ON cloud_unwrap_log(at);
