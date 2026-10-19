-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Retiring a previous refund-identity HMAC key (refund-identity.ts retireRedundantKeys; Astra ASTRA-REFUND2 #4).
-- While REFUND_KEY_SECRET_PREVIOUS is configured every capture hashes under both keys, so new records always carry previous-version keys
-- too. Once no stored payment is left that has previous-version keys WITHOUT the matching current-version keys (the old-only records have
-- aged out under the 24-month retention), the previous-version keys and claims are redundant: the billing sweep deletes them (claims are
-- carried over to the current-version keys first), stops hashing with that key, and records retired_at here. The previous key can then
-- be removed from the Worker without stopping the check.
ALTER TABLE refund_identity_keyring ADD COLUMN retired_at INTEGER;
