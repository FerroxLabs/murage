-- Self-service round 3 (Astra SELFSERVICE2): provider power reservations, unknown outcomes of destructive jobs, the pair-hold spend
-- bound to a device key, and the export key shown exactly once.

-- A provider power action (reboot, start) holds the home's one job slot (kind 'power') from before the provider call until its outcome
-- is settled: settle_at is when a confirmed call has taken effect, or, when the call timed out or failed in transit, when it can no
-- longer be executing. No reset, undo, update, export or other power action is admitted meanwhile.
CREATE TABLE cloud_home_jobs_r3 (
  id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('reset', 'undo', 'update', 'export', 'power')),
  ref TEXT,
  generation INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'done', 'failed', 'expired')),
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  outcome TEXT,
  settle_at INTEGER
);
INSERT INTO cloud_home_jobs_r3 (id,home_id,kind,ref,generation,state,created_at,finished_at,outcome)
  SELECT id,home_id,kind,ref,generation,state,created_at,finished_at,outcome FROM cloud_home_jobs;
DROP TABLE cloud_home_jobs;
ALTER TABLE cloud_home_jobs_r3 RENAME TO cloud_home_jobs;
CREATE UNIQUE INDEX cloud_home_jobs_active_idx ON cloud_home_jobs (home_id) WHERE state = 'active';
CREATE INDEX cloud_home_jobs_home_idx ON cloud_home_jobs (home_id, created_at);

-- A reset or undo whose home did not answer by its run deadline may still have happened: 'unknown' / 'undo_unknown' until the home's
-- late result arrives (it retries its acknowledgement on its own). Never reported failed, never undoable while unknown.
CREATE TABLE cloud_resets_r3 (
  id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('requested', 'done', 'failed', 'undo_requested', 'undone', 'expired', 'unknown', 'undo_unknown')),
  snapshot_tag TEXT NOT NULL,
  command_id TEXT NOT NULL,
  undo_command_id TEXT,
  requested_at INTEGER NOT NULL,
  done_at INTEGER,
  keep_until INTEGER NOT NULL,
  undone_at INTEGER
);
INSERT INTO cloud_resets_r3 SELECT id,home_id,account_id,state,snapshot_tag,command_id,undo_command_id,requested_at,done_at,keep_until,undone_at
  FROM cloud_resets;
DROP TABLE cloud_resets;
ALTER TABLE cloud_resets_r3 RENAME TO cloud_resets;
CREATE INDEX cloud_resets_home_idx ON cloud_resets (home_id, requested_at);

-- A completed pair hold is spent here, in control-plane state that no home restore can roll back, and only for one device key:
-- spent_device_digest is SHA-256 over the device's scope and keys (pairing.ts pairDeviceDigest). The signed proof carries it and the
-- home refuses any other device.
ALTER TABLE cloud_recovery_holds ADD COLUMN spent_device_digest TEXT;
ALTER TABLE cloud_recovery_holds ADD COLUMN spent_at INTEGER;

-- The export archive's key is shown once per archive (every request sharing it): the first link request inserts this row and gets the
-- key: the wrapped key is then dropped.
CREATE TABLE cloud_export_key_disclosures (
  archive_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  disclosed_at INTEGER NOT NULL
);
