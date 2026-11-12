-- Image signature support: the 1 h provider re-check cache, and the durable policy epoch (a rolled-back bundle cannot create servers).
CREATE TABLE image_recheck (
  env TEXT NOT NULL,
  image_id TEXT NOT NULL,
  sig_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  image_size TEXT NOT NULL,
  arch TEXT NOT NULL,
  checked_at INTEGER NOT NULL,
  PRIMARY KEY (env, image_id, sig_hash, arch)
);
CREATE TABLE image_policy (
  id TEXT PRIMARY KEY CHECK (id = 'current'),
  epoch INTEGER NOT NULL
);
INSERT INTO image_policy (id, epoch) VALUES ('current', 0);
