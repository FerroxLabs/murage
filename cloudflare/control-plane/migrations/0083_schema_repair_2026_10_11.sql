-- Schema repair, 2026-10-11. Staging D1 applied 0037_supabase_identity.sql on 2026-10-10 08:32 UTC from an OLDER
-- version of that file (commit f5df74b8f: supabase_identities with `email_iat INTEGER NOT NULL`, and an
-- account_link_events kind list without 'email_conflict_cleared'). Commit 262bbcb38 then rewrote the file in place
-- (`email_conflict TEXT`, no email_iat, the wider kind list), so staging's live tables no longer match what the code
-- expects: every signed-in route failed with "no such column: s.email_conflict" and every insert would have failed on
-- email_iat NOT NULL. A comparison of staging against 0001..0081 applied to an empty database found exactly these two
-- tables drifted and nothing else.
--
-- RULE: a migration that has been applied anywhere is never edited again. A change of shape is a NEW migration.
-- This file is the repair for that one mistake, not a licence to repeat it.
--
-- Method: rebuild both tables to the expected shape. It is safe on a database already in the expected shape (the
-- same shape comes out again) and on staging's drifted shape, because it copies only the columns present in BOTH
-- shapes and never names email_iat or email_conflict. On a database in the expected shape any non-NULL
-- email_conflict would be reset to NULL by the copy. That column is a transient flag the next request recomputes,
-- production has no Supabase identities yet, and staging never had the column.

CREATE TABLE supabase_identities_new (
  sub TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES "user" ("id") ON DELETE CASCADE,
  via TEXT NOT NULL CHECK (via = 'created'),
  created_at INTEGER NOT NULL,
  email_conflict TEXT,
  email_revision INTEGER NOT NULL DEFAULT 0,
  contact_email TEXT
);
INSERT INTO supabase_identities_new (sub, user_id, via, created_at, email_revision, contact_email)
  SELECT sub, user_id, via, created_at, email_revision, contact_email FROM supabase_identities;
DROP TABLE supabase_identities;
ALTER TABLE supabase_identities_new RENAME TO supabase_identities;
CREATE UNIQUE INDEX supabase_identities_contact_email ON supabase_identities (contact_email);

CREATE TABLE account_link_events_new (
  id TEXT PRIMARY KEY,
  sub TEXT NOT NULL,
  user_id TEXT,
  email TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('created', 'refused_email_taken', 'email_updated', 'email_conflict', 'email_conflict_cleared')),
  at INTEGER NOT NULL
);
INSERT INTO account_link_events_new (id, sub, user_id, email, kind, at)
  SELECT id, sub, user_id, email, kind, at FROM account_link_events;
DROP TABLE account_link_events;
ALTER TABLE account_link_events_new RENAME TO account_link_events;
CREATE INDEX account_link_events_sub_idx ON account_link_events (sub, at);
