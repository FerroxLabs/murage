// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Every bound the app-grant readers use, one copy each
// (lanes/release103/APP-GRANT-DESIGN-FINAL.AGREED-r10.md). A reader that runs
// past one of these says so, and the caller holds what it could not read
// whole; nothing here shortens what policy reads to make it fit.

/** Rule 37: the most nodes one argument scan reads. */
export const SCAN_NODES = 1_000_000;
/** Rule 37: the deepest nesting one argument scan follows. */
export const SCAN_DEPTH = 64;
/** Rule 37: the most string text, in UTF-16 code units, one scan reads. No
 * per-string cap: a long string is read whole up to this total. */
export const SCAN_TOTAL = 16 * 1024 * 1024;

/** Rule 10: how many wrappers (`use_tool` inside `use_tool`) are opened
 * before the call is held unread. */
export const WRAP_DEPTH = 3;

/** Rule 56d: `readValues` depth, counted from the addressing key's value (an
 * array is 1, an object in it 2, an object in that 3). */
export const READ_VALUES_DEPTH = 3;

/** Rule 56a: how long the verdict waits for a connector schema it has not
 * cached. */
export const SCHEMA_FETCH_MS = 2_000;

/** Rule 15: the largest call the Pi gate sends in one message (the RPC frame
 * limit, 32 MiB, minus headroom). A larger call is sent cut and held unread. */
export const GATE_MESSAGE_BYTES = 16 * 1024 * 1024;

/** Rule 63 step 4: the bounded walk that expands a glob operand. */
export const GLOB_WALK_ENTRIES = 10_000;

/** Rule 73a: the walk of the real tree under a search root. */
export const WALK_ENTRIES = 100_000;
export const WALK_MS = 3_000;
/** Rule 73a: how long one walk of a root is reused within a turn. */
export const WALK_CACHE_MS = 10_000;

/** Rule 74a: the owner's interactive login capture. */
export const CAPTURE_MS = 5_000;
export const CAPTURE_BYTES = 1024 * 1024;

/** Rule 74d: the consistency check of the pinned shell form. */
export const CHECK_MS = 2_000;
export const CHECK_WINDOWS_MS = 10_000;
export const CHECK_BYTES = 1024 * 1024;

/** Rule 75d: each git configuration file the disk-fact callback reads. */
export const GIT_CONFIG_BYTES = 64 * 1024;

/** Rule 68c: how long the Codex driver waits for the hook's `SessionStart`
 * post before it refuses the turn. */
export const HOOK_LIVENESS_MS = 10_000;

/** Rule 72: the same (tool, text) denied this many times in one turn raises
 * the card instead. */
export const NARROW_DENIALS_BEFORE_CARD = 3;
