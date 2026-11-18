// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import { database, closeDatabase } from '../database.ts';
import { stopWalMaintenance } from '../wal-maintenance.ts';
import { stopSearchIndex } from '../message-search-index.ts';
// Unref maintenance workers must finish before this standalone boot probe exits.
const hold = setInterval(() => {}, 1000);
try {
  database(); closeDatabase();
  assert.equal(await stopWalMaintenance(), true);
  assert.equal(await stopSearchIndex(), true);
} finally { clearInterval(hold); }
