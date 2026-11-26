// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: build tooling owns compiler partitions and budgets; CI owns runner allocation.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, totalmem } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { safeWipeSync } from '../server/testing/safe-wipe.mjs';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const budgets = JSON.parse(readFileSync(join(root, 'ci/typecheck-budgets.json'), 'utf8'));
const marker = 'TYPECHECK_RESOURCE ';

export function checkPeak(peak, cap, fraction = budgets.maxFraction) {
  if (!Number.isFinite(peak) || peak <= 0 || peak > cap * fraction) {
    throw new Error(`TypeScript peak ${peak} MiB exceeds ${fraction * 100}% of ${cap} MiB; split the program before raising a budget.`);
  }
}
export function heapCap(options = '') {
  return Number(options.match(/--max[-_]old[-_]space[-_]size(?:=|\s+)(\d+)/)?.[1] ?? 0);
}
// A job on a large runner may declare MURAGE_TYPECHECK_CAP_MIB: a compiler cap at
// least the recorded one, never smaller, that its own NODE_OPTIONS supplies. The
// 70% rule then holds against that cap. Without it every job gets the recorded cap.
export function effectiveCap(entry, env = process.env) {
  const raw = env.MURAGE_TYPECHECK_CAP_MIB;
  if (raw === undefined || raw === '') return entry.capMiB;
  const declared = Number(raw);
  if (!Number.isInteger(declared) || declared < entry.capMiB) throw new Error(`MURAGE_TYPECHECK_CAP_MIB=${raw} is below the recorded ${entry.capMiB} MiB cap`);
  if (heapCap(env.NODE_OPTIONS) < declared) throw new Error(`MURAGE_TYPECHECK_CAP_MIB=${declared} needs NODE_OPTIONS --max-old-space-size of at least ${declared}`);
  return declared;
}

// A preload in the compiler process: maxRSS is an OS high-water mark, including
// memory between GC cycles. It conservatively bounds heap usage on every OS.
if (process.env.MURAGE_TSC_RESOURCE_WORKER === '1') {
  process.on('exit', () => console.log(marker + JSON.stringify({
    peakMiB: process.resourceUsage().maxRSS / 1024,
    finalHeapMiB: process.memoryUsage().heapUsed / 1024 ** 2,
  })));
}

export function partitions(ts, config, count, base = root, partition = 'tests', covered) {
  const parsed = ts.getParsedCommandLineOfConfigFile(resolve(base, config), {}, {
    ...ts.sys, onUnRecoverableConfigFileDiagnostic: d => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n')); },
  });
  if (!parsed || parsed.errors.length) throw new Error(`Cannot parse ${config}`);
  const groups = Array.from({ length: count }, () => []);
  for (const file of parsed.fileNames) {
    const text = ts.sys.readFile(file) ?? '';
    // Preserve declarations, global scripts and module augmentations everywhere.
    // Full checks share production roots; production checks first cover the
    // entrypoint graph, then deal out the roots that graph did not reach.
    const test = /\.(?:test|spec|node-test)\.[cm]?tsx?$/.test(file);
    const source = (test || partition !== 'tests') && count > 1 ? ts.createSourceFile(file, text, ts.ScriptTarget.Latest) : undefined;
    const shared = (partition === 'tests' && !test) || file.endsWith('.d.ts') || !source || !ts.isExternalModule(source) || /\bdeclare\s+(?:global|module)\b/.test(text);
    const hash = createHash('sha256').update(relative(base, file).replaceAll('\\', '/')).digest().readUInt32BE();
    if (covered && !shared && covered.has(file.replaceAll('\\', '/'))) continue;
    const shard = covered ? 1 + hash % (count - 1) : hash % count;
    groups.forEach((files, index) => { if (shared || index === shard) files.push(file); });
  }
  if (covered) groups[0].push(resolve(base, 'server/index.ts'));
  return groups;
}

export async function runProgram(name, { list = false, original = false, noEmit = false, roots: selectedRoots } = {}) {
  const entry = budgets.programs[name];
  if (!entry) throw new Error(`Unrecorded TypeScript program: ${name}`);
  if (entry.recordedPeakMiB !== null) checkPeak(entry.recordedPeakMiB, entry.capMiB);
  const capMiB = effectiveCap(entry);
  const ambient = heapCap(process.env.NODE_OPTIONS);
  if (ambient && ambient < capMiB) throw new Error(`${name} requires a ${capMiB} MiB cap; job supplies ${ambient}`);
  // The child gets the recorded cap (or the job's declared cap), never the
  // caller's generic Node budget. Hosted macOS must never inherit a Linux-sized heap.
  if (process.env.CI && totalmem() / 1024 ** 2 * 0.61 < capMiB) throw new Error(`${name}: runner RAM is too small for cap ${capMiB}`);
  const compilerRequire = createRequire(resolve(root, entry.config));
  const ts = compilerRequire('typescript');
  const compiler = compilerRequire.resolve('typescript/bin/tsc');
  const typeRoots = [];
  for (let dir = dirname(resolve(root, entry.config)); ; dir = dirname(dir)) {
    typeRoots.push(join(dir, 'node_modules/@types'));
    if (dirname(dir) === dir) break;
  }
  noEmit ||= Boolean(entry.typecheckOnly);
  let covered;
  if (!original && !selectedRoots && entry.partition === 'dependencies') {
    const candidates = partitions(ts, entry.config, 2, root, 'all');
    const second = new Set(candidates[1]);
    const ambient = candidates[0].filter(file => second.has(file));
    covered = await runProgram(name, { list: true, noEmit: true, roots: [resolve(root, 'server/index.ts'), ...ambient] });
  }
  const groups = selectedRoots ? [selectedRoots] : original || entry.shards === 1 ? [null] : partitions(ts, entry.config, entry.shards, root, entry.partition, covered);
  const dir = mkdtempSync(join(tmpdir(), 'murage-types-'));
  const files = new Set();
  let failed = false;
  try {
    for (const [index, roots] of groups.entries()) {
      const config = roots === null ? resolve(root, entry.config) : join(dir, `${index}.json`);
      if (roots) writeFileSync(config, JSON.stringify({
        extends: resolve(root, entry.config), files: roots, include: [], exclude: [],
        compilerOptions: { typeRoots, ...(noEmit || list ? { noEmit: true } : {}) },
      }));
      const start = Date.now();
      const result = spawnSync(process.execPath, ['--import', import.meta.url, compiler, '-p', config,
        '--pretty', 'false', ...(list ? ['--listFilesOnly'] : ['--extendedDiagnostics', ...(/-(?:build|emit)$/.test(name) ? ['--listFiles'] : [])]), ...(noEmit ? ['--noEmit'] : []), '--noCheck', String(Boolean(entry.noCheck))], {
        cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 ** 2,
        env: { ...process.env, MURAGE_TSC_RESOURCE_WORKER: '1', NODE_OPTIONS: `--max-old-space-size=${capMiB}` },
      });
      let measurement;
      for (const line of (result.stdout ?? '').split(/\r?\n/).filter(Boolean)) {
        if (line.startsWith(marker)) measurement = JSON.parse(line.slice(marker.length));
        else if (list || (/^(?:\/|[A-Za-z]:[\\/])/.test(line) && /\.(?:[cm]?[jt]sx?|json)$/.test(line))) files.add(line.replaceAll('\\', '/'));
        else console.log(line);
      }
      if (result.stderr) process.stderr.write(result.stderr);
      if (!measurement) throw new Error(`${name}/${index + 1}: compiler exited without resource measurement (${result.status ?? result.signal})`);
      console.log('TYPECHECK_MEASUREMENT ' + JSON.stringify({ program: name, shard: index + 1, capMiB, ...measurement, wallSeconds: (Date.now() - start) / 1000, status: result.status, list }));
      checkPeak(measurement.peakMiB, capMiB);
      if (result.status !== 0 || result.error || result.signal) failed = true;
    }
    if (failed) throw new Error(`${name}: TypeScript failed`);
    if (!list && /-(?:build|emit)$/.test(name)) {
      const listed = files;
      const tests = [...listed].filter(file => !file.includes('/node_modules/') && /\.(?:test|spec|node-test)\.[cm]?tsx?$/.test(file));
      if (tests.length) throw new Error(`${name} imports test files: ${tests.map(file => relative(root, file)).join(', ')}`);
    }
    return files;
  } finally { safeWipeSync(dir); }
}

export async function coverage() {
  for (const name of [...budgets.groups.full, 'server-build']) {
    const before = await runProgram(name, { list: true, original: true });
    const after = await runProgram(name, { list: true });
    const removed = [...before].filter(file => !after.has(file));
    const added = [...after].filter(file => !before.has(file));
    if (removed.length || added.length) throw new Error(`${name}: coverage changed (${removed.length} removed, ${added.length} added)`);
    const digest = createHash('sha256').update([...before].sort().join('\n')).digest('hex');
    console.log(`TYPECHECK_COVERAGE ${name} files=${before.size} diff=0 sha256=${digest}`);
  }
}

export async function main(args = process.argv.slice(2)) {
  const [command = 'full', ...flags] = args;
  if (command === 'coverage') return coverage();
  const selected = command === 'full' ? (process.env.MURAGE_TYPECHECK_MODE || 'full') : command;
  if (!['full', 'production', ...Object.keys(budgets.programs)].includes(selected)) throw new Error(`Unknown type-check mode ${selected}`);
  if (selected === 'full') await coverage();
  for (const name of budgets.groups[selected] ?? [selected]) {
    const noEmit = selected === 'full' || selected === 'production' || flags.includes('--noEmit');
    await runProgram(name, { noEmit });
    const emit = budgets.programs[name].emitProgram;
    if (emit && !noEmit) await runProgram(emit);
  }
}
if (process.env.MURAGE_TSC_RESOURCE_WORKER !== '1' && process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
