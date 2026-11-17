// SPDX-License-Identifier: AGPL-3.0-or-later
import {expect,it} from 'vitest';
import {rawWipeEvidence,certifiableDelete} from '../shared/no-limits-raw-wipe.ts';
import {visibleWipe} from '../shared/no-limits-visible-wipe.ts';
import {noLimitsWipe} from './no-limits-wipe.ts';
import {parseFreeWipeCases} from '../shared/testing/no-limits-parse-free-cases.ts';
import {d,fixture,baseRun} from './decision/fixture.ts';
it.each(parseFreeWipeCases)('R5 independent evidence $id reaches server, Pi reader and production decisions',({id,command,wipe})=>{
 const f=fixture(),context={cwd:'/w',project:'/w',home:'/home/fixture'};
 d.installDecisionHost({store:f.store,view:()=>({title:'Wipe',subtitle:'Fixture'}),executionContext:()=>context});
 expect(d.readTurnPolicy({threadId:'t',generation:'g'})?.permission.noLimits).toBe(true);
 try{
  // MAIN RULING 1114-NOLIMITS-OLD-ORACLES: descriptor duplication and
  // the ordinary group retain the literal producer's rm -rf ~ payload.
  const cards=['r5-array','r5-time','r5-fd-dup','r5-group'];
  expect(rawWipeEvidence(command)&&!certifiableDelete(command),id+' raw').toBe(wipe);
 // MAIN RULING NARROW-WIPE: REDESIGN-WIPE-NARROW-v2 §0; SQL, opaque execution and included-file contents are outside the catastrophe list.
  expect(!!noLimitsWipe(command,context),id+' server').toBe(cards.includes(id));
 // MAIN RULING NARROW-WIPE: the standalone fallback uses the same narrow catastrophe classes; legacy raw evidence stays separate.
  expect(!!visibleWipe(command,context),id+' Pi').toBe(cards.includes(id));
 // MAIN RULING NARROW-WIPE: REDESIGN-WIPE-NARROW-v2 §0; SQL, opaque execution and included-file contents are outside the catastrophe list.
  expect(d.decide(f.open(id,{command,cwd:context.cwd}),baseRun).kind,id+' decision').toBe(cards.includes(id)?'card':'run');
 }finally{f.dispose();}
});

// R1/R4 retain bounded database-delete words even in non-executing text.
it.each(['echo dropdb prod', 'echo "dropdb prod"', '# dropdb prod'])(
 'R6 raw dropdb evidence survives every reader: %s',command=>{
 const f=fixture();
 try{
  expect(rawWipeEvidence(command)).toBe(true);
 // MAIN RULING NARROW-WIPE: REDESIGN-WIPE-NARROW-v2 §0; SQL, opaque execution and included-file contents are outside the catastrophe list.
  expect(!!noLimitsWipe(command,{cwd:'/w'})).toBe(false);
 // MAIN RULING NARROW-WIPE: the standalone fallback uses the same narrow catastrophe classes; legacy raw evidence stays separate.
  expect(!!visibleWipe(command,'/home/fixture',0,'posix','/w')).toBe(false);
 // MAIN RULING NARROW-WIPE: REDESIGN-WIPE-NARROW-v2 §0; SQL, opaque execution and included-file contents are outside the catastrophe list.
  expect(d.decide(f.open(command,{command}),baseRun).kind).toBe('run');
 }finally{f.dispose();}
});
