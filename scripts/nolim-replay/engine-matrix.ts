// Offline judge counterfactuals only: no corpus command is executed.
// Read sealed input through stdin and emit aggregate fixed identifiers only.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
console.log=console.info=console.warn=console.error=()=>{};
try {
 const source=resolve(process.argv[2]!);
 const {routineTurnApproval,applyRoutinePermissionMode}=await import(pathToFileURL(source+'/server/routine-permissions.ts').href);
 const rows=JSON.parse(readFileSync(0,'utf8'));
 // Match the production request envelopes: Muse omits toolEngine, while the
 // OpenAI chat driver stamps the shared EngineKind "chat".
 const engines=[['claude','claude'],['codex','codex'],['acp','acp'],['pi','pi'],['muse',undefined],['antigravity','antigravity'],['openai','chat']] as const;
 const result:Record<string,unknown>={};
 for(const [label,engine] of engines){
  const groups:Record<string,any>={};
  for(const r of rows){
   const cc=r.cardClass;
   const cohort=cc.origin==='routine'||cc.automated===1?'routine':cc.origin==='owner'&&cc.unattended===0&&cc.automated===0?'owner':'non-owner';
   const g=groups[cohort]??={rows:0,judged:0,unavailable:0,cards:0,refusals:0,questions:0,bySource:{},byRule:{}};
   g.rows++;
   if(r.boundedToolInput===null||r.toolInputTruncated===1){g.unavailable++;continue;}
   let args;try{args=JSON.parse(r.boundedToolInput);}catch{g.unavailable++;continue;}
   g.judged++;
   const command=typeof args.command==='string'?args.command:undefined;
   const context={fullAccessOrigin:cc.origin??'other',ownerStarted:cohort==='owner',unattended:cc.unattended!==0,automated:cc.automated!==0,
    outsideRead:null,workFolder:'/fixture/work',commandCwd:'/fixture/work',commandText:command,inputCut:false,inputTruncated:false,
    call:{engine,toolCall:{name:r.tool,input:args}},promptFacts:{cwd:'/fixture/work',home:'/fixture/home'},
    unseen:{platform:'posix',fs:{realpath(){throw Error('UNAVAILABLE');},stat(){throw Error('UNAVAILABLE');},head(){throw Error('UNAVAILABLE');}},sessionFile:()=> 'unavailable'}};
   const {verdict:v}=routineTurnApproval({bot:{...applyRoutinePermissionMode({id:'matrix-fixture',alwaysAllow:[]},'unlimited'),permissionExplicit:cohort!=='non-owner'},
    ...(cohort==='routine'?{run:{permissionMode:'unlimited'}}:{}),tool:r.tool,summary:command??r.boundedToolInput,context});
   const kind=v.source==='question-tool'?'questions':v.source==='narrow'?'refusals':v.approve===null?'cards':undefined;
   if(kind){g[kind]++;const source=/^[a-z][a-z0-9-]{0,79}$/.test(v.source)?v.source:'unclassified';
    const rule=/^[a-z][a-z0-9-]{0,79}$/.test(v.rule??'')?v.rule:'other';
    g.bySource[source]=(g.bySource[source]??0)+1;g.byRule[rule]=(g.byRule[rule]??0)+1;}
  }
  result[label]=groups;
 }
 process.stdout.write(JSON.stringify({mode:'display-judge-engine-counterfactual',engines:result,nativeTransportProven:false})+'\n');
}catch{process.stdout.write('{"errors":1}\n');process.exitCode=3;}
