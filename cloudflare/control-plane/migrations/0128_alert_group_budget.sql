-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Two-tier alerts: each page reason (opened, count_doubled, still_open, resolved) of a group has its OWN send-attempt budget, so a run of
-- failures on one reason (a bad URL, a long run of 500s) never stops the others. Reset when any page of the group is sent.
CREATE TABLE cloud_alert_group_budget (
  group_key TEXT NOT NULL,
  reason TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_failed_at INTEGER NOT NULL,
  PRIMARY KEY (group_key, reason)
);
