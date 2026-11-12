import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
if (!process.argv[2]) throw new Error('Pass the isolated scratch installation directory');
const root=resolve(process.argv[2]);
const requests=[];
const server=createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;requests.push({url:req.url,body:JSON.parse(body)});res.writeHead(429,{'content-type':'application/json','retry-after':'1'});res.end(JSON.stringify({error:{message:'Local fixture rate limit',type:'rate_limit_error',code:'rate_limit_exceeded'}}));});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const config={model:'fixture/mock',small_model:'fixture/mock',provider:{fixture:{npm:'@ai-sdk/openai-compatible',name:'Offline fixture',options:{baseURL:`http://127.0.0.1:${server.address().port}/v1`,apiKey:'fake-local-only'},models:{mock:{name:'Mock',limit:{context:32000,output:1000}}}}}};
const child=spawn(root+'/node_modules/.bin/opencode',['acp','--print-logs'],{ windowsHide: true,cwd:root+'/work',env:{PATH:process.env.PATH,HOME:root+'/home',USERPROFILE:root+'/home',XDG_CONFIG_HOME:root+'/home/config',XDG_DATA_HOME:root+'/home/data',XDG_CACHE_HOME:root+'/home/cache',XDG_STATE_HOME:root+'/home/state',TMPDIR:root+'/home',OPENCODE_CONFIG_CONTENT:JSON.stringify(config),OPENCODE_DISABLE_MODELS_FETCH:'true',OPENCODE_DISABLE_AUTOUPDATE:'true',OPENCODE_DISABLE_DEFAULT_PLUGINS:'true',OPENCODE_DISABLE_EXTERNAL_SKILLS:'true',OPENCODE_PURE:'true'}});
let stdout='',stderr='',buf='',id=0;const pending=new Map();
child.stderr.on('data',c=>{stderr+=c;});
child.stdout.on('data',c=>{stdout+=c;buf+=c;while(buf.includes('\n')){const n=buf.indexOf('\n');const line=buf.slice(0,n);buf=buf.slice(n+1);try{const m=JSON.parse(line);if(pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}}catch{}}});
const rpc=(method,params)=>new Promise(resolve=>{const i=++id;pending.set(i,resolve);child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:i,method,params})+'\n');});
const timer=setTimeout(()=>child.kill('SIGTERM'),35000);
try{
console.log(await rpc('initialize',{protocolVersion:1,clientCapabilities:{},clientInfo:{name:'offline-fixture',version:'1'}}));
const session=await rpc('session/new',{cwd:root+'/work',mcpServers:[]}); console.log(session);const sessionId=session.result.sessionId;
await rpc('session/prompt',{sessionId,prompt:[{type:'text',text:'Offline fixture prompt'}]});
console.log(await rpc('session/load',{sessionId,cwd:root+'/work',mcpServers:[]}));
const other=await rpc('session/new',{cwd:root+'/work',mcpServers:[]});
console.log(other);
await Promise.all([rpc('session/prompt',{sessionId,prompt:[{type:'text',text:'Loaded fixture prompt'}]}),rpc('session/prompt',{sessionId:other.result.sessionId,prompt:[{type:'text',text:'Overlapping fixture prompt'}]})]);
child.kill('SIGTERM');
await new Promise(r=>child.once('exit',r));
}finally{clearTimeout(timer);child.kill('SIGTERM');server.close();writeFileSync(root+'/stdout.jsonl',stdout);writeFileSync(root+'/stderr.log',stderr);writeFileSync(root+'/requests.json',JSON.stringify(requests,null,2));}
