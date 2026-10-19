-- Cloud checkout WP9 r3-3 (Astra WP9-3 #3): contract_deadlines is write-once in fact, not only by convention. 0064 blocked UPDATE; these
-- triggers close the other ways a frozen payment moment could move:
--  - a first write must be valid: integer milliseconds (not seconds), a known source, and the subscription the contract itself records
--    (checkout consent, else its insert-only contract link) for a completed contract. Anything else aborts.
--  - a second write for the same contract never lands: INSERT OR IGNORE keeps working, and INSERT OR REPLACE / REPLACE (whose implicit
--    delete fires no DELETE trigger) is silently ignored, so the first value stands.
--  - DELETE is refused while the contract exists, so DELETE + re-insert cannot move it either. Retention removes the contract first.
-- (Two triggers with WHEN clauses rather than one CASE, so each is independent of trigger firing order.)
CREATE TRIGGER contract_deadlines_written_once BEFORE INSERT ON contract_deadlines
  WHEN EXISTS (SELECT 1 FROM contract_deadlines x WHERE x.consent_id=NEW.consent_id)
BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER contract_deadlines_first_write_valid BEFORE INSERT ON contract_deadlines
  WHEN NOT EXISTS (SELECT 1 FROM contract_deadlines x WHERE x.consent_id=NEW.consent_id)
    AND (typeof(NEW.paid_at)<>'integer' OR NEW.paid_at<1000000000000 OR typeof(NEW.frozen_at)<>'integer' OR NEW.source NOT IN ('observed','billing')
      OR NEW.subscription_id IS NULL OR NEW.subscription_id=''
      OR NOT EXISTS (SELECT 1 FROM checkout_consents c WHERE c.id=NEW.consent_id AND c.completed_at IS NOT NULL
        AND COALESCE(c.stripe_subscription_id,(SELECT l.subscription_id FROM contract_links l WHERE l.consent_id=c.id))=NEW.subscription_id))
BEGIN SELECT RAISE(ABORT, 'contract_deadlines_invalid_first_write'); END;
CREATE TRIGGER contract_deadlines_no_delete BEFORE DELETE ON contract_deadlines
  WHEN EXISTS (SELECT 1 FROM checkout_consents c WHERE c.id=OLD.consent_id)
BEGIN SELECT RAISE(ABORT, 'contract_deadlines_write_once'); END;
