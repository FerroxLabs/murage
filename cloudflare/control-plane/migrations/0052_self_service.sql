-- Customer self-service from the murage.ai members area (lanes/cloud-v2/support/SELF-SERVICE.md, SUPPORT-DESIGN.md rev 3
-- rows B1, B2b and S7): status, Fix it, restart, reboot, start, safe mode, redacted logs, the watchdog, automated export.

-- Fixed-window limits per home (the pairing.ts ledger's pattern, with an explicit window per subject).
CREATE TABLE selfservice_rate_limits (
  subject TEXT PRIMARY KEY,
  window_started_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts >= 1)
);

-- Every customer, device, watchdog and operator self-service action and its outcome. No token, no log line, no secret.
CREATE TABLE selfservice_audit (
  id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('customer', 'device', 'watchdog', 'operator')),
  account_id TEXT,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  at INTEGER NOT NULL
);
CREATE INDEX selfservice_audit_home_idx ON selfservice_audit (home_id, at);

-- Commands the home picks up from GET /v1/machines/<id>/commands and acks once. Fenced by the home generation.
CREATE TABLE cloud_home_commands (
  id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('restart_service', 'safe_mode', 'collect_logs', 'export_archive', 'update_software',
    'reset_from_backup', 'undo_reset')),
  payload TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  acked_at INTEGER,
  outcome TEXT
);
CREATE INDEX cloud_home_commands_home_idx ON cloud_home_commands (home_id, generation, acked_at);

-- The Fix-it ladder: one open run per home, advanced by the customer's button and by the cron sweep.
CREATE TABLE cloud_fixit_runs (
  id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('customer', 'watchdog')),
  step TEXT NOT NULL,
  step_at INTEGER NOT NULL,
  next_at INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  outcome TEXT,
  steps TEXT NOT NULL DEFAULT '[]'
);
CREATE UNIQUE INDEX cloud_fixit_runs_open_idx ON cloud_fixit_runs (home_id) WHERE finished_at IS NULL;
CREATE INDEX cloud_fixit_runs_home_idx ON cloud_fixit_runs (home_id, started_at);

-- "Reset my Cloud": rebuild from the last good backup, reversibly. The home first keeps the current state as a backup snapshot tagged
-- snapshot_tag for 7 days; "Undo reset" restores it. Nothing is destroyed, so no 72-hour hold (fresh aal2 plus a confirm instead).
CREATE TABLE cloud_resets (
  id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('requested', 'done', 'failed', 'undo_requested', 'undone', 'expired')),
  snapshot_tag TEXT NOT NULL,
  command_id TEXT NOT NULL,
  undo_command_id TEXT,
  requested_at INTEGER NOT NULL,
  done_at INTEGER,
  keep_until INTEGER NOT NULL,
  undone_at INTEGER
);
CREATE INDEX cloud_resets_home_idx ON cloud_resets (home_id, requested_at);

-- Redacted recent logs the home uploaded for a collect_logs command, in chunks; kept 24 hours.
CREATE TABLE cloud_home_logs (
  home_id TEXT NOT NULL,
  chunk INTEGER NOT NULL CHECK (chunk BETWEEN 0 AND 7),
  command_id TEXT NOT NULL,
  lines TEXT NOT NULL,
  collected_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (home_id, chunk)
);

-- Automated export (S7): the home builds an encrypted archive into its backup space; the key is held wrapped here and handed
-- out only with an MFA-gated download.
CREATE TABLE cloud_export_jobs (
  request_id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  command_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('requested', 'ready', 'manual', 'expired')),
  requested_at INTEGER NOT NULL,
  deliver_by INTEGER NOT NULL,
  ready_at INTEGER,
  available_until INTEGER,
  file TEXT,
  format TEXT,
  bytes INTEGER,
  sha256 TEXT,
  wrapped_key TEXT,
  box_id INTEGER,
  directory TEXT,
  downloaded_at INTEGER,
  purged_at INTEGER
);
CREATE INDEX cloud_export_jobs_home_idx ON cloud_export_jobs (home_id, requested_at);
CREATE TABLE cloud_export_downloads (
  token_hash TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0
);

-- Who opened a hold (operator admin route, or the members area with fresh aal2) and who cancelled it.
ALTER TABLE cloud_recovery_holds ADD COLUMN source TEXT NOT NULL DEFAULT 'operator';
ALTER TABLE cloud_recovery_holds ADD COLUMN canceled_by TEXT;
