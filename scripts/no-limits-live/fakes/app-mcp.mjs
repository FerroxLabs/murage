#!/usr/bin/env node
// Inert local connected-app surface. It can only append a count to the owned
// fixture capture. No tool arguments become code, paths or network requests.
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const capture=process.env.GNL_FIXTURE_CAPTURE;
if(!capture)throw Error('Owned fixture capture required');
const tool={name:'connected_app_write',description:'Record an inert fixture app write; no external service is contacted.',inputSchema:{type:'object',properties:{toolkit:{type:'string'},tool_slug:{type:'string'},accountId:{type:'string'},text:{type:'string'}},required:['toolkit','tool_slug','accountId','text']}};
const fieldTool={name:'write',description:'Record inert outside-content field data locally.',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}};
createInterface({input:process.stdin}).on('line',line=>{
  let m;try{m=JSON.parse(line);}catch{return;}
  if(m.id===undefined)return;
  let result,error;
  if(m.method==='initialize')result={protocolVersion:m.params?.protocolVersion??'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'gnl-inert-app',version:'1'}};
  else if(m.method==='tools/list')result={tools:[tool,fieldTool]};
  else if(m.method==='tools/call'&&[tool.name,fieldTool.name].includes(m.params?.name)) {
    appendFileSync(capture,JSON.stringify({kind:'fixture-app-write',ok:true})+'\n',{mode:0o600});
    result={content:[{type:'text',text:'{"ok":true,"fixture":true}'}],isError:false};
  }else error={code:-32601,message:'Not an inert fixture operation'};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,...(error?{error}:{result})})+'\n');
});
