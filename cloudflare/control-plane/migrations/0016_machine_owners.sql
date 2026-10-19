-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Staging-only owner for CP0 test machines, which have no cloud_homes row. Read by
-- pairing only when CLOUD_CP0_STAGING=1. No foreign keys: it must not drive or block
-- any other control path.
CREATE TABLE machine_owners (
  machine_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  assigned_at INTEGER NOT NULL
);
