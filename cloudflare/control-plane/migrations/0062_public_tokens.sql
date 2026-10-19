-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Cloud checkout WP7: single-use public links (src/public-tokens.ts). Number 0062 is the BUILD-PLAN slot (WP1 0059, WP3 0060, WP5 0061);
-- on this base the last file is 0051, so wrangler applies it in filename order once the other packages merge.

-- One row per live link: `#selector.secret`. The secret is never stored; `hmac` is HMAC-SHA256 over the secret and the binding below.
-- A reissue replaces BOTH selector and hmac (ON CONFLICT on the subject), so the previous pair stops existing. A used row is never reissued.
CREATE TABLE verify_tokens (
  selector TEXT NOT NULL UNIQUE,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('notice','cancellation')),
  subject_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('confirm','repudiate','clarify')),
  action TEXT NOT NULL DEFAULT '' CHECK (action IN ('','withdraw_now','cancel_at_end')),  -- clarify only; '' otherwise
  classification_rev INTEGER,
  account_id TEXT NOT NULL,        -- the Supabase user id
  email TEXT NOT NULL,             -- the account email at issue (lower case)
  email_gen TEXT NOT NULL,         -- that user's Supabase updated_at at issue
  received_at INTEGER NOT NULL,    -- the notice or request was received (ms): caps the lifetime at +14 days
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,     -- min(issued_at + 7 days, received_at + 14 days)
  cap_at INTEGER,                  -- cancellation hold link only: the subject's own cap (hold_until), which replaces received_at + 14 days;
                                   -- the sweep keeps the row (selector and used tombstone) until cap_at + 30 days. NULL: the 14-day rule.
  hmac TEXT NOT NULL,
  used_at INTEGER,
  used_by TEXT,                    -- the redeemer's op id: lets the same batch condition its other writes on "my consume won"
  PRIMARY KEY (subject_kind, subject_id, purpose, action),
  CHECK ((purpose = 'clarify') = (action <> '')),
  CHECK ((used_at IS NULL) = (used_by IS NULL))
);
CREATE INDEX verify_tokens_expiry ON verify_tokens (expires_at);

-- Fixed-window counters for the public routes: per recipient, global, per selector. `bucket` never holds a raw address.
CREATE TABLE public_mail_limits (
  bucket TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
