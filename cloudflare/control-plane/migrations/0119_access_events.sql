-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Cloud token custody G2 (CLOUD-TOKEN-CUSTODY.md): Ferrox holds the key to every home disk, so every use of that key, and every provider
-- rescue, console or password action on a home server, is written here BEFORE it proceeds, and the owner is told in plain words.
-- One row is both the audit entry (who/what: kind + actor, when: at, which home: home_id + generation, why: reason) and the owner notice
-- queue (the notice columns). No key, token or address is stored. cloud_unwrap_log stays as it was (throttle ledger and the 3-a-day ops alert).
-- notice_state: pending (owed), sent, no_owner (the home has no owner row, e.g. a CP0 staging machine: nobody to tell).
-- cloud_access_cursor: when a home provider action list was last read (the sweep reads the oldest-checked first, in small batches).
CREATE TABLE cloud_access_events (
  id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  source_ip TEXT,
  outcome TEXT NOT NULL DEFAULT 'requested',
  notice_state TEXT NOT NULL DEFAULT 'pending',
  notice_sent_at INTEGER,
  notice_attempts INTEGER NOT NULL DEFAULT 0,
  notice_next_at INTEGER NOT NULL,
  notice_claim TEXT
);
CREATE INDEX cloud_access_events_due ON cloud_access_events (notice_next_at) WHERE notice_state='pending';
CREATE INDEX cloud_access_events_home ON cloud_access_events (home_id, at);
CREATE TABLE cloud_access_cursor (
  home_id TEXT PRIMARY KEY,
  checked_at INTEGER NOT NULL
);
