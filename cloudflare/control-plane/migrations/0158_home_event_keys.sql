-- J5b r7 draft (DESIGN-J5b-r7.md section 7: migration 0158_home_event_keys.sql). Numbers up to 0157 are taken (0157 is the checkout outbox).
-- THE NUMBER IS RECHECKED AT INTEGRATION: take the next unused number on the integration line at that moment and rename the file; nothing else refers to it.
-- Apply this migration BEFORE the Worker that records home event keys (a Worker on a D1 without the table cannot record a key).
-- home_event_keys: one row per (home, kind, event time) the control plane has accepted, so a replayed heartbeat never opens a second alert for the same event
-- even after the alert was resolved and aged out (91 day sweep). seq is a per-(home, kind) acceptance counter: retention keeps the 128 highest seq,
-- never an order by wall-clock time (first_seen is kept for audit only, and a stepped clock must not change which keys survive).
CREATE TABLE home_event_keys (
  home_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  at INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  first_seen INTEGER NOT NULL,
  PRIMARY KEY (home_id, kind, at)
) WITHOUT ROWID;
