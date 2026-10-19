-- A Murage Cloud account (a murage.ai members-area Supabase user, keyed by `sub`) and a phone-companion account (a
-- Better Auth email-code user, the desktop's managed relay) are SEPARATE accounts, never linked or compared by email.
-- The "user" table backs both, and Better Auth signs in by "user".email, so a Cloud account's row must not hold a real
-- address there: it gets a synthetic, undeliverable one (cloud-<id>@cloud-account.invalid) and its contact address
-- (receipts, notices, the Stripe customer email) moves to supabase_identities.contact_email. A companion sign-in with
-- the same address as a Cloud member then simply finds (or creates) its own companion row. src/cloud-accounts.ts,
-- CONTRACT.md section 2.
ALTER TABLE supabase_identities ADD COLUMN contact_email TEXT;
UPDATE supabase_identities SET contact_email = (SELECT lower(u.email) FROM "user" u WHERE u.id = supabase_identities.user_id);
UPDATE "user" SET email = 'cloud-' || id || '@cloud-account.invalid' WHERE id IN (SELECT user_id FROM supabase_identities);
-- One Cloud account per contact address (Cloud accounts only; companion rows are not consulted).
CREATE UNIQUE INDEX supabase_identities_contact_email ON supabase_identities (contact_email);
