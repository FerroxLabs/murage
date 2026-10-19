-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Versioned HMAC keys for the refund-identity hashes (refund-identity.ts keyring). REFUND_KEY_SECRET is the current key (version
-- REFUND_KEY_VERSION, default 1); REFUND_KEY_SECRET_PREVIOUS (REFUND_KEY_VERSION_PREVIOUS) is kept while records hashed under it are within
-- the 24-month retention. Every capture hashes under every configured key, so a rotation keeps matching new payments against old ones.
-- Rotation: set the new key with a new version and move the old one to *_PREVIOUS; drop *_PREVIOUS 24 months later.
-- key_version: the key a hash was made with. refund_identity_keyring: a check value per version (an HMAC of a fixed label, never the
-- key). A key replaced without a new version, or an old version still in use by stored records but no longer configured, stops the
-- check (nothing is granted on it) and alerts ops, instead of silently forgetting every earlier payment.
ALTER TABLE refund_identity_keys ADD COLUMN key_version INTEGER NOT NULL DEFAULT 1;
CREATE INDEX refund_identity_keys_version ON refund_identity_keys (key_version);
CREATE TABLE refund_identity_keyring (
  version INTEGER PRIMARY KEY,
  check_hash TEXT NOT NULL,
  first_used_at INTEGER NOT NULL
);
