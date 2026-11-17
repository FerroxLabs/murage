// SPDX-License-Identifier: AGPL-3.0-or-later
// Verification README control surface, isolated fake engine, network-none runner.
import { launchVerificationServer,runControlMurage } from '../../scripts/control-murage.ts';
import { readMcpAccessKey } from '../mcp-access.ts';
import { mkdirSync,writeFileSync,copyFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const evidence=join(process.cwd(),'evidence','bld-fts-amend','fixture');mkdirSync(evidence,{recursive:true});
const fixture=await launchVerificationServer(process.env,undefined,{turnLog:{replies:['FTS drain fixture reply quokka']},separateHome:true});
const commands=[];
const call=async(command,args=[])=>{const argv=[command,...args,'--url',fixture.info.url];commands.push(argv);const result=await runControlMurage(argv);writeFileSync(join(evidence,command+'.json'),JSON.stringify(result,null,2)+'\n');return result;};
try{
 writeFileSync(join(evidence,'launch.json'),JSON.stringify(fixture.info,null,2)+'\n');
 const doctor=await call('doctor');assert.equal(doctor.ok,true);
 const created=await call('new-bot',['--name','Search fixture']);
 const bot=created.bot??created;assert.equal(typeof bot.id,'string');
 await call('send',['--bot',bot.id,'--text','findablecanary ftsdrain smoke']);
 const wait=await call('wait',['--bot',bot.id,'--timeout','30']);assert.equal(wait.state??wait.status,'settled');
 const messages=await call('messages',['--bot',bot.id,'--limit','10']);assert.match(JSON.stringify(messages),/FTS drain fixture reply quokka/);
 const key=readMcpAccessKey(fixture.info.dataDir);const headers={Authorization:`Bearer ${key}`};
 const deadline=Date.now()+30000, searches=[]; let result;
 do {
  const response=await fetch(fixture.info.url+'/api/search?q=findablecanary&limit=10',{headers});assert.equal(response.status,200);
  result=await response.json(); searches.push({at:Date.now(),result});
  if(result.hits.some(hit=>hit.snippet.includes('findablecanary')))break;
  await new Promise(resolve=>setTimeout(resolve,50));
 } while(Date.now()<deadline);
 writeFileSync(join(evidence,'search-attempts.json'),JSON.stringify(searches,null,2)+'\n');
 writeFileSync(join(evidence,'search.json'),JSON.stringify(result,null,2)+'\n');assert.ok(result.hits.some(hit=>hit.snippet.includes('findablecanary')));
 console.log('FIXTURE PASS',JSON.stringify({url:fixture.info.url,logPath:fixture.info.logPath,hitCount:result.hits.length}));
}finally{
 writeFileSync(join(evidence,'commands.json'),JSON.stringify(commands,null,2)+'\n');
 await fixture.close();copyFileSync(fixture.info.logPath,join(evidence,'server.log'));
}
