import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createInterface} from 'node:readline';
import {acpLaunchMounts} from './mount-config.mjs';
import {proveFeatureOff} from './feature-off.mjs';
import {out,begin,requested,received,holdReleased,recordReleasedEffect,resolveReleaseStep,rememberReleaseResult} from './common.mjs';
import {requireGatedHandle} from '../gated-handle.mjs';
export async function runFake(gatedHandle){
 const {createMountedTools,executeReleased}=requireGatedHandle(gatedHandle);
if(process.argv.includes('--version')){console.log('1.0.0');process.exit(0);}
let sessionId=`base-${process.pid}`,sequence=1000,servers=[],mounts=[];const waits=new Map();
const update=update=>out({jsonrpc:'2.0',method:'session/update',params:{sessionId,update}});
const ask=(method,params)=>new Promise(resolve=>{const id=++sequence;waits.set(id,resolve);out({jsonrpc:'2.0',id,method,params:{sessionId,...params}});});
async function play(m){
 const plan=await begin(m.params.prompt);
 const pageState={};
 for(const [i,original] of plan.steps.entries()){
  const step=resolveReleaseStep(original,pageState);
  if(step.kind==='off'){const text=await proveFeatureOff(step,mounts,gatedHandle);update({sessionUpdate:'agent_message_chunk',content:{type:'text',text}});continue;}
  if(step.kind==='delay'){await holdReleased(step,text=>update({sessionUpdate:'agent_message_chunk',content:{type:'text',text}}));continue;}
  if(step.kind==='text'){update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:step.text}});continue;}
  requested(plan,i);const toolCall={toolCallId:`base-${i}`,title:step.tool==='Bash'?(Object.hasOwn(step.input,'command')?'shell':''):step.tool,kind:step.tool==='Bash'?'execute':step.tool==='Write'?'edit':'other',status:'pending',rawInput:step.input};
  if(step.kind==='question')await ask('elicitation/create',{message:step.input.question,requestedSchema:{type:'object',properties:{pick:{type:'string',enum:step.input.choices}},required:['pick']}});
  else{const checkedFirst=process.env.GNL_FAKE_KIND==='hermesAgent';if(!checkedFirst)update({sessionUpdate:'tool_call',...toolCall});let ok,content=[];
   const permission=async()=>{
    const answer=await ask('session/request_permission',{toolCall,options:[{optionId:'allow',kind:'allow_once'},{optionId:'deny',kind:'reject_once'}]});
    const allowed=answer?.outcome?.optionId==='allow';if(checkedFirst&&allowed)update({sessionUpdate:'tool_call',...toolCall});
    return allowed;
   };
   if(['Bash','Write'].includes(step.tool))ok=executeReleased(step,await permission());
   else{
    const tools=createMountedTools(mounts,permission);
    try{const reply=await tools.call(step.tool,step.input);rememberReleaseResult(step,reply,pageState);recordReleasedEffect(step);ok=true;content=(reply.result?.content??[]).map(value=>({type:'content',content:value}));}
    catch(error){ok=false;content=[{type:'content',content:{type:'text',text:error.message}}];}
   }if(!checkedFirst||ok)update({sessionUpdate:'tool_call_update',toolCallId:toolCall.toolCallId,status:ok?'completed':'failed',content});}
  received(plan,i);
 }
 if(!plan.steps.some(step=>step.kind==='off'))update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:plan.steps.findLast(step=>step.kind==='text')?.text??'fake BASE complete'}});out({jsonrpc:'2.0',id:m.id,result:{stopReason:'end_turn'}});
}
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(!m.method&&waits.has(m.id)){waits.get(m.id)(m.result);waits.delete(m.id);return;}
 const result=value=>out({jsonrpc:'2.0',id:m.id,result:value});
 if(m.method==='initialize')result({protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:['grok.com','cached_token','cursor_login','oauth-personal','gemini-api-key','api-key'].map(id=>({id,name:id}))});
 else if(m.method==='session/new'||m.method==='session/load'){sessionId=m.params.sessionId??sessionId;mounts=m.params.mcpServers?.length?m.params.mcpServers:acpLaunchMounts(process.argv.slice(2));servers=Array.isArray(mounts)?mounts.map(s=>s.name):Object.keys(mounts);const meta=m.params._meta,ack=meta?.['fuigo/permissionPolicySha256'];if(ack&&createHash('sha256').update(readFileSync(meta['fuigo/permissionPolicyPath'])).digest('hex')!==ack)throw Error('fixture policy mismatch');result({sessionId,...(ack?{_meta:{'fuigo/permissionPolicy':{sha256:ack}}}:{}),modes:{currentModeId:'default',availableModes:['default','normal','auto','yolo','plan','readonly','bypassPermissions'].map(id=>({id,name:id}))},configOptions:[{id:'model',category:'model',type:'select',currentValue:'fake-model',options:[{value:'fake-model',name:'Fixture'}]}],models:{currentModelId:'fake-model',availableModels:['fake-model','grok-4.6','grok-4.6-mini'].map(modelId=>({modelId,name:modelId}))}});out({jsonrpc:'2.0',method:'_fuigo/mcp_initialized',params:{sessionId,mcpToolCount:servers.length,elapsedMs:1}});}
 else if(m.method==='_fuigo/mcp/list'||m.method==='_x.ai/mcp/list')result({servers:servers.map(name=>({name,session:{enabled:true,status:'ready'}}))});
 else if(m.method==='session/set_mode'){update({sessionUpdate:'current_mode_update',currentModeId:m.params.modeId});result({modes:{currentModeId:m.params.modeId}});}
 else if(m.method==='session/set_config_option'){const configOptions=[{id:m.params.configId,category:m.params.configId,type:'select',currentValue:m.params.value,options:[{value:m.params.value,name:m.params.value}]}];update({sessionUpdate:'config_option_update',configOptions});result({configOptions});}
 else if(m.method==='session/prompt')void play(m).catch(error=>out({jsonrpc:'2.0',id:m.id,error:{code:-32603,message:error.message}}));
 else if(m.id!==undefined)result({});
});

}
