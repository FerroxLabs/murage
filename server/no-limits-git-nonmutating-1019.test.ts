// SPDX-License-Identifier: AGPL-3.0-or-later
// Production request ingress and decision path; Git inputs are never executed.
import { expect, it } from 'vitest';
import { baseRun, d, fixture } from './decision/fixture.ts';

const commands = [
  ['git push --mirror --dry-run', 'run'],
  ['git push --mirror -n', 'run'],
  ['git push --dry-run --force origin main', 'run'],
  ['git push --mirror --help', 'run'],
  ['git push --mirror -h', 'run'],
  ['git --help push --mirror', 'run'],
  ['git help push --mirror', 'run'],
  ['git -C /w push --dry-run --force origin main', 'run'],
  ['git clean -fdxn', 'run'],
  ['git clean -fdx --help', 'run'],
  ['git filter-branch --help', 'run'],
  ['git filter-repo --help', 'run'],
  ['git reflog expire --help && git gc --prune=now', 'run'],
  ['git reflog expire --all && git gc --prune=now --help', 'run'],
  ['git push --mirror', 'card'],
  ['git push --force origin main', 'card'],
  ['git filter-branch --all', 'card'],
  ['git push --mirror --dry-run && git push --mirror', 'card'],
  ['git push --mirror --help; rm -rf /', 'card'],
  // An option's value and refspec data cannot turn a real push into a dry run/help.
  ['git push --mirror --push-option --dry-run', 'card'],
  ['git push --mirror --push-option --help', 'card'],
  ['git push --mirror -- --dry-run', 'card'],
  ['git push --mirror -- --help', 'card'],
  // These option values are data, never destructive push flags.
  ['git push --push-option --mirror origin topic', 'run'],
  ['git push --push-option --all --force origin topic', 'run'],
  ['git push --push-option --force origin main', 'run'],
  ['git push --receive-pack --mirror origin topic', 'run'],
  ['git push --exec --all --force origin topic', 'run'],
  ['git push -o--mirror origin topic', 'run'],
  ['git push --push-option=--mirror origin topic', 'run'],
  ['git push --mirror --push-option --force-with-lease origin main', 'card'],
] as const;
for (const [command, outcome] of commands) {
  it(`Git nonmutating intent ${outcome}: ${command}`, () => {
    const f = fixture();
    try {
      expect(d.decide(f.open('git', { command, cwd: '/w' }), baseRun).kind).toBe(outcome);
    } finally { f.dispose(); }
  });
}
