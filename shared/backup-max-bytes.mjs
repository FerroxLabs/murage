// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The ONE backup size ceiling. It is the largest size limit the schedule
// accepts (shared/backup-schedule.ts max), so every check on a backup's size
// (make, store, upload, download, export, restore) uses this same number.
// A plain .mjs so the Electron main process and the TypeScript server share it.
export const MAX_BACKUP_BYTES = 1024 ** 4;
