// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// All payloads are inert: only the policy and registered decision host run.
import {expect,it} from 'vitest';
import {autoVerdict} from './auto-approve.ts';
import {sqlWipe} from './no-limits-wipe-sql.ts';
import {noLimitsWipe} from './no-limits-wipe.ts';
import {readExecutableOwnerNl} from './no-limits-code.ts';
import {d,fixture,baseRun} from './decision/fixture.ts';
import {reviewRows,overflowPrefix} from '../scripts/no-limits-live/truly-review-rows.mjs';
const bot={autoApprove:true,fullAccess:true,noLimits:true};
const context={cwd:'/w',project:'/w',home:'/home/fixture'};
// MAIN RULING 1114-NOLIMITS-OLD-ORACLES: these original inputs delete the
// filesystem root. SQL (including executable DELETE), opaque evaluation,
// printed examples and Git pushes do not remove a protected filesystem root.
const filesystemWipes=new Set(['native-overflow-tail','native-overflow-head','native-overflow-tail-js'].map(id=>'truly-review-'+id));
it('native overflow recovery keeps the strict authority read incomplete',()=>{
 const code=overflowPrefix+`import shutil; shutil.rmtree('/')`;
 expect(code.lastIndexOf('shutil.rmtree')).toBeGreaterThan(65536);
 expect(()=>readExecutableOwnerNl('py',code)).toThrow();
 expect(readExecutableOwnerNl('py',code,undefined,0,'/w',true)).toMatchObject({classes:expect.arrayContaining(['root']),authority:{exhausted:true}});
});
for(const row of reviewRows)for(const layer of ['direct','approval','registered'])it(`${row.id} ${row.expected} ${layer}`,async()=>{
 // MAIN RULING 1114-NOLIMITS-OLD-ORACLES
 const card=filesystemWipes.has(row.id);
 expect(row.actor).toBe('owner');expect(row.level).toBe('unlimited');
 const input=row.input as {code?:string;command?:string},tool=row.tool;
 const native=tool==='python'||tool==='node';
 const text=native?input.code:input.command;
 if(layer==='direct')return expect(!!noLimitsWipe(text!,{...context,lang:tool==='python'?'py':tool==='node'?'js':'sh'}),'direct wipe').toBe(card);
 if(layer==='approval')return expect(autoVerdict(bot,tool,'Fixture',{fullAccessOrigin:'owner',commandCwd:context.cwd,workFolder:context.project,promptFacts:{cwd:context.cwd,home:context.home},call:{toolCall:{name:tool,input}}}).approve===null,'approval verdict').toBe(card);
 const f=fixture();try{
  d.installDecisionHost({store:f.store,view:()=>({title:'Wipe',subtitle:'Fixture'}),executionContext:()=>context});
  expect(d.readTurnPolicy({threadId:'t',generation:'g'})?.permission.noLimits).toBe(true);
  const out=d.decide(f.open(row.id,{...input,cwd:'/w'},{tool,toolCall:{name:tool,input:{...input,cwd:'/w'}}}),baseRun);
  expect(out.kind,'registered decision').toBe(card?'card':'run');
  if(out.kind==='card'){await d.presentApproval(out.ref,{title:'Wipe',subtitle:'Fixture'});expect(d.readApproval(out.ref.approvalId)).toMatchObject({why:'wipe'});}
  else expect(d.openApprovals('t')).toHaveLength(0);
 }finally{f.dispose();}
});

it('unresolved SQL is a possible wipe only in a database input context',()=>{
 expect(sqlWipe('ordinary search words')).toBe(false);
 expect(sqlWipe('drop')).toBe(true);
 expect(sqlWipe('ordinary search words',true)).toBe(true);
 expect(sqlWipe('SELECT 1',true)).toBe(false);
});
