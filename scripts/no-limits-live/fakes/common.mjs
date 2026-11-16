import {appendFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {releasePlan} from './release-plan.mjs';
import {waitForMemoryCapture} from './api-service.mjs';
import {parsePlan,planHash} from '../baseline-f-plan.mjs';
export const out=m=>process.stdout.write(JSON.stringify(m)+'\n');
export const log=m=>{if(process.env.BASE_F_LOG)appendFileSync(process.env.BASE_F_LOG,JSON.stringify(m)+'\n');};
export async function begin(value){let plan;try{plan=parsePlan(value);}catch(error){
 if(process.env.NOLIM_RELEASE_FAKE!=='1')throw error;
 plan=releasePlan(value);
}log({type:'plan',id:plan.id,hash:planHash(plan)});if(plan.gate){const until=Date.now()+20000;while(!existsSync(plan.gate)){if(Date.now()>until)throw Error('fake BASE gate deadline');await sleep(10);}}
 if(process.env.NOLIM_RELEASE_FAKE==='1'&&plan.steps.some(step=>step.tool==='memory_save')){
  const text=typeof value==='string'?value:Array.isArray(value)?value.map(part=>part.text??'').join('\n'):value?.text??JSON.stringify(value);
  await waitForMemoryCapture(process.env.S3_STATE_DIR,text);
 }
 return plan;}
export const requested=(plan,index)=>log({type:'request',id:plan.id,hash:planHash(plan),index,step:plan.steps[index]});
export const received=(plan,index)=>log({type:'receipt',id:plan.id,hash:planHash(plan),index});
export async function holdReleased(step,text){text('Working on the fixture.');await sleep(step.ms);}

// The room workflow also reads the actual routine run and completed room
// turn. This trace says which native MCP call produced that run; it is never
// a substitute for the independent product run/turn witnesses.
export function recordReleasedEffect(step,stateDir=process.env.S3_STATE_DIR){
 if(process.env.NOLIM_RELEASE_FAKE!=='1'||!step.fixture?.room)return;
 if(!stateDir||stateDir==='/dev'||stateDir.startsWith('/dev/'))throw Error('Owned fixture state directory required');
 appendFileSync(join(stateDir,'room-actions.ndjson'),JSON.stringify({...step.fixture.room,nativeMcp:true,ownerSurface:false})+'\n');
}

// Continuations use the actual previous read receipt, never an invented handle.
export function releasedPage(result){
 if(typeof result==='string'){try{return releasedPage(JSON.parse(result));}catch{try{return releasedPage(JSON.parse(result.split('\n')[0]));}catch{return undefined;}}}
 const reply=result?.result??result;
 if(typeof reply==='string')return releasedPage(reply);
 if(Array.isArray(reply))for(const item of reply){const page=releasedPage(item);if(page)return page;}
 if(reply?.structuredContent?.handle)return reply.structuredContent;
 if(reply?.handle)return reply;
 if(reply?.output){const page=releasedPage(reply.output);if(page)return page;}
 for(const item of reply?.content??[]){if(item.type!=='text')continue;try{const page=JSON.parse(item.text.split('\n')[0]);if(page.handle)return page;}catch{}}
}
export function resolveReleaseStep(step,state){
 if(!step.savedRead)return step;
 if(typeof state.page?.handle!=='string'||state.page.next_offset!==step.input.offset)throw Error('Release read continuation lacks its previous saved-page receipt');
 return {...step,input:{handle:state.page.handle,...step.input}};
}
export function rememberReleaseResult(step,result,state){
 if(step.tool==='agent_browser_read'&&!step.savedRead){
  const page=releasedPage(result);
  if(!page?.handle||page.next_offset!==12000)throw Error('Release initial read did not return its saved-page continuation');
  state.page=page;
 }
}
