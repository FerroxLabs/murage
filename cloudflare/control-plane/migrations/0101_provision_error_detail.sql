-- SPDX-License-Identifier: AGPL-3.0-or-later
-- A provisioning refusal keeps the hosting provider's own words next to its code: last_error stays host_<status>_<code>, and
-- last_error_detail holds a sanitized copy of the provider's message (at most 200 characters; anything that looks like an id, token,
-- email or IP address replaced). Operator-only: it reaches provision_attempts and the provision.failed alert, never customer text.
ALTER TABLE provision_attempts ADD COLUMN last_error_detail TEXT;
