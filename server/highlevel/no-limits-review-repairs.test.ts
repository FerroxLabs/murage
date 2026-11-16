// SPDX-License-Identifier: AGPL-3.0-or-later
// Exercise production Store projections and permission decisions in an isolated
// server process, using Node's production loader and a temporary data directory.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchVerificationServer, type VerificationServer } from '../../scripts/control-murage.ts';
let fixture: VerificationServer;
let rows: any[];
beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    const {Store}=await import(${JSON.stringify(new URL('../store.ts', import.meta.url).href)});
    const {installPermissionInheritance}=await import(${JSON.stringify(new URL('../permission-inheritance.ts', import.meta.url).href)});
    const {botPermissionMode}=await import(${JSON.stringify(new URL('../routine-permissions.ts', import.meta.url).href)});
    const {autoVerdict}=await import(${JSON.stringify(new URL('../auto-approve.ts', import.meta.url).href)});
    const fs=await import('node:fs'),path=await import('node:path');
    const levels=[{autoApprove:false,fullAccess:false,noLimits:false},{autoApprove:true,fullAccess:false,noLimits:false},{autoApprove:true,fullAccess:true,noLimits:false}];
    const rows=[],store=new Store();
    for(const [chiefIndex,chief] of levels.entries())for(const [botIndex,flags] of levels.entries()){
      const restore=installPermissionInheritance(()=>chief);
      try{
        const bot=store.createBot({name:'AFIX parity'},{seedMessages:false});
        store.patchBot(bot.id,{...flags,permissionExplicit:false});
        const projected=store.projectBotForTask(bot.id,bot.threadId);
        rows.push({chiefIndex,botIndex,mode:botPermissionMode(projected),
          expected:autoVerdict({...flags,permissionExplicit:true},'Bash','printf fixture',{fullAccessOrigin:'owner'}),
          actual:autoVerdict(projected,'Bash','printf fixture',{fullAccessOrigin:'owner'})});
      }finally{restore();}
    }
    fs.writeFileSync(path.join(process.env.MURAGE_DATA_DIR,'lower-level-decisions.json'),JSON.stringify(rows));
  ` });
  rows = JSON.parse(readFileSync(join(fixture.info.dataDir, 'lower-level-decisions.json'), 'utf8'));
}, 90000);
afterAll(async () => fixture?.close());
for (const chiefIndex of [0, 1, 2]) for (const botIndex of [0, 1, 2]) {
  it(`AFIX H2 lower chief ${chiefIndex} preserves stored bot ${botIndex} at the production permission decision`, () => {
    const row = rows.find(row => row.chiefIndex === chiefIndex && row.botIndex === botIndex);
    expect(row.mode).toBe(['ask', 'auto', 'full'][botIndex]);
    expect(row.actual).toEqual(row.expected);
  });
}
