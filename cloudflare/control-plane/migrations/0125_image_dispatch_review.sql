-- Dispatch review (KMS signing design 10.6, 13, 13.1). Two changes.
--
-- 1. image_dispatch_auth is rebuilt (13.1 H4): SQLite cannot alter the 0124 CHECK, so a new table is created, the rows are copied, the old one is
--    dropped and the new one renamed. The states become open (written, POST not answered), settled_created (the provider answered with a server id,
--    recorded in provider_server_id), settled_failed (a parsed provider refusal), needs_review (set only by an activation or a revocation) and
--    resolved_absent / resolved_alerted (a review closed). New columns: provider_server_id (NULL until the POST answers; a rebuild has it at the
--    INSERT), settled_at and review_reason ('epoch', 'image', 'key', 'check', or 'prelabel').
--    Rows copied from 0124: an 'open' row stays open. Any other 0124 row (the old 'settled' state was never written by the code, and 'needs_review'
--    never had a writer) becomes needs_review with review_reason 'prelabel'. None of them carries the murage/dispatch label (it is new with this
--    migration), so none can be matched at the provider by it: the sweep leaves a 'prelabel' row without a server id for a manual decision.
--
-- 2. image_policy gets the trust sets the 5-minute cron diffs against (13.1 H2): accepted_fps, accepted_checks, accepted_images (JSON arrays) and
--    trust_hash. They are NULL here ON PURPOSE: the accepted image ids come from the environment's B5_PROVISIONER_CONFIG (images and imageKinds), which a
--    migration cannot read, and the fingerprint and check lists are code constants that a literal copied into SQL would let drift from the code. The
--    first cron run, which is the first act of the 5-minute invocation, stores the baseline from DEFAULT_TRUST and the config in one batch; it marks
--    nothing, because there is no earlier set to diff against.
CREATE TABLE image_dispatch_auth_v2 (
  dispatch_id TEXT PRIMARY KEY,
  epoch INTEGER NOT NULL,
  key_fp TEXT NOT NULL,
  check_sha256 TEXT NOT NULL,
  image TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','settled_created','settled_failed','needs_review','resolved_absent','resolved_alerted')),
  provider_server_id TEXT,
  settled_at INTEGER,
  review_reason TEXT
);
INSERT INTO image_dispatch_auth_v2 (dispatch_id, epoch, key_fp, check_sha256, image, created_at, state, provider_server_id, settled_at, review_reason)
  SELECT dispatch_id, epoch, key_fp, check_sha256, image, created_at,
         CASE WHEN state = 'open' THEN 'open' ELSE 'needs_review' END, NULL, NULL,
         CASE WHEN state = 'open' THEN NULL ELSE 'prelabel' END
  FROM image_dispatch_auth;
DROP TABLE image_dispatch_auth;
ALTER TABLE image_dispatch_auth_v2 RENAME TO image_dispatch_auth;
CREATE INDEX image_dispatch_auth_open ON image_dispatch_auth(state, epoch);
CREATE INDEX image_dispatch_auth_review ON image_dispatch_auth(state, created_at);

ALTER TABLE image_policy ADD COLUMN accepted_fps TEXT;
ALTER TABLE image_policy ADD COLUMN accepted_checks TEXT;
ALTER TABLE image_policy ADD COLUMN accepted_images TEXT;
ALTER TABLE image_policy ADD COLUMN trust_hash TEXT;
