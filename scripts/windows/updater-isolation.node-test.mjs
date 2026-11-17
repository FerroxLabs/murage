import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { safeWipeSync } from '../../server/testing/safe-wipe.mjs';
import { prepareUpdaterRestart } from '../../electron/updater-restart.mjs';

// Exercise the existing production admission function with an isolated fixture,
// not a mock or a source-text assertion. No server, account, provider or PC.
test('gate isolation is rejected before packaged updater cleanup/handoff', async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'winscen-updater-'));
  const environment = { MURAGE_DATA_DIR: join(fixture, 'data'), MURAGE_USER_DATA: join(fixture, 'user-data') };
  const calls = [];
  try {
    await assert.rejects(prepareUpdaterRestart({
      environment, isClosing: () => false, isCleanedUp: () => false,
      readActivity: async () => { calls.push('read-activity'); return { bots: [], groups: [] }; },
      cleanup: async () => { calls.push('cleanup'); },
    }), /custom profile.*same profile launcher/);
    assert.deepEqual(calls, [], 'refusal must precede cleanup and handoff');
  } finally { safeWipeSync(fixture); }
});

