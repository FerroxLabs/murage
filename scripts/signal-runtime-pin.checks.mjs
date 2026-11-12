import { safeWipeSync } from "../server/testing/safe-wipe.mjs";
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { SIGNAL_CLI_COMMIT } from '../server/channels/signal/evidence.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const targets = ['darwin-arm64', 'linux-x64', 'win32-x64'];
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) safeWipeSync(root); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'signal-pin-check-')); roots.push(root);
  const pin = JSON.parse(readFileSync(new URL('../server/channels/signal/runtime-pin.json', import.meta.url)));
  const evidence = JSON.parse(readFileSync(new URL('../server/channels/signal/runtime-pin.evidence.json', import.meta.url)));
  const builder = JSON.parse(readFileSync(new URL('./signal-builder.json', import.meta.url)));
  const sums = [];
  for (const target of targets) {
    pin.targets[target].integrity ??= { resigned: null };
    const name = `${target}.tar.gz`, bytes = Buffer.from(`synthetic archive ${target}`);
    writeFileSync(join(root, name), bytes);
    pin.releaseInputs[target] = { url: `https://example.test/${name}`, sha256: hash(bytes), layout: 'prelinked-jre' };
    const fragment = { target, signalCliCommit: SIGNAL_CLI_COMMIT, builder, record: pin.targets[target],
      signalNetworkSha256: pin.signalNetwork.sha256, releaseInput: pin.releaseInputs[target] };
    const fragmentName = `pin-fragment-${target}.json`, fragmentBytes = JSON.stringify(fragment, null, 2) + '\n';
    writeFileSync(join(root, fragmentName), fragmentBytes);
    evidence.fragments[fragmentName] = hash(fragmentBytes);
    sums.push(`${hash(bytes)}  ./${name}\n`);
  }
  const sumsBytes = sums.join('');
  writeFileSync(join(root, 'SHA256SUMS'), sumsBytes);
  evidence.sha256sumsSha256 = hash(sumsBytes);
  const pinPath = join(root, 'runtime-pin.json');
  writeFileSync(pinPath, JSON.stringify(pin));
  writeFileSync(join(root, 'runtime-pin.evidence.json'), JSON.stringify(evidence));
  return { root, check: () => spawnSync(process.execPath, ['scripts/merge-signal-runtime-inputs.mjs', '--check', root, pinPath], { encoding: 'utf8' }) };
}

it.each(targets)('T-PIN-COMMITTED: %s rejects a one-byte archive change', target => {
  const f = fixture(); expect(f.check().status).toBe(0);
  const path = join(f.root, `${target}.tar.gz`), bytes = readFileSync(path);
  bytes[0] ^= 1; writeFileSync(path, bytes);
  const result = f.check(); expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/archive hash mismatch/);
});
it.each(targets)('T-PIN-COMMITTED: %s rejects a one-byte fragment change even in JSON whitespace', target => {
  const f = fixture(); expect(f.check().status).toBe(0);
  const path = join(f.root, `pin-fragment-${target}.json`), bytes = readFileSync(path);
  bytes[bytes.indexOf(32)] = 9; writeFileSync(path, bytes);
  const result = f.check(); expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/fragment hash mismatch/);
});
it('T-PIN-COMMITTED: null provenance cannot disable fragment verification', () => {
  const f = fixture(); expect(f.check().status).toBe(0);
  writeFileSync(join(f.root, 'runtime-pin.evidence.json'), 'null\n');
  const result = f.check(); expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/Independent runtime builder evidence required/);
});
