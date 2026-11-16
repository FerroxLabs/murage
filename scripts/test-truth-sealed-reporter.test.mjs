import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import Reporter from './test-truth/sealed-progress-reporter.mjs';
import { removeTempDirSync } from '../server/testing/cleanup.ts';

it('sealed run-end retains every unhandled message and stack, including native Error properties', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sealed-reporter-'));
  vi.stubEnv('GATE_IDS', join(dir, 'run.ids.jsonl'));
  try {
    const native = new Error('unhandled child write');
    const serialized = { message: 'unhandled rejection', stack: 'rejection stack', type: 'Unhandled Rejection', vitest_test_path: 'server/example.test.ts', vitest_test_name: 'example' };
    const reporter = new Reporter();
    reporter.onTestRunEnd([{}], [native, serialized], 'failed');
    reporter.onTestRunEnd([], [], 'passed');
    const rows = readFileSync(join(dir, 'run.modules.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(rows[0]).toEqual({ kind: 'run-end', files: 1, unhandled_errors: 2, reason: 'failed', errorDetails: [
      { message: native.message, stack: native.stack }, serialized,
    ] });
    expect(rows[1]).toEqual({ kind: 'run-end', files: 0, unhandled_errors: 0, reason: 'passed', errorDetails: [] });
  } finally {
    vi.unstubAllEnvs();
    removeTempDirSync(dir);
  }
});
