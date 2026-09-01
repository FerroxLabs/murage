-- A per-install daily ceiling on billable Composio tool calls.
--
-- This is a fuse, not a meter. Registration stays open and the product stays
-- free; the ceiling only exists so one runaway install cannot spend the whole
-- account's quota at $4 per 1,000 calls. `calls_day` is a UTC day number, so
-- the counter resets by comparison rather than by a scheduled job.
ALTER TABLE installations ADD COLUMN calls_day INTEGER NOT NULL DEFAULT 0;
ALTER TABLE installations ADD COLUMN calls_today INTEGER NOT NULL DEFAULT 0;
ALTER TABLE installations ADD COLUMN calls_total INTEGER NOT NULL DEFAULT 0;
