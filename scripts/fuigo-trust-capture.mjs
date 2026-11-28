#!/usr/bin/env node
// Producer: MAIN capture runner (q1024-trustcapture) on hz/Mac/Windows capture hosts.
// Consumers: scripts/fuigo-trust-release.mjs (release.yml trust step) and the hp23 stage kit (check_trust_bound).
// Turns raw per-target capture folders into one staged trust directory, or nothing at all.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildTrustReceipt, readRealTurns } from './fuigo-bump.mjs';
import { trustReleaseGate } from './fuigo-trust-release.mjs';
import { checkTrustV3, TRUST_V3_CASES } from './fuigo-trust-evidence-v3.mjs';
import { FUIGO_TARGET_OSES } from './prepare-fuigo.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const readJson = (file, what) => {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch (error) { throw new Error(`trust-capture: ${what} is unreadable: ${error.message}`); }
};

/** The four designated installers, literal names, exactly as the stage kit pins them. */
export const trustInstallers = version => {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('trust-capture: an exact x.y.z release version is required');
  return [`Murage-${version}-amd64.deb`, `Murage-${version}-arm64.dmg`, `Murage-${version}-setup.exe`, `Murage-${version}-x86_64.AppImage`];
};

/** BOUND: line 1 the sha256 of the staged SHA256SUMS, then each designated installer line copied from it. */
export function buildTrustBound(sumsBytes, version) {
  const lines = sumsBytes.toString('utf8').split('\n');
  const out = [`${sha256(sumsBytes)}  SHA256SUMS`];
  for (const name of trustInstallers(version)) {
    const hits = lines.filter(line => /^[a-f0-9]{64}  /.test(line) && line.slice(66) === name);
    if (hits.length !== 1) throw new Error(`trust-capture: staged SHA256SUMS needs exactly one line for ${name}, found ${hits.length}`);
    out.push(hits[0]);
  }
  return `${out.join('\n')}\n`;
}

/** Mirror of the stage kit's check_trust_bound (hp23 bin/common.sh), so a packet the kit would refuse is never staged. */
export function checkTrustBound(boundBytes, sumsBytes, version) {
  if (!boundBytes.length || !sumsBytes.length) return false;
  const lines = boundBytes.toString('utf8').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const [head = '', ...rest] = lines;
  // awk 'NR==1{print $1}'
  if ((head.trim().split(/\s+/)[0] ?? '') !== sha256(sumsBytes)) return false;
  const sums = new Set(sumsBytes.toString('utf8').split('\n'));
  let n = 0;
  for (const line of rest) {
    // read -r want name: first field, then the rest of the line with outer whitespace stripped
    const match = /^\s*(\S*)\s*(.*?)\s*$/.exec(line), want = match[1], name = match[2];
    if (!name) continue;
    if (!sums.has(`${want}  ${name}`)) return false;
    n++;
  }
  // awk '{print $2}' over every line (a blank line is an empty field) | LC_ALL=C sort | paste -s -d,
  const names = rest.map(line => line.trim().split(/\s+/)[1] ?? '').sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return n === 4 && names.join() === [...trustInstallers(version)].sort().join();
}

/** Per target and case: owed until the raw packet for that target passes the whole schema-3 check. */
export function trustCaptureStatus(rawDir, expected) {
  const files = existsSync(rawDir) ? readRealTurns(rawDir) : [];
  return Object.keys(expected?.targets ?? {}).sort().map(target => {
    const file = files.find(entry => entry.name === `${target}.json`);
    const cases = file?.row?.trustV3?.cases ?? {};
    const present = TRUST_V3_CASES.filter(id => cases[id]);
    let fault = null;
    if (!file) fault = 'no raw packet';
    else if (!(file.folder instanceof Map)) fault = 'raw capture folder missing';
    else try { checkTrustV3(file.row, file.folder, expected); } catch (error) { fault = error.message; }
    return { target, os: FUIGO_TARGET_OSES[target], ready: fault === null, captured: present.length,
      owed: TRUST_V3_CASES.filter(id => !cases[id]), fault };
  });
}

/** Writes outDir/{expected.json,receipt.json,captures/,BOUND} or nothing. Every write is re-read through the release gate first. */
export function assembleTrust({ rawDir, expectedFile, sumsFile, binding, version, outDir }) {
  if (!rawDir || !expectedFile || !sumsFile || !binding || !outDir) throw new Error('trust-capture: raw captures, expected release, staged SHA256SUMS, receipt binding and output dir are required');
  const out = resolve(outDir);
  if (existsSync(out)) throw new Error(`trust-capture: ${out} already exists; staged evidence is never overwritten`);
  const expected = readJson(expectedFile, 'expected release');
  // The BOUND installers and the packets must name one release: the installer version is the expected release's packageVersion.
  if (version !== expected.packageVersion) throw new Error(`trust-capture: the installers are for ${version} but the packets are for ${expected.packageVersion}`);
  const sums = readFileSync(sumsFile);
  const bound = buildTrustBound(sums, version);
  const files = readRealTurns(rawDir);
  const missing = Object.keys(expected.targets ?? {}).filter(target => !files.some(file => file.name === `${target}.json` && file.folder instanceof Map));
  if (missing.length) throw new Error(`trust-capture: no whole raw packet for ${missing.join(', ')}`);
  const extra = files.filter(file => !Object.hasOwn(expected.targets, file.name.slice(0, -5)));
  if (extra.length) throw new Error(`trust-capture: raw packet for an unselected target: ${extra.map(file => file.name).join(', ')}`);
  const owed = trustCaptureStatus(rawDir, expected).filter(row => !row.ready);
  if (owed.length) throw new Error(`trust-capture: not every target is whole:\n  ${owed.map(row => `${row.target}: ${row.owed.length ? `owed=${row.owed.join(',')} ` : ''}${row.fault}`).join('\n  ')}`);
  const receipt = buildTrustReceipt(binding, files, expected);
  // An exclusively created staging dir per run: never a predictable path, so nothing this run does not own is ever removed.
  mkdirSync(dirname(out), { recursive: true });
  const temp = mkdtempSync(`${out}.capture-`);
  try {
    const captures = join(temp, 'captures');
    mkdirSync(captures, { recursive: true });
    for (const { name, folder } of files) {
      writeFileSync(join(captures, name), readFileSync(join(rawDir, name)));
      const osDir = join(captures, name.slice(0, -5)); mkdirSync(osDir);
      for (const [entry, bytes] of folder) {
        if (!Buffer.isBuffer(bytes)) throw new Error(`trust-capture: ${name.slice(0, -5)}/${entry} is not a regular file`);
        writeFileSync(join(osDir, entry), bytes);
      }
    }
    writeFileSync(join(temp, 'expected.json'), readFileSync(expectedFile));
    writeFileSync(join(temp, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
    writeFileSync(join(temp, 'BOUND'), bound);
    trustReleaseGate({ expectedFile: join(temp, 'expected.json'), receiptFile: join(temp, 'receipt.json'), capturesDir: captures, expectedSha: expected.murageSha });
    if (!checkTrustBound(readFileSync(join(temp, 'BOUND')), sums, version)) throw new Error('trust-capture: BOUND is not bound to the staged installers');
    renameSync(temp, out);
  } catch (error) {
    rmSync(temp, { recursive: true, force: true });
    throw error;
  }
  return { outDir: out, targets: files.map(file => file.row.target), cases: TRUST_V3_CASES.length };
}

/** A PATH shim named fuigo that runs the tap with the real binary and capture dir baked in: Murage's version probe passes only
 * platform launch essentials (env-path.ts fuigoVersion), so nothing may depend on inherited environment. POSIX only; a
 * Windows capture needs a real fuigo.exe launcher (resolveFuigoCli never takes a .cmd). */
export function writeTapShim({ real, dir, shimDir, node = process.execPath }) {
  if (process.platform === 'win32') throw new Error('trust-capture: the Windows tap needs a fuigo.exe launcher; a script shim is never resolved');
  for (const [name, value] of Object.entries({ real, dir, shimDir, node })) {
    if (typeof value !== 'string' || !value.startsWith('/') || /['\n\r]/.test(value)) throw new Error(`trust-capture: ${name} must be an absolute path without quotes or newlines`);
  }
  const tap = fileURLToPath(new URL('./fuigo-trust-tap.mjs', import.meta.url));
  if (/['\n\r]/.test(tap)) throw new Error('trust-capture: the tap path must not contain quotes or newlines');
  mkdirSync(shimDir, { recursive: true }); mkdirSync(dir, { recursive: true });
  const shim = join(shimDir, 'fuigo');
  writeFileSync(shim, `#!/bin/sh\nMURAGE_TRUST_TAP_REAL='${real}' MURAGE_TRUST_TAP_DIR='${dir}' exec '${node}' '${tap}' "$@"\n`, { mode: 0o755 });
  return shim;
}

const args = argv => Object.fromEntries(argv.flatMap((arg, index) => arg.startsWith('--') ? [[arg.slice(2), argv[index + 1]]] : []));
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, ...rest] = process.argv.slice(2), a = args(rest);
  try {
    if (mode === 'status') {
      const rows = trustCaptureStatus(a.raw, readJson(a.expected, 'expected release'));
      for (const row of rows) console.log(`${row.target}\t${row.os}\t${row.ready ? 'READY' : 'OWED'}\t${row.captured}/${TRUST_V3_CASES.length}\t${row.ready ? '' : `${row.owed.length ? `owed=${row.owed.join(',')} ` : ''}fault=${row.fault}`}`);
      process.exitCode = rows.length && rows.every(row => row.ready) ? 0 : 1;
    } else if (mode === 'assemble') {
      const result = assembleTrust({ rawDir: a.raw, expectedFile: a.expected, sumsFile: a.sums, version: a.version, outDir: a.out,
        binding: a.binding && readJson(a.binding, 'receipt binding') });
      console.log(`trust-capture: staged ${result.targets.join(',')} x ${result.cases} cases at ${result.outDir}`);
    } else if (mode === 'tap-shim') {
      console.log(writeTapShim({ real: a.real, dir: a.dir, shimDir: a.out }));
    } else throw new Error('usage: fuigo-trust-capture.mjs status --raw <dir> --expected <file> | assemble --raw <dir> --expected <file> --sums <SHA256SUMS> --version <x.y.z> --binding <file> --out <dir> | tap-shim --real <fuigo> --dir <capture dir> --out <shim dir>');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
