// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { withHideInherit } from "../../../shared/win-hide-child-process.mjs";
// The installed-byte contract, shared by staging, inventory and every spawn.
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { digest, safePath, treeRecords, readRegular } from './runtime-tree.mjs';
import { executableFormat, normalizedDigest, machoTeamIdentifiers } from './binary-digest.mjs';
import { verifySignalEvidence } from './evidence.mjs';
import { SIGNAL_RUNTIME_G0, signalFixtureDir } from './runtime-paths.mjs';
import { requireWindowsAddon } from '../../engine-exclusion.ts';
export { normalizedDigest } from './binary-digest.mjs';
const fail = message => { throw Error('Signal runtime: ' + message); };
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const hash = value => /^[0-9a-f]{64}$/.test(value ?? '');
const nativeNames = {
  'darwin-arm64': ['libsignal_jni.dylib', 'libsqlitejdbc.dylib'],
  'win32-x64': ['signal_jni.dll', 'sqlitejdbc.dll'],
  'linux-x64': ['libsignal_jni.so', 'libsqlitejdbc.so'],
};

/** Platform trust verification, with per-path results. Never use a shell
 * to interpolate paths or signer identities. Tests inject this boundary; their
 * self-signed fixtures are not production trust evidence. */
export async function probeSignatures({ paths, identity, target }) {
  if (!paths.length) return true;
  const options = { encoding: 'utf8', windowsHide: true, timeout: 1500, maxBuffer: 1024 * 1024 };
  if (target === 'darwin-arm64' && process.platform === 'darwin' && /^[A-Z0-9]{10}$/.test(identity?.teamId)) {
    try {
      if (!paths.every(path => machoTeamIdentifiers(readRegular(path)).every(team => team === identity.teamId))) return false;
    } catch { return false; }
    // Apple-issued certificate subject.OU is the Team Identifier. -R checks
    // that identity in the same strict verification invocation for every path.
    // https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/RequirementLang/RequirementLang.html
    const requirement = `=anchor apple generic and certificate leaf[subject.OU] = "${identity.teamId}"`;
    const result = spawnSync('/usr/bin/codesign', ['--verify', '--strict', '-R', requirement, ...paths], withHideInherit(options));
    return result.status === 0 && !result.error;
  }
  if (target === 'win32-x64' && process.platform === 'win32' && typeof identity?.subject === 'string' && identity.subject.length) {
    // Use the same WinVerifyTrust helper as the updater. Compare the whole
    // verified leaf subject; a matching display name alone cannot admit a file.
    const native = requireWindowsAddon();
    if (typeof native.authenticode !== 'function') fail("Windows signature verification needs Murage's native helper. Reinstall Murage to repair it.");
    let timer;
    try {
      return await Promise.race([
        (async () => {
          for (const path of paths) {
            const result = await native.authenticode(path);
            if (result?.status !== 'Valid' || result.subject !== identity.subject) return false;
          }
          return true;
        })(),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), options.timeout); }),
      ]);
    } catch { return false; }
    finally { clearTimeout(timer); }
  }
  return false;
}

export function assertIntegrityRecord(record, target) {
  const integrity = record?.integrity;
  if (!nativeNames[target] || !integrity || !Array.isArray(integrity.rows) || !Array.isArray(integrity.directories) || !integrity.executables || !Array.isArray(record.natives)) fail('missing integrity pin');
  const paths = new Set();
  for (const row of integrity.rows) {
    safePath(row.path);
    if (paths.has(row.path) || !/^(?:signal-cli\.jar$|lib\/|native\/|jre\/)/.test(row.path)) fail('invalid pinned row');
    paths.add(row.path);
    if (Object.hasOwn(row, 'link')) { if (typeof row.link !== 'string') fail('invalid pinned link'); }
    else if (!hash(row.sha256) || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || ![0, 0o111].includes(row.executable)) fail('invalid pinned file');
  }
  if (new Set(integrity.directories).size !== integrity.directories.length) fail('duplicate directory pin');
  for (const path of integrity.directories) safePath(path);
  const jarPaths = record.jars.map(jar => jar.path).sort();
  const rowJars = integrity.rows.filter(row => row.path.endsWith('.jar') && !row.path.startsWith('jre/')).map(row => row.path).sort();
  if (!jarPaths.includes('signal-cli.jar') || !equal(jarPaths, rowJars)) fail('jar inventory differs from pinned rows');
  const expectedNatives = nativeNames[target].map(n => 'native/' + n).sort();
  if (!equal(record.natives.map(n => n.path).sort(), expectedNatives)) fail('native inventory mismatch');
  for (const item of [...record.jars, ...record.natives]) {
    const row = integrity.rows.find(r => r.path === item.path);
    if (!row || row.sha256 !== item.sha256) fail('artifact row does not match its pin');
  }
  const jre = integrity.rows.filter(r => r.path.startsWith('jre/')).map(r => ({ ...r, path: r.path.slice(4) }));
  if (digest(JSON.stringify(jre)) !== record.jre.sha256) fail('original JRE rows do not match tree pin');
  for (const [path, exe] of Object.entries(integrity.executables)) {
    if (!/^(jre|native)\//.test(path) || !paths.has(path) || !hash(exe.sha256) || !hash(exe.normalizedSha256) || !['macho', 'pe', 'elf'].includes(exe.format) || integrity.rows.find(r => r.path === path)?.sha256 !== exe.sha256) fail('invalid executable pin');
  }
  const resigned = integrity.resigned;
  if (resigned !== null) {
    if (!resigned || !Array.isArray(resigned.paths) || !resigned.paths.length || new Set(resigned.paths).size !== resigned.paths.length) fail('invalid signing policy');
    if (target === 'darwin-arm64' ? !/^[A-Z0-9]{10}$/.test(resigned.identity?.teamId) : target === 'win32-x64' ? !resigned.identity?.subject : true) fail('invalid signing identity');
    for (const path of resigned.paths) if (integrity.executables[path]?.format !== (target === 'darwin-arm64' ? 'macho' : 'pe')) fail('non-signable allowlisted path');
  }
  return integrity;
}

export async function canonicalRuntimeRows({ root, pin, target, probe = probeSignatures }) {
  root = resolve(root);
  if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) fail('runtime root is not a directory');
  const record = pin.targets?.[target], integrity = assertIntegrityRecord(record, target);
  const allowedAux = new Set([SIGNAL_RUNTIME_G0, 'licenses', 'runtime-pin.json', 'signal.inventory.json']);
  const rows = treeRecords(root, { exclude: [...allowedAux] });
  const expected = integrity.rows;
  if (!equal(rows.map(r => r.path), expected.map(r => r.path))) fail('runtime file set differs');
  const directories = [];
  const walk = (dir, prefix = '') => { for (const name of readdirSync(dir).sort()) {
    const rel = prefix + name;
    if (!prefix && allowedAux.has(name)) continue;
    const path = join(dir, name), st = lstatSync(path);
    if (st.isDirectory() && !st.isSymbolicLink()) { directories.push(rel); walk(path, rel + '/'); }
  } };
  walk(root);
  if (!equal(directories.sort(), integrity.directories)) fail('runtime directory set differs');
  const changed = [], canonical = [];
  for (let i = 0; i < rows.length; i++) {
    const actual = rows[i], original = expected[i], exe = integrity.executables[actual.path];
    if (actual.sha256) {
      const format = executableFormat(readRegular(join(root, actual.path)));
      if (/^(jre|native)\//.test(actual.path) && (format ?? null) !== (exe?.format ?? null)) fail('executable set differs');
    }
    if (equal(actual, original)) { canonical.push(original); continue; }
    if (!actual.sha256 || !original.sha256 || actual.executable !== original.executable || !integrity.resigned?.paths.includes(actual.path) || !exe) fail('unlisted changed runtime file: ' + actual.path);
    if (normalizedDigest(readRegular(join(root, actual.path)), exe.format) !== exe.normalizedSha256) fail('executable code changed: ' + actual.path);
    changed.push(join(root, actual.path));
    // Both SHA and length come from the authenticated original rows, as does
    // the whole inventory projection. A signature can change file length.
    canonical.push(original);
  }
  if (changed.length && await probe({ paths: changed, identity: integrity.resigned.identity, target }) !== true) fail('runtime signature identity/trust mismatch');
  return canonical;
}

export async function verifyRuntimeTree({ root, pin, target, probe }) {
  root = resolve(root);
  const record = pin.targets?.[target];
  const rows = await canonicalRuntimeRows({ root, pin, target, probe });
  const network = record.jars.find(j => j.path === `lib/signal-network-${pin.signalNetwork.version}.jar`);
  if (network?.sha256 !== pin.signalNetwork.sha256) fail('signal-network coordinate mismatch');
  const jreRows = rows.filter(r => r.path.startsWith('jre/')).map(r => ({ ...r, path: r.path.slice(4) }));
  if (digest(JSON.stringify(jreRows)) !== record.jre.sha256) fail('JRE tree mismatch');
  const release = readRegular(join(root, 'jre/release')).toString('utf8');
  if (!release.includes(`JAVA_RUNTIME_VERSION="${record.jre.build}"`) || !release.includes('IMPLEMENTOR="Eclipse Adoptium"')) fail('JRE build mismatch');
  const libsignal = record.natives.find(n => n.path === 'native/' + nativeNames[target][0]);
  if (libsignal?.sha256 !== record.libsignal.sha256) fail('JNI pin mismatch');
  const java = join(root, 'jre/bin', target === 'win32-x64' ? 'java.exe' : 'java');
  if (!lstatSync(java).isFile() || lstatSync(java).isSymbolicLink()) fail('Java executable missing');
  const entries = new Set(readdirSync(root));
  if (pin.g0 && !entries.has(SIGNAL_RUNTIME_G0)) fail('runtime evidence missing');
  if (record.integrity.licenseRows?.length && !entries.has('licenses')) fail('runtime licenses missing');
  if (entries.has(SIGNAL_RUNTIME_G0)) verifySignalEvidence(pin, signalFixtureDir(root));
  if (entries.has('licenses')) {
    if (!record.integrity.licenseRows || !equal(treeRecords(join(root, 'licenses')), record.integrity.licenseRows)) fail('license tree differs');
  }
  if (entries.has('runtime-pin.json') && !equal(JSON.parse(readRegular(join(root, 'runtime-pin.json'))), pin)) fail('installed pin differs');
  if (entries.has('signal.inventory.json')) {
    const inventory = JSON.parse(readRegular(join(root, 'signal.inventory.json')));
    if (inventory.target !== target || inventory.pinSha256 !== digest(JSON.stringify(pin))) fail('installed inventory pin differs');
  }
  return { java, jar: join(root, 'signal-cli.jar'), nativeDir: join(root, 'native') };
}

// S1 owns the evidence schema; S3 adds only the runtime byte records. Apply to
// the repository schema so build tooling and the integrity verifier agree.
export function withIntegritySchema(schema) {
  const result = structuredClone(schema), defs = result.$defs;
  const sha = { $ref: '#/$defs/sha256' }, text = { $ref: '#/$defs/text' };
  const object = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
  const array = items => ({ type: 'array', items, minItems: 1 });
  const extraction = object({ kind: { const: 'upstream-jar' }, jar: text, entry: text, upstreamSha256: sha });
  const row = { oneOf: [object({ path: text, sha256: sha, bytes: { type: 'integer', minimum: 0 }, executable: { enum: [0, 73] } }), object({ path: text, link: text })] };
  const stripped = object({ kind: { const: 'native-stripped' }, upstreamSha256: sha, removed: array(text) });
  const target = defs.target;
  target.required = [...new Set([...target.required, 'natives', 'integrity'])];
  target.properties.jars.items.properties.provenance = stripped;
  target.properties.jre.properties.provenance = object({ kind: { const: 'upstream-jre' }, url: { type: 'string', pattern: '^https://' }, sha256: sha, build: text });
  target.properties.jre.required = [...new Set([...target.properties.jre.required, 'provenance'])];
  target.properties.libsignal.properties.provenance = extraction;
  target.properties.natives = array(object({ path: text, sha256: sha, provenance: extraction }));
  target.properties.integrity = object({ rows: array(row), directories: array(text), licenseRows: array(row),
    executables: { type: 'object', additionalProperties: object({ sha256: sha, normalizedSha256: sha, format: { enum: ['macho', 'pe', 'elf'] } }) },
    resigned: { oneOf: [{ type: 'null' }, object({ paths: array(text), identity: { oneOf: [object({ teamId: { type: 'string', pattern: '^[A-Z0-9]{10}$' } }), object({ subject: text })] } })] },
  });
  return result;
}
