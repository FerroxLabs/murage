-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Two-tier alerts (lanes/cloud-v2/ALERTS-TWO-TIER-DESIGN.md): page alerts are delivered as one message per cause (group), not one per home.
-- One row per group. state 'open' while any member alert is open; paged_at stays NULL until the first page goes out (a group held back by
-- the hourly page cap, or still under its threshold). claim_until and attempts are the group's own delivery claim and retry backoff.
CREATE TABLE cloud_alert_groups (
  group_key TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('open', 'closed')),
  opened_at INTEGER NOT NULL,
  last_paged_at INTEGER,
  last_paged_count INTEGER NOT NULL DEFAULT 0,
  pages INTEGER NOT NULL DEFAULT 0,
  peak_count INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  claim_until INTEGER,
  closed_at INTEGER
);
-- Every page sent, for the hourly cap. bypass=1 pages (compromise, control plane down) are logged but never counted against the cap.
CREATE TABLE cloud_alert_pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  group_key TEXT NOT NULL,
  reason TEXT NOT NULL,
  bypass INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX cloud_alert_pages_at ON cloud_alert_pages (at);
