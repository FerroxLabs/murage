// A real disabled-channel admission bug must produce a product approval card.
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,existsSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
const out=resolve(process.argv[2]);mkdirSync(out,{recursive:true});
const temp=mkdtempSync(join(tmpdir(),'gnl-native-mutant-'));
const before='channelMessagesEnabled: botId => store.bot(botId)?.fullAccessChannelMessages !== false,';
const after='channelMessagesEnabled: botId => true,';
if(!readFileSync('server/index.ts','utf8').includes(before))throw Error('Native mutation anchor absent');
const report={mode:'real server channel admission with fake Telegram and inert native engine',releaseGate:false,verdict:'FAIL'};
try{
 const active=join(temp,'activated'),preload=join(temp,'mutant.mjs');
 writeFileSync(preload,`import {registerHooks} from 'node:module';import {writeFileSync} from 'node:fs';registerHooks({load(url,ctx,next){const r=next(url,ctx);if(url.endsWith('/server/index.ts')){const s=String(r.source);if(!s.includes(${JSON.stringify(before)}))throw Error('anchor');writeFileSync(${JSON.stringify(active)},'yes');return {...r,source:s.replace(${JSON.stringify(before)},${JSON.stringify(after)})};}return r;}});`);
 const run=(name,mutant)=>{
  const env={...process.env};delete env.NODE_TEST_CONTEXT;if(mutant)env.GNL_MUTANT_PRELOAD=pathToFileURL(preload).href;
  const result=spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run','scripts/no-limits-live/origin-api.test.mjs','--testNamePattern=owner-channel-dm-off','--reporter=json',`--outputFile=${join(out,name+'.json')}`],{encoding:'utf8',timeout:100000,env});
  writeFileSync(join(out,name+'.log'),(result.stdout??'')+(result.stderr??''));
  const evidence=JSON.parse(readFileSync('scripts/no-limits-live/evidence/origin-api/verification.json'));
  writeFileSync(join(out,name+'-observation.json'),JSON.stringify(evidence,null,2)+'\n');writeFileSync(join(out,name+'-server.log'),readFileSync('scripts/no-limits-live/evidence/origin-api/server.log'));return {result,evidence};
 };
 const control=run('control',false),mutant=run('mutant',true);
 const failed=mutant.evidence.rows.find(r=>r.id==='owner-channel-dm-off');
 const killed=control.result.status===0&&mutant.result.status===1&&existsSync(active)&&failed?.verdict==='FAIL'&&failed.cardCount>0;
 Object.assign(report,{mutants:[{id:'disabled-channel-product-card',source:'server/index.ts',activated:existsSync(active),controlExit:control.result.status,mutantExit:mutant.result.status,observedCards:failed?.cardCount,killed}],verdict:killed?'PASS':'FAIL'});
}finally{rmSync(temp,{recursive:true,force:true});writeFileSync(join(out,'verdict.json'),JSON.stringify(report,null,2)+'\n');}
if(report.verdict!=='PASS')process.exitCode=1;
