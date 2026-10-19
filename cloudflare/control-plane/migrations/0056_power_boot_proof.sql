-- Self-service round 5 (Astra SELFSERVICE4): a power reservation is released only on proof that the requested operation finished.
-- The home reports its kernel boot id on the heartbeat. Before dispatch the reservation records a baseline: the newest provider
-- action id on the server (build host) and the home's boot id. Settlement accepts only a new provider action past that baseline, or (Vultr)
-- a server that is up with a boot id different from the baseline. last_checked_at rotates the settlement sweep so no reservation starves.
ALTER TABLE cloud_home_health ADD COLUMN boot_id TEXT;
ALTER TABLE cloud_home_jobs ADD COLUMN baseline_action TEXT;
ALTER TABLE cloud_home_jobs ADD COLUMN baseline_boot TEXT;
ALTER TABLE cloud_home_jobs ADD COLUMN last_checked_at INTEGER;
