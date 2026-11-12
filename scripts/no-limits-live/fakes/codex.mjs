#!/usr/bin/env node
import {createInterface} from 'node:readline';
import {out,begin,requested,received,executeReleased} from './common.mjs';
if(process.argv.includes('--version')){console.log('codex-cli 0.147.0');process.exit(0);}
if(process.argv.includes('login')){console.log('Logged in using ChatGPT');process.exit(0);}
let thread='base-thread',turn='base-turn',sequence=0;const waits=new Map();
const notify=(method,params)=>out({jsonrpc:'2.0',method,params:{threadId:thread,turnId:turn,...params}});
const ask=(method,params)=>new Promise(resolve=>{const id=++sequence+1000;waits.set(id,resolve);out({jsonrpc:'2.0',id,method,params:{threadId:thread,turnId:turn,...params}});});
async function play(m){
 const plan=await begin(m.params.input);
 for(const [i,step] of plan.steps.entries()){
  if(step.kind==='text'){notify('item/completed',{item:{id:`text-${i}`,type:'agentMessage',text:step.text}});continue;}
  let released=true;requested(plan,i);const itemId=`base-${i}`;
  const item=step.kind==='question'?undefined:step.tool==='Bash'?{id:itemId,type:'commandExecution',command:step.input.command}:{id:itemId,type:'mcpToolCall',server:'fixture',tool:step.tool,arguments:step.input};
  if(item)notify('item/started',{item});
  if(step.kind==='question')await ask('item/tool/requestUserInput',{itemId,isBlocking:true,questions:[{id:`q-${i}`,header:'Fixture',question:step.input.question,isOther:false,isSecret:false,options:step.input.choices.map(label=>({label,description:label}))}]});
  else if(step.tool==='Bash'){const answer=await ask('item/commandExecution/requestApproval',{itemId,command:step.input.command});released=executeReleased(step,['accept','acceptForSession'].includes(answer?.decision));}
  else await ask('mcpServer/elicitation/request',{serverName:'fixture',mode:'form',_meta:{codex_approval_kind:'mcp_tool_call',tool_params:step.input},message:`Allow the fixture MCP server to run tool "${step.tool}"?`,requestedSchema:{type:'object',properties:{}}});
  received(plan,i);if(item)notify('item/completed',{item:{...item,status:'completed',exitCode:released===false?1:0,result:{content:[]}}});
 }
 notify('item/completed',{item:{id:'complete',type:'agentMessage',text:'fake BASE complete'}});notify('turn/completed',{turn:{id:turn,status:'completed'}});
}
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(!m.method&&waits.has(m.id)){waits.get(m.id)(m.result);waits.delete(m.id);return;}
 const result=value=>out({jsonrpc:'2.0',id:m.id,result:value});
 if(m.method==='model/list')result({data:[{id:'gpt-5.4',displayName:'Fake',isDefault:true,hidden:false},...(process.env.NOLIM_RELEASE_FAKE==='1'?[{id:'gpt-sol-fixture',displayName:'Sol fixture',hidden:false}]:[])],nextCursor:null});
 else if(m.method==='thread/start'||m.method==='thread/resume'){thread=m.params.threadId??`base-${process.pid}`;result({thread:{id:thread},model:m.params.model??'gpt-5.4',modelProvider:'openai'});}
 else if(m.method==='turn/start'){thread=m.params.threadId;turn=`base-turn-${++sequence}`;result({turn:{id:turn,status:'inProgress',items:[],error:null}});notify('turn/started',{turn:{id:turn,status:'inProgress'}});void play(m).catch(error=>{notify('error',{message:error.message});notify('turn/completed',{turn:{id:turn,status:'failed',error:{message:error.message}}});});}
 else if(m.id!==undefined)result({});
});
