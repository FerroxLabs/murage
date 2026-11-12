// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared predicates keep classifier and marker access on the same optional indexes.
export const SETTLE_SEEDING_FOLD_PREDICATE = "state='seeding' AND kind='bulk' AND CASE WHEN json_valid(root) THEN json_extract(root,'$.cause')='fold' ELSE 0 END";
// An absent prerequisite must throw, never fall back to scanning job history.
export const SEEDING_FOLD_SQL = `SELECT revoke_id FROM memory_revoke_jobs INDEXED BY memory_revoke_jobs_seeding_fold WHERE ${SETTLE_SEEDING_FOLD_PREDICATE} ORDER BY revoke_id LIMIT 1`;
export const ACTIVE_FLOW_SQL = "SELECT revoke_id FROM memory_revoke_jobs INDEXED BY memory_revoke_jobs_active_flow WHERE state='active' AND phase='flow' ORDER BY revoke_id LIMIT 1";
