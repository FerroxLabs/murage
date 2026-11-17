// secret-scan: fixture
import { readFileSync } from 'node:fs';
import { outsideScanMarks, interpreterBranches } from '../../../server/outside-scan.ts';
const root = new URL('../../../server/testing/fixtures/win-git-bash-trust/', import.meta.url);
const fixture = name => JSON.parse(readFileSync(new URL(name + '.json', root), 'utf8'));
const native = 'C:/Users/fixture/AppData/Local/Programs/Git/bin/bash.exe';
const clean = {
  cwd: 'C:/Users/fixture/work',
  lookupProgram: name => name.toLowerCase() === 'bash' ? native : `C:/Windows/System32/${name}.exe`,
  probe: file => /(?:^|[\\/])bash(?:\.exe)?$/i.test(file)
    ? { kind: 'file', real: native, native: true, fresh: false, zip: false } : null,
};
const run = (id, command, hooks = clean) => {
  const marks = outsideScanMarks(command, hooks);
  return { id, marks, branches: interpreterBranches() };
};
const explicit = '/c/Users/fixture/AppData/Local/Programs/Git/bin/bash.exe ./build.sh';
const rows = [
  run('bare-per-user', 'bash ./build.sh'),
  run('explicit-native-cwd-on-linux', explicit),
  run('explicit-host-cwd-synthetic-probe', explicit, { ...clean, cwd: '/fixture/work' }),
  run('explicit-with-engine-env-host-cwd', explicit, { ...clean, cwd: '/fixture/work', engineEnv: true }),
  run('bare-missing-probe', 'bash ./build.sh', {}),
  run('operand-env', 'env printf bash'),
  run('operand-find', 'find . -exec printf bash \\;'),
  ...['claude-plain', 'claude-cd', 'fuigo-pwsh', 'codex-control'].map(name => {
    const row = fixture(name);
    return run(name, row.command, { ...clean, pwsh: row.dialect === 'pwsh' });
  }),
  ...fixture('same-turn-matrix').cases.map(row => run(row.id, row.command)),
];
console.log(JSON.stringify({
  schema: 1, base: 'c12aaad9341e8f87126a193f35b5c2768f0aa66f', host: process.platform,
  evidenceKind: 'synthetic scanner hooks only; no Windows process, body-reader, policy or private binding proof',
  realWindowsBaseline: 'unmeasured', rows,
}, null, 2));
