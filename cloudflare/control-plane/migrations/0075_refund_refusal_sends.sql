-- SPDX-License-Identifier: AGPL-3.0-or-later
-- One lock between an objection and a refusal email (Astra ASTRA-REFUND5 #2). Claiming a "not_first_payment" refusal notice for
-- sending writes, in the same batch as the claim and its revalidation, one row per person the refusal rests on (the asker, and everyone
-- whose codes match the payment's). Recording an objection fails while a live row names that person, and is tried again once the send
-- has finished (the row is removed right after the handoff, success or failure; `until` bounds a crashed sender). So an objection either
-- lands before the claim (the refusal is held or cancelled, never sent) or after the handoff (the refusal went out first; a failed
-- send is then revalidated on retry and never sent).
CREATE TABLE refund_refusal_sends (
  user_id TEXT NOT NULL,
  holder TEXT NOT NULL,
  notice_id TEXT NOT NULL,
  until INTEGER NOT NULL,
  PRIMARY KEY (user_id, holder)
);
