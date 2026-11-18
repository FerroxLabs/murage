// Protocol fixture consumer owner: gnl-harness-r9. Box driver producer: MAIN.
// Provisioned inert computers, named prompts, events and terminal status.
// Never synthesize Murage tool completions from provider status.
import {mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {requireGatedHandle} from '../gated-handle.mjs';
import {releasePlan} from './release-plan.mjs';
export function boxFixture(root,gatedHandle){
 const {executeBoxAction}=requireGatedHandle(gatedHandle);
 const boxes=new Map();
 return async function request(url,init={}){
  const method=String(init.method??'GET').toUpperCase(),path=url.pathname.replace('/api/box/v1',''),body=init.body?JSON.parse(String(init.body)):{};
  const json=(value,status=200)=>Response.json(value,{status});
  if(path==='/me')return json({id:'fixture-owner'});
  if(path==='/boxes'&&method==='GET')return json({boxes:[...boxes.values()].map(b=>({id:b.id,name:b.name,state:b.state}))});
  if(path==='/boxes'&&method==='POST'){
   if(body.noEnv!==true)return json({error:'Fixture computers require noEnv'},400);
   const id='fixture-'+randomUUID(),disk=join(root,id);mkdirSync(disk);
   const box={id,disk,name:id,state:'idle',events:[],prompts:new Map()};boxes.set(id,box);
   return json({box:{id,name:id,state:'idle'}},201);
  }
  const match=/^\/boxes\/([^/]+)(.*)$/.exec(path),box=match&&boxes.get(match[1]),tail=match?.[2];
  if(!box)return json({error:'Unknown fixture computer'},404);
  if(tail===''&&method==='GET')return json({box:{id:box.id,name:box.name,state:box.state}});
  if(tail===''&&method==='PATCH'){box.name=body.name;return json({box:{id:box.id,name:box.name,state:box.state}});}
  if(tail===''&&method==='DELETE'){boxes.delete(box.id);return json({ok:true});}
  if(tail==='/desktop'&&method==='POST')return json({desktopUrl:'http://127.0.0.1:1/fixture-desktop'});
  if(tail==='/commands'&&method==='POST'){
   // Provisioning installs an inert guest image, not the provider bootstrap
   // on this host. This receipt is never accepted as a scenario action.
   if(typeof body.command!=='string'||!body.command.includes('tmux'))return json({exitCode:64,stdout:'',stderr:'Unsupported fixture guest bootstrap'});
   writeFileSync(join(box.disk,'provisioned'),'inert guest image');return json({exitCode:0,stdout:'Inert guest provisioned',stderr:''});
  }
  if(tail==='/events')return json({events:box.events});
  if(tail==='/interrupt'&&method==='POST'){for(const run of box.prompts.values())if(run.status==='running')run.status='interrupted';return json({ok:true});}
  if(['/stop','/resume'].includes(tail)){box.state=tail==='/stop'?'archived':'idle';return json({ok:true});}
  if(tail==='/prompt'&&method==='POST'){
   const id='prompt-'+randomUUID(),run={id,status:'running',result:''};box.prompts.set(id,run);
   try{
    const plan=releasePlan(body.prompt),cwd=/Work ONLY inside ([^\n]+?)\. Use the requested tools/.exec(body.prompt)?.[1];
    if(!cwd||!resolve(cwd).startsWith(resolve(root)+sep))throw Error('Owned fixture cwd required');
    for(const step of plan.steps){
     if(step.kind==='text'){run.result+=step.text;continue;}
     // Box currently declares no mounted tools. Unknown actions stay failed.
     // A narrow real shell control proves the prompt protocol without ever
     // executing a wipe, interpreter or arbitrary provider bootstrap.
     if(step.tool!=='Bash'||!/^(?:printf (?:fixture|ran|switched|ok) > action\.done|pwd > action\.done)$/.test(step.input.command))throw Error('Box fixture action is not implemented');
     const result=await executeBoxAction(step.input.command,cwd);
     if(result!==0)throw Error('Inert box shell failed');
     box.events.push({id:'event-'+randomUUID(),promptId:id,type:'command',command:step.input.command,input:step.input});
    }
    run.status='finished';run.result||='Inert box action completed';
   }catch(error){run.status='failed';run.result=error.message;}
   return json({type:'prompt.queued',promptId:id,promptRun:{id},id:box.id});
  }
  if(tail?.startsWith('/prompts/')){const run=box.prompts.get(tail.slice('/prompts/'.length));return run?json({promptRun:run}):json({error:'Unknown fixture prompt'},404);}
  return json({error:'Unsupported fixture Box operation'},404);
 };
}
