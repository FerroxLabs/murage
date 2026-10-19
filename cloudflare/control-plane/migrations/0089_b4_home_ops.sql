-- SPDX-License-Identifier: AGPL-3.0-or-later
-- B4 round 3: ONE per-home serializer. Every lifecycle request (Stop, billing stop, unlink, cap
-- change, mint, key compensation) writes an intent row here in the SAME D1 batch as its durable
-- state change, before any network call. A lease on the home row (op_holder / op_lease_until)
-- makes exactly one worker at a time run the router calls, in seq order; the sweep finishes
-- whatever a crashed request left behind. D1 and a lease are used rather than a Durable Object:
-- the control plane has no DO binding and its tests run D1 as in-memory SQLite.
-- Additive: 0086-0088 are already applied.
CREATE TABLE flux_home_ops (
  op_id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('mint', 'stop', 'cap', 'compensate')),
  payload TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'done', 'superseded')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 64),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX flux_home_ops_by_home ON flux_home_ops (home_id, state, seq);
CREATE INDEX flux_home_ops_open ON flux_home_ops (state, seq);

ALTER TABLE flux_home_keys ADD COLUMN op_holder TEXT;
ALTER TABLE flux_home_keys ADD COLUMN op_lease_until INTEGER;

-- Fold the old compensation table into ops (kind 'compensate'); it is no longer read or written.
INSERT INTO flux_home_ops (op_id, home_id, seq, kind, payload, state, attempts, last_error, created_at, updated_at)
  SELECT comp_id, home_id, 1000000 + rowid, 'compensate',
    json_object('generation', generation, 'lifecycleVersion', lifecycle_version),
    CASE state WHEN 'done' THEN 'done' ELSE 'queued' END,
    attempts, NULL, created_at, COALESCE(last_attempt_at, created_at)
  FROM flux_key_compensations;
-- A Stop that was recorded as 'stopping' but not yet confirmed becomes a queued stop op.
INSERT INTO flux_home_ops (op_id, home_id, seq, kind, payload, state, created_at, updated_at)
  SELECT 'migrated-stop:' || home_id, home_id,
    2000000 + rowid, 'stop',
    json_object('version', COALESCE(stop_version, lifecycle_version), 'linkVersion', stop_link_version, 'reason', 'stop'),
    'queued', updated_at, updated_at
  FROM flux_home_keys WHERE state = 'stopping';
