-- One automatic-canary pass at a time, fleet-wide (the */5 reconcile and the 1-minute cron both run autoCanaryPass; Astra and Grok
-- canary-minute round 1). A single row (id=1): the holder's random token and its expiry. Taken by compare-and-set, released only by its owner,
-- and every write of a pass (bookkeeping, each promotion) is fenced on still holding it, so a pass whose lease expired and was taken over
-- writes nothing.
CREATE TABLE auto_canary_lease (
  id INTEGER PRIMARY KEY CHECK(id=1),
  owner TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
