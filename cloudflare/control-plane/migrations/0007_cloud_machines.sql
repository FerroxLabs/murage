-- SPDX-License-Identifier: AGPL-3.0-or-later
CREATE TABLE cloud_machines (
  id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  state TEXT NOT NULL,
  credential_hash TEXT,
  server_id TEXT,
  bound_ips TEXT,
  created_at INTEGER NOT NULL,
  -- Enrollment must retain these admin-supplied origins between requests.
  public_origin TEXT NOT NULL,
  admin_url TEXT NOT NULL
);
CREATE TABLE cloud_enrollment_tokens (
  hash TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  bound_server_id TEXT,
  bound_ip TEXT
);
CREATE TABLE cloud_home_keys (
  home_id TEXT PRIMARY KEY,
  wrapped_data_key TEXT NOT NULL,
  wrapped_bootstrap_secret TEXT NOT NULL,
  wrapped_volume_key TEXT,
  kek_id TEXT NOT NULL
);
CREATE TABLE cloud_unwrap_log (
  home_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  at INTEGER NOT NULL,
  source_ip TEXT,
  outcome TEXT NOT NULL
);
