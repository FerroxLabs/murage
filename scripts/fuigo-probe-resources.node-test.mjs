import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { validateFuigoProbeResources, stampSignedFuigoProbe } from './fuigo-probe-resources.mjs';

// Header fixtures verify rejection logic only; the CI-only case uses a real compiled helper.
async function fixture(t, platform = 'linux') {
  const resources = await mkdtemp(join(tmpdir(), 'murage-fuigo-resource-'));
  t.after(() => rm(resources, { recursive: true, force: true }));
  const root = join(resources, 'fuigo-probe'); await mkdir(root);
  const bytes = Buffer.alloc(128); Buffer.from([0x7f, 69, 76, 70, 2, 1]).copy(bytes); bytes.writeUInt16LE(0x3e, 18);
  if (platform === 'win32') { bytes.fill(0); bytes.write('MZ'); bytes.writeUInt32LE(64, 60); bytes.write('PE\0\0', 64); bytes.writeUInt16LE(0x8664, 68); }
  const manifest = { schema: 1, target: `${platform}-x64`, executable: platform === 'win32' ? 'launcher.exe' : 'launcher', binarySha256: createHash('sha256').update(bytes).digest('hex') };
  const file = join(root, manifest.executable), manifestPath = join(root, 'manifest.json');
  await writeFile(file, bytes); await writeFile(manifestPath, JSON.stringify(manifest));
  return { resources, root, bytes, manifest, file, manifestPath };
}
test('validates Linux inventory and normalizes executable modes', async t => {
  const f = await fixture(t); await chmod(f.root, 0o700); await chmod(f.file, 0o600);
  assert.deepEqual((await validateFuigoProbeResources(f.resources, 'linux')).manifest, f.manifest);
  assert.equal((await stat(f.root)).mode & 0o777, 0o755); assert.equal((await stat(f.file)).mode & 0o777, 0o755);
  await assert.rejects(validateFuigoProbeResources(f.resources, 'win32'));
  assert.equal(await validateFuigoProbeResources(f.resources, 'darwin'), null);
});
test('binds the Windows manifest to post-signing bytes and rejects later corruption', async t => {
  // Format/hash test only; real Authenticode validation is required in afterPack.
  const f = await fixture(t, 'win32'), resource = await validateFuigoProbeResources(f.resources, 'win32');
  const signedFixture = Buffer.concat([f.bytes, Buffer.from('synthetic signature bytes')]);
  await writeFile(f.file, signedFixture);
  await assert.rejects(validateFuigoProbeResources(f.resources, 'win32'), /identity mismatch/);
  await stampSignedFuigoProbe(resource);
  assert.equal((await validateFuigoProbeResources(f.resources, 'win32')).manifest.binarySha256, createHash('sha256').update(signedFixture).digest('hex'));
  await writeFile(f.file, Buffer.alloc(128));
  await assert.rejects(stampSignedFuigoProbe(resource));
});
test('rejects corrupted bytes and wrong target identity', async t => {
  const f = await fixture(t); await writeFile(f.file, Buffer.concat([f.bytes, Buffer.from('changed')]));
  await assert.rejects(validateFuigoProbeResources(f.resources, 'linux'), /identity mismatch/);
  await writeFile(f.file, f.bytes); await writeFile(f.manifestPath, JSON.stringify({ ...f.manifest, target: 'win32-x64' }));
  await assert.rejects(validateFuigoProbeResources(f.resources, 'linux'), /identity mismatch/);
});
test('rejects missing required payload and unexpected canary payload', async t => {
  const f = await fixture(t); await writeFile(join(f.root, 'canary'), 'must not ship');
  await assert.rejects(validateFuigoProbeResources(f.resources, 'linux'), /Unexpected/);
  await rm(f.root, { recursive: true });
  await assert.rejects(validateFuigoProbeResources(f.resources, 'linux'));
  assert.equal(await validateFuigoProbeResources(f.resources, 'linux', false), null);
});
test('rejects a symlink in place of the launcher', async t => {
  const f = await fixture(t), source = join(f.resources, 'other');
  await writeFile(source, f.bytes); await rm(f.file); await symlink(source, f.file);
  await assert.rejects(validateFuigoProbeResources(f.resources, 'linux'), /Invalid/);
});
test('rejects a symlink in place of the resource directory', async t => {
  const f = await fixture(t), source = join(f.resources, 'other');
  await mkdir(source); await rm(f.root, { recursive: true }); await symlink(source, f.root);
  await assert.rejects(validateFuigoProbeResources(f.resources, 'linux'), /real directory/);
});
test('validates actual compiled Linux helper copied into package resource layout', { skip: process.env.MURAGE_FUIGO_RESOURCE_CHECK_REAL !== '1' }, async t => {
  assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64');
  const f = await fixture(t), source = resolve('dist-native/fuigo-probe/linux-x64');
  await copyFile(join(source, 'launcher'), f.file); await copyFile(join(source, 'manifest.json'), f.manifestPath);
  const result = await validateFuigoProbeResources(f.resources, 'linux');
  assert.equal(result.manifest.binarySha256, createHash('sha256').update(await readFile(f.file)).digest('hex'));
  console.log(JSON.stringify({ source: process.env.GITHUB_SHA, check: 'compiled-linux-package-resource', manifest: result.manifest, runtimeExecuted: false }));
});
