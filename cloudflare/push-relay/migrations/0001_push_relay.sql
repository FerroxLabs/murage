-- Murage push relay. Derived from the Codex control-plane 0007 with the
-- account columns removed (spec §3.5: enrolment is rooted in the phone).
-- Nothing here names a person, a bot, a thread or a message.
CREATE TABLE relay_devices (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  environment TEXT NOT NULL CHECK (environment IN ('development', 'production')),
  push_token TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  secret_hash TEXT NOT NULL UNIQUE,
  attest_key TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE relay_challenges (
  id TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX relay_challenges_expiry ON relay_challenges(expires_at);

CREATE TABLE relay_bindings (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES relay_devices(id) ON DELETE CASCADE,
  grant_hash TEXT UNIQUE,
  grant_expires_at INTEGER NOT NULL,
  publisher_hash TEXT UNIQUE,
  badge INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX relay_bindings_device ON relay_bindings(device_id);

CREATE TABLE relay_events (
  binding_id TEXT NOT NULL REFERENCES relay_bindings(id) ON DELETE CASCADE,
  event_ref TEXT NOT NULL,
  revision INTEGER NOT NULL,
  payload TEXT NOT NULL,
  admitted_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  lease_id TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  accepted_at INTEGER,
  PRIMARY KEY (binding_id, event_ref, revision)
);
CREATE INDEX relay_events_due ON relay_events(accepted_at, next_attempt_at);

CREATE TABLE relay_counters (
  scope TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (scope, window_start)
);
CREATE INDEX relay_counters_window ON relay_counters(window_start);

CREATE TABLE relay_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- APNs JWTs, encrypted under key material derived from the APNs key, never plaintext.
CREATE TABLE relay_provider_auth (
  cache_key TEXT PRIMARY KEY,
  iv TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
