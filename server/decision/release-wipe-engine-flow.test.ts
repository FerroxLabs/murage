// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner release consumer: c3-nl-b. Owner checker: wipe-fable.
import {expect,it} from 'vitest';
import {d,fixture,baseRun} from './fixture.ts';
import {useOutsideStoreFixture} from '../testing/outside-store-fixture.ts';
import {installWipeContextReader} from '../wipe/context.ts';
import {linuxContext} from '../wipe/corpus/v3-context.fixture.ts';
useOutsideStoreFixture();
it('an approved engine-variable home wipe releases without a second unset-variable card',async()=>{
 const f=fixture(),off=installWipeContextReader(()=>linuxContext());
 try{
  const input={command:'rm -rf "$BUILD_DIR"/*',cwd:'/work/project/pkg'};
  const handle=f.open('engine-env',input,{executionCwd:'/work/project/pkg',execEnv:{env:{BUILD_DIR:'/home/u'},absent:[],cwd:'/work/project/pkg',shell:['sh','-c'],capture:'session'}});
  const outcome=d.decide(handle,baseRun);expect(outcome.kind).toBe('card');
  if(outcome.kind!=='card')throw Error('expected wipe card');
  await d.presentApproval(outcome.ref,{title:'Fixture',subtitle:'Wipe'});
  await d.answerApproval(outcome.ref,{behavior:'allow'});
  expect(f.respond).toHaveBeenCalledTimes(1);
  expect(d.readApprovalExecution(outcome.ref)).toMatchObject({delivery:'accepted'});
  expect(d.openApprovals('t')).toHaveLength(0);
 }finally{off();f.dispose();}
});
