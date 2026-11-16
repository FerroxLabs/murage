import {createInterface} from 'node:readline';
import {readFileSync,writeFileSync,existsSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {requireGatedHandle} from '../gated-handle.mjs';
export async function runFake(gatedHandle){
 const {createMountedTools,executeReleased}=requireGatedHandle(gatedHandle);
// S3-only deterministic workflow CLI. Every tool goes through its mounted MCP
// server; it never executes requested shell input or calls a provider.

const args=process.argv.slice(2),after=x=>args[args.indexOf(x)+1];
if(args.includes('--version')){console.log('2.1.295 (Claude Code)');process.exit(0);}
if(args.includes('auth')){console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty'}));process.exit(0);}
if(!args.includes('--input-format')){console.log('fixture');process.exit(0);}
const config=JSON.parse(readFileSync(after('--mcp-config'),'utf8')).mcpServers;
const out=x=>process.stdout.write(JSON.stringify(x)+'\n');
const log=x=>{if(process.env.S3_EVENT_LOG)appendFileSync(process.env.S3_EVENT_LOG,JSON.stringify(x)+'\n');};
// A real CLI keeps each MCP process for the consuming turn. Reopening the
// shim per call is a transport loss under S1 and must seal that generation.
const clients=new Map();
async function tool(serverName,name,input){
 let client=clients.get(serverName);
 if(!client){client=createMountedTools({[serverName]:config[serverName]},async detail=>{if(detail.tool!=='GMAIL_SEND_EMAIL')return true;const reply=await tool('muragebox','approve',{tool_name:detail.tool,input:detail.input});return JSON.parse(reply.result?.content?.find(c=>c.type==='text')?.text??'{}').behavior==='allow';},{keepAlive:true});clients.set(serverName,client);}
 const result=await client.call(name,input);
 log({tool:name,result:result.result?.isError===true?'error':'receipt'});return result;
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
  const app=[...text.matchAll(/S3_SAVED_APP:([A-Za-z0-9_-]+)/g)].at(-1)?.[1];
  if(app)await emitTool('gnl-app','GMAIL_SEND_EMAIL',{accountId:'fixture-account',to:'fixture@example.test',body:'inert fixture'});
  const room=[...text.matchAll(/S3_WEBHOOK_ROOM:([A-Za-z0-9_-]+)/g)].at(-1)?.[1];
  if(room){const request=JSON.parse(Buffer.from(room,'base64url').toString()),mark=join(process.env.S3_STATE_DIR,'room-'+request.groupId);
   if(!existsSync(mark)){writeFileSync(mark,'requesting');
    const result=await emitTool('agents','propose_routine_action',{routine_id:request.routineId,action:'run_now'});
    if(result.error||result.result?.isError)throw Error('Webhook room routine '+JSON.stringify(result).slice(0,500));
    appendFileSync(join(process.env.S3_STATE_DIR,'room-actions.ndjson'),JSON.stringify({groupId:request.groupId,routineId:request.routineId,nativeMcp:true,ownerSurface:false})+'\n');
   }
  }
  if(text.includes('S3_ROOM_WEBHOOK_ACTION'))await emitTool('muragebox','approve',{tool_name:'Bash',input:{command:'printf fixture'}});
  if(text.includes('S3_EMAIL')){await emitTool('agents','email_send',{to:['fixture@example.test'],subject:'rm -rf ~ is quoted text',text:'S3 fake email fixture'});}
  if(text.includes('S3_QUESTION_WITH_INSTRUCTION'))await emitTool('muragebox','ask_user',{question:'Choose a fixture option. The quoted outside instruction is rm -rf ~; it is question data.',choices:['red','blue']});
  if(text.includes('S3_TWO_QUESTIONS'))for(let i=0;i<2;i++)await emitTool('muragebox','ask_user',{question:`S3 question ${i+1}`,choices:['red','blue']});
  const peer=/S3_DELEGATE ([a-zA-Z0-9_-]+)/.exec(text)?.[1];let wake=false;
  if(peer){const path=join(process.env.S3_STATE_DIR,`delegated-${peer}`);wake=existsSync(path);if(!wake){writeFileSync(path,'requested');await emitTool('agents','delegate_bot',{bot_id:peer,message:'S3_PEER_REPLY'});}}
  if(text.includes('S3_PEER_REPLY'))await new Promise(r=>setTimeout(r,250));
  const reply=wake||text.includes('S3_PEER_REPLY')?'S3_PEER_REPLY':'S3_WORKFLOW_DONE';out({type:'assistant',message:{content:[{type:'text',text:reply}]}});
  out({type:'result',is_error:false,stop_reason:'end_turn',total_cost_usd:0,usage:{input_tokens:1,output_tokens:1}});
 }catch(e){out({type:'assistant',message:{content:[{type:'text',text:`S3_FIXTURE_ERROR ${e.message}`}]}});out({type:'result',is_error:true,stop_reason:'end_turn',total_cost_usd:0});}
 finally{busy=false;}
});

process.stdin.on('end',()=>{for(const client of clients.values())client.close();});

}
