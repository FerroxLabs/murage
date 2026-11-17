#!/usr/bin/env node
// S3-only deterministic workflow CLI. Every tool goes through its mounted MCP
// server; it never executes requested shell input or calls a provider.
import {createInterface} from 'node:readline';
import {readFileSync,writeFileSync,existsSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
const args=process.argv.slice(2),after=x=>args[args.indexOf(x)+1];
if(args.includes('--version')){console.log('2.1.295 (Claude Code)');process.exit(0);}
if(args.includes('auth')){console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty'}));process.exit(0);}
if(!args.includes('--input-format')){console.log('fixture');process.exit(0);}
const config=JSON.parse(readFileSync(after('--mcp-config'),'utf8')).mcpServers;
const out=x=>process.stdout.write(JSON.stringify(x)+'\n');
const log=x=>{if(process.env.S3_EVENT_LOG)appendFileSync(process.env.S3_EVENT_LOG,JSON.stringify(x)+'\n');};
async function tool(serverName,name,input){
 const server=config[serverName];if(!server)throw Error(`fixture mount absent: ${serverName}`);
 const child=spawn(server.command,server.args??[],{env:{...process.env,...server.env},stdio:['pipe','pipe','ignore']});
 const waiters=new Map();let next=0,buffer='';
 child.stdout.on('data',chunk=>{buffer+=chunk;let n;while((n=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,n);buffer=buffer.slice(n+1);try{const m=JSON.parse(line);waiters.get(m.id)?.(m);}catch{}}});
 const call=(method,params)=>new Promise((resolve,reject)=>{const id=++next,timer=setTimeout(()=>reject(Error('fixture MCP deadline')),15000);waiters.set(id,m=>{clearTimeout(timer);resolve(m);});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
 try{await call('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'S3 fake',version:'1'}});const result=await call('tools/call',{name,arguments:input});log({tool:name,result:result.result?.isError===true?'error':'receipt'});return result;}
 finally{child.stdin.end();child.kill();}
}
let started=false,busy=false;
createInterface({input:process.stdin}).on('line',async line=>{
 let m;try{m=JSON.parse(line);}catch{return;}
 if(m.type==='control_request'){out({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{}}});return;}
 if(m.type!=='user'||busy)return;busy=true;
 if(!started){started=true;out({type:'system',subtype:'init',session_id:after('--session-id')??after('--resume')??'s3-fixture',model:'sonnet'});}
 const text=JSON.stringify(m.message?.content??m),emitTool=async(server,name,input)=>{const id=`s3-${Date.now()}`;out({type:'assistant',message:{content:[{type:'tool_use',id,name:`mcp__${server}__${name}`,input}]}});const r=await tool(server,name,input);out({type:'user',message:{content:[{type:'tool_result',tool_use_id:id,is_error:r.result?.isError===true,content:JSON.stringify(r.result??r.error)}]}});return r;};
 try{
  if(text.includes('S3_HOLD'))await new Promise(r=>setTimeout(r,1000));
  const field=[...text.matchAll(/S3_FIELD:([A-Za-z0-9_-]+)/g)].at(-1)?.[1];
  if(field){const row=JSON.parse(Buffer.from(field,'base64url').toString());
   if(row.outside && row.outside!=='earlier-turn'){const id='s3-outside';out({type:'assistant',message:{content:[{type:'tool_use',id,name:'WebFetch',input:{url:'http://fixture.nolim.invalid/'}}]}});out({type:'user',message:{content:[{type:'tool_result',tool_use_id:id,content:'outside fixture content'}]}});}
   await emitTool('muragebox','approve',{tool_name:row.tool,input:row.input});
  }
  if(text.includes('S3_EMAIL')){await emitTool('agents','email_send',{to:['fixture@example.test'],subject:'rm -rf ~ is quoted text',text:'S3 fake email fixture'});}
  if(text.includes('S3_QUESTION_WITH_INSTRUCTION'))await emitTool('muragebox','ask_user',{question:'Choose a fixture option. The quoted outside instruction is rm -rf ~; it is question data.',choices:['red','blue']});
  if(text.includes('S3_TWO_QUESTIONS'))for(let i=0;i<2;i++)await emitTool('muragebox','ask_user',{question:`S3 question ${i+1}`,choices:['red','blue']});
  const peer=/S3_DELEGATE ([a-zA-Z0-9_-]+)/.exec(text)?.[1];let wake=false;
  if(peer){const path=join(process.env.S3_STATE_DIR,`delegated-${peer}`);wake=existsSync(path);if(!wake){writeFileSync(path,'requested');await emitTool('agents','delegate_bot',{bot_id:peer,message:'S3_PEER_REPLY'});}}
  if(text.includes('S3_PEER_REPLY'))await new Promise(r=>setTimeout(r,250));
  const reply=wake?'S3_WAKE_DONE':'S3_WORKFLOW_DONE';out({type:'assistant',message:{content:[{type:'text',text:reply}]}});
  out({type:'result',is_error:false,stop_reason:'end_turn',total_cost_usd:0,usage:{input_tokens:1,output_tokens:1}});
 }catch(e){out({type:'assistant',message:{content:[{type:'text',text:`S3_FIXTURE_ERROR ${e.message}`}]}});out({type:'result',is_error:true,stop_reason:'end_turn',total_cost_usd:0});}
 finally{busy=false;}
});
