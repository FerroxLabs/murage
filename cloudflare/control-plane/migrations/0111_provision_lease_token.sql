-- Astra round 2 #1 (warm pool L3): the provisioning attempt's fencing token, stored with its lease (provision_attempts.next_at)
ALTER TABLE provision_attempts ADD COLUMN lease_token TEXT;
