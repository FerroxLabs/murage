#!/usr/bin/env node
// Owner: wg-proof (replay consumer); wg-text/wg-win own wipeBreaker producer.
// Logs and context stay outside the repository. Worker output is always drained.
import "../../../shared/win-hide-child-process.mjs";
import { Worker } from 'node:worker_threads';
import { ruleIds } from '../adapter.mjs';
const argv = process.argv.slice(2), options = {};
try {
  if (!argv.length) throw Error('usage');
  options.directory = argv.shift();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--require-zero-new') options.requireZero = true;
    else if (['--checker', '--baseline-checker', '--context'].includes(argv[i]) && argv[i + 1])
      options[argv[i].slice(2).replaceAll('-', '_')] = argv[++i];
    else throw Error('usage');
  }
  if (options.requireZero && !options.baseline_checker) throw Error('baseline-required');
} catch {
  process.stderr.write('Usage: replay.mjs DIRECTORY [--context FILE] [--checker FILE] [--baseline-checker FILE] [--require-zero-new]\n');
  process.exit(2);
}
const worker = new Worker(new URL('./worker.mjs', import.meta.url), { workerData: options, stdout: true, stderr: true });
// Discard, never echo arbitrary producer diagnostics or command bytes.
worker.stdout.resume(); worker.stderr.resume();
let received = false;
worker.on('message', summary => {
  received = true;
  // Only the fixed count schema can leave the worker.
  const counts = value => Number.isSafeInteger(value) && value >= 0;
  const rulesSafe = value => value && Object.entries(value).every(([key, count]) => ruleIds.has(key) && counts(count));
  if (!counts(summary.commands) || !counts(summary.cards) || !counts(summary.files) ||
      !(summary.newCards === null || counts(summary.newCards)) || !rulesSafe(summary.rules) || !rulesSafe(summary.newRules)) {
    process.stderr.write('Replay failed; no input rows disclosed.\n'); process.exitCode = 1; return;
  }
  console.log(JSON.stringify({ kind: 'wipe-proof-replay', files: summary.files, commands: summary.commands,
    cards: summary.cards, rules: summary.rules, newCards: summary.newCards, newRules: summary.newRules }));
  if (options.requireZero && summary.newCards !== 0) process.exitCode = 1;
});
worker.on('error', () => { process.stderr.write('Replay failed; no input rows disclosed.\n'); process.exitCode = 1; });
worker.on('exit', code => { if (code || !received) process.exitCode = 1; });
