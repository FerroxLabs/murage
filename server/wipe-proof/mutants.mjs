// Owner: wg-proof. Roll back each review fix in a disposable copy, never in the checkout.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { here } from './adapter.mjs';
import { assertTempRoot } from './safety.mjs';
import { execute } from './process.mjs';
const sandbox = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'wipe-proof-'));
let failures = 0;
try {
  for (const [id, file, from, to] of [
    ['H1', 'windows/disk-fixture.ps1', 'string full = System.IO.Path.GetFullPath(value);', 'if (value != null) return System.IO.Path.GetFullPath(value); // boundary removed\n      string full = System.IO.Path.GetFullPath(value);'],
    ['M1', 'windows/assertions.mjs', 'return expected;', 'return before;'],
    // The reviewed process helper also marks the overflowing stream; remove all flags for the same silent-truncation mutant.
    ['M2', 'process.mjs', 'overflow = true; overflowed[stream] = true; error = true;', '/* silently truncate */'],
    ['M3', 'adapter.mjs', "['guard.sh', 'guard-lib.sh', 'guard-request.sh']", "['guard.sh', 'guard-lib.sh']"],
    ['M4', 'posix/device-proof.mjs', 'ok: outcome.code === expected', 'ok: true || outcome.code === expected'],
  ]) {
    const copy = path.join(sandbox, id); await fs.cp(here, copy, { recursive: true });
    const target = path.join(copy, file), original = await fs.readFile(target, 'utf8');
    if (!original.includes(from)) throw Error('mutant-not-applied');
    await fs.writeFile(target, original.replace(from, to));
    const outcome = await execute(process.execPath, ['--test', '--test-name-pattern=^' + id + ':', path.join(copy, 'regression.test.mjs')], process.env, copy, 30000);
    const killed = outcome.code === 1 && !outcome.error && !outcome.timedOut && outcome.stdout.includes('fail 1') && (id !== 'H1' || outcome.stdout.includes('42'));
    console.log(`${killed ? 'PASS' : 'FAIL'} mutant/${id}-killed`);
    if (!killed) { failures++; process.stdout.write(outcome.stdout); process.stderr.write(outcome.stderr); }
  }
} finally { await assertTempRoot(sandbox); await fs.rm(sandbox, { recursive: true, force: true }); }
process.exitCode = failures ? 1 : 0;
