-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Remotely managed Cloudflare Tunnel metadata for one endpoint per cloud MACHINE.
-- Same columns, lease and cleanup bookkeeping as installation_endpoints (0004/0005)
-- so one lifecycle implementation serves both. Connector tokens and Cloudflare
-- API credentials must never be written to D1.
-- The row is created together with the machine (CP0 create, B3 reserve), which
-- is what allocates the hostname; the hostname and tunnel name never change.
-- No foreign key: a B3 reservation precedes its cloud_machines row, and a hard
-- machine deletion must not erase the Cloudflare IDs needed for cleanup retries.
CREATE TABLE machine_endpoints (
  machine_id TEXT PRIMARY KEY,
  hostname TEXT NOT NULL UNIQUE,
  tunnel_name TEXT NOT NULL UNIQUE,
  tunnel_id TEXT UNIQUE,
  dns_record_id TEXT UNIQUE,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'provisioning', 'ready', 'deleting', 'deleted', 'error')
  ),
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  lease_owner TEXT,
  lease_expires_at INTEGER,
  last_reconciled_at INTEGER,
  delete_requested_at INTEGER,
  last_error_code TEXT CHECK (
    last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 64
  ),
  cleanup_attempts INTEGER NOT NULL DEFAULT 0 CHECK (cleanup_attempts >= 0),
  last_cleanup_attempt_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (lease_owner IS NULL AND lease_expires_at IS NULL)
    OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
  )
);

CREATE INDEX machine_endpoints_status_lease_idx
  ON machine_endpoints(status, lease_expires_at, updated_at);

-- Machine-authenticated reconciles are limited separately from the installation
-- and account limiters. No foreign key, as above.
CREATE TABLE machine_action_rate_limits (
  machine_id TEXT NOT NULL,
  action TEXT NOT NULL,
  window_started_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts >= 1),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (machine_id, action)
);

CREATE INDEX machine_action_rate_limits_updated_idx
  ON machine_action_rate_limits(updated_at);
