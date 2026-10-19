-- SPDX-License-Identifier: AGPL-3.0-or-later
CREATE TABLE cloud_reconcile_progress (
  id TEXT PRIMARY KEY,
  last_home_id TEXT NOT NULL
);
