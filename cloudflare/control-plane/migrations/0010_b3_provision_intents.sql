-- SPDX-License-Identifier: AGPL-3.0-or-later
-- No raw enrollment token or private user-data is stored here.
CREATE TABLE cloud_provision_intents (
  home_id TEXT PRIMARY KEY,
  cp_generation INTEGER NOT NULL,
  resource_generation INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  volume_phase TEXT NOT NULL DEFAULT 'pending' CHECK(volume_phase IN ('pending','claimed','created')),
  server_phase TEXT NOT NULL DEFAULT 'pending' CHECK(server_phase IN ('pending','claimed','created')),
  volume_claim TEXT,
  server_claim TEXT,
  volume_id TEXT,
  server_id TEXT,
  volume_json TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','bound','failed')),
  failure_code TEXT,
  created_at INTEGER NOT NULL
);
-- Structured fake protocol metadata only. Never persist create user-data.
ALTER TABLE cloud_fake_resources ADD COLUMN provider TEXT NOT NULL DEFAULT 'hetzner';
ALTER TABLE cloud_fake_resources ADD COLUMN serial TEXT;
ALTER TABLE cloud_fake_resources ADD COLUMN attachment_server_id TEXT;
ALTER TABLE cloud_fake_resources ADD COLUMN last_attachment_server_id TEXT;
