-- SPDX-License-Identifier: AGPL-3.0-or-later
-- The Flux Router Terms of Service version a customer accepted in the same acceptance as ours (checkout and re-accept). Nullable: a row
-- written before the Flux line was shown has none, stays valid and readable, and is not sent through a re-accept (the latest-acceptance
-- rules look at our three document versions only).
ALTER TABLE terms_acceptances ADD COLUMN flux_terms_version TEXT;
