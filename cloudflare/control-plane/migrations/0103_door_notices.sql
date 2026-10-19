-- SPDX-License-Identifier: AGPL-3.0-or-later
-- The door (POST /v1/homes/:id/door, src/door.ts): the owner is emailed "Murage was opened from a new browser sign-in" the first time
-- each account opens each home from the members area. A NOTICE, never a gate (lanes/cloud-door/DESIGN.md section 2): one row per
-- (account, home). The hand-out ARMS the row (armed=1) in its last write, one batch that rechecks owner and generation, before its final
-- check: that write commits it to handing the ticket out, so the notice is owed from it on, whatever happens to the step-up intent's later
-- confirmation. The arming that sets armed 0 -> 1 (or inserts the row) claims the first attempt, made after the response. handouts counts
-- the hand-outs that wrote the row, armed_by is the count at which it was armed: a hand-out refused after its arming (the clock) takes it
-- back only while both are still its own (armed=0 again), so a later hand-out's notice is never lost. An unarmed row is
-- never sent; the next hand-out arms it, and
-- delivered is set once a hand-out of the row is answered with its ticket: the notice says the link was GIVEN only then, else (a
-- refused hand-out whose arming stands) it describes the access ATTEMPT. The next hand-out arms an unarmed row, and the sweep tidies unarmed rows away after a day (on cloud_door_notices_unarmed). The cron
-- sweep (sweepDoorNotices) retries only an ARMED unsent row from next_attempt_at, with backoff, until sent_at is set. The row is the
-- dedupe: one email per (account, home). next_attempt_at is also a sender's claim (DOOR_NOTICE_CLAIM_MS). No
-- ticket, nonce or address is stored; the rows of a deleted home are removed with it (b3-control.ts) and by the retention sweep
-- (cloud-machines.ts sweepCloudRetention).
CREATE TABLE cloud_door_notices (
  account_id TEXT NOT NULL,
  home_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  armed INTEGER NOT NULL DEFAULT 0,
  handouts INTEGER NOT NULL DEFAULT 0,
  armed_by INTEGER,
  delivered INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, home_id)
);
CREATE INDEX cloud_door_notices_due ON cloud_door_notices (next_attempt_at) WHERE sent_at IS NULL AND armed=1;
CREATE INDEX cloud_door_notices_unarmed ON cloud_door_notices (created_at) WHERE sent_at IS NULL AND armed=0;
CREATE INDEX cloud_door_notices_home ON cloud_door_notices (home_id);
