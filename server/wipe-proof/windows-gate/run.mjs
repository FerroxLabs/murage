// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: wg-winproof owns this caller/corpus; wg-text owns wipeBreaker and its
// public context contract (wg-win owns the Windows language implementation).
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// No shell, eval, child process, app server, or command execution belongs here.
// Paths in the corpus are fixture text, never real deletion targets.
const minimumNode = 24;
if (Number(process.versions.node.split('.')[0]) < minimumNode) {
  console.error(`Windows text gate requires Node ${minimumNode}+ with native TypeScript support.`);
  process.exit(1);
}
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--summary')) {
  console.error('Usage: node run.mjs [--summary FILE]');
  process.exit(1);
}

try {
  const source = await readFile(new URL('./cases.json', import.meta.url), 'utf8');
  const rows = JSON.parse(source);
  const engines = new Map([
    ['Windows PowerShell 5.1', 'pwsh'], ['PowerShell 7', 'pwsh'],
    ['cmd', 'cmd'], ['Git Bash', 'sh'],
  ]);
  const ids = new Set();
  if (!Array.isArray(rows) || rows.length !== 240) throw new Error('Expected all 240 reference rows.');
  for (const row of rows) {
    if (!/^[CR]\d{3}$/.test(row.id) || ids.has(row.id)) throw new Error('Invalid or duplicate reference id.');
    ids.add(row.id);
    // MAIN RULING 23:15Z(b): only C100 changes section; every other ID keeps its verdict prefix.
    if (!['card', 'run'].includes(row.expected) || (row.id === 'C100' ? row.expected !== 'run' : row.id[0] !== (row.expected === 'card' ? 'C' : 'R'))) {
      throw new Error(`Invalid expectation: ${row.id}`);
    }
    if (typeof row.command !== 'string' || !row.command.trim() || typeof row.reason !== 'string' || !row.reason.trim()) {
      throw new Error(`Missing command/reason: ${row.id}`);
    }
    const context = row.context;
    if (!engines.has(row.engine) || context?.dialect !== engines.get(row.engine) || context.platform !== 'win32' ||
        !['cwd', 'home', 'project', 'dataDir'].every(key => typeof context[key] === 'string' && /^[A-Z]:\\/.test(context[key])) ||
        context.env?.HOME !== context.home || context.env?.USERPROFILE !== context.home) {
      throw new Error(`Invalid Windows fixture context: ${row.id}`);
    }
  }
  const count = expected => rows.filter(row => row.expected === expected).length;
  // MAIN RULING 23:15Z(b): C100 keeps its original ID and command as an ordinary RUN control.
  if (count('card') !== 119 || count('run') !== 121) throw new Error('Expected 119 CARD and 121 RUN rows.');

  const { wipeBreaker } = await import('../../wipe-breaker.ts');
  // Fresh isolated ports per row. Never consult the machine's home, project
  // registry, mounts or filesystem to decide the supplied fixture strings.
  // The product still classifies every root and parses every command itself.
  const fixturePorts = () => ({
    pathPort: { realpath: () => null, isBlockDevice: () => false, lstat: () => null, stat: () => null },
    registry: { contains: () => false, protectedChildren: () => [] },
    mountInventory: { contains: () => false },
  });
  const failures = [];
  const totals = { card: { total: count('card'), passed: 0 }, run: { total: count('run'), passed: 0 } };
  const byEngine = {};
  for (const row of rows) {
    let actual, rule = null;
    try {
      const hit = wipeBreaker(row.command, { ...structuredClone(row.context), ...fixturePorts() });
      actual = hit === null ? 'run' : 'card';
      rule = hit?.rule ?? null;
      // A checker fault cannot satisfy a catastrophe reference assertion.
      if (rule === 'wipe-check-fault') actual = 'fault';
    } catch {
      actual = 'error';
    }
    const passed = actual === row.expected;
    const bucket = byEngine[row.engine] ??= { total: 0, passed: 0, failed: 0 };
    bucket.total++;
    bucket[passed ? 'passed' : 'failed']++;
    if (passed) totals[row.expected].passed++;
    else failures.push({ id: row.id, expected: row.expected, actual, rule });
    console.log(`${passed ? 'PASS' : 'FAIL'} ${row.id} expected=${row.expected} actual=${actual}${rule ? ` rule=${rule}` : ''}`);
  }
  const summary = {
    gate: 'windows-plain-text', schemaVersion: 1,
    platform: process.platform, node: process.versions.node,
    launcherPowerShell: process.env.WINDOWS_GATE_POWERSHELL_VERSION ?? null,
    commandsExecuted: 0, fixture: 'isolated lexical Windows context; filesystem unavailable',
    casesSha256: createHash('sha256').update(source).digest('hex'),
    checkerSha256: createHash('sha256').update(await readFile(new URL('../../wipe-breaker.ts', import.meta.url))).digest('hex'),
    total: rows.length, passed: rows.length - failures.length, failed: failures.length,
    verdicts: totals, byEngine, failures,
  };
  // Explicit output only: the Linux caller keeps evidence outside the checkout.
  if (args.length) await writeFile(args[1], JSON.stringify(summary, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify(summary));
  process.exitCode = failures.length ? 1 : 0;
} catch (error) {
  console.error(`FAIL gate setup: ${error.message}`);
  process.exitCode = 1;
}
