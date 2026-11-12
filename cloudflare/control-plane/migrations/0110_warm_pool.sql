-- Warm pool of pre-created, powered-off servers (plan: WARM-POOL-PLAN section 2). New file; applied migrations are untouched.
CREATE TABLE warm_pool (
  id TEXT PRIMARY KEY,
  env TEXT NOT NULL CHECK (env IN ('staging','production')),
  class TEXT NOT NULL CHECK (class IN ('starter','pro')),
  provider TEXT NOT NULL CHECK (provider IN ('hetzner','vultr')),
  server_type TEXT NOT NULL,
  arch TEXT NOT NULL CHECK (arch IN ('x86','arm')),
  location TEXT NOT NULL,
  image_id TEXT NOT NULL,
  image_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('warming','ready','claimed','failed','retired')),
  phase TEXT,
  server_id TEXT,
  ipv4 TEXT,
  secret_hash TEXT,
  create_call_id TEXT NOT NULL UNIQUE,
  monthly_cents INTEGER NOT NULL,
  vcpus INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  ready_at INTEGER,
  last_verified_at INTEGER,
  claimed_at INTEGER,
  home_id TEXT,
  resource_generation INTEGER,
  fail_reason TEXT,
  retired_at INTEGER,
  retire_reason TEXT,
  destroyed_at INTEGER
);
CREATE UNIQUE INDEX warm_pool_one_claim ON warm_pool(home_id, resource_generation) WHERE home_id IS NOT NULL;
CREATE UNIQUE INDEX warm_pool_server ON warm_pool(provider, server_id) WHERE server_id IS NOT NULL;
CREATE INDEX warm_pool_claimable ON warm_pool(env, class, state, image_id);

CREATE TABLE warm_pool_deliveries (
  pool_id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  resource_generation INTEGER NOT NULL,
  token_hash TEXT NOT NULL,
  payload_wrapped TEXT,
  created_at INTEGER NOT NULL,
  fetch_count INTEGER NOT NULL DEFAULT 0,
  first_fetched_at INTEGER,
  purged_at INTEGER
);

CREATE TABLE warm_pool_stock (
  sampled_at INTEGER NOT NULL,
  provider TEXT NOT NULL,
  server_type TEXT NOT NULL,
  locations TEXT NOT NULL,
  PRIMARY KEY (sampled_at, provider, server_type)
);

CREATE TABLE warm_pool_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pool_id TEXT,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT
);

CREATE TABLE warm_pool_control (
  id TEXT PRIMARY KEY CHECK (id = 'pool'),
  grabber TEXT NOT NULL DEFAULT 'off' CHECK (grabber IN ('off','observe','on','drain')),
  claims INTEGER NOT NULL DEFAULT 0 CHECK (claims IN (0,1)),
  targets_override TEXT,
  lease_holder TEXT,
  lease_until INTEGER,
  updated_at INTEGER,
  updated_by TEXT
);
INSERT INTO warm_pool_control (id) VALUES ('pool');

ALTER TABLE provision_choices ADD COLUMN pool_id TEXT;
