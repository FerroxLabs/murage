-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Objections to keeping refund codes (terms r11 section 5(2), GDPR Art 18(1)(d) and 21, Astra ASTRA-REFUND3 #4). Recording an objection
-- (POST /v1/admin/refund-identity-objection, action "object") restricts that person at once: their codes are kept but never used to
-- refuse anyone. A 7-day request that would need them (their own, or one matching their codes) waits, recorded with its receipt time,
-- exactly as in an outage. The restriction lasts until the decision notice has been sent to the person (action "decision_notice_sent",
-- with the decision): only then are waiting requests decided, by the sweep, as of their receipt time. decision "erase" deletes the codes
-- of the payments made up to the decision (they are never captured again), "keep" keeps them for the rest of the 24 months.
-- The EU and UK statutory withdrawal never waits on this (it never waits on the identity check).
-- One row per person: a later objection after a decision opens it again.
CREATE TABLE refund_identity_restrictions (
  user_id TEXT PRIMARY KEY,
  objected_at INTEGER NOT NULL,
  decision TEXT CHECK (decision IN ('keep','erase')),
  decided_at INTEGER,
  notice_sent_at INTEGER
);
CREATE INDEX refund_identity_restrictions_open ON refund_identity_restrictions (notice_sent_at, objected_at);
