-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Cloud browser as full owner (browser-owner/DESIGN.md): the control plane's half. Nothing here changes an existing row's meaning.
--
-- cloud_homes.door_proof: 1 while the home's heartbeats carry x-murage-owner-factor: 1 (an image that advertises the remembered-owner
-- factor). The door stamps a browser ticket's `proof` claim only for such a home; an older image parses no such claim, so it gets today's ticket.
ALTER TABLE cloud_homes ADD COLUMN door_proof INTEGER NOT NULL DEFAULT 0;

-- Home-to-control-plane calls (src/home-api.ts), HMAC signed with the home's bootstrap secret. One row per accepted call, so a replay of the
-- same signed body (same nonce) is refused. Rows past expires_at are deleted as new calls come in.
CREATE TABLE home_api_nonces (
  home_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (home_id, nonce)
);
CREATE INDEX home_api_nonces_expiry ON home_api_nonces(expires_at);

-- The fresh code for a high-risk act (owner-code-send / owner-code-verify). One live challenge per (home, device, act). The code itself is
-- never stored: code_hash is an HMAC over home, generation, device, act, challenge, account, address and the code.
CREATE TABLE home_owner_codes (
  challenge_id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  account_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  act TEXT NOT NULL,
  label TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  email TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX home_owner_codes_act ON home_owner_codes(home_id, device_id, act);

-- Every code send, for the limits that are NOT the account's step-up budget: 30 s between sends and 12 a day, per home.
CREATE TABLE home_owner_code_sends (
  id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  challenge_id TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX home_owner_code_sends_home ON home_owner_code_sends(home_id, at);

-- Owner events the home reports (owner-event): deduped on (home_id, seq); a row is mailed once, paced like door notices, the rest folded.
CREATE TABLE home_owner_events (
  home_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  generation INTEGER NOT NULL,
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  mailed_at INTEGER,
  claim_id TEXT,
  next_attempt_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (home_id, seq)
);
CREATE INDEX home_owner_events_due ON home_owner_events(mailed_at, next_attempt_at);
CREATE TABLE home_owner_event_slots (
  home_id TEXT NOT NULL,
  hour INTEGER NOT NULL,
  n INTEGER NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (home_id, hour, n)
);

-- The mail "A computer was connected to your Murage home" (door.ts): one row per ticket nonce that was handed out for a first computer.
CREATE TABLE door_computer_notices (
  home_id TEXT NOT NULL,
  ticket_nonce TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  PRIMARY KEY (home_id, ticket_nonce)
);
