// Harness generated-source owner: afix-gnl-harness-r10. Native fixture producer: MAIN.
import ts from 'typescript';
const helper=new URL('./native-play.mjs',import.meta.url).href;
const mounts=new URL('./fakes/mount-config.mjs',import.meta.url).href;
// Release prompts replace the legacy prompt handlers. Their unused transports
// must also be unavailable in the loaded graph; retain the pure helper exports.
const retired={
 'fake-agy-cli.ts':['driveMcp'],
 'fake-mcp-propose.ts':['session','proposeThroughMcp'],
 'fake-custom-tool.ts':['callFirstCustomTool'],
};
export function generatedNativeSource(url,source){
 const file=new URL(url).pathname.split('/').at(-1);
 const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
 const bodies=ast.statements.filter(n=>ts.isFunctionDeclaration(n)&&retired[file]?.includes(n.name?.text)&&n.body).map(n=>n.body).sort((a,b)=>b.pos-a.pos);
 for(const node of bodies)source=source.slice(0,node.getStart(ast))+"{throw Error('Legacy mounted transport unavailable in release fixture');}"+source.slice(node.end);
 const kind=/^fake-(pi|muse|agy)-cli\.ts$/.exec(file)?.[1];
 if(!kind)return source;
 source=source.replace(/^#![^\n]*\n/,'');
 source=`import {nativePlay} from ${JSON.stringify(helper)};import {environmentMounts} from ${JSON.stringify(mounts)};\n`+source;
 if(kind==='pi'){
  source=source.replace('case "prompt":',`case "prompt":
   send({type:'response',command:'prompt',success:true});send({type:'agent_start'});send({type:'turn_start'});
   void nativePlay(cmd.message,{mounts:environmentMounts(),
    beforeMounted:(detail,step,i)=>new Promise(resolve=>{const id='release-'+i;proposalAsks.set(id,resolve);send({type:'extension_ui_request',id,method:'editor',title:'murage-gate:'+process.env.MURAGE_PI_GATE,prefill:JSON.stringify({tool:step.tool,mount:detail.server,mcpTool:detail.tool,input:detail.input})});}),
    allow:(step,i)=>new Promise(resolve=>{const id='release-'+i;proposalAsks.set(id,resolve);send({type:'extension_ui_request',id,method:'editor',title:'murage-gate:'+process.env.MURAGE_PI_GATE,prefill:JSON.stringify({tool:step.tool==='Bash'?'bash':'write',input:step.tool==='Write'?{path:step.input.file_path,content:step.input.content}:step.input})});}),
    started:(step,i)=>send({type:'tool_execution_start',toolCallId:'release-'+i,toolName:step.tool,args:step.input}),
    completed:(step,i,ok)=>send({type:'tool_execution_end',toolCallId:'release-'+i,toolName:step.tool,isError:!ok}),
    text:text=>send({type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:text}})
   }).then(()=>finishRun(1,1),()=>{send({type:'turn_end',message:{role:'assistant',stopReason:'error'}});send({type:'agent_end',messages:[]});});return;
   case '__unused_release_prompt':`);
 }else if(kind==='muse'){
  source=source.replace('const mode = env.FAKE_MUSE_TURN ?? "reply";',`void nativePlay(params.input??params.prompt??params.text,{mounts:releaseMounts,
   beforeMounted:(detail,step,i)=>new Promise(resolve=>{releaseWaits.set('release-'+i,resolve);notify('approval/requested',{sessionId,turnId,approvalId:'release-'+i,itemId:'release-'+i,toolName:step.tool,rawArgs:JSON.stringify(detail.input),currentRequirementId:{sourceIndex:0},subject:{kind:'mcp',toolName:step.tool,target:detail.server,workspaceRoot:process.cwd()},availableChoices:DEFAULT_CHOICES});}),
   allow:(step,i)=>new Promise(resolve=>{releaseWaits.set('release-'+i,resolve);notify('approval/requested',{sessionId,turnId,approvalId:'release-'+i,itemId:'release-'+i,toolName:step.tool,rawArgs:JSON.stringify(step.input),currentRequirementId:{sourceIndex:0},subject:step.tool==='Bash'?{kind:'shell',command:step.input.command,workspaceRoot:process.cwd()}:{kind:'fileAccess',path:step.input.file_path,workspaceRoot:process.cwd()},availableChoices:DEFAULT_CHOICES});}),
   started:(step,i)=>notify('item/started',{sessionId,item:{itemId:'release-'+i,kind:'toolCall',status:'inProgress',turnId,tool:step.tool,args:JSON.stringify(step.input)}}),
   completed:(step,i,ok)=>notify('item/completed',{sessionId,item:{itemId:'release-'+i,kind:'toolCall',status:ok?'completed':'failed',turnId,tool:step.tool,args:JSON.stringify(step.input)}}),
   text:text=>notify('item/completed',{sessionId,item:{itemId:'release-text',kind:'agentMessage',status:'completed',turnId,text}})
  }).then(()=>complete('completed'),()=>complete('failed'));return;const mode = env.FAKE_MUSE_TURN ?? "reply";`);
  source=source.replace('input.on("line",',`const releaseWaits=new Map();let releaseMounts={};\ninput.on("line",`);
  source=source.replace('if (method === "session/resume")',`if (method === "session/resume") releaseMounts=params.config?.mcpServers??{};\n if (method === "session/resume")`);
  source=source.replace('if (method === "session/start") {',`if (method === "session/start") {releaseMounts=params.config?.mcpServers??{};`);
  source=source.replace('if (method === "approval/decide") { ok(); complete("completed"); return; }',`if(method==='approval/decide'){ok();const done=releaseWaits.get(params.approvalId);if(done){releaseWaits.delete(params.approvalId);done(['c-once','c-session','c-rule'].includes(params.choiceId));}return;}`);
 }else{
  source=source.replace('always = false): string | null {','always = false, requireAllow = false): string | null {let observedAllow=false;');
  source=source.replace('return null;\n  const home',"return requireAllow?'missing native hook':null;\n  const home");
  source=source.replace('if (!existsSync(file)) return null;',"if (!existsSync(file)) return requireAllow?'missing native hook':null;");
  source=source.replace('if (decision.decision === "deny")',`if(requireAllow && decision.decision!=='allow' && decision.decision!=='deny')return 'missing explicit native allow';if(decision.decision==='allow')observedAllow=true;\n        if (decision.decision === "deny")`);
  source=source.replace('  return null;\n}\nout({ event: "init"',"  return requireAllow&&!observedAllow?'missing native hook':null;\n}\nout({ event: \"init\"");
  const seam='const toolCalls: Array<{ name: string; args: Record<string, unknown> }> | null =';
  const start=source.indexOf(seam),end=source.indexOf('// FAKE_AGY_USAGE_FIRST',start);
  if(start<0||end<0)throw Error('Release Antigravity fake seam unavailable');
  source=source.slice(0,start)+`const releaseText=[];await nativePlay(prompt,{mounts:JSON.parse(readFileSync(join(process.env.HOME,'.gemini/config/mcp_config.json'),'utf8')).mcpServers,
   beforeMounted:async(detail,step,i)=>hookDenial('call_mcp_tool',{ServerName:detail.server,ToolName:detail.tool,Arguments:detail.input},i,true,true)===null,
   text:text=>{releaseText.push(text);out({event:'step_update',conversation_id:CONV,step_update:{conversation_id:CONV,step_index:999,state:'ACTIVE',step_type:'agent_response',partial:text}});},
   allow:async(step,i)=>hookDenial(step.tool==='Bash'?'run_command':'write_to_file',step.tool==='Bash'?{CommandLine:step.input.command}:step.input,i)===null,
   started:(step,i)=>out({event:'step_update',conversation_id:CONV,step_update:{conversation_id:CONV,step_index:i,state:'ACTIVE',step_type:'tool',tool_name:step.tool,tool_info:{name:step.tool,parameters:step.input}}}),
   completed:(step,i,ok)=>out({event:'step_update',conversation_id:CONV,step_update:{conversation_id:CONV,step_index:i,state:ok?'DONE':'ERROR',step_type:'tool',tool_name:step.tool,tool_info:{name:step.tool,parameters:step.input}}})
  }).catch(error=>{out({event:'result',conversation_id:CONV,result:{conversation_id:CONV,status:'ERROR',response:'GNL_FIXTURE_ERROR '+error.message,num_turns:1}});process.exit(1);});\nout({event:'result',conversation_id:CONV,result:{conversation_id:CONV,status:'SUCCESS',response:releaseText.join('\\n'),num_turns:1,usage:{input_tokens:1,output_tokens:1}}});process.exit(0);\nconst toolCalls: Array<{ name: string; args: Record<string, unknown> }> | null = [];\n`+source.slice(end);
 }
 return source;
}
