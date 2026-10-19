-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Cloud door v2 (CLOUD-DOOR-V2-DESIGN.md r4 section 4B, with the r4.1 and r4.2 addenda; src/door.ts).
-- (1) The door notice is owed per (account, home, Supabase session, device key `bind`), not per (account, home). The table is recreated
--     with the two new key columns and the sender's claim id; existing rows are copied with session_id='' and bind=''. No predicate
--     excludes '', so a legacy armed unsent row is claimed and sent like any other (r3 condition 2).
-- (2) cloud_door_notice_slots: at most three notice emails per (account, home) per clock hour, reserved atomically (slot n = 1, 2, 3).
-- (3) The door's 15-minute reuse reads the emailed-code `granted` events of one Supabase session (customer-identity.ts doorRecentProofAt).
-- (4) cloud_homes.door_version: 'v2' while the home's heartbeats carry X-Murage-Door: v2 (b3-control.ts heartbeat), else NULL.
-- (5) r4.1: the desktop door mint RESERVES a completed pair hold (reserved_by = the ticket nonce, reserved_until = ticket expiry + skew);
--     it never spends it. The home spends it at exchange; an unspent reservation lapses at reserved_until.
CREATE TABLE cloud_door_notices_0107 (
  account_id TEXT NOT NULL,
  home_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  bind TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  armed INTEGER NOT NULL DEFAULT 0,
  handouts INTEGER NOT NULL DEFAULT 0,
  armed_by INTEGER,
  delivered INTEGER NOT NULL DEFAULT 0,
  claim_id TEXT,
  PRIMARY KEY (account_id, home_id, session_id, bind)
);
INSERT INTO cloud_door_notices_0107 (account_id,home_id,session_id,bind,created_at,sent_at,attempts,next_attempt_at,armed,handouts,armed_by,delivered,claim_id)
  SELECT account_id,home_id,'','',created_at,sent_at,attempts,next_attempt_at,armed,handouts,armed_by,delivered,NULL FROM cloud_door_notices;
DROP TABLE cloud_door_notices;
ALTER TABLE cloud_door_notices_0107 RENAME TO cloud_door_notices;
CREATE INDEX cloud_door_notices_due ON cloud_door_notices (next_attempt_at) WHERE sent_at IS NULL AND armed=1;
CREATE INDEX cloud_door_notices_unarmed ON cloud_door_notices (created_at) WHERE sent_at IS NULL AND armed=0;
CREATE INDEX cloud_door_notices_home ON cloud_door_notices (home_id);

CREATE TABLE cloud_door_notice_slots (
  account_id TEXT NOT NULL,
  home_id TEXT NOT NULL,
  hour INTEGER NOT NULL,
  n INTEGER NOT NULL CHECK (n BETWEEN 1 AND 3),
  at INTEGER NOT NULL,
  PRIMARY KEY (account_id, home_id, hour, n)
);

CREATE INDEX cloud_stepup_events_session ON cloud_stepup_events (user_id, session_id, kind, at);

ALTER TABLE cloud_homes ADD COLUMN door_version TEXT;

ALTER TABLE cloud_recovery_holds ADD COLUMN reserved_by TEXT;
ALTER TABLE cloud_recovery_holds ADD COLUMN reserved_until INTEGER;
