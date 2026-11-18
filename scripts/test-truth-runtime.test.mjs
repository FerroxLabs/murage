// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { removeTempDirSync } from '../server/testing/cleanup.ts';

const program = `import base64,hashlib,importlib.util,io,json,pathlib,sys,tarfile
spec=importlib.util.spec_from_file_location('runtime','scripts/test-truth/collect-runtime.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
root=pathlib.Path(sys.argv[1]);kind=sys.argv[2];dest=root/'published';dest.mkdir()
(dest/'head-build.tar.gz').write_bytes(b'previous artifact')
(dest/'head-build.finished').write_text('previous receipt')
good=b'private runtime bytes';artifact=good if kind!='tampered' else b'changed in transit'
receipt=json.dumps({'sha':'b'*40 if kind=='wrong-source' else 'a'*40,'archiveSha256':hashlib.sha256(good).hexdigest()}).encode()
packed=io.BytesIO()
with tarfile.open(fileobj=packed,mode='w:') as archive:
 for name,data in [('head-build.tar.gz',artifact),('head-build.finished',receipt)]+([('../escape',b'outside')] if kind=='extra-entry' else []):
  item=tarfile.TarInfo(name);item.size=len(data);archive.addfile(item,io.BytesIO(data))
log=root/'build.log';log.write_text('BEGIN_RUNTIME head\\n'+base64.b64encode(packed.getvalue()).decode()+'\\nEND_RUNTIME head\\n')
error=None
try:m.collect(log,'head','a'*40,dest,root)
except ValueError as e:error=str(e)
print(json.dumps({'error':error,'artifact':(dest/'head-build.tar.gz').read_text(),'receipt':(dest/'head-build.finished').read_text(),'escaped':(root/'escape').exists()}))`;

it.skipIf(process.platform !== 'linux').each(['valid', 'wrong-source', 'tampered', 'extra-entry'])('runtime stream %s preserves source and artifact identity before atomic publication', kind => {
  const root = mkdtempSync(join(tmpdir(), 'truth-runtime-test-'));
  try {
    const run = spawnSync('python3', ['-c', program, root, kind], { encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    const result = JSON.parse(run.stdout);
    expect(result.escaped).toBe(false);
    if (kind === 'valid') {
      expect(result.error).toBeNull();
      expect(result.artifact).toBe('private runtime bytes');
      expect(JSON.parse(result.receipt).sha).toBe('a'.repeat(40));
    } else {
      expect(result.error).toBeTypeOf('string');
      expect(result.artifact).toBe('previous artifact');
      expect(result.receipt).toBe('previous receipt');
    }
  } finally { removeTempDirSync(root); }
});
