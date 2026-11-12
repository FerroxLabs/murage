import {createInterface} from 'node:readline';
import {existsSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createMcpCatalogWriter} from '../../../mcp-listed.ts';
const writer=createMcpCatalogWriter();
process.stdin.on('end',()=>process.exit(0));
const names=JSON.parse(process.env.FIXTURE_TOOLS||'[]');
const resources=process.env.FIXTURE_RESOURCES==='1';
const pages=Number(process.env.FIXTURE_PAGE_SIZE)||names.length||1;
const control=process.env.FIXTURE_REFRESH_DIR;
let root=0;
const waiting=path=>new Promise(resolve=>{const timer=setInterval(()=>{if(existsSync(path)){clearInterval(timer);resolve();}},5);});
if(control){
 const emitted=new Set();
 setInterval(()=>{for(let n=1;n<=4;n++)if(!emitted.has(n)&&existsSync(join(control,`notify-${n}`))){emitted.add(n);void writer.send({jsonrpc:'2.0',method:'notifications/tools/list_changed'}).catch(()=>{});}},5);
}
async function handle(m){
 const req=writer.observeRequest(m);
 await req.published;
 if(m.id===undefined)return;
 let result;
 if(m.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{listChanged:true},...(resources?{resources:{}}:{})},serverInfo:{name:'loopback-fixture',version:'1'}};
 else if(m.method==='tools/list') {
  let offered=names, generation;
  if(control){
   generation=root++;writeFileSync(join(control,`started-${generation}`),'');
   if(process.env.FIXTURE_GROWTH==='1')offered=generation===0?['final_0']:['final_0','new_unseen'];
   else {
    offered=generation===0?['base']:generation===1?Array.from({length:12},(_,i)=>`large_${i}`):generation===2?['small_0','small_1']:['final_0','final_1','final_2'];
    if(generation===1||generation===2)await waiting(join(control,`release-${generation}`));
   }
  }
  const offset=Number(m.params?.cursor)||0;
  result={tools:offered.slice(offset,offset+pages).map(name=>({name,description:'Offline fixture tool',inputSchema:{type:'object',properties:{}}})),...(offset+pages<offered.length?{nextCursor:String(offset+pages)}:{})};
  await req.respond({jsonrpc:'2.0',id:m.id,result});
  if(generation!==undefined)writeFileSync(join(control,`completed-${generation}`),'');
  return;
 }
 else if(m.method==='resources/list')result={resources:[]};
 else if(m.method==='resources/templates/list')result={resourceTemplates:[]};
 else if(m.method==='ping')result={};
 else {await req.respond({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Fixture method unavailable'}});return;}
 await req.respond({jsonrpc:'2.0',id:m.id,result});
}
for await(const line of createInterface({input:process.stdin}))void handle(JSON.parse(line)).catch(error=>{process.stderr.write(String(error));process.exitCode=1;process.stdin.destroy();});
