import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { smoothVerdict } from './judge.mjs';

// Rejudge raw evidence; a saved PASS field is never sufficient.
export function readSmoothReceipt({ root, sha, rig, mode, git, now = Date.now() }) {
  const json = path => JSON.parse(readFileSync(path, 'utf8'));
  const value = path => readFileSync(path, 'utf8').trim();
  const manifest = json(join(root, 'manifest.json'));
  const evidence = join(root, `smooth-${mode}-evidence`);
  const states = readdirSync(join(root, `smooth-${mode}`)).filter(f => f.startsWith(`run-${mode}.`));
  if (manifest.sha !== sha || manifest.smoothRig !== rig || states.length !== 1) throw Error('Smoothness receipt candidate/rig mismatch');
  const originalState = join(root, `smooth-${mode}`, states[0]);
  const overlay = value(join(originalState, 'overlay'));
  if (!/^[a-f0-9]{40}$/.test(overlay) || git('rev-parse', `${overlay}^`) !== sha) throw Error('Smoothness overlay parent mismatch');
  // g8-overlay updates the rig's index entries and retains extra candidate
  // fixture files. Require every pinned entry, including its mode and blob.
  const rigEntries = git('ls-tree', '-r', rig, 'scripts/smoothness').split('\n').filter(Boolean);
  const overlayEntries = new Set(git('ls-tree', '-r', overlay, 'scripts/smoothness').split('\n').filter(Boolean));
  if (!rigEntries.length || rigEntries.some(entry => !overlayEntries.has(entry))) throw Error('Smoothness overlay rig mismatch');
  const rigFiles = new Set(rigEntries.map(entry => entry.slice(entry.indexOf('\t') + 1)));
  const fakes = ['fake-acp-cli.ts', 'fake-claude-cli.ts', 'fake-codex-app-server.ts', 'fake-pi-cli.ts', 'fixture-request.ts'].map(f => 'server/testing/' + f);
  const changed = git('diff-tree', '--no-commit-id', '--name-only', '-r', overlay).split('\n').filter(Boolean);
  if (changed.some(f => !rigFiles.has(f) && !fakes.includes(f))) throw Error('Smoothness overlay changed product code');
  for (const file of fakes) {
    if (git('rev-parse', `${overlay}:${file}`) !== git('rev-parse', `fd825341c6cc752318f0433203399db4d434a19c:${file}`)) throw Error('Smoothness fake-engine pin mismatch');
  }
  const worker = value(join(originalState, 'worker.exit'));
  if (!/^[01]$/.test(worker) || value(join(originalState, 'tee.exit')) !== '0' || value(join(evidence, 'done')) !== worker) throw Error('Incomplete smoothness worker/cleanup receipt');
  const code = +worker;
  const resultFiles = readdirSync(join(evidence, 'out')).filter(f => /^results-.*\.json$/.test(f));
  if (resultFiles.length !== 1) throw Error('Missing/ambiguous smoothness result');
  const result = json(join(evidence, 'out', resultFiles[0]));
  const age = now - Date.parse(result.startedAt);
  if (result.tree !== overlay || result.engines !== 'fake' || result.load !== (mode === 'load') || !Number.isFinite(age) || age < 0 || age > 7 * 86400_000) throw Error('Smoothness result identity, engine mode or freshness mismatch');
  const fixture = json(join(evidence, 'fixture.json'));
  if (JSON.stringify(fixture) !== JSON.stringify(JSON.parse(git('show', `${rig}:scripts/smoothness/fixtures-v7.json`)))) throw Error('Smoothness fixture manifest mismatch');
  const log = join(evidence, 'gate.log');
  return { ...smoothVerdict(readFileSync(log, 'utf8'), code), code, log, evidence, reusedFrom: root };
}
