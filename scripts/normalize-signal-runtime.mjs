// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Linux assembly only: foreign JVMs and native code are never executed.
import { cpSync, mkdirSync, readFileSync, writeFileSync, readdirSync, chmodSync, lstatSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { digest, treeRecords, treeDigest } from '../server/channels/signal/runtime-tree.mjs';
import { executableFormat, normalizedDigest } from '../server/channels/signal/binary-digest.mjs';
import { stageRuntimeLicenses } from '../server/channels/signal/runtime-licenses.mjs';
import { SIGNAL_CLI_COMMIT } from '../server/channels/signal/evidence.mjs';
export const RUNTIME_TAG = 'signal-runtime-0.14.11-48a0a5e-r1';
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const pins = JSON.parse(readFileSync(new URL('./signal-java-inputs.json', import.meta.url)));
const builder = JSON.parse(readFileSync(new URL('./signal-builder.json', import.meta.url)));
export function assertModuleSubset(required, release) {
  const modules = release.match(/^MODULES="([^"]+)"$/m)?.[1].split(/\s+/);
  if (!modules || !required.trim() || required.trim().split(',').some(m => !modules.includes(m))) throw Error('jdeps modules are not a subset of the upstream JRE');
}
export async function normalizeRuntime({ dist, jre, target, output, build, pinPath = join(ROOT, 'server/channels/signal/runtime-pin.json'), licenseRoot = join(ROOT, 'licenses/signal-runtime') }) {
  if (!['darwin-arm64', 'win32-x64', 'linux-x64'].includes(target)) throw Error('Unsupported target');
  const release = readFileSync(join(jre, 'release'), 'utf8');
  if (!release.includes(`JAVA_RUNTIME_VERSION="${build}"`) || !release.includes('IMPLEMENTOR="Eclipse Adoptium"')) throw Error('Upstream JRE build mismatch');
  assertModuleSubset(readFileSync(join(output, 'jdeps.txt'), 'utf8'), release);
  const input = join(output, target);
  mkdirSync(input); mkdirSync(join(input, 'lib')); mkdirSync(join(input, 'native'));
  const result = spawnSync('python3', [fileURLToPath(new URL('./signal-jar-layout.py', import.meta.url)), '--assemble', dist, input, target, pinPath], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw Error('Jar normalization failed: ' + result.stderr);
  const provenance = JSON.parse(result.stdout);
  cpSync(jre, join(input, 'jre'), { recursive: true, verbatimSymlinks: true });
  const directories = [];
  const walk = (dir, prefix = '') => { for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name), rel = prefix + name, st = lstatSync(path);
    if (st.isDirectory()) { chmodSync(path, 0o755); directories.push(rel); walk(path, rel + '/'); }
    else if (st.isFile()) chmodSync(path, target === 'win32-x64' || !(st.mode & 0o111) ? 0o644 : 0o755);
  } };
  walk(input);
  const rows = treeRecords(input), executables = {};
  for (const row of rows) {
    if (!row.sha256 || !/^(jre|native)\//.test(row.path)) continue;
    const bytes = readFileSync(join(input, row.path)), format = executableFormat(bytes);
    if (format) executables[row.path] = { sha256: row.sha256, normalizedSha256: normalizedDigest(bytes, format), format };
  }
  const libsignal = provenance.natives.find(n => /signal_jni/.test(n.path));
  const record = {
    jars: rows.filter(r => r.path.endsWith('.jar') && !r.path.startsWith('jre/')).map(({ path, sha256 }) => ({ path, sha256, ...(provenance.jars[path] ? { provenance: provenance.jars[path] } : {}) })),
    jre: { build, sha256: treeDigest(join(input, 'jre')), provenance: { kind: 'upstream-jre', ...pins[target] } },
    libsignal: { version: '0.106.1', sha256: libsignal.sha256, provenance: libsignal.provenance },
    natives: provenance.natives,
    integrity: { licenseRows: [], rows, directories: directories.sort(), executables, resigned: null },
  };
  const licenses = join(output, target + '-licenses');
  stageRuntimeLicenses(licenseRoot, licenses, record.jars);
  record.integrity.licenseRows = treeRecords(licenses);
  // The transport root is retained for compatibility; it contains a JRE only.
  renameSync(join(input, 'jre'), join(input, 'jdk'));
  const name = `${RUNTIME_TAG}-${target}.tar.gz`, archive = join(output, name);
  const packed = spawnSync('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '--format=gnu', '--no-xattrs', '--no-acls', '--no-selinux', '--mode=u+rwX,go+rX,go-w', '-czf', archive, '-C', input, 'signal-cli.jar', 'lib', 'native', 'jdk'], { env: { ...process.env, GZIP: '-n', LC_ALL: 'C' }, encoding: 'utf8', windowsHide: true });
  if (packed.status !== 0) throw Error('Archive failed: ' + packed.stderr);
  const fragment = { signalCliCommit: SIGNAL_CLI_COMMIT, builder, target, record,
    signalNetworkSha256: record.jars.find(j => j.path === 'lib/signal-network-2.15.3_unofficial_157.jar').sha256,
    releaseInput: { url: `https://github.com/FerroxLabs/murage-releases/releases/download/${RUNTIME_TAG}/${name}`, sha256: digest(readFileSync(archive)), layout: 'prelinked-jre' } };
  writeFileSync(join(output, `pin-fragment-${target}.json`), JSON.stringify(fragment, null, 2) + '\n');
  return fragment;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [dist, jre, target, output, build] = process.argv.slice(2);
  if (!build) throw Error('usage: <installDist/lib> <JRE-home> <target> <fresh-output> <build>');
  const f = await normalizeRuntime({ dist: resolve(dist), jre: resolve(jre), target, output: resolve(output), build });
  console.log(f.target, f.releaseInput.sha256);
}
