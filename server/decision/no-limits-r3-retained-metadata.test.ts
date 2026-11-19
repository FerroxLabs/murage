// SPDX-License-Identifier: AGPL-3.0-or-later
// Replacing a large code call still uses its authenticated mount metadata.
import {expect,it} from 'vitest';
import {d,fixture,baseRun} from './fixture.ts';
import {guardEngineRelease} from './provider-release.ts';
it.each([
 ['python','print(1)',"import shutil; shutil.rmtree('/')"],
 ['node','console.log(1)',"require('fs').rmSync('/', {recursive:true})"],
])('B1 retained mount metadata after display truncation: %s',(lang,safe,wipe)=>{
 const f=fixture(),tool=`mcp__fixture__${lang}`,input={padding:'x'.repeat(1_050_000),code:safe};
 try{
  const h=f.open('retained-code',input,{tool,toolCall:{name:tool,input},toolEngine:'claude',mcpMounts:[{engineName:'fixture',mountId:'custom:fixture',provenance:'custom'}]});
  expect(d.decide(h,baseRun).kind).toBe('run');
  // MAIN RULING 1114-NOLIMITS-OLD-ORACLES: actual literal interpreter
  // deletion of / cards even when its display payload was truncated.
  expect(d.readTurnPolicy({threadId:'t',generation:'g'})?.permission.noLimits).toBe(true);
  expect(guardEngineRelease({threadId:'t',requestId:'retained-code',turnId:'turn',providerInstanceId:'p'},{code:wipe})).toBe(false);
  expect(d.openApprovals('t')).toHaveLength(1);expect(f.respond).not.toHaveBeenCalled();
 }finally{f.dispose();}
});
