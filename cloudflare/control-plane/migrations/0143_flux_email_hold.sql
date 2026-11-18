-- SPDX-License-Identifier: AGPL-3.0-or-later
-- FLUX-ENSURE-EMAIL-VERIFIED, round 1 code review (astra-code1.md, grok-code1.md).
--
-- M1: ONE hold deadline per account after Flux answered 202 pending_verification. Every caller (first key, B5 grant ask, B4 grant delivery)
-- reads it before asking Flux (flux-grants.ts ensureOwnerAccount); it is advanced only on an actual 202, to now + 15 min, and only while the
-- address revision that got the 202 is still current and no link exists (a late 202 is discarded). Only a row for the CURRENT revision holds.
-- The wake-up after a proof deletes it only once ensure returned linked. The first-key bound rows (flux_first_key_retry hold) take their
-- next_at from it, so homes of one account never renew each other's hold.
CREATE TABLE flux_email_hold (
  account_id TEXT PRIMARY KEY,
  email_revision INTEGER NOT NULL,
  until_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- M4: the deploy gate is a ONE-TIME first-rollout check. scripts/deploy.mjs requires flux_links to be empty in production only while this
-- marker is absent, and writes it after that first deploy succeeded; later deploys skip the count (real links exist after launch).
CREATE TABLE flux_email_proof_rollout (
  id TEXT PRIMARY KEY CHECK (id = 'first'),
  at INTEGER NOT NULL
);
