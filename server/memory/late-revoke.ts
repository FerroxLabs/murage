// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The reserved revoke id of the shared late-note list, in a module that imports NOTHING (owners: the late list = revoke-marker.ts /
// revoke-commit.ts; this split = q1023-cycle). memory-revocation.ts builds a module-level SQL string from it, and revoke-marker.ts sits in
// its import cycle: a process entering revoke-marker.ts (or revoke-budget.ts) first evaluated memory-revocation.ts before the constant was
// initialised (ReferenceError at load). Keep this file import-free.

/** A late note, stored once under this reserved id however many revokes hold the child (`late:<head lsn>:<count>:<hash>:<json>`, write order). */
export const LATE_REVOKE = -8;
