-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Cloud checkout WP10 r4-1 (Astra WP10-4 #1): the sender that holds a notice mail row. A claim writes a fresh claim_id; every later write of that
-- sender (the links and the stored mail, the release, the completion) is conditioned on it, so a sender whose claim lapsed writes nothing.
ALTER TABLE withdrawal_notice_mail ADD COLUMN claim_id TEXT;
