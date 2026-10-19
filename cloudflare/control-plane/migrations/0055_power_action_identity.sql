-- Self-service round 4 (Astra SELFSERVICE3 #1): a power reservation records the provider operation it stands for (the server and,
-- when the provider answered, its action id) and is released only once the provider confirms that operation's terminal status.
ALTER TABLE cloud_home_jobs ADD COLUMN server_id TEXT;
ALTER TABLE cloud_home_jobs ADD COLUMN action_id TEXT;
