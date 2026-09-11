-- Moving an install's connected apps onto a FluxRouter account.
--
-- Composio cannot re-key a connection to a different user id, so the FluxRouter
-- account adopts this install's `murage_<id>` user instead of being handed a
-- copy. Three columns record the two halves of that handover, kept apart on
-- purpose:
--
--   claim_issued_at     this Worker SIGNED an assertion. Audit only, plus the
--                       seven-day backstop. It does NOT retire the install:
--                       FluxRouter may never have accepted it.
--   claim_confirmed_at  FluxRouter accepted, and the desktop said so. THIS is
--                       what starts the grace clock after which data routes
--                       return 410 migrated_to_flux.
--   last_claim_jti      the id of the most recent assertion, so a confirmation
--                       can only settle the claim it belongs to.
--
-- `claims_issued` is a counter for spotting an install that keeps re-issuing.
-- Additive throughout: the pre-claim Worker ignores every one of these columns,
-- which is what makes `wrangler rollback` a real option.
ALTER TABLE installations ADD COLUMN claim_issued_at INTEGER;
ALTER TABLE installations ADD COLUMN claim_confirmed_at INTEGER;
ALTER TABLE installations ADD COLUMN claims_issued INTEGER NOT NULL DEFAULT 0;
ALTER TABLE installations ADD COLUMN last_claim_jti TEXT;
