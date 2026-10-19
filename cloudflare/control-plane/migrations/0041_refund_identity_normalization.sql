-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Which normalization made an email or billing key (refund-identity.ts NORMALIZATION). The version is also part of the hashed input, so keys
-- of different versions never match by accident. When normalization changes, captures write the keys of every version still listed as
-- active until the records made with the old one have aged out (24 months), so new payments stay comparable with old ones.
-- 1: the first draft (ASCII-only names, "+tag" dropped on every domain); never written in production. 2: Unicode letters and marks kept,
-- internationalized domains in their ASCII (punycode) form, "+tag" dropped only for providers that document it.
ALTER TABLE refund_identity_keys ADD COLUMN norm INTEGER NOT NULL DEFAULT 1;
