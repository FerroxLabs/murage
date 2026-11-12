import { safeWipeSync } from "../server/testing/safe-wipe.mjs";
import { it as test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
test('T-RELEASE-NO-REBUILD', () => {
  assert.doesNotMatch(read('.github/workflows/release.yml'), /build-signal-runtime-inputs\.sh|normalize-signal-runtime|\bjlink\b|--archive/);
});
test('T-INTEGRITY-ONE-CONTRACT', () => {
  for (const path of ['server/channels/signal/process-host.ts', 'scripts/signal-inventory.mjs', 'scripts/stage-signal-runtime.mjs']) {
    const source = read(path);
    assert.doesNotMatch(source, /\btreeDigest\s*\(|\bfileHash\s*\(|record\.jre\.sha256/);
    assert.match(source, /verifyRuntimeTree\(/);
  }
});
test('T-REPRO-SELF: Gradle and environment are deterministic before pinning', () => {
  const source = read('scripts/build-signal-runtime-inputs.sh');
  for (const token of ['SOURCE_DATE_EPOCH=0', 'TZ=UTC', 'LC_ALL=C', 'umask 022', '--no-build-cache', '--no-configuration-cache', '--dependency-verification=strict', 'distributionSha256Sum', 'diffoscope', 'cmp ']) assert.ok(source.includes(token), token);
});
test('T-GRADLE-STRICT: reviewed metadata covers the complete closure', () => {
  const metadata = read('gradle/verification-metadata.xml');
  assert.match(metadata, /<verify-metadata>true<\/verify-metadata>/);
  assert.match(metadata, /<verify-signatures>true<\/verify-signatures>/);
  assert.match(metadata, /<key-servers enabled="false"/);
  assert.doesNotMatch(metadata, /<trusted-artifact\b|<ignored-artifact\b|<trusted-key\b/);
  const artifacts = [...metadata.matchAll(/<artifact name="([^"]+)">([\s\S]*?)<\/artifact>/g)];
  assert.equal(artifacts.length, 342, 'review the complete D102 closure when updating metadata');
  for (const [, name, verification] of artifacts) {
    assert.match(verification, /<sha256 value="[a-f0-9]{64}"/, name);
  }
  assert.match(read('gradle/verification-keyring.keys'), /-----BEGIN PGP PUBLIC KEY BLOCK-----/);
});
test.skipIf(process.platform !== 'linux')('T-GRADLE-STRICT: production execution and key retrieval fail closed with fake inputs', async () => {
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync('python3', ['scripts/signal-gradle-verification.test.py'], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
test('T-NO-NESTED-NATIVE: launcher selects both loose libraries', () => {
  const source = read('server/channels/signal/process-host.ts');
  for (const token of ['-Djava.library.path=', '-Dorg.sqlite.lib.path=', '-Dorg.sqlite.lib.name=']) assert.ok(source.includes(token), token);
});

test.skipIf(process.platform !== 'linux')('T-NO-NESTED-NATIVE and T-JRE-UPSTREAM rejection witnesses', async () => {
  const { spawnSync } = await import('node:child_process');
  for (const file of ['scripts/signal-native-stripping.test.py','scripts/signal-java-inputs.test.py']) {
    const result=spawnSync('python3',[file],{encoding:'utf8',windowsHide:true});
    assert.equal(result.status,0,result.stdout+result.stderr);
  }
});
test.skipIf(process.platform !== 'linux')('T-REPRO-SELF rejects an unpinned image and a missing Gradle checksum before downloading', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, mkdirSync, cpSync, writeFileSync, existsSync } = await import('node:fs');
  const { join } = await import('node:path');const { tmpdir }=await import('node:os');
  const root=mkdtempSync(join(tmpdir(),'signal-builder-negative-'));
  try {
    mkdirSync(join(root,'scripts'));cpSync(new URL('./build-signal-runtime-inputs.sh',import.meta.url),join(root,'scripts/build-signal-runtime-inputs.sh'));
    for(const pin of [{image:'node:24-bookworm'}, {image:'node:24-bookworm@sha256:'+'0'.repeat(64)}]){
      writeFileSync(join(root,'scripts/signal-builder.json'),JSON.stringify(pin));
      const result=spawnSync('bash',[join(root,'scripts/build-signal-runtime-inputs.sh'),join(root,'out')],{encoding:'utf8',windowsHide:true,env:{...process.env,SIGNAL_BUILDER_IMAGE:pin.image}});
      assert.notEqual(result.status,0);assert.match(result.stderr,/Digest-pinned|Gradle distribution checksum/);assert.equal(existsSync(join(root,'out')),false);
    }
  }finally{safeWipeSync(root);}
});
