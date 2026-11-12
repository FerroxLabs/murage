// SPDX-License-Identifier: AGPL-3.0-or-later
import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
const source=readFileSync(new URL('./index.ts',import.meta.url),'utf8');
it.each(['ask','auto','full','no-limits',undefined])('R3-3 lead No limits wins over new-bot default %s',permissionLevel=>{
 const body=source.match(/function ownerGlobalNoLimits\(\): boolean \{([\s\S]*?)\n\}/)?.[1];
 expect(body,'production owner default function').toBeTruthy();
 const read=new Function('store','cfg','isWorkspaceChief',body!);
 expect(read({bots:[{autoApprove:true,fullAccess:true,noLimits:true}]},{newBots:{permissionLevel}},()=>true)).toBe(true);
 expect(read({bots:[{autoApprove:true,fullAccess:false,noLimits:false}]},{newBots:{permissionLevel}},()=>true)).toBe(permissionLevel==='no-limits');
});
it.each([true,false])('R3-4 terms accepted=%s never downgrade a per-call permission',accepted=>{
 const block=source.match(/const judged = ([\s\S]*?);\n\s*const inheritedRoutine/)?.[1];
 expect(block).toBeTruthy();
 const judged={autoApprove:true,fullAccess:true,noLimits:true};
 expect(new Function('judgedLevel','cfg','noLimitsTermsAccepted','return '+block)(judged,{},()=>accepted)).toEqual(judged);
});

it('F7 a global level change rechecks followers even when another bot emitted the change',()=>{
 const body=source.match(/function recheckDecisionLevels\(botId\?:string\) \{([\s\S]*?)\n\}/)?.[1];
 expect(body,'production follower-level recheck').toBeTruthy();
 let global=false;const scheduled:string[]=[];
 const bots=[{id:'chief',fixed:'unlimited'},{id:'follower'},{id:'lower',fixed:'ask'}];
 const stamp=(bot:typeof bots[number])=>({level:bot.fixed??(global?'unlimited':'ask')});
 const previous=new Map(bots.map(bot=>[bot.id,stamp(bot)]));
 const recheck=new Function('ownerGlobalNoLimits','store','decisionBotLevels','decisionLevelStamp','decisionLevelsChanged','scheduleDecisionLevelChange',
  'let decisionOwnerNoLimits=false;return function(botId){'+body+'}')( ()=>global,{bots,bot:(id:string)=>bots.find(bot=>bot.id===id)},previous,stamp,(a:{level:string},b:{level:string})=>a.level!==b.level,(id:string)=>scheduled.push(id));
 global=true;recheck('chief');expect(scheduled).toEqual(['follower']);
 global=false;recheck();expect(scheduled).toEqual(['follower','follower']);
 expect(source).toContain('if(patch.newBots!==undefined)recheckDecisionLevels();');
});
