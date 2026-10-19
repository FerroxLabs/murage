-- SPDX-License-Identifier: AGPL-3.0-or-later
-- A machine credential rotation owes the machine's tunnel a secret roll so the
-- previously issued connector token stops working. token_roll_due=1 is set by
-- the rotation, the next endpoint claim rolls the secret before returning any
-- token, and the flag clears only with the ready publish. Both endpoint tables
-- share one lifecycle, so both get the column; desktop rows never set it.
ALTER TABLE machine_endpoints ADD COLUMN token_roll_due INTEGER NOT NULL DEFAULT 0 CHECK (token_roll_due IN (0, 1));
ALTER TABLE installation_endpoints ADD COLUMN token_roll_due INTEGER NOT NULL DEFAULT 0 CHECK (token_roll_due IN (0, 1));
