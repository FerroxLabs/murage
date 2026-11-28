// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The current-checkpoint predicate as text, in a module that imports NOTHING (owners: the predicate = the checkpoint lane, checkpoints.ts;
// this split = q1023-denyfable, merge of fix/1023-bump14). Module-level SQL constants in oneindex.ts and eligibility.ts are built from it
// while those modules are evaluated. checkpoints.ts imports database.ts, and database.ts reaches policy.ts and oneindex.ts, so when a
// process entered checkpoints.ts first (memory/worker.ts -> eligibility.ts -> checkpoints.ts) oneindex.ts was evaluated inside that cycle and
// read the constant before it was initialised: the memory worker exited at start with a ReferenceError. Keep this file import-free.

/** Discovery selects one head; exact citation lookup deliberately does not use this filter. */
export const CURRENT_CHECKPOINT_SQL = `NOT EXISTS(SELECT 1 FROM memory_checkpoint_members cm WHERE cm.record_id=r.id AND NOT EXISTS(SELECT 1 FROM memory_checkpoint_heads ch WHERE ch.family_id=cm.family_id AND ch.record_id=r.id AND ch.record_version=r.version AND ch.state='active'))`;
