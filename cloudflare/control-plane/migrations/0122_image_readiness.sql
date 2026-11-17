-- Image readiness for sales (KMS signing design 9.8, 12.3). One row, written by the readiness check: whether each arch can be built from a
-- verified image, and the policy epoch (image_policy.epoch, 0121) the bundle that computed it carried. Sales admission compares this row's
-- epoch with the CURRENT durable policy epoch: a row computed by an older bundle never admits a sale after the epoch was raised.
CREATE TABLE image_readiness (
  id TEXT PRIMARY KEY CHECK (id = 'current'),
  config_hash TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  usable_x86 INTEGER NOT NULL CHECK (usable_x86 IN (0,1)),
  usable_arm INTEGER NOT NULL CHECK (usable_arm IN (0,1)),
  zero_runs INTEGER NOT NULL DEFAULT 0,
  checked_at INTEGER NOT NULL
);
