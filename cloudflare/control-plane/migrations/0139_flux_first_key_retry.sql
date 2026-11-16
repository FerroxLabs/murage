-- SPDX-License-Identifier: AGPL-3.0-or-later
-- B4: bound on a home's FIRST Flux key taken by its poller. A failed attempt (Flux down, account refused, not linked, router 5xx) records
-- the failure here and the next cue and mint wait next_at (60 s, 2 min, 4 min, 8 min, then 10 min), so a persistently failing first key
-- cannot be asked of Flux every poll. Cleared when the key lands. One row per home, written only on the machine first-key path.
CREATE TABLE flux_first_key_retry (
  home_id TEXT PRIMARY KEY,
  failures INTEGER NOT NULL CHECK (failures >= 1),
  next_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
