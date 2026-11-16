// Targeted review regressions: restore each reported gate independently.
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const out='evidence/gnl-apps-r2/mutants';mkdirSync(out,{recursive:true});
const cases=[
 {id:'H1-whole-batch',source:'server/composio.ts',anchor:'    if (options.noLimits) {\n      const owner = inventoryOwner(cfg)!;',replacement:'    if (options.noLimits) return { ...textReply(action.id, "Reconnect gmail"), delivery: "not-sent" };\n    if (options.noLimits) {\n      const owner = inventoryOwner(cfg)!;',test:'server/gnl-apps-preflight-api.test.ts',name:'H1 preflight',failure:/expected .* to contain .*account|expected .* to contain .*home/s},
 {id:'H2-task-default',source:'server/index.ts',anchor:'if (!noLimitsChannelMessagesOff(origin, effective)) return undefined;',replacement:'if (!noLimitsChannelMessagesOff(origin, store.bot(botId))) return undefined;',test:'server/gnl-apps-capabilities-api.test.ts',name:'GNL-A3 paired owner channel',failure:/gnl-channel-task-ask/},
 {id:'H2-guest-owner',source:'server/index.ts',anchor:'if (!noLimitsChannelMessagesOff(origin, effective)) return undefined;',replacement:"if (!noLimitsChannelMessagesOff('owner-channel', isWorkspaceOwner(principal) ? effective : store.bot(botId))) return undefined;",test:'server/gnl-apps-capabilities-api.test.ts',name:'GNL-A3 paired owner channel',failure:/gnl-channel-guest-ask/},
];
const summary=[];
for(const item of cases.filter(item=>!process.argv[2]||item.id.startsWith(process.argv[2]))){
 const original=readFileSync(item.source,'utf8');if(!original.includes(item.anchor))throw Error('Missing anchor '+item.id);
 const sha=createHash('sha256').update(original).digest('hex');
 try{
  writeFileSync(item.source,original.replace(item.anchor,item.replacement));
  const run=spawnSync('pnpm',['exec','vitest','run',item.test,'-t',item.name,'--reporter=default','--reporter=json','--outputFile='+out+'/'+item.id+'.json'],{encoding:'utf8',timeout:240000,maxBuffer:20*1024*1024});
  writeFileSync(out+'/'+item.id+'.log',(run.stdout??'')+(run.stderr??''));
  const report=JSON.parse(readFileSync(out+'/'+item.id+'.json','utf8'));
  const failures=report.testResults.flatMap(r=>r.assertionResults).filter(r=>r.status==='failed');
  const killed=run.status!==0&&failures.some(r=>r.fullName.includes(item.name)&&item.failure.test(r.failureMessages.join('\n')));
  summary.push({id:item.id,sourceSha256:sha,status:run.status,killed,failures});
  writeFileSync(out+'/summary.json',JSON.stringify(summary,null,2));
  if(!killed)throw Error('Mutant survived or failed outside intended assertion '+item.id);
  console.log(item.id+' KILLED');
 }finally{writeFileSync(item.source,original);if(createHash('sha256').update(readFileSync(item.source)).digest('hex')!==sha)throw Error('Restore failed');}
}
