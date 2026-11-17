import {recordFeatureOff} from './feature-off.mjs';
import {resolveReleaseStep,releasedPage} from './common.mjs';
import {releasePlan} from './release-plan.mjs';
import {createServer} from 'node:http';
import {appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as sleep} from 'node:timers/promises';

// The HTTP fake can issue a tool in the same tick as the user send. Real
// providers have a transport round trip before that call. Wait for the actual
// current owner line's source capture, rather than turning capture-pending
// into a fabricated successful save or concealing a failed native attempt.
export async function waitForMemoryCapture(stateDir,content){
 if(!stateDir)return;
 const until=Date.now()+3000;
 while(Date.now()<until){let db;try{
  db=new DatabaseSync(join(stateDir,'..','messages.db'),{readOnly:true});db.exec('PRAGMA query_only=ON');
  const line=db.prepare("SELECT id,thread_id,text FROM messages WHERE role='user' AND kind='text' ORDER BY at DESC LIMIT 200").all().find(m=>m.text&&String(content).includes(m.text));
  if(line&&db.prepare("SELECT 1 FROM memory_sources s JOIN memory_source_versions v ON v.source_id=s.id AND v.revision=s.revision JOIN memory_jobs j ON j.source_id=s.id AND j.source_revision=s.revision AND j.stage='capture' AND j.status='complete' WHERE s.thread_id=? AND s.message_id=? AND s.state='active'").get(line.thread_id,line.id))return;
 }catch{}finally{db?.close();}await sleep(25);}
 throw Error('Current owner memory source capture did not finish');
}
export async function startApiFixture({stateDir}={}){
 const server=createServer(async(req,res)=>{
  let text='';for await(const chunk of req)text+=chunk;
  const json=value=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));};
  if(req.url.endsWith('/models'))return json({data:[{id:'fake-model'}]});
  if(req.url.endsWith('/me'))return json({id:'fixture-owner'});
  if(req.url.endsWith('/chat/completions')){
   const body=JSON.parse(text||'{}');
   let lastUser=-1,plan;
   for(let i=(body.messages?.length??0)-1;i>=0;i--){if(body.messages[i].role!=='user')continue;try{plan=releasePlan(body.messages[i].content);lastUser=i;break;}catch{}}
   if(!plan){res.writeHead(400,{'content-type':'application/json'});res.end('{"error":"Unimplemented release instruction"}');return;}
   const user=body.messages[lastUser];
   const completed=body.messages.slice(lastUser+1).filter(m=>m.role==='tool').length;
   const room=plan.steps.find(s=>s.fixture?.room);
   if(room&&completed>0&&stateDir){
    const receipt=body.messages.slice(lastUser+1).find(m=>m.role==='tool');
    let accepted=false;try{accepted=JSON.parse(receipt.content).ok===true;}catch{}
    if(accepted)appendFileSync(join(stateDir,'room-actions.ndjson'),JSON.stringify({...room.fixture.room,nativeMcp:true,ownerSurface:false})+'\n');
   }
   const original=plan.steps.filter(s=>['tool','question'].includes(s.kind))[completed];
   const pageState={page:body.messages.slice(lastUser+1).filter(m=>m.role==='tool').map(m=>releasedPage(m.content)).findLast(Boolean)};
   let resolved;try{resolved=original?resolveReleaseStep(original,pageState):undefined;}catch(error){res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:error.message}));return;}
   const step=resolved?.kind==='question'?{...resolved,input:{questions:[{question:resolved.input.question,options:resolved.input.choices.map(label=>({label}))}]}}:resolved;
   if(step?.tool==='memory_save')try{await waitForMemoryCapture(stateDir,user.content);}catch(error){res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:error.message}));return;}
   const names=(body.tools??[]).map(t=>t.function?.name).filter(Boolean);
   if(stateDir)appendFileSync(join(stateDir,'api-inventory.ndjson'),JSON.stringify({plan:plan.id,requested:step?.tool,names,results:body.messages?.filter(m=>m.role==='tool').map(m=>m.content)})+'\n');
   const canonical=step?.tool.replace(/^mcp__/,'').replaceAll('__','_').toLowerCase();
   // Flattened API names can collide (native Write and custom write). Resolve
   // the advertised schema as well as the namespace/name; never call Write
   // with a text-only custom tool's input merely because the spelling agrees.
   const compatible=n=>{const schema=body.tools.find(t=>t.function?.name===n)?.function?.parameters;return Object.keys(step.input).every(k=>!schema?.properties||Object.hasOwn(schema.properties,k));};
   const match=step&&(names.find(n=>(n===step.tool||n.endsWith('__'+step.tool)||n.endsWith('_'+step.tool.toLowerCase())||n.replace(/_\d+$/,'')===canonical)&&compatible(n))??(step.tool==='Bash'?names.find(n=>/(?:^|_)(?:shell|bash|exec|run_command)$/.test(n)):undefined));
   const off=plan.steps.find(s=>s.kind==='off');
   let offText;if(off&&stateDir)try{offText=recordFeatureOff(off,names,stateDir);}catch{offText='Disabled capability inventory failed';}
   const message=match?{role:'assistant',content:null,tool_calls:[{id:'fixture-'+completed,type:'function',function:{name:match,arguments:JSON.stringify({...step.input,...(/(?:^|_)gnl_fixture_|gnl_fixture/.test(match)?{cwd:/Work ONLY inside ([^\n]+?)\. Use the requested tools/.exec(String(user?.content))?.[1]}:{})})}}]}:{role:'assistant',content:offText??[...plan.steps.filter(s=>s.kind==='text').map(s=>s.text),'Release fixture complete'].join('\n')};
   const reply={id:'fixture-completion',object:'chat.completion',model:body.model,choices:[{index:0,message,finish_reason:match?'tool_calls':'stop'}]};
   const hold=completed===0&&plan.steps.find(s=>s.kind==='delay');
   if(!body.stream){if(hold)await new Promise(r=>setTimeout(r,hold.ms));return json(reply);}
   res.writeHead(200,{'content-type':'text/event-stream'});
   if(hold){res.write(`data: ${JSON.stringify({id:'fixture-progress',object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',content:'Working on the fixture.'},finish_reason:null}]})}\n\n`);await new Promise(r=>setTimeout(r,hold.ms));}
   res.end(`data: ${JSON.stringify({...reply,object:'chat.completion.chunk',choices:[{index:0,delta:{...message,...(message.tool_calls?{tool_calls:message.tool_calls.map((t,index)=>({...t,index}))}:{})},finish_reason:reply.choices[0].finish_reason}]})}\n\ndata: [DONE]\n\n`);return;
  }
  res.writeHead(404,{'content-type':'application/json'});res.end('{"error":"Fixture endpoint unavailable"}');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 return {url:`http://127.0.0.1:${server.address().port}/v1`,async close(){server.closeAllConnections();await new Promise(r=>server.close(r));}};
}
