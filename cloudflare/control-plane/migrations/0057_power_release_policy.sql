-- Self-service round 6 (Astra SELFSERVICE5): only a correlated provider receipt (the call's own action id) completes a power
-- reservation. An unresolved one is released after the uncertain window only as 'unconfirmed_released' (never done), once the provider
-- answers that the server is up and the home has sent several consecutive fresh heartbeats (fresh_beats, last_beat_at). A receipt that
-- arrives after that is recorded (late_receipt); the mutation is never replayed.
ALTER TABLE cloud_home_jobs ADD COLUMN fresh_beats INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cloud_home_jobs ADD COLUMN last_beat_at INTEGER;
ALTER TABLE cloud_home_jobs ADD COLUMN late_receipt TEXT;
