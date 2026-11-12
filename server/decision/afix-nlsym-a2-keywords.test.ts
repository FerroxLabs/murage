// SPDX-License-Identifier: AGPL-3.0-or-later
// Inputs are inspected as data; no Python or filesystem mutation is executed.
import { expect, it } from 'vitest';
import { inspectOwnerOperation } from '../no-limits-inspection.ts';
import { noLimitsProtectedWrite } from '../no-limits-protected.ts';
import { d, fixture, baseRun } from './fixture.ts';
const rows = [
 ['chmod', (p:string)=>`os.chmod(path='${p}', mode=0o600)`],
 ['chown', (p:string)=>`os.chown(path='${p}', uid=1, gid=1)`],
 ['lchmod', (p:string)=>`os.lchmod(path='${p}', mode=0o600)`],
 ['lchown', (p:string)=>`os.lchown(path='${p}', uid=1, gid=1)`],
 ['mkdir', (p:string)=>`os.mkdir(path='${p}')`],
 ['makedirs', (p:string)=>`os.makedirs(name='${p}')`],
 ['rename-dst', (p:string)=>`os.rename(src='/tmp/nlsym-source', dst='${p}')`],
 ['rename-src', (p:string)=>`os.rename(src='${p}', dst='/tmp/nlsym-dest')`],
 ['replace', (p:string)=>`os.replace(src='/tmp/nlsym-source', dst='${p}')`],
 ['symlink-src', (p:string)=>`os.symlink(src='${p}', dst='/tmp/nlsym-link')`],
 ['symlink-dst', (p:string)=>`os.symlink(src='/tmp/nlsym-source', dst='${p}')`],
 ['link-src', (p:string)=>`os.link(src='${p}', dst='/tmp/nlsym-link')`],
 ['link-dst', (p:string)=>`os.link(src='/tmp/nlsym-source', dst='${p}')`],
 ['path-rename', (p:string)=>`pathlib.Path('/tmp/nlsym-source').rename(target='${p}')`],
 ['path-replace', (p:string)=>`pathlib.Path('/tmp/nlsym-source').replace(target='${p}')`],
 ['path-symlink', (p:string)=>`pathlib.Path('/tmp/nlsym-link').symlink_to(target='${p}')`],
 ['path-hardlink', (p:string)=>`pathlib.Path('/tmp/nlsym-link').hardlink_to(target='${p}')`],
 ['tofile', (p:string)=>`data.tofile(file='${p}')`],
 ['open', (p:string)=>`os.open(path='${p}', flags=os.O_WRONLY)`],
] as const;
it.each(rows)('A2 keyword %s protected/ordinary typed twins', (_name, call) => {
 for(const [path, verdict] of [['/etc/hosts','hold'],['/tmp/nlsym-ordinary','run']] as const){
  const result=inspectOwnerOperation({kind:'code',lang:'py',text:`import os, pathlib; ${call(path)}`,cwd:'/tmp',cwdInvalid:false});
  expect(result.verdict, call(path)).toBe(verdict);
  if(verdict==='hold')expect(result.decisions.length).toBeGreaterThan(0);
 }
});
it.each([true,false])('A2 chmod keyword compatibility and S1 protected=%s', protectedPath => {
 const path=protectedPath?'/etc/hosts':'/tmp/nlsym-ordinary';
 const command=`python3 -c "import os; os.chmod(path='${path}', mode=0o600)"`;
 expect(noLimitsProtectedWrite(command,{commandCwd:'/tmp'})!==null).toBe(protectedPath);
 const f=fixture();try{expect(d.decide(f.open('keyword',{command,cwd:'/tmp'}),baseRun).kind).toBe(protectedPath?'card':'run');}finally{f.dispose();}
});

it('A2 read-only keyword open retains protected read RUN',()=>{
 expect(inspectOwnerOperation({kind:'code',lang:'py',text:"import os; os.open(path='/etc/hosts', flags=os.O_RDONLY)",cwd:'/tmp',cwdInvalid:false}).verdict).toBe('run');
});
