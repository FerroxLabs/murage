-- SPDX-License-Identifier: AGPL-3.0-or-later
-- B3 fake-only tables. CP0 tables and production behavior remain unchanged.
CREATE TABLE cloud_homes (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  desired_state TEXT NOT NULL,
  observed_state TEXT NOT NULL,
  entitlement TEXT NOT NULL DEFAULT 'pending',
  payment_version INTEGER NOT NULL DEFAULT -1,
  generation INTEGER NOT NULL DEFAULT 1,
  resource_generation INTEGER NOT NULL DEFAULT 1,
  reservation_expires_at INTEGER,
  grace_until INTEGER,
  delete_after INTEGER,
  suspension_notices INTEGER NOT NULL DEFAULT 0,
  dns_removed_at INTEGER,
  heartbeat_at INTEGER,
  image_digest TEXT NOT NULL,
  canary_json TEXT,
  home_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX cloud_one_live_home ON cloud_homes(installation_id)
  WHERE desired_state <> 'deleted';
CREATE TABLE cloud_capacity (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  location TEXT NOT NULL,
  server_type TEXT NOT NULL,
  home_id TEXT UNIQUE,
  expires_at INTEGER,
  outcome TEXT NOT NULL DEFAULT 'available'
);
CREATE TABLE cloud_waitlist (
  installation_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  requested_at INTEGER NOT NULL
);
CREATE TABLE cloud_payment_inbox (
  id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  payload TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  processed_at INTEGER
);
CREATE TABLE cloud_fake_refunds (
  payment_id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE cloud_outbox (
  id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  receipt TEXT
);
CREATE TABLE cloud_mutations (
  id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  response TEXT NOT NULL
);
-- A failed compare-and-swap aborts the complete D1 batch, including receipts.
CREATE TABLE cloud_write_guards (id TEXT PRIMARY KEY, ok INTEGER NOT NULL CHECK(ok=1));
CREATE TABLE cloud_leases (
  installation_id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  holder TEXT NOT NULL,
  generation INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  renewed_at INTEGER NOT NULL,
  acknowledged INTEGER NOT NULL DEFAULT 0,
  fenced INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE cloud_fake_resources (
  id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  role TEXT NOT NULL,
  state TEXT NOT NULL,
  public_ips TEXT NOT NULL,
  quarantined INTEGER NOT NULL DEFAULT 0,
  quarantine_relay_ip TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  UNIQUE(home_id,generation,role)
);
CREATE TABLE cloud_fake_dns (
  home_id TEXT PRIMARY KEY,
  addresses TEXT NOT NULL,
  ttl INTEGER NOT NULL CHECK(ttl=60)
);
CREATE TABLE cloud_devices (
  id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  public_jwk TEXT NOT NULL,
  revoked_at INTEGER
);
CREATE TABLE cloud_device_proofs (
  nonce TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  used_at INTEGER NOT NULL
);
CREATE TABLE cloud_recovery_holds (
  id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  action TEXT NOT NULL,
  generation INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  completes_at INTEGER NOT NULL,
  completed_at INTEGER,
  canceled_at INTEGER,
  signed_proof TEXT
);
