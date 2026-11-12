// SPDX-License-Identifier: AGPL-3.0-or-later
// A copied, synthetic 1.0.18 data directory; no user directory is opened.
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {launchVerificationServer,type VerificationServer} from '../scripts/control-murage.ts';
let fixture:VerificationServer;
let headers:Record<string,string>={};
beforeAll(async()=>{
 fixture=await launchVerificationServer(process.env,undefined,{instrumentationSource:`
  const fs=await import('node:fs');const path=await import('node:path');
  const {Store}=await import(${JSON.stringify(new URL('./store.ts',import.meta.url).href)});
  const store=new Store();
  const lead=store.createBot({name:'Legacy lead'},{seedMessages:false});store.setChiefOfStaff(lead.id,undefined,'workspace');
  store.patchBot(lead.id,{autoApprove:true,fullAccess:true,noLimits:true});
  const full=store.createBot({name:'Legacy Full access'},{seedMessages:false});store.patchBot(full.id,{autoApprove:true,fullAccess:true,noLimits:false});
  const auto=store.createBot({name:'Edited Auto'},{seedMessages:false});store.patchBot(auto.id,{autoApprove:true,fullAccess:false,noLimits:false,permissionRev:1});
  const file=path.join(process.env.MURAGE_DATA_DIR,'bots.json');const saved=JSON.parse(fs.readFileSync(file,'utf8'));const bots=Array.isArray(saved)?saved:saved.bots;
  for(const bot of bots){delete bot.permissionExplicit;for(const task of bot.tasks??[])delete task.permissionExplicit;}
  const task=bots.find(bot=>bot.id===lead.id).tasks[0];Object.assign(task,{title:'Earlier chat',autoApprove:true,fullAccess:true,noLimits:false,permissionRev:1});
  fs.writeFileSync(file,JSON.stringify(saved));fs.copyFileSync(file,path.join(process.env.MURAGE_DATA_DIR,'legacy-1018-copy.json'));
 `});
 const proof=await(await fetch(fixture.info.url+'/api/desktop-secret')).json() as {secret:string};
 headers={'x-murage-surface':'desktop','x-murage-surface-secret':proof.secret};
},120000);
afterAll(async()=>{await fixture?.close();});
it('H7 a legacy data copy lists Full access, edited Auto and lower chats without silently upgrading them',async()=>{
 const response=await fetch(fixture.info.url+'/api/permissions/no-limits',{headers});expect(response.status).toBe(200);const status=await response.json() as any;
 mkdirSync('evidence/nolim-merge/upgrade',{recursive:true});writeFileSync('evidence/nolim-merge/upgrade/state.json',JSON.stringify({fixture:fixture.info,status},null,2));writeFileSync('evidence/nolim-merge/upgrade/legacy-1018-copy.json',readFileSync(join(fixture.info.dataDir,'legacy-1018-copy.json')));
 expect(status.enabled).toBe(true);
 expect(status.lower).toEqual(expect.arrayContaining([
  expect.objectContaining({name:'Legacy Full access',kind:'bot',level:'full'}),
  expect.objectContaining({name:'Edited Auto',kind:'bot',level:'auto'}),
  expect.objectContaining({name:'Earlier chat',kind:'chat',level:'full'}),
 ]));
});
