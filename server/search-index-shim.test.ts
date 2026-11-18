// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from 'vitest';
import * as search from './message-search-index.ts';
import * as compat from './testing/search-index-compat.ts';
import { readFileSync } from 'node:fs';
it('T-SHIM-IDENTITY: historical support is a pure pass-through on the tip', () => {
  for (const name of ['stopSearchIndex','startSearchIndex','pruneMessageSearchIntents','searchIndexTestHooks','SEARCH_FILES','MESSAGE_SEARCH_DDL','PENDING_MAX','PRUNE_PER_COMMIT','INTENT_MAX_BYTES','messageSearchIndexReady','readMessageSearchCandidates','searchCleanupPending','intentCount','searchDbPath','openSearchIndex','recovery','scrubDelay'] as const) {
    expect(compat[name], name).toBe(search[name]);
    expect(search[name], name).toBeDefined();
  }
  const table = JSON.parse(readFileSync('server/testing/RED-TABLE.json', 'utf8')) as { RED: Array<{file: string}> };
  for (const file of new Set(table.RED.map(row => row.file))) {
    expect(readFileSync(file, 'utf8'), file).not.toMatch(/from\s+['"][^'"]*\/message-search-index\.ts['"]/);
  }
});
