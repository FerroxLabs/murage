-- Home-update rollout controller (lanes/cloud-v2/LANE-G-UPDATE-STATE-MACHINE-r3.md, the home side). Operator-driven, cron-swept.
-- A release is one signed sequence the fleet moves to in waves (0 internal homes, 1 three homes, 2 a quarter, 3 everyone), each wave
-- waiting for every home to report the target sequence healthy and then soaking. Only a PROMOTED release is what a customer's Update
-- button installs. A halted release dispatches nothing more; going back is a NEW release (the home's sequence floor forbids a downgrade).
CREATE TABLE cloud_releases (
  id TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL UNIQUE CHECK (sequence >= 1 AND sequence <= 9007199254740991),
  manifest_ref TEXT NOT NULL CHECK (length(manifest_ref) BETWEEN 1 AND 200),
  state TEXT NOT NULL CHECK (state IN ('draft','rolling','halted','promoted','cancelled')),
  wave INTEGER NOT NULL DEFAULT 0 CHECK (wave BETWEEN 0 AND 3),
  -- When the current wave's homes were chosen and sent the command; when every one of them first reported healthy (the soak clock).
  wave_started_at INTEGER,
  soak_started_at INTEGER,
  halt_reason TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  halted_at INTEGER,
  promoted_at INTEGER,
  cancelled_at INTEGER,
  updated_at INTEGER NOT NULL,
  -- The sweep's own lease: one controller pass at a time per release.
  sweep_holder TEXT,
  sweep_until INTEGER,
  -- The last monitoring sweep that succeeded while this release rolled: a blind interval longer than a cron gap is added back to the soak.
  monitored_at INTEGER
);
-- At most one release is moving (rolling) or waiting on an operator (halted) at a time.
CREATE UNIQUE INDEX cloud_releases_active ON cloud_releases ((1)) WHERE state IN ('rolling','halted');

CREATE TABLE cloud_release_homes (
  release_id TEXT NOT NULL REFERENCES cloud_releases (id) ON DELETE CASCADE,
  home_id TEXT NOT NULL,
  wave INTEGER NOT NULL CHECK (wave BETWEEN 0 AND 3),
  state TEXT NOT NULL CHECK (state IN ('pending','dispatched','updated','failed','skipped')),
  command_id TEXT,
  dispatched_at INTEGER,
  healthy_at INTEGER,
  failure TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (release_id, home_id)
);
CREATE INDEX cloud_release_homes_wave ON cloud_release_homes (release_id, wave, state);

-- What a home last reported about its own updater (murage-commands, POST /v1/machines/<id>/update-state). Optional on the wire: a home
-- that never reports has no row, and the controller treats it as silent. lastResult is the journal's (commandId, outcome, reason).
CREATE TABLE cloud_home_update_reports (
  home_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL,
  installed_sequence INTEGER,
  last_command_id TEXT,
  last_outcome TEXT CHECK (last_outcome IS NULL OR last_outcome IN ('done','failed')),
  last_reason TEXT,
  stuck TEXT,
  reported_at INTEGER NOT NULL
);

-- Operator flag: wave 0 is the homes flagged internal (our own and staging homes).
CREATE TABLE cloud_rollout_flags (
  home_id TEXT PRIMARY KEY,
  internal INTEGER NOT NULL DEFAULT 0 CHECK (internal IN (0,1)),
  updated_at INTEGER NOT NULL
);
