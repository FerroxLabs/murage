import {appendFileSync,existsSync} from 'node:fs';
import {setTimeout as sleep} from 'node:timers/promises';
import {parsePlan,planHash} from '../baseline-f-plan.mjs';
export const out=m=>process.stdout.write(JSON.stringify(m)+'\n');
export const log=m=>{if(process.env.BASE_F_LOG)appendFileSync(process.env.BASE_F_LOG,JSON.stringify(m)+'\n');};
export async function begin(value){const plan=parsePlan(value);log({type:'plan',id:plan.id,hash:planHash(plan)});if(plan.gate){const until=Date.now()+20000;while(!existsSync(plan.gate)){if(Date.now()>until)throw Error('fake BASE gate deadline');await sleep(10);}}return plan;}
export const requested=(plan,index)=>log({type:'request',id:plan.id,hash:planHash(plan),index,step:plan.steps[index]});
export const received=(plan,index)=>log({type:'receipt',id:plan.id,hash:planHash(plan),index});
