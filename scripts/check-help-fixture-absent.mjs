#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
export function checkHelpFixtureAbsent(dist = 'dist', release = '.github/workflows/release.yml', args = process.argv.slice(2)) {
  if (args.some(arg => arg === '--mode' || arg.startsWith('--mode=')) || /--mode(?:[=\s]|$)/m.test(readFileSync(release, 'utf8'))) {
    throw Error('Release must not pass --mode');
  }
  let files = 0;
  function scan(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) scan(path);
      else {
        files++;
        const text = readFileSync(path).toString('utf8');
        if (text.includes('HELP_ASK_FIXTURE_ONLY') || text.includes('__helpAskFixture')) throw Error(`Help fixture in shipped asset: ${path}`);
      }
    }
  }
  scan(dist);
  if (!files) throw Error('Empty dist cannot prove fixture absence');
}
if (process.argv[1] === fileURLToPath(import.meta.url)) checkHelpFixtureAbsent();
