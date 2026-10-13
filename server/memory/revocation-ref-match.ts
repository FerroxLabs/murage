// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Imports nothing, on purpose: restore.ts builds RECORD_TOMBSTONE_REVOCATION_TAIL from REF_MATCH while it loads, and the module that used to
// define it (revocation.ts) is in an import cycle with restore.ts, so a process that reached restore.ts first read it before it existed
// ("Cannot access 'REF_MATCH' before initialization"). See revocation.ts for why the extra CAST term is there.
export const REF_MATCH = (ids: string) => `CAST(x.ref_id AS TEXT) IN (${ids}) AND +x.ref_id IN (${ids})`;
