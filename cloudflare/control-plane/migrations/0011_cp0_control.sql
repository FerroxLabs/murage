-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Control-link lease and heartbeat for CP0 machines, which have no cloud_homes row.
-- One row per machine; contains no secret. Written only by the machine routes in cp0-control.ts.
CREATE TABLE cloud_cp0_control (
  machine_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  renewed_at INTEGER NOT NULL,
  heartbeat_at INTEGER
);
