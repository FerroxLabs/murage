-- SPDX-License-Identifier: AGPL-3.0-or-later
-- FLUX-ENSURE-EMAIL-VERIFIED contract (c), launch flow A: Flux creates or links ONLY on email_verified:true, so every new buyer proves the
-- address before the first home links. The proof code is mailed ONCE, automatically, when the checkout completes (src/flux-email-proof.ts
-- autoSendProof). This row is that one auto-send per account and address revision: written before the send (a second webhook delivery finds it
-- and sends nothing), its state after. A failed send is tried again by the cron sweep at most once (tries 2); the buyer can always press
-- "Send a new code" on the page (the normal quota). A page refresh never writes here.
-- first_at (ITEM4-PROOF-CURRENT): the 24 h page's clock (src/flux-email-proof.ts sweepFluxEmailStuck). Set once at INSERT (the auto-send, or an
-- address move of an account whose home went active, state 'skipped'), never updated by a retry; `at` keeps its role.
-- 'queued' (ITEM 9, PROOF-MAIL-AFTER-CHECKPOINT; edited in place: 0144 is applied nowhere yet): the checkout only enqueues under its billing
-- lease; the mail goes after the checkpoint (waitUntil) or from the sweep, which claims queued -> sending once. A row queued while Flux was not
-- serving (a credential outage) stays queued until Flux is ready.
CREATE TABLE flux_email_proof_autosend (
  account_id TEXT NOT NULL,
  email_revision INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'sending', 'sent', 'failed', 'skipped')),
  tries INTEGER NOT NULL DEFAULT 1 CHECK (tries >= 1 AND tries <= 2),
  at INTEGER NOT NULL,
  first_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, email_revision)
);
CREATE INDEX flux_email_proof_autosend_due ON flux_email_proof_autosend (state, at);

-- ITEM 9 r2 (edited in place: 0144 is applied nowhere yet): the first-computer mail (0134 door_computer_notices, src/door.ts) is sent under
-- ONE claim per notice. tries: the retries started (0 = the hand-out's own send); claimed_at: when the current attempt took the claim. A
-- retry moves tries k-1 -> k conditionally, so two sweeps never both send; rows at the cap are filtered out before the sweep's LIMIT.
ALTER TABLE door_computer_notices ADD COLUMN tries INTEGER NOT NULL DEFAULT 0;
ALTER TABLE door_computer_notices ADD COLUMN claimed_at INTEGER;
