-- Cloud checkout WP3 r7 (Astra WP3-7 #1, #2): our OWN retained record of every refund or credit note we asked Stripe to create, written under
-- the home's billing lease (fenced) and never edited by anything outside this worker. Stripe metadata (op_id, submission) can be edited by
-- anyone with Dashboard or API access, so it never proves who owns an object; this journal does. One row per operation and submission number:
--   intent_at        written BEFORE the create call, in the same fenced batch as the operation's submission number (intent_journaled = 1);
--   object_id        the id the create call RETURNED for that submission, written once right after it returned (COALESCE: never replaced);
-- An object proves ownership only when its id is the object_id recorded here for that operation and submission. A submission whose call never
-- returned an id is released as unpaid only on affirmative evidence (intent journaled, no id returned, and a complete Stripe listing shows no
-- object for that invoice/payment and amount since the intent). Rows are retained when the operation is quarantined or released.
CREATE TABLE IF NOT EXISTS refund_submission_journal (
  op_id TEXT NOT NULL,                                                       -- refund_ops.id
  submission INTEGER NOT NULL,                                               -- refund_ops.submission the create call used (its idempotency key)
  object_kind TEXT NOT NULL CHECK (object_kind IN ('credit_note', 'refund')),
  invoice_id TEXT,                                                           -- the invoice a credit note was asked for
  payment_intent TEXT,                                                       -- the payment a refund was asked for
  amount_cents INTEGER NOT NULL,                                             -- the amount asked for
  intent_at INTEGER NOT NULL,                                                -- when the intent was recorded (before the call)
  intent_journaled INTEGER NOT NULL DEFAULT 1,                               -- 0 = the intent predates this journal (only the returned id is known)
  object_id TEXT,                                                            -- cn_... or re_... as the create call returned it
  returned_at INTEGER,
  PRIMARY KEY (op_id, submission)
);
CREATE INDEX IF NOT EXISTS refund_submission_journal_object ON refund_submission_journal (object_id);
