// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { linkSync, mkdirSync, mkdtempSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractInspectedOperation } from '../no-limits-operation.ts';
import { inspectNativeEffects, type ProtectedDecision } from '../no-limits-fs.ts';
import type { OwnerOperation as InspectedOperation } from '../no-limits-inspection.ts';
import { removeTempDir } from '../testing/cleanup.ts';
import { approvedEvidenceCovers, installReleaseContextReader, inspectReleaseWipes, releaseGuard, type ReleaseInspection, type ReleaseRequest } from './release-guard.ts';
import type { ApprovalRef } from './types.ts';
let scratch:string,dispose=()=>{};
beforeEach(()=>{scratch=mkdtempSync(join(tmpdir(),'nlsym-guard-'));mkdirSync(join(scratch,'out'));});
afterEach(async()=>{dispose();await removeTempDir(scratch);});
const identity={requestKey:'p:g:r',threadId:'t',generation:'g'};
function request(tool='write_file',input:unknown={path:'out/notes',content:'x'}):ReleaseRequest{
  const result=extractInspectedOperation({tool,input},{cwd:scratch});
  if(result.kind!=='operation')throw new Error('operation-not-extracted');
  return {...identity,...result,releaseKind:'native'};
}
const inspect=(op:InspectedOperation):ReleaseInspection=>{
  if(op.kind!=='native')throw new Error('exec inspector must be provided by C5');
  return inspectNativeEffects(op.effects,{cwd:op.cwd,cwdInvalid:op.cwdInvalid});
};
const decision=(more:Partial<ProtectedDecision>={}):ProtectedDecision=>({operandId:'write:1',op:'write',reason:'direct-path',ruleId:'protected-path',protectedClass:'system',lexical:'/ordinary/h',physical:'/etc/hosts',resolution:{kind:'known',lexical:'/ordinary/h',physical:'/etc/hosts',exists:true,footprint:['/ordinary/h','/etc/hosts'],linkValues:['/etc/hosts']},...more});

describe('C6 typed release guard',()=>{
  it.each([false,true])('native write rechecks disk at release changed=%s',changed=>{
    const r=request();
    dispose=installReleaseContextReader(id=>id.requestKey===identity.requestKey&&id.threadId==='t'&&id.generation==='g'?{posture:'owner-no-limits',operationHash:r.operationHash,inspect,approved:()=>undefined}:undefined);
    expect(releaseGuard(r)).toEqual({kind:'release'});
    if(changed)symlinkSync('/etc/hosts',join(scratch,'out','notes'));
    const result=releaseGuard(r);expect(result.kind).toBe('release');
    if(changed)expect(inspect(r.exactOperation).decisions).toContainEqual(expect.objectContaining({reason:'direct-path',physical:'/etc/hosts'}));
  });
  it('Full access bypass does not read operation/hash/approval or call an inspector',()=>{
    dispose=installReleaseContextReader(()=>({posture:'legacy'}));
    const unavailable=()=>{throw new Error('legacy must not read');};
    expect(releaseGuard({...identity,releaseKind:'native',get exactOperation(){return unavailable();},get operationHash(){return unavailable();},get approvedEvidence(){return unavailable();}})).toEqual({kind:'release'});
  });
  it('requires the authoritative request identity and an issued complete operation',()=>{
    const r=request();dispose=installReleaseContextReader(id=>id.generation==='g'?{posture:'owner-no-limits',operationHash:r.operationHash,inspect,approved:()=>undefined}:undefined);
    expect(releaseGuard({...r,generation:'stale'})).toEqual({kind:'refuse',reason:'unregistered-release'});
    expect(releaseGuard({...r,exactOperation:{...r.exactOperation}})).toEqual({kind:'refuse',reason:'operation-integrity'});
    const changed=request('write_file',{path:'out/notes',content:'changed'});
    expect(releaseGuard(changed)).toEqual({kind:'refuse',reason:'operation-changed'});
  });
  it('refreshes the narrow inode registry between decision and release',()=>{
    const target=join(scratch,'out','notes'),named=join(scratch,'.zshrc');
    writeFileSync(target,'ordinary');writeFileSync(named,'different inode');const r=request();
    const inspectInodes=(op:InspectedOperation)=>{
      if(op.kind!=='native')throw new Error('native required');return inspectNativeEffects(op.effects,{cwd:scratch,home:scratch});
    };
    dispose=installReleaseContextReader(()=>({posture:'owner-no-limits',operationHash:r.operationHash,approved:()=>undefined,inspect:inspectInodes}));
    expect(releaseGuard(r)).toEqual({kind:'release'});unlinkSync(named);linkSync(target,named);
    expect(inspectInodes(r.exactOperation).decisions).toContainEqual(expect.objectContaining({reason:'protected-inode',namedProtectedPath:named}));
    expect(releaseGuard(r)).toEqual({kind:'release'});
  });
  it('permits an unchanged issued wipe approval and rejects newly resolved catastrophe evidence',()=>{
    symlinkSync('/',join(scratch,'out','notes'));const r=request('delete_file',{path:'out/notes/'}),ref={} as ApprovalRef;
    const initial={...inspect(r.exactOperation),wipes:inspectReleaseWipes(r.exactOperation)};
    dispose=installReleaseContextReader(()=>({posture:'owner-no-limits',operationHash:r.operationHash,inspect,approved:candidate=>candidate===ref?{operationHash:r.operationHash,inspection:initial}:undefined}));
    expect(releaseGuard(r).kind).toBe('hold');expect(releaseGuard({...r,approvedEvidence:ref})).toEqual({kind:'release'});
    expect(releaseGuard({...r,approvedEvidence:{} as ApprovalRef})).toEqual({kind:'refuse',reason:'unverified-approval'});
    unlinkSync(join(scratch,'out','notes'));symlinkSync('/etc',join(scratch,'out','notes'));
    expect(releaseGuard({...r,approvedEvidence:ref}).kind).toBe('hold');
  });
  it('retains protected approval coverage diagnostics without recarding protected-only changes',()=>{
    symlinkSync('/etc/hosts',join(scratch,'out','notes'));const r=request(),ref={} as ApprovalRef;
    const initial=inspect(r.exactOperation);
    dispose=installReleaseContextReader(()=>({posture:'owner-no-limits',operationHash:r.operationHash,inspect,approved:candidate=>candidate===ref?{operationHash:r.operationHash,inspection:initial}:undefined}));
    expect(releaseGuard(r).kind).toBe('release');expect(releaseGuard({...r,approvedEvidence:ref})).toEqual({kind:'release'});
    expect(releaseGuard({...r,approvedEvidence:{} as ApprovalRef})).toEqual({kind:'refuse',reason:'unverified-approval'});
    unlinkSync(join(scratch,'out','notes'));symlinkSync('/etc/passwd',join(scratch,'out','notes'));
    expect(approvedEvidenceCovers(inspect(r.exactOperation),initial)).toBe(false);
    expect(releaseGuard({...r,approvedEvidence:ref}).kind).toBe('release');
  });
  it.each([false,true])('never reuses a shell-only inspection for a native request wipe=%s',wipe=>{
    const r=request('delete_file',{path:wipe?'/':'out/notes'});let checked:InspectedOperation|undefined;
    dispose=installReleaseContextReader(()=>({posture:'owner-no-limits',operationHash:r.operationHash,inspect:op=>{checked=op;return {decisions:[decision()]};},approved:()=>undefined}));
    expect(releaseGuard(r).kind).toBe(wipe?'hold':'release');expect(checked).toBe(r.exactOperation);
  });
  it('approval coverage binds each operand/reason/path/inode and every taint trigger',()=>{
    const base=decision({reason:'alias-taint',taintOperationIds:['ln:1']});
    const initial={decisions:[base],taintEvidence:[{operationId:'ln:1',target:'/etc/hosts',resolution:{kind:'known',physical:'/etc/hosts'}}]};
    expect(approvedEvidenceCovers(initial,initial)).toBe(true);
    for(const extra of [{operandId:'write:2'},{reason:'resolution-exhausted' as const},{physical:'/etc/passwd'},{identity:{dev:'2',ino:'42',nlink:2}}])expect(approvedEvidenceCovers({...initial,decisions:[{...base,...extra}]},initial)).toBe(false);
    expect(approvedEvidenceCovers({...initial,taintEvidence:[{operationId:'ln:1',target:'/etc/passwd',resolution:{kind:'known',physical:'/etc/passwd'}}]},initial)).toBe(false);
    expect(approvedEvidenceCovers({decisions:[decision({resolution:{kind:'known',lexical:'/ordinary/h',physical:'/etc/hosts',exists:true,footprint:[],linkValues:[]}})]},{decisions:[decision({resolution:{kind:'unknown',lexical:'/ordinary/h',cause:'unreadable'}})]})).toBe(false);
  });
  it('taint and incomplete alias diagnostics never hold an unrelated non-wipe',()=>{
    expect(approvedEvidenceCovers({decisions:[],taintEvidence:[{target:'/etc/passwd'}]},{decisions:[],taintEvidence:[{target:'/etc/hosts'}]})).toBe(true);
    const incomplete={decisions:[decision({reason:'alias-taint'})]};
    expect(approvedEvidenceCovers(incomplete,incomplete)).toBe(false);
    const r=request();
    dispose=installReleaseContextReader(()=>({posture:'owner-no-limits',operationHash:r.operationHash,inspect:()=>incomplete,approved:()=>undefined}));
    const warning=vi.spyOn(console,'warn').mockImplementation(()=>{});
    try{expect(releaseGuard(r)).toEqual({kind:'release'});expect(warning).toHaveBeenCalledOnce();}finally{warning.mockRestore();}
  });
});
