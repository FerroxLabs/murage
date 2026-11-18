// Harness mount/decision consumer owner: gnl-harness-r10. Native decision producer: MAIN.
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {readFileSync} from 'node:fs';
export {codexMounts,environmentMounts,acpLaunchMounts} from './fakes/mount-config.mjs';
// The only action transport is private. Every caller receives this gated handle;
// tool discovery, not caller-supplied step metadata, identifies saved-app calls.
export function createMountedTools(mounts,authorize,{keepAlive=false}={}){
 const clients=new Map();
 const close=()=>{for(const client of clients.values())client.close();clients.clear();};
 return Object.freeze({list:()=>mountedTool(mounts,null,undefined,authorize,keepAlive?clients:undefined),call:(name,input)=>mountedTool(mounts,name,input,authorize,keepAlive?clients:undefined),close});
}
function connect(server){
 const child=spawn(server.command,server.args??[],{env:{...process.env,...server.env},stdio:['pipe','pipe','ignore']});
 const waits=new Map();let next=0,closed=false;
 createInterface({input:child.stdout}).on('line',line=>{try{const m=JSON.parse(line);waits.get(m.id)?.resolve(m);}catch{}});
 const close=()=>{if(closed)return;closed=true;for(const w of waits.values())w.reject(Error('Release mounted transport closed'));waits.clear();child.stdin.end();child.kill();};
 child.on('error',close);child.on('close',close);
 const call=(method,params)=>new Promise((resolve,reject)=>{if(closed)return reject(Error('Release mounted transport closed'));const id=++next,timer=setTimeout(()=>{waits.delete(id);reject(Error('Release mounted tool deadline'));},15000);waits.set(id,{resolve:m=>{clearTimeout(timer);waits.delete(id);resolve(m);},reject:e=>{clearTimeout(timer);reject(e);}});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
 return {call,close,ready:call('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'Release fixture',version:'1'}})};
}
async function mountedTool(mounts,name,input,authorize,clients){
 const inventory=[];
 const entries=Array.isArray(mounts)?mounts.map(s=>({...s,env:Array.isArray(s.env)?Object.fromEntries(s.env.map(e=>[e.name,e.value])):s.env})):Object.entries(mounts).map(([key,s])=>({...s,name:key}));
 for(const server of entries){
  if(!server.command)continue;
  let client=clients?.get(server.name);
  if(!client){client=connect(server);clients?.set(server.name,client);}
  try{
   await client.ready;
   const list=(await client.call('tools/list',{})).result?.tools??[];
   if(name===null){inventory.push(...list.map(t=>t.name));continue;}
   const tool=list.find(t=>t.name===name||`mcp__${server.name}__${t.name}`===name);
   if(!tool)continue;
   const savedApp=tool.name==='GMAIL_SEND_EMAIL'||server.env?.GNL_SAVED_APP_FIXTURE==='1';
   if(savedApp&&typeof authorize!=='function')throw Error('Release mounted action missing native permission decision');
   if(authorize&&await authorize({server:server.name,tool:tool.name,input})!==true)throw Error('Release mounted action refused by native approval');
   const result=await client.call('tools/call',{name:tool.name,arguments:input});
   if(result.error||result.result?.isError)throw Error('Release mounted action failed: '+String(result.error?.message??result.result?.content?.find(c=>c.type==='text')?.text??'No action receipt').slice(0,300));
   return result;
  }finally{if(!clients)client.close();}
 }
 if(name===null)return inventory;
 throw Error(`Release mounted tool unavailable: ${name}`);
}
