-- Dispatch authorizations (KMS signing design 9.6, 10.4, 10.6). Every creating or rebuilding call to the provider first takes one row here through a
-- conditional INSERT that succeeds only while the durable policy epoch (image_policy.epoch) is not above the capability's epoch, immediately before
-- the POST. The row carries what a later revocation needs to find it: the signing key, the check hash and the image. state: open (sent or about to
-- be, no settled answer yet), settled, needs_review (a matching key, check hash or image was revoked).
CREATE TABLE image_dispatch_auth (
  dispatch_id TEXT PRIMARY KEY,
  epoch INTEGER NOT NULL,
  key_fp TEXT NOT NULL,
  check_sha256 TEXT NOT NULL,
  image TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','settled','needs_review'))
);
CREATE INDEX image_dispatch_auth_open ON image_dispatch_auth(state, epoch);
