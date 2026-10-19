-- SPDX-License-Identifier: AGPL-3.0-or-later
-- B5 ops: what a home reports on its heartbeat, the alerts raised from it, and a tiny state table.
CREATE TABLE cloud_home_health (
  home_id TEXT PRIMARY KEY,
  reported_at INTEGER NOT NULL,
  disk_used_percent INTEGER,
  last_backup_at INTEGER
);
CREATE TABLE cloud_alerts (
  id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL,
  detail TEXT NOT NULL,
  raised_at INTEGER NOT NULL,
  resolved_at INTEGER,
  delivered_at INTEGER,
  delivery_attempts INTEGER NOT NULL DEFAULT 0
);
-- At most one open alert per home and kind; a recurrence after resolution is a new row.
CREATE UNIQUE INDEX cloud_alerts_open ON cloud_alerts(home_id, kind) WHERE resolved_at IS NULL;
CREATE INDEX cloud_alerts_raised ON cloud_alerts(raised_at);
CREATE TABLE cloud_ops_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
