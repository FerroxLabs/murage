-- Self-service round 2 (Astra SELFSERVICE1): one exclusive data job per home, command pickup and run deadlines, app health,
-- the home command runner's capability and export coalescing.

-- One data job at a time per home: reset, undo, update or export. A job is its one command (id = command id). The partial unique index
-- is the admission: a second job for the home cannot be inserted while one is active, whatever raced to the check.
CREATE TABLE cloud_home_jobs (
  id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('reset', 'undo', 'update', 'export')),
  ref TEXT,
  generation INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'done', 'failed', 'expired')),
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  outcome TEXT
);
CREATE UNIQUE INDEX cloud_home_jobs_active_idx ON cloud_home_jobs (home_id) WHERE state = 'active';
CREATE INDEX cloud_home_jobs_home_idx ON cloud_home_jobs (home_id, created_at);

-- expires_at is now the pickup deadline. The home's GET commands picks a command once (picked_at) and gives it a run deadline, the
-- home never starts, or passes an irreversible step of, a command after its run deadline, and the control plane fails a job whose
-- command was not picked by expires_at, or not acknowledged by run_deadline plus a grace.
ALTER TABLE cloud_home_commands ADD COLUMN picked_at INTEGER;
ALTER TABLE cloud_home_commands ADD COLUMN run_deadline INTEGER;

-- The home's self-service runner (murage-commands) last polled for commands at this generation. Commands are only offered to a home
-- whose runner has polled at its current generation (a home image without the runner never gets a command it cannot run).
CREATE TABLE cloud_home_runner (
  home_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL,
  polled_at INTEGER NOT NULL
);

-- Health means the Murage app answers on the home, not just the root daemon: the heartbeat reports whether the app answered a local
-- request. app_reported_at: the last heartbeat that carried that evidence, app_ok_at: the last one where the app answered.
ALTER TABLE cloud_home_health ADD COLUMN app_reported_at INTEGER;
ALTER TABLE cloud_home_health ADD COLUMN app_ok_at INTEGER;

-- Export requests share one archive (archive_id = the request whose archive it is). A request admitted while another data job runs
-- waits (state 'requested', command_id NULL), every waiting request of a home then shares the next archive.
ALTER TABLE cloud_export_jobs ADD COLUMN archive_id TEXT;
UPDATE cloud_export_jobs SET archive_id = request_id WHERE archive_id IS NULL;
CREATE INDEX cloud_export_jobs_archive_idx ON cloud_export_jobs (archive_id);
