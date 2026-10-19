-- SPDX-License-Identifier: AGPL-3.0-or-later
-- A queued "not your first payment" refusal notice is revalidated at every send, by the request, the refund operation and the billing
-- sweep alike (Astra ASTRA-REFUND5 #1). canceled_at marks a refusal that no longer stands and must never be sent: its operation reopened
-- (an objection) or paid, or the codes it rested on were erased. A refusal resting on codes under an open objection is held instead
-- (next_attempt_at moves on; no try is counted). A later decision that refuses again records the same notice id and clears canceled_at.
ALTER TABLE billing_notices ADD COLUMN canceled_at INTEGER;
