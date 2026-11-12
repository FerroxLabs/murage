-- Readiness validity per arch (KMS signing design 10.5): valid_until = min(signature expiry, re-check expiry), epoch ms. A row past it is not usable
-- at once. 0 means "not usable" (also the value of every row written before this column existed).
ALTER TABLE image_readiness ADD COLUMN valid_until_x86 INTEGER NOT NULL DEFAULT 0;
ALTER TABLE image_readiness ADD COLUMN valid_until_arm INTEGER NOT NULL DEFAULT 0;
