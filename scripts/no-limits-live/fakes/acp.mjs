#!/usr/bin/env node
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createInterface} from 'node:readline';
import {out,begin,requested,received} from './common.mjs';
if(process.argv.includes('--version')){console.log('1.0.0');process.exit(0);}
let sessionId=`base-${process.pid}`,sequence=1000,servers=[];const waits=new Map();
const update=update=>out({jsonrpc:'2.0',method:'session/update',params:{sessionId,update}});
const ask=(method,params)=>new Promise(resolve=>{const id=++sequence;waits.set(id,resolve);out({jsonrpc:'2.0',id,method,params:{sessionId,...params}});});
async function play(m){
 const plan=await begin(m.params.prompt);
 for(const [i,step] of plan.steps.entries()){
  if(step.kind==='text'){update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:step.text}});continue;}
  requested(plan,i);const toolCall={toolCallId:`base-${i}`,title:step.tool==='Bash'?'shell':step.tool,kind:step.tool==='Bash'?'execute':step.tool==='Write'?'edit':'other',status:'pending',rawInput:step.input};
  if(step.kind==='question')await ask('elicitation/create',{message:step.input.question,requestedSchema:{type:'object',properties:{pick:{type:'string',enum:step.input.choices}},required:['pick']}});
  else{update({sessionUpdate:'tool_call',...toolCall});await ask('session/request_permission',{toolCall,options:[{optionId:'allow',kind:'allow_once'},{optionId:'deny',kind:'reject_once'}]});update({sessionUpdate:'tool_call_update',toolCallId:toolCall.toolCallId,status:'completed',content:[]});}
  received(plan,i);
 }
 update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'fake BASE complete'}});out({jsonrpc:'2.0',id:m.id,result:{stopReason:'end_turn'}});
}
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(!m.method&&waits.has(m.id)){waits.get(m.id)(m.result);waits.delete(m.id);return;}
 const result=value=>out({jsonrpc:'2.0',id:m.id,result:value});
 if(m.method==='initialize')result({protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[]});
 else if(m.method==='session/new'||m.method==='session/load'){sessionId=m.params.sessionId??sessionId;servers=(m.params.mcpServers??[]).map(s=>s.name);const meta=m.params._meta,ack=meta?.['fuigo/permissionPolicySha256'];if(ack&&createHash('sha256').update(readFileSync(meta['fuigo/permissionPolicyPath'])).digest('hex')!==ack)throw Error('fixture policy mismatch');result({sessionId,...(ack?{_meta:{'fuigo/permissionPolicy':{sha256:ack}}}:{}),models:{currentModelId:'fake-model',availableModels:[{modelId:'fake-model',name:'Fake'}]}});out({jsonrpc:'2.0',method:'_fuigo/mcp_initialized',params:{sessionId,mcpToolCount:servers.length,elapsedMs:1}});}
 else if(m.method==='_fuigo/mcp/list'||m.method==='_x.ai/mcp/list')result({servers:servers.map(name=>({name,session:{enabled:true,status:'ready'}}))});
 else if(m.method==='session/prompt')void play(m).catch(error=>out({jsonrpc:'2.0',id:m.id,error:{code:-32603,message:error.message}}));
 else if(m.id!==undefined)result({});
});
