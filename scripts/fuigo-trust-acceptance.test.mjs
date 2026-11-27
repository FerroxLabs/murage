// Structural inventory only. Behavioral assurance lives in the checker/release suites
// and T1–T3 production witnesses; this file is never counted as a behavioral RED.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const REQUIRED = [
  'scripts/fuigo-bump.test.mjs', 'scripts/fuigo-trust-release.test.mjs',
  'scripts/fuigo-trust-evidence-v3.test.mjs', 'scripts/fuigo-trust-acceptance.test.mjs',
  'scripts/prepare-fuigo.test.mjs', 'scripts/release-workflows.test.mjs',
];
const PRIMARY = [
  'server/fuigo-trust-primary-production.test.ts', 'server/fuigo-trust-primary-api.test.ts',
  'server/decision/trust-origin.test.ts', 'server/drivers/acp/fuigo-trust-reply.test.ts',
  'server/folder-trust-bounds.test.ts', 'server/folder-trust-transaction.test.ts',
  'server/folder-trust-index.test.ts', 'server/folder-trust-cache-page.test.ts',
  'server/folder-trust-notice-lifetime.test.ts', 'server/folder-trust-v2-seeds-cloud.test.ts',
  'server/fuigo-trust-donor-regressions.test.ts', 'src/components/FolderTrustNote.test.ts',
];
const RETAINED = [
  'server/folder-trust-v2.test.ts', 'server/folder-trust-v2-seeds.test.ts',
  'server/folder-trust-v2-settings.test.ts', 'server/folder-trust-v2-api.test.ts',
  'server/folder-trust-reporting.test.ts', 'src/components/FolderTrustRecords.test.ts',
];
it('T-TRUST-F01-inventory: structural T4 and retained trust acceptance files block CI', () => {
  const gate = readFileSync(new URL('../ci/gate-tests.txt', import.meta.url), 'utf8').trim().split('\n');
  for (const file of [...REQUIRED, ...PRIMARY, ...RETAINED, 'server/folder-trust-v2-seeds-cloud-launcher.test.ts']) {
    const entries = gate.filter(line => line.startsWith(`${file}\t`));
    expect(entries, file).toHaveLength(1);
    if (REQUIRED.includes(file) || PRIMARY.includes(file)) expect(entries[0].split('\t')[1], file).toBe('all');
    if (file === 'server/folder-trust-v2-seeds-cloud-launcher.test.ts') expect(entries[0].split('\t')[1]).toBe('linux');
  }
});
it('T-TRUST-F06-mandatory: structural current qualification blocks publication even without a pin change', () => {
  const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const qualification = workflow.indexOf('run: node scripts/fuigo-trust-release.mjs');
  expect(qualification).toBeGreaterThan(0);
  expect(qualification).toBeLessThan(workflow.indexOf('run: node scripts/release-guard.mjs publish-prepared'));
  const step = workflow.slice(workflow.lastIndexOf('      - name:', qualification), qualification);
  expect(step).not.toMatch(/continue-on-error|fuigo.*changed|if:/);
  expect(step).toContain('needs.prepare.outputs.sha');
});
