-- SPDX-License-Identifier: AGPL-3.0-or-later
-- B4: link a Murage account to a Flux account, one Flux key per home, and the
-- monthly included-credit entitlements. No Flux secret is ever stored here: the home's
-- key is returned once to the caller and held only by the home.

-- One Flux account per Murage account, and one Murage account per Flux account.
CREATE TABLE flux_links (
  owner_user_id TEXT PRIMARY KEY,
  flux_account_id TEXT NOT NULL UNIQUE,
  linked_at INTEGER NOT NULL
);

-- The owner starts a link; only the hash of the state is kept. Single use.
CREATE TABLE flux_link_challenges (
  state_hash TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

-- Flux's signed proof carries a unique id; it works once.
CREATE TABLE flux_link_proofs (
  jti TEXT PRIMARY KEY,
  used_at INTEGER NOT NULL
);

-- Per-home Flux state. generation only ever goes up; it is what Flux checks to
-- retire an older key. 'stopping' means Stop was asked and Flux has not yet
-- confirmed the revocation (the cron sweep retries it).
-- lifecycle_version is bumped (conditionally, before Flux is called) by every
-- Stop, billing stop and unlink. A mint carries the version it read; the final
-- commit of a mint only lands if the version is unchanged, so a Stop that races
-- a mint always wins and the minted key is revoked, never returned.
CREATE TABLE flux_home_keys (
  home_id TEXT PRIMARY KEY,
  plan TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  state TEXT NOT NULL DEFAULT 'none' CHECK (state IN ('none', 'active', 'stopping', 'stopped')),
  cap_microcents INTEGER NOT NULL CHECK (cap_microcents > 0),
  cap_custom INTEGER NOT NULL DEFAULT 0 CHECK (cap_custom IN (0, 1)),
  -- Billing stopped this home (cancelled, refunded, charged back). The owner cannot
  -- resume it. Only a NEW paid invoice whose period starts after
  -- billing_hold_at clears it; an old or replayed invoice never does.
  billing_hold INTEGER NOT NULL DEFAULT 0 CHECK (billing_hold IN (0, 1)),
  billing_hold_at INTEGER,
  lifecycle_version INTEGER NOT NULL DEFAULT 0 CHECK (lifecycle_version >= 0),
  key_expires_at INTEGER,
  updated_at INTEGER NOT NULL
);

-- Machine renewal operations. op_id is derived from home + machine generation +
-- current Flux generation, so the same renewal request cannot mint twice.
CREATE TABLE flux_mint_ops (
  op_id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Every paid invoice Billing has told us about, once. A repeat never touches the
-- billing hold. reversed_at is set when the invoice is refunded or disputed.
CREATE TABLE flux_invoices (
  invoice_id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  plan TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('period', 'upgrade_delta')),
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  reversed_at INTEGER,
  created_at INTEGER NOT NULL
);

-- Included-credit entitlements. grant_id is the idempotency key sent to Flux.
-- entitlement_key is unique per home and subscription period
-- (home:<id>:period:<periodStart>, plus :delta:<toPlan> for an upgrade), so a
-- second invoice in the same period grants nothing.
-- recipient_flux_account_id is fixed from the link when the grant is created (or,
-- if the owner had not linked yet, at the first delivery attempt after linking).
-- If the owner unlinks or relinks to another Flux account first, the grant is
-- cancelled, never delivered elsewhere. expires_at is the period end plus one
-- more month (one month of carryover); a pending grant past it becomes 'expired'.
CREATE TABLE flux_grants (
  grant_id TEXT PRIMARY KEY,
  entitlement_key TEXT NOT NULL UNIQUE,
  home_id TEXT NOT NULL,
  invoice_id TEXT,
  kind TEXT NOT NULL DEFAULT 'period' CHECK (kind IN ('period', 'upgrade_delta')),
  recipient_flux_account_id TEXT,
  plan TEXT NOT NULL,
  amount_microcents INTEGER NOT NULL CHECK (amount_microcents > 0),
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed', 'cancelled', 'reversed', 'expired')),
  reversal_state TEXT NOT NULL DEFAULT 'none' CHECK (reversal_state IN ('none', 'requested', 'done')),
  reversal_reason TEXT CHECK (reversal_reason IS NULL OR length(reversal_reason) <= 32),
  reversal_attempts INTEGER NOT NULL DEFAULT 0,
  reversal_last_attempt_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER,
  last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 64),
  created_at INTEGER NOT NULL,
  delivered_at INTEGER
);
CREATE INDEX flux_grants_by_status ON flux_grants (status, last_attempt_at);
CREATE INDEX flux_grants_by_home ON flux_grants (home_id, status);
CREATE INDEX flux_grants_by_reversal ON flux_grants (reversal_state, reversal_last_attempt_at);
