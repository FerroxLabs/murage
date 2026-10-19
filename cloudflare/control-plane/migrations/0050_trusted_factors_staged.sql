-- Astra MAKERKIT8 #3: a trust row is STAGED (inert) until its notice is delivered and the member state is re-read. Only
-- then is it activated. Every reader counts only state='active' rows. A crash or a failed notice leaves a staged row that
-- grants nothing (and is replaced by the next attempt after STAGE_STALE_MS). Rows that existed before this migration were
-- activated by the old code, so they stay active, and new rows default to staged (fail closed).
ALTER TABLE cloud_trusted_factors ADD COLUMN state TEXT NOT NULL DEFAULT 'staged' CHECK (state IN ('staged', 'active'));
ALTER TABLE cloud_trusted_factors ADD COLUMN op TEXT;
UPDATE cloud_trusted_factors SET state = 'active';

-- op is the staging request id, which activation and cleanup are bound to.

-- Astra MAKERKIT8 #5: the code is bound to the Supabase user record generation (its email and updated_at, which Supabase
-- Auth bumps on every write to auth.users, every email change included) as well as the address. A->B->A leaves the same
-- address but a different updated_at, so the code no longer redeems. Codes issued before
-- this migration carry the generation none and never redeem.
ALTER TABLE cloud_factor_trust_codes ADD COLUMN email_gen TEXT NOT NULL DEFAULT 'none';
