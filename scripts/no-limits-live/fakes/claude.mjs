#!/usr/bin/env node
import {createInterface} from 'node:readline';
import {readFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {out,begin,requested,received} from './common.mjs';
const args=process.argv.slice(2),after=k=>args[args.indexOf(k)+1];
if(args.includes('--version')){console.log('2.1.295 (Claude Code)');process.exit(0);}
if(args.includes('auth')){console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty'}));process.exit(0);}
if(!args.includes('--input-format')){console.log('fixture');process.exit(0);}
const config=JSON.parse(readFileSync(after('--mcp-config'),'utf8')).mcpServers;
async function broker(name,input){
 const server=config.muragebox;if(!server)throw Error('fake BASE broker mount missing');
 const child=spawn(server.command,server.args??[],{env:{...process.env,...server.env},stdio:['pipe','pipe','ignore']});
 const waiters=new Map();let next=0;
 createInterface({input:child.stdout}).on('line',line=>{const m=JSON.parse(line);waiters.get(m.id)?.(m);});
 const call=(method,params)=>new Promise((resolve,reject)=>{const id=++next,timer=setTimeout(()=>reject(Error('fake BASE MCP deadline')),20000);waiters.set(id,m=>{clearTimeout(timer);resolve(m);});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
 try{await call('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'fake BASE',version:'1'}});return await call('tools/call',{name,arguments:input});}
 finally{child.stdin.end();child.kill();}
}
let busy=false,started=false;
createInterface({input:process.stdin}).on('line',async line=>{
 const m=JSON.parse(line);
 if(m.type==='control_request'){out({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{}}});return;}
 if(m.type!=='user'||busy)return;busy=true;
 if(!started){started=true;out({type:'system',subtype:'init',session_id:after('--session-id')??after('--resume')??'base-f',model:'sonnet'});}
 try{
  const plan=await begin(m.message?.content??m);
  for(const [i,step] of plan.steps.entries()){
   if(step.kind==='text'){out({type:'assistant',message:{content:[{type:'text',text:step.text}]}});continue;}
   requested(plan,i);const id=`base-${i}-${Date.now()}`;
   out({type:'assistant',message:{content:[{type:'tool_use',id,name:step.tool,input:step.input}]}});
   const result=await broker(step.kind==='question'?'ask_user':'approve',step.kind==='question'?step.input:{tool_name:step.tool,input:step.input,tool_use_id:id});
   received(plan,i);out({type:'user',message:{content:[{type:'tool_result',tool_use_id:id,content:JSON.stringify(result.result??result.error)}]}});
  }
  out({type:'assistant',message:{content:[{type:'text',text:'fake BASE complete'}]}});
  out({type:'result',is_error:false,stop_reason:'end_turn',total_cost_usd:0,usage:{input_tokens:1,output_tokens:1}});
 }catch(error){out({type:'assistant',message:{content:[{type:'text',text:error.message}]}});out({type:'result',is_error:true,total_cost_usd:0});}
 finally{busy=false;}
});
