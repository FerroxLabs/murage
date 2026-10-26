-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Cloud door: the remembered owner browser factor (CLOUD-DOOR-OWNER-FACTOR-DESIGN-r3 §4.1, src/door.ts, src/b3-control.ts).
-- cloud_homes.door_proof: 1 while the home's heartbeats carry X-Murage-Owner-Factor: 1 (a 1.0.5 app that advertises the factor
-- in its health body), else 0. The door mint stamps a browser ticket's `proof` claim only for a home at door_proof=1. An old app
-- server never emits the health field, so murage-control sends no header and this stays 0: the CP mints today's ticket.
ALTER TABLE cloud_homes ADD COLUMN door_proof INTEGER NOT NULL DEFAULT 0;
