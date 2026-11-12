import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const out='evidence/gnl-apps-mutants';mkdirSync(out,{recursive:true});
const cases=[
 {id:'A1',source:'server/bot-access.ts',old:'if(highlevel.noLimits)return;',replacement:'if(false)return;',test:'server/gnl-apps-api.test.ts',name:'GNL-A1 saved write/tool/account'},
 {id:'A2',source:'server/drivers/acp/core.ts',old:'launch((trustGeneration === 1 || (turn.permissionNow?.() ?? turn).noLimits === true) && folderTrusted === "trust");',replacement:'launch(trustGeneration === 1 && folderTrusted === "trust");',test:'server/service-no-limits-routes-api.test.ts',name:'N7 No limits overrides Fuigo own saved no'},
 {id:'A3',source:'server/index.ts',old:"if (bot?.fullAccessChannelMessages !== false || !noLimitsAppliesTo('owner', bot)) return undefined;",replacement:'if (true) return undefined;',test:'server/gnl-apps-capabilities-api.test.ts',name:'GNL-A3 paired owner channel'},
 {id:'A4',source:'server/index.ts',old:"serviceNoLimits(internalClaim.generation, internalClaim.threadId, internalClaim.botId) && ['sign-in-ended', 'needs-sign-in', 'needs-more-access', 'needs-key', 'key-rejected'].includes(relayed.body.code)",replacement:"false && ['sign-in-ended', 'needs-sign-in', 'needs-more-access', 'needs-key', 'key-rejected'].includes(relayed.body.code)",test:'server/mcp-signin-card-api.test.ts',name:'GNL-A4 expired MCP'},
 {id:'A5',source:'server/host-computer-consent.ts',old:'return !noLimits && bot.computer === undefined',replacement:'return bot.computer === undefined',test:'server/gnl-apps-capabilities-api.test.ts',name:'GNL-A5 saved host consent'},
];
const expectedFailure={A1:/blocked connected-app writes|expected 403 to be 200/,A2:/expected false to be true/,A3:/Channel messages are off/,A4:/needs the owner to sign in/,A5:/expected undefined to be truthy/};
const summary=[];
for(const item of cases){
 const original=readFileSync(item.source,'utf8');if(!original.includes(item.old))throw Error('Missing mutant anchor '+item.id);
 const digest=createHash('sha256').update(original).digest('hex');
 try{
  writeFileSync(item.source,original.replace(item.old,item.replacement));
  const report=`${out}/${item.id}.json`;
  const args=['exec','vitest','run',item.test,'-t',item.name,'--reporter=default','--reporter=json',`--outputFile=${report}`];
  const run=spawnSync('pnpm',args,{encoding:'utf8',timeout:300000,maxBuffer:20*1024*1024,env:process.env});
  writeFileSync(`${out}/${item.id}.log`,(run.stdout??'')+(run.stderr??''));
  const result=JSON.parse(readFileSync(report,'utf8'));
  const failures=result.testResults.flatMap(r=>r.assertionResults).filter(r=>r.status==='failed');
  const killed=run.status!==0&&failures.some(r=>r.fullName.includes(item.name)&&expectedFailure[item.id].test((r.failureMessages??[]).join('\n')));
  summary.push({id:item.id,command:['pnpm',...args],status:run.status,killed,sourceSha256:digest,failures:failures.map(r=>({name:r.fullName,message:r.failureMessages}))});
  writeFileSync(`${out}/summary.json`,JSON.stringify(summary,null,2));
  if(!killed)throw Error('Mutant survived or failed outside the intended assertion: '+item.id);
  console.log(item.id+' KILLED');
 }finally{writeFileSync(item.source,original);if(createHash('sha256').update(readFileSync(item.source)).digest('hex')!==digest)throw Error('Restore mismatch '+item.source);}
}
