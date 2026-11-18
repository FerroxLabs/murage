import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { parentPort, workerData as options } from 'node:worker_threads';
import { loadChecker, ruleIds } from '../adapter.mjs';
// Dedicated worker isolates diagnostics; parent drops stdout and stderr.
const checker = await loadChecker(options.checker);
const baseline = options.baseline_checker ? await loadChecker(options.baseline_checker) : null;
const context = options.context ? JSON.parse(await fsp.readFile(options.context, 'utf8')) : {};
if (!context || typeof context !== 'object' || Array.isArray(context)) throw Error('context-contract');
const summary = { files: 0, commands: 0, cards: 0, rules: {}, newCards: baseline ? 0 : null, newRules: {} };
const safeRule = hit => ruleIds.has(hit.rule) ? hit.rule : 'other';
function add(table, rule) { table[rule] = (table[rule] ?? 0) + 1; }
async function walk(directory) {
  const stat = await fsp.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('input-directory');
  for (const name of (await fsp.readdir(directory)).sort()) {
    const file = path.join(directory, name), entry = await fsp.lstat(file);
    if (entry.isSymbolicLink()) throw Error('input-symlink');
    if (entry.isDirectory()) { await walk(file); continue; }
    if (!entry.isFile()) throw Error('input-file');
    summary.files++;
    const stream = fs.createReadStream(file, { encoding: 'utf8' });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const row of lines) {
        if (!row.trim()) continue;
        summary.commands++;
        const hit = await checker(row, context), before = baseline ? await baseline(row, context) : null;
        if (hit) {
          summary.cards++; add(summary.rules, safeRule(hit));
          if (baseline && !before) { summary.newCards++; add(summary.newRules, safeRule(hit)); }
        }
      }
    } finally { lines.close(); stream.destroy(); }
  }
}
await walk(path.resolve(options.directory));
parentPort.postMessage(summary);
