import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertExternalEvidencePath } from './evidence-path.mjs';
import { safeWipeSync } from '../server/testing/safe-wipe.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));

// The lane pins paths. Hosted CI may fetch the pins; offline runners read
// them from the host repository and mount the result outside their checkout.
export function prepareEvidenceTestInputs(allowFetch = false) {
  const manifest = readFileSync(new URL('evidence-test-inputs.txt', import.meta.url), 'utf8');
  const archives = Map.groupBy(manifest.trimEnd().split(/\r?\n/).map(line => {
    const [commit, path] = line.split(' ');
    return { commit, path };
  }), entry => entry.commit);
  const git = args => execFileSync('git', ['-C', repository, ...args], { maxBuffer: 64 * 1024 * 1024 });
  for (const commit of archives.keys()) {
    if (spawnSync('git', ['-C', repository, 'cat-file', '-e', commit + '^{commit}'], { stdio: 'ignore' }).status === 0) continue;
    if (!allowFetch) throw Error(`Missing evidence source commit ${commit}. For source-only runs, mount the pinned inputs and set MURAGE_EVIDENCE_ARCHIVE.`);
    git(['fetch', '--no-tags', '--depth=1', 'origin', commit]);
  }

  const destination = mkdtempSync(join(assertExternalEvidencePath(tmpdir()), 'murage-evidence-inputs-'));
  try {
    for (const [commit, entries] of archives) {
      const archive = git(['--literal-pathspecs', 'archive', '--format=tar', commit, '--', ...entries.map(entry => entry.path)]);
      execFileSync('tar', ['-xf', '-', '-C', destination], { input: archive });
    }
    return destination;
  } catch (error) {
    safeWipeSync(destination, { reason: 'incomplete qualification test inputs' });
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(prepareEvidenceTestInputs(process.argv.includes('--allow-fetch')));
}
