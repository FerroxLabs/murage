import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { collectPresenceEvidence } from '../../presence-guard-evidence.mjs';
const digest = value => createHash('sha256').update(value).digest('hex');
const sha = 'a'.repeat(40), bytes = Buffer.from('synthetic addon image');
const addon = { read: () => ({ fullscreen: false, sharing: false, focus: false }), onChange: () => () => {} };
function provenance() { return { sourceSha: sha, expectedSourceSha: sha, sourceSha256: digest('sources'), expectedSourceSha256: digest('sources'),
  target: 'darwin-x64', loadedBytes: bytes, buildSha256: digest(bytes) }; }
describe('T10 native load provenance', () => {
  it('records actual loaded bytes separately from the build and source identities', () => {
    const receipt = collectPresenceEvidence({ addon, platform: 'darwin', arch: 'x64', provenance: provenance() });
    expect(receipt.loaded).toBe(true); expect(receipt.loadedSha256).toBe(digest(bytes));
    expect(receipt.sourceSha).toBe(sha); expect(receipt.target).toBe('darwin-x64');
    expect(receipt.stage).toBe('build-load');
  });
  it.each([
    ['wrong source SHA', p => { p.sourceSha = 'b'.repeat(40); }],
    ['unknown source SHA', p => { p.sourceSha = undefined; }],
    ['wrong native source bytes', p => { p.sourceSha256 = digest('other sources'); }],
    ['swapped installed bytes', p => { p.loadedBytes = Buffer.from('swapped addon'); }],
    ['wrong architecture', p => { p.target = 'darwin-arm64'; }],
    ['unmapped signature changes', p => { p.loadedBytes = Buffer.concat([bytes, Buffer.from('signature')]); }],
  ])('refuses %s before invoking the addon', (_label, mutate) => {
    const p = provenance(); mutate(p); let reads = 0;
    expect(() => collectPresenceEvidence({ addon: { ...addon, read: () => { reads++; return addon.read(); } }, platform: 'darwin', arch: 'x64', provenance: p })).toThrow();
    expect(reads).toBe(0);
  });
  it('does not label legacy diagnostic snapshots as loaded-byte proof', () => {
    expect(collectPresenceEvidence({ addon }).loaded).not.toBe(true);
  });
});
describe('T10 both Mac runtime loads and exact-source Windows receipts', () => {
  const mac = parse(readFileSync(new URL('../../../.github/workflows/mac-notification-authorization-preflight.yml', import.meta.url), 'utf8'));
  const windows = parse(readFileSync(new URL('../../../.github/workflows/native-addon-msvc.yml', import.meta.url), 'utf8'));
  it('loads x64 notification and presence addons on native Intel, not just lipo verification', () => {
    const job = mac.jobs['load-x64'];
    expect(job).toBeDefined(); expect(job['runs-on']).toBe('macos-15-intel');
    const run = job.steps.map(s => s.run ?? '').join('\n');
    expect(run).toContain('test "$(node -p process.arch)" = x64');
    expect(run).toContain('scripts/notification-authorization-evidence.mjs');
    expect(run).toContain('scripts/presence-guard-evidence.mjs');
    expect(job.env?.EXPECTED_SHA).toBe('${{ inputs.source_sha }}');
    expect(job.steps.find(s => s.uses?.startsWith('actions/upload-artifact')).if).toBe('always()');
  });
  it('binds the arm64 presence load to the same immutable source', () => {
    expect(mac.jobs.compile.env?.EXPECTED_SHA).toBe('${{ inputs.source_sha }}');
  });
  it('checks the actual Windows checkout and retains failed native loads', () => {
    const job = windows.jobs.compile;
    expect(job.env?.EXPECTED_SHA).toBe('${{ inputs.source_sha || github.sha }}');
    const run = job.steps.map(s => s.run ?? '').join('\n');
    expect(run).toContain('git rev-parse HEAD');
    expect(job.steps.find(s => s.uses?.startsWith('actions/upload-artifact')).if).toBe('always()');
  });
});

import { collectNotificationEvidence } from '../../notification-authorization-evidence.mjs';
describe('T10 notification runtime export completeness', () => {
  const names = ['status', 'request', 'registerCategories', 'post', 'remove', 'onResponse'];
  const binding = () => Object.fromEntries(names.map(name => [name, () => { throw new Error('permission methods must not be called'); }]));
  it('records all six actual function exports without requesting OS permission', () => {
    const receipt = collectNotificationEvidence({ addon: binding(), provenance: provenance(), platform: 'darwin', arch: 'x64' });
    expect(receipt.exports).toEqual([...names].sort()); expect(receipt.osPermissionRequested).toBe(false);
    expect(receipt.loadedSha256).toBe(digest(bytes));
  });
  it.each(names)('refuses a compile/load receipt without %s', name => {
    const addon = binding(); delete addon[name];
    expect(() => collectNotificationEvidence({ addon, provenance: provenance(), platform: 'darwin', arch: 'x64' })).toThrow();
  });
});
