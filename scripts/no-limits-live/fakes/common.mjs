import {appendFileSync,existsSync,realpathSync,writeFileSync} from 'node:fs';
import {resolve,sep} from 'node:path';
import {spawnSync} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';
import {parsePlan,planHash} from '../baseline-f-plan.mjs';
export const out=m=>process.stdout.write(JSON.stringify(m)+'\n');
export const log=m=>{if(process.env.BASE_F_LOG)appendFileSync(process.env.BASE_F_LOG,JSON.stringify(m)+'\n');};
export async function begin(value){let plan;try{plan=parsePlan(value);}catch(error){
 if(process.env.NOLIM_RELEASE_FAKE!=='1')throw error;
 const text=typeof value==='string'?value:Array.isArray(value)?value.map(x=>x.text??'').join('\n'):JSON.stringify(value);
 const command=/Run exactly(?: this shell command once)?: ([\s\S]*?)(?:\. If denied, stop\.|$)/.exec(text)?.[1];
 plan={id:'release-native',steps:command?[{kind:'tool',tool:'Bash',input:{command}}]:[{kind:'text',text:'Fixture prompt received; no scripted action witness'}]};
}log({type:'plan',id:plan.id,hash:planHash(plan)});if(plan.gate){const until=Date.now()+20000;while(!existsSync(plan.gate)){if(Date.now()>until)throw Error('fake BASE gate deadline');await sleep(10);}}return plan;}
export const requested=(plan,index)=>log({type:'request',id:plan.id,hash:planHash(plan),index,step:plan.steps[index]});
export const received=(plan,index)=>log({type:'receipt',id:plan.id,hash:planHash(plan),index});
// Only the release rig executes approved fixture actions. Fixed BASE scripts
// retain their inert behavior. A denied receipt can never execute anything.
export function executeReleased(step,allowed){
 if(process.env.NOLIM_RELEASE_FAKE!=='1')return true;
 if(!allowed)return false;
 const root=realpathSync(process.env.NOLIM_FIXTURE_ROOT),cwd=realpathSync(process.cwd());
 if(!/[/\\]nolim-live-/.test(root)||!cwd.startsWith(root+sep))throw Error('Release fake requires its owned fixture cwd');
 if(step.tool==='Bash'){
  // Catastrophes are observed at the permission seam, never executed by a
  // fixture even if a broken product releases one.
  if(cwd.endsWith('-python-alias-wipe')||/nolim_wipe=|(?:^|[;&|])\s*mkfs\.[a-z0-9]+\s+\/dev/.test(step.input.command))return false;
  return spawnSync('sh',['-c',step.input.command],{cwd,timeout:5000,stdio:'ignore'}).status===0;
 }
 if(step.tool==='Write'){
  const path=resolve(cwd,step.input.file_path);if(!path.startsWith(root+sep))throw Error('Release fake write outside fixture');
  writeFileSync(path,step.input.content);return true;
 }
 return false;
}
