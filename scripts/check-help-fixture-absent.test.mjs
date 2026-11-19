import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { removeTempDirSync } from '../server/testing/cleanup.ts';
import { checkHelpFixtureAbsent } from './check-help-fixture-absent.mjs';
const roots = [];
afterEach(() => { for (const dir of roots.splice(0)) removeTempDirSync(dir); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'help-package-exclusion-')); roots.push(root);
  const dist = join(root, 'ui'), release = join(root, 'release.yml');
  mkdirSync(dist); writeFileSync(release, 'jobs:\n  release:\n    run: pnpm package:linux\n');
  return { root, dist, release };
}
it('rejects an empty package and accepts ordinary released assets', () => {
  const f = fixture(); expect(() => checkHelpFixtureAbsent(f.dist, f.release, [])).toThrow('Empty dist');
  writeFileSync(join(f.dist, 'app.js'), 'window.app = true;');
  expect(() => checkHelpFixtureAbsent(f.dist, f.release, [])).not.toThrow();
});
it.each([['br', brotliCompressSync], ['gz', gzipSync]])('scans the decoded %s asset', (suffix, compress) => {
  const f = fixture(); writeFileSync(join(f.dist, `app.js.${suffix}`), compress(Buffer.from('window.__helpAskFixture = "HELP_ASK_FIXTURE_ONLY";'.repeat(128))));
  expect(() => checkHelpFixtureAbsent(f.dist, f.release, [])).toThrow('Help fixture');
});
it('refuses broken compression as unproved package exclusion', () => {
  const f = fixture(); writeFileSync(join(f.dist, 'app.js.br'), 'broken compressed bytes');
  expect(() => checkHelpFixtureAbsent(f.dist, f.release, [])).toThrow();
});
it('does not follow an asset symlink outside the package', () => {
  const f = fixture(), other = join(f.root, 'outside.js'); writeFileSync(other, 'ordinary bytes');
  symlinkSync(other, join(f.dist, 'app.js'));
  expect(() => checkHelpFixtureAbsent(f.dist, f.release, [])).toThrow(/link|regular/i);
});
it('refuses mode overrides from both the package command and release workflow', () => {
  const f = fixture(); writeFileSync(join(f.dist, 'app.js'), 'ordinary bytes');
  expect(() => checkHelpFixtureAbsent(f.dist, f.release, ['--mode=help-fixture'])).toThrow('Release must not');
  writeFileSync(f.release, 'run: vite build --mode help-fixture');
  expect(() => checkHelpFixtureAbsent(f.dist, f.release, [])).toThrow('Release must not');
});
