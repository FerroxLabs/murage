-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Door device confirmation (door-confirm/DESIGN.md sections 2 and 5, with the r8 corrections, src/device-join.ts). Additive, except the
-- verify_tokens rebuild that lets subject_kind be 'device_join' (a CHECK cannot be altered on D1, 0107 is the pattern).
-- Nothing here is read while DOOR_JOIN_REQUIRED is unset.
CREATE TABLE cloud_device_joins (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  home_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('desktop','phone')),
  tier TEXT NOT NULL CHECK (tier IN ('first','later')),
  state TEXT NOT NULL CHECK (state IN ('ticketed','used','ended','waiting','ready','cancelled','lapsed')),
  created_at INTEGER NOT NULL,
  hold_until INTEGER,
  ready_at INTEGER,
  used_at INTEGER,
  ended_at INTEGER,
  ended_by TEXT CHECK (ended_by IS NULL OR ended_by IN ('link','my_cloud','lapse')),
  yes_at INTEGER,
  redeemed_bind TEXT,
  last_ticket_exp INTEGER,
  ticket_nonce TEXT,
  place TEXT,
  needs_revoke INTEGER NOT NULL DEFAULT 0,
  mail_sent_at INTEGER,
  mail_count INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  claim_id TEXT,
  ready_mail_sent_at INTEGER,
  cancel_until INTEGER NOT NULL DEFAULT 0,
  removed_count INTEGER NOT NULL DEFAULT 0,
  also_removed_at INTEGER,
  removed_mail_at INTEGER
);
CREATE UNIQUE INDEX cloud_device_joins_live_later ON cloud_device_joins (home_id) WHERE tier='later' AND state IN ('waiting','ready');
CREATE UNIQUE INDEX cloud_device_joins_live_first ON cloud_device_joins (home_id) WHERE tier='first' AND state='ticketed';
CREATE INDEX cloud_device_joins_home ON cloud_device_joins (home_id, tier, state);
CREATE INDEX cloud_device_joins_sweep ON cloud_device_joins (next_attempt_at) WHERE state IN ('waiting','ready','ticketed') OR needs_revoke=1;

ALTER TABLE cloud_homes ADD COLUMN join_cancel_at INTEGER;

-- Every ticket that could enroll a NEW key (first, join, customer hold). Kept at least as long as the latest cancellation link of the join
-- it belongs to can be used (r8-1), the sweep deletes by retain_until.
CREATE TABLE cloud_door_desktop_tickets (
  home_id TEXT NOT NULL,
  bind TEXT NOT NULL,
  nonce TEXT NOT NULL,
  join_id TEXT,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  retain_until INTEGER NOT NULL,
  PRIMARY KEY (home_id, nonce)
);
CREATE INDEX cloud_door_desktop_tickets_home ON cloud_door_desktop_tickets (home_id, issued_at);
CREATE INDEX cloud_door_desktop_tickets_retain ON cloud_door_desktop_tickets (retain_until);

-- The join mail budget, apart from the door notice slots: 3 an hour and 10 a day per home.
CREATE TABLE cloud_device_join_mail (
  home_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (home_id, at, n)
);

CREATE TABLE verify_tokens_0135 (
  selector TEXT NOT NULL UNIQUE,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('notice','cancellation','device_join')),
  subject_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('confirm','repudiate','clarify')),
  action TEXT NOT NULL DEFAULT '' CHECK (action IN ('','withdraw_now','cancel_at_end')),
  classification_rev INTEGER,
  account_id TEXT NOT NULL,
  email TEXT NOT NULL,
  email_gen TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  cap_at INTEGER,
  hmac TEXT NOT NULL,
  used_at INTEGER,
  used_by TEXT,
  PRIMARY KEY (subject_kind, subject_id, purpose, action),
  CHECK ((purpose = 'clarify') = (action <> '')),
  CHECK ((used_at IS NULL) = (used_by IS NULL))
);
INSERT INTO verify_tokens_0135 (selector,subject_kind,subject_id,purpose,action,classification_rev,account_id,email,email_gen,received_at,issued_at,expires_at,cap_at,hmac,used_at,used_by)
  SELECT selector,subject_kind,subject_id,purpose,action,classification_rev,account_id,email,email_gen,received_at,issued_at,expires_at,cap_at,hmac,used_at,used_by FROM verify_tokens;
DROP TABLE verify_tokens;
ALTER TABLE verify_tokens_0135 RENAME TO verify_tokens;
CREATE INDEX verify_tokens_expiry ON verify_tokens (expires_at);
