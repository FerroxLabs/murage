-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Two-tier alerts: a P8 row that aged out unconfirmed owes the daily digest one watch-ended line. The age-out sets the marker, and only a
-- digest that carried the line and got a 2xx clears it, so a webhook that is down for days still delivers it once.
ALTER TABLE cloud_alerts ADD COLUMN ageout_notice INTEGER;
