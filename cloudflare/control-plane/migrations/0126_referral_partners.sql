-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Every paying Murage Cloud member becomes a FirstPromoter referral partner (src/referral.ts). One row per member (the home owner),
-- written when the first invoice is paid and never on a reserved or unpaid home. state: pending (queued, or FirstPromoter did not answer
-- yet; the billing sweep retries it with backoff) or active (promoter_id, ref_token and the promoter's current campaign are stored; the sweep re-reads the campaign once a day). No API key or secret is stored here.
CREATE TABLE cloud_referral_partners (
  user_id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  promoter_id INTEGER,
  ref_token TEXT,
  campaign_id INTEGER,
  campaign_checked_at INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  alerted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX cloud_referral_partners_due ON cloud_referral_partners (next_attempt_at) WHERE state='pending';
CREATE UNIQUE INDEX cloud_referral_partners_promoter ON cloud_referral_partners (promoter_id) WHERE promoter_id IS NOT NULL;
