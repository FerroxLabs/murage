// SPDX-License-Identifier: AGPL-3.0-or-later
import {expect,it} from 'vitest';
import {rawDynamicExecution} from '../shared/no-limits-raw-wipe.ts';
import {visibleWipe} from '../shared/no-limits-visible-wipe.ts';
import {noLimitsWipe} from './no-limits-wipe.ts';
import {assembledWipeCases} from '../shared/testing/no-limits-assembled-cases.ts';
import {d,fixture,baseRun} from './decision/fixture.ts';
it('R4 raw, server, Pi reader and decisions agree for every assembled case',()=>{
 // Requests have distinct IDs and share one isolated, unchanged turn. Keep the
 // complete matrix while avoiding a database rebuild for every classifier row.
 const f=fixture(),context={cwd:'/w',project:'/w',home:'/home/fixture'};
 d.installDecisionHost({store:f.store,view:()=>({title:'Wipe',subtitle:'Fixture'}),executionContext:()=>context});
 expect(d.readTurnPolicy({threadId:'t',generation:'g'})?.permission.noLimits).toBe(true);
 try{for(const {id,command,wipe} of assembledWipeCases){
  // MAIN RULING 1114-NOLIMITS-OLD-ORACLES: these original literal
  // producer/consumer pairs assemble rm -rf ~; opaque and inert twins run.
  const card=['review-escaped-consumer','encoded-shell'].includes(id);
  expect(rawDynamicExecution(command),id+' raw reader: '+command).toBe(wipe);
 // MAIN RULING NARROW-WIPE: REDESIGN-WIPE-NARROW-v2 §0; SQL, opaque execution and included-file contents are outside the catastrophe list.
  expect(!!noLimitsWipe(command,context),id+' server reader').toBe(card);
 // MAIN RULING NARROW-WIPE: the standalone fallback uses the same narrow catastrophe classes; legacy raw evidence stays separate.
  expect(!!visibleWipe(command,context),id+' Pi reader').toBe(card);
 // MAIN RULING NARROW-WIPE: REDESIGN-WIPE-NARROW-v2 §0; SQL, opaque execution and included-file contents are outside the catastrophe list.
  expect(d.decide(f.open('r4-'+id,{command,cwd:context.cwd}),baseRun).kind,id+' decision').toBe(card?'card':'run');
 }}finally{f.dispose();}
});
