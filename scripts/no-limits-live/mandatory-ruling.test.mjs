import { expect, it } from 'vitest';
import { autoVerdict } from '../../server/auto-approve.ts';
import { noLimits, context, protectedTarget } from './mandatory-fixture.mjs';
import { resolve } from 'node:path';
import { predicateInventory } from './predicate-inventory.mjs';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {extractInspectedOperation} from '../../server/no-limits-operation.ts';
import {inspectNativeEffects} from '../../server/no-limits-fs.ts';
import {installReleaseContextReader,releaseGuard} from '../../server/decision/release-guard.ts';
it('one noLimitsAppliesTo implementation decides both policy entry points',()=>{
  const inventory=predicateInventory(resolve('.'));
  expect(inventory.definitions).toHaveLength(1);
  expect(inventory.callers).toContain('server/auto-approve.ts');
  expect(inventory.callers).toContain('server/decision/implementation.ts');
});
// Replaces the superseded protected-path and outside-content No limits
// assertions in server/nolimits-means-it.test.ts. No input is executed.
it.each(['owner','routine','webhook','owner-channel'])('%s non-wipe protected writes RUN, also on marked turns',origin=>{
  const command=`printf fixture > '${protectedTarget()}'`;
  const c=context(command,{noLimitsOrigin:origin,fullAccessOrigin:origin==='webhook'?'other':origin,ownerStarted:origin==='owner'||origin==='owner-channel',
    unattended:origin==='routine'||origin==='webhook',automated:origin==='routine'||origin==='webhook',
    routineLevel:origin==='routine',channelOwner:origin==='owner-channel',outsideRead:['web page'],channelMessages:true});
  const v=autoVerdict(noLimits,'Bash',command,c);expect(v.approve).not.toBeNull();
});
it.each(['full','unlimited'])('other humans remain at Ask on legacy %s bots',level=>{
  const bot={...noLimits,noLimits:level==='unlimited'};delete bot.permissionExplicit;
  const command='touch fixture';
  expect(autoVerdict(bot,'Bash',command,context(command,{fullAccessOrigin:'other',ownerStarted:false,unattended:true,channelOwner:false})).approve).toBeNull();
});
it('a late protected symlink cannot hold a proven No limits non-wipe write',()=>{
 const scratch=mkdtempSync(join(tmpdir(),'gnl-release-symlink-')),home=join(scratch,'home'),work=join(scratch,'work');
 mkdirSync(join(home,'.ssh'),{recursive:true});mkdirSync(work);mkdirSync(join(work,'protected'));writeFileSync(join(home,'.ssh','config'),'fixture');
 let dispose=()=>{};
 try{
  const operation=extractInspectedOperation({tool:'write_file',input:{path:join(work,'protected','config'),content:'fixture'}},{cwd:work});
  expect(operation.kind).toBe('operation');
  const request={requestKey:'fixture:g:write',threadId:'fixture',generation:'g',...operation,releaseKind:'native'};
  dispose=installReleaseContextReader(()=>({posture:'owner-no-limits',operationHash:operation.operationHash,
   inspect:op=>inspectNativeEffects(op.effects,{cwd:work,home}),approved:()=>undefined}));
  expect(releaseGuard(request).kind).toBe('release');
  rmdirSync(join(work,'protected'));symlinkSync(join(home,'.ssh'),join(work,'protected'),process.platform==='win32'?'junction':'dir');
  expect(releaseGuard(request).kind).toBe('release');
 }finally{dispose();rmSync(scratch,{recursive:true,force:true});}
});
it('the non-No-limits release posture retains its existing shortcut',()=>{
 const dispose=installReleaseContextReader(()=>({posture:'legacy'}));
 const unavailable=()=>{throw Error('The legacy guard must not read a No limits operation');};
 try{expect(releaseGuard({requestKey:'fixture:g:legacy',threadId:'fixture',generation:'g',releaseKind:'native',
  get exactOperation(){return unavailable();},get operationHash(){return unavailable();},get approvedEvidence(){return unavailable();}})).toEqual({kind:'release'});
 }finally{dispose();}
});
