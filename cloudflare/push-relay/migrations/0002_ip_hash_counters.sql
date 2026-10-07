-- IP counter scope suffixes now contain only rotating HMAC-SHA-256 digests.
-- Discard every legacy IP scope, including normalized IPv6 and malformed input.
DELETE FROM relay_counters WHERE scope LIKE 'ip-%';
