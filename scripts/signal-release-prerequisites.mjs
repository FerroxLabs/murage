import { safeWipeSync } from "../server/testing/safe-wipe.mjs";
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertReleasePin, json, PIN_PATH, ROOT } from './signal-inventory.mjs';
import { assertGateReport } from './signal-gate-report.mjs';

// Every release mutation and the early workflow gate use this function.
// No cached receipt or environment opt-out: qualify the current checkout anew.
export function assertSignalReleaseReady() {
  const gatePath = new URL('../ci/gate-post-g0.txt', import.meta.url);
  const gates = readFileSync(gatePath, 'utf8')
    .split(/\r?\n/).filter(line => line && !line.startsWith('#')).map(line => line.split('\t'));
  if (gates.length !== 5 || gates.some(row => row.length !== 2 || !row.every(Boolean))) {
    throw new Error('Signal release check requires exactly five named post-G0 gates');
  }
  // Refuse before spawning tests or touching release credentials.
  assertReleasePin(json(PIN_PATH));
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const temporary = mkdtempSync(join(tmpdir(), 'signal-post-g0-'));
  try {
    const report = join(temporary, 'result.json');
    const result = spawnSync(process.execPath, [
      'node_modules/vitest/vitest.mjs', 'run', '--config', 'scripts/signal-gate.test-config.mjs',
      ...new Set(gates.map(([file]) => file)),
      '--testNamePattern', `^(?:${gates.map(([, name]) => escape(name)).join('|')})$`,
      '--reporter=default', '--reporter=json', `--outputFile=${report}`,
    ], {
      cwd: ROOT, env: { ...process.env, RELEASE: '1' },
      // upload's stdout is the numeric release ID; diagnostics belong on stderr.
      stdio: ['ignore', 2, 2], timeout: 10 * 60_000,
    });
    if (result.error || result.status !== 0) {
      throw new Error('Signal post-G0 tests did not complete successfully; refusing release');
    }
    return assertGateReport(gatePath, report);
  } finally {
    safeWipeSync(temporary);
  }
}
