// SPDX-License-Identifier: AGPL-3.0-or-later
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it,vi} from 'vitest';
import {fixture,d,baseRun} from './fixture.ts';
import {guardEngineRelease} from './provider-release.ts';
import {extractInspectedOperation} from '../no-limits-operation.ts';
import {emittedCwd} from '../testing/no-limits-request-cwd-inventory-1019.ts';
import {removeTempDir} from '../testing/cleanup.ts';
import {protectedReferent} from '../testing/no-limits-a4-fixture.ts';
async function release(path:string, site:string, changed=true, explicit=false, level:'unlimited'|'full'='unlimited') {
 const root=mkdtempSync(join(tmpdir(),'nlsym-A4-cwd-')),other=join(root,'X');mkdirSync(join(root,'out'));mkdirSync(join(other,'out'),{recursive:true});
 const target=join(explicit?other:root,'out/notes');writeFileSync(target,'ordinary');
 const before=readFileSync(protectedReferent(),'utf8'),f=fixture(level);
 try{
  const input={path,content:'fake-only',...(explicit?{cwd:other}:{})},cwdFields=emittedCwd(site,root);
  const h=f.open('cwd',input,{tool:'write_file',toolCall:{name:'write_file',input},...cwdFields});
  expect(d.decide(h,baseRun)).toEqual({kind:'run'});
  if(changed){const {unlinkSync}=await import('node:fs');unlinkSync(target);symlinkSync(protectedReferent(),target);}
  let writes=0;
  const allowed=guardEngineRelease({threadId:'t',turnId:'turn',requestId:'cwd',providerInstanceId:'p'},input);
  if(allowed)writes++;
  expect(allowed).toBe(!changed||level==='full');expect(writes).toBe(!changed||level==='full'?1:0);
  expect(readFileSync(protectedReferent(),'utf8')).toBe(before);
  if(changed&&level==='unlimited')expect(d.openApprovals('t')).toHaveLength(1);
  else expect(d.openApprovals('t')).toEqual([]);
 }finally{await removeTempDir(root);}
}
it('CWD-1 relative MCP write releases only its captured cwd evidence',()=>release('out/notes','openai-chat.ts#1'));
it('CWD-1-run ordinary relative write has no card or refusal',()=>release('out/notes','openai-chat.ts#1',false));
it.each(['./out/notes','out/../out/notes'])('CWD-2 normalized relative MCP path %s',path=>release(path,'openai-chat.ts#1'));
it('CWD-3 explicit input cwd wins over executionCwd',()=>release('out/notes','openai-chat.ts#1',true,true));
it('CWD-4 Antigravity native write emit seam carries process cwd',()=>release('out/notes','antigravity.ts#1'));
it('CWD-5 Muse args branch emit seam carries process cwd',()=>release('out/notes','muse-code.ts#1'));
for(const site of ['acp/core.ts#3','claude.ts#3','codex.ts#1','codex.ts#2'])it(`CWD-6 undefined execEnv fallback ${site}`,()=>release('out/notes',site));
it('CWD-7 Full access bypasses changed cwd evidence',()=>release('out/notes','openai-chat.ts#1',true,false,'full'));
it('CWD-7 Full access reader and disk sentinels are never evaluated',async()=>{
 const {releaseGuard,installReleaseContextReader}=await import('./release-guard.ts');
 const inspect=vi.fn(()=>{throw Error('disk reader touched');}),extract=vi.fn(()=>{throw Error('owner extractor touched');});
 const off=installReleaseContextReader(()=>({posture:'legacy',inspect}));
 try{const request={get exactOperation(){return extract();},get operationHash():string{throw Error('operation hash touched');},requestKey:'r',threadId:'t',generation:'g',releaseKind:'native' as const};let result;expect(()=>{result=releaseGuard(request);}).not.toThrow();expect(result).toEqual({kind:'release'});expect(inspect).not.toHaveBeenCalled();expect(extract).not.toHaveBeenCalled();}finally{off();}
});
it('CWD-3 reader precedence remains explicit cwd then event cwd then execEnv',()=>{
 const result=extractInspectedOperation({tool:'write_file',input:{path:'out/notes',cwd:'/input'},event:{executionCwd:'/event',execEnv:{cwd:'/env'}}} as any);
 expect(result.kind).not.toBe('incomplete');if(result.kind!=='incomplete')expect(result.exactOperation.cwd).toBe('/input');
});
