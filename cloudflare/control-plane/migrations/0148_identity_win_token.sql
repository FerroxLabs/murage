-- SPDX-License-Identifier: AGPL-3.0-or-later
-- CH1-G rule 14: the id of the batch whose compare-and-swap last wrote this identity row. Each dependent statement of that batch (event, alert resolve,
-- marker insert) runs only while its own id is the stored one, so a batch that lost the swap changes zero rows. Additive. NULL means never written by a batch.
ALTER TABLE supabase_identities ADD COLUMN win_token TEXT;
