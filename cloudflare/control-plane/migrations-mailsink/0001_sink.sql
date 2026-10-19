-- SPDX-License-Identifier: AGPL-3.0-or-later
-- STAGING ONLY. The staging mail sink (TRUST-FIRST-FACTOR.md revision 2, part C; src/email.ts). Applied by the operator to the
-- separate database murage-cloud-staging-mailsink, never to the control-plane database:
--   wrangler d1 migrations apply murage-cloud-staging-mailsink --env staging --remote
-- Rows carry authentication codes in plaintext: no route reads them; the cron deletes rows older than 24 h; the one documented read
-- is the operator's manual query in README "Staging mail sink". D1 read access = members of the staging Cloudflare account only.
CREATE TABLE staging_mail_sink (
  id TEXT PRIMARY KEY,
  to_addr TEXT NOT NULL,
  subject TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL          -- ms
);
CREATE INDEX staging_mail_sink_created ON staging_mail_sink (created_at);
