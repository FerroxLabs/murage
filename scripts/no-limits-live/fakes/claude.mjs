import {createInterface} from 'node:readline';
import {readFileSync} from 'node:fs';
import {proveFeatureOff} from './feature-off.mjs';
import {out,begin,requested,received,holdReleased,resolveReleaseStep,rememberReleaseResult} from './common.mjs';
import {requireGatedHandle} from '../gated-handle.mjs';
export async function runFake(gatedHandle){
 const {createMountedTools,executeReleased}=requireGatedHandle(gatedHandle);

const args=process.argv.slice(2),after=k=>args[args.indexOf(k)+1];
if(args.includes('--version')){console.log('2.1.295 (Claude Code)');process.exit(0);}
if(args.includes('auth')){console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty'}));process.exit(0);}
if(!args.includes('--input-format')){console.log('fixture');process.exit(0);}
const config=JSON.parse(readFileSync(after('--mcp-config'),'utf8')).mcpServers;
const broker=(name,input)=>createMountedTools({muragebox:config.muragebox}).call(name,input);
let busy=false,started=false;
createInterface({input:process.stdin}).on('line',async line=>{
 const m=JSON.parse(line);
 if(m.type==='control_request'){out({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{}}});return;}
 if(m.type!=='user'||busy)return;busy=true;
 if(!started){started=true;out({type:'system',subtype:'init',session_id:after('--session-id')??after('--resume')??'base-f',model:'sonnet'});}
 try{
  const plan=await begin(m.message?.content??m);
  const pageState={};
 for(const [i,original] of plan.steps.entries()){
  const step=resolveReleaseStep(original,pageState);
   if(step.kind==='off'){const text=await proveFeatureOff(step,config,gatedHandle);out({type:'assistant',message:{content:[{type:'text',text}]}});continue;}
  if(step.kind==='delay'){await holdReleased(step,text=>out({type:'assistant',message:{content:[{type:'text',text}]}}));continue;}
   if(step.kind==='text'){out({type:'assistant',message:{content:[{type:'text',text:step.text}]}});continue;}
   requested(plan,i);const id=`base-${i}-${Date.now()}`;
   out({type:'assistant',message:{content:[{type:'tool_use',id,name:step.tool,input:step.input}]}});
   const native=(['Bash','Write'].includes(step.tool))||step.kind==='question';
   let result,ok;
   if(native){
    result=await broker(step.kind==='question'?'ask_user':'approve',step.kind==='question'?step.input:{tool_name:step.tool,input:step.input,tool_use_id:id});
    let answer;try{answer=JSON.parse(result.result?.content?.find(c=>c.type==='text')?.text??'{}');}catch{}
    ok=step.kind==='question'||executeReleased(step,answer?.behavior==='allow');
   }else{
    const tools=createMountedTools(config,async detail=>{
     const answer=await broker('approve',{tool_name:step.tool,input:detail.input,tool_use_id:id});
     return JSON.parse(answer.result?.content?.find(c=>c.type==='text')?.text??'{}').behavior==='allow';
    });
    try{result=await tools.call(step.tool,step.input);ok=true;}
    catch(error){ok=false;result={result:{isError:true,content:[{type:'text',text:error.message}]}};}
   }
   rememberReleaseResult(step,result,pageState);
   if(step.fixture?.room){const r=step.fixture.room;const {appendFileSync}=await import('node:fs');appendFileSync(process.env.S3_STATE_DIR+'/room-actions.ndjson',JSON.stringify({...r,nativeMcp:true,ownerSurface:false})+'\n');}
   received(plan,i);out({type:'user',message:{content:[{type:'tool_result',tool_use_id:id,is_error:!ok,content:JSON.stringify(result.result??result.error)}]}});
  }
  if(!plan.steps.some(step=>step.kind==='off'))out({type:'assistant',message:{content:[{type:'text',text:plan.steps.findLast(step=>step.kind==='text')?.text??'fake BASE complete'}]}});
  out({type:'result',is_error:false,stop_reason:'end_turn',total_cost_usd:0,usage:{input_tokens:1,output_tokens:1}});
 }catch(error){out({type:'assistant',message:{content:[{type:'text',text:error.message}]}});out({type:'result',is_error:true,total_cost_usd:0});}
 finally{busy=false;}
});

}
