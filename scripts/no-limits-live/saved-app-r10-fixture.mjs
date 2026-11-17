// Harness protocol consumer owner: gnl-harness-r10. Native protocol producer: MAIN.
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {removeTempDirSync} from '../../server/testing/cleanup.ts';
export const appInput={accountId:'fixture-account',to:'fixture@example.test',body:'inert fixture'};
export const appPrompt='S3_SAVED_APP:'+Buffer.from(JSON.stringify({id:'deny-app-denied',ruleId:'saved-rule'})).toString('base64url');
export function appFixture(){
 const root=mkdtempSync(join(tmpdir(),'nolim-live-app-control-')),state=join(root,'s3-state');mkdirSync(state);
 writeFileSync(join(root,'bots.json'),JSON.stringify([{id:'fixture',composio:true,connectedAppAccess:{denials:[{id:'saved-rule',source:'request-denied',accountId:appInput.accountId,tools:['GMAIL_SEND_EMAIL']}]}}]));
 const mount={command:process.execPath,args:[new URL('./launchers/release-tool-service.mjs',import.meta.url).pathname],env:{NOLIM_RELEASE_FAKE:'1',NOLIM_FIXTURE_ROOT:root,GNL_APP_DATA_DIR:root,S3_STATE_DIR:state,GNL_SAVED_APP_FIXTURE:'1',GNL_APP_BOT:'fixture',GNL_APP_SCENARIO:'deny-app-denied'}};
 const actions=join(state,'app-actions.ndjson');
 return {root,state,mount,actions,deliveries:()=>existsSync(actions)?readFileSync(actions,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[],close:()=>removeTempDirSync(root)};
}
export async function cliControl(spec,config,mode){
 const fixture=appFixture(),{root,state,mount,actions}=fixture,asksFile=join(root,'asks.ndjson');
 const allowed=mode==='allow',missing=mode==='missing';
 const peer=join(root,'permission-peer.mjs');
 writeFileSync(peer,`import {createInterface} from 'node:readline';import {appendFileSync,existsSync,readFileSync} from 'node:fs';const record=params=>appendFileSync(${JSON.stringify(asksFile)},JSON.stringify({params,before:existsSync(${JSON.stringify(actions)})})+'\\n');if(process.argv.includes('hook')){const params=JSON.parse(readFileSync(0,'utf8'));record(params);console.log(JSON.stringify({decision:${JSON.stringify(allowed?'allow':'deny')}}));}else createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='tools/call')record(m.params);process.stdout.write(JSON.stringify({id:m.id,jsonrpc:'2.0',result:m.method==='tools/list'?{tools:[{name:'approve'},{name:'ask_user'}]}:m.method==='tools/call'?{content:[{type:'text',text:JSON.stringify({behavior:${JSON.stringify(allowed?'allow':'deny')}})}]}:{}})+'\\n');});`);
 const mounts={...(mode==='never-consulted'?{}:{'gnl-app':mount}),muragebox:{command:process.execPath,args:[peer]}};
 const configFile=join(root,'mcp.json');writeFileSync(configFile,JSON.stringify({mcpServers:mounts}));
 mkdirSync(join(root,'.gemini','config'),{recursive:true});
 writeFileSync(join(root,'.gemini','config','mcp_config.json'),JSON.stringify({mcpServers:mounts}));
 writeFileSync(join(root,'.gemini','config','hooks.json'),JSON.stringify({fixture:{PreToolUse:[{matcher:'*',hooks:[{command:`'${process.execPath}' '${peer}' hook`}]}]}}));
 const hookFile=join(root,'.gemini','config','hooks.json');
 if(mode==='missing-hook')unlinkSync(hookFile);
 if(mode==='disabled-hook')writeFileSync(hookFile,JSON.stringify({fixture:{enabled:false,PreToolUse:[{matcher:'*',hooks:[{command:`'${process.execPath}' '${peer}' hook`}]}]}}));
 if(mode==='unmatched-hook')writeFileSync(hookFile,JSON.stringify({fixture:{PreToolUse:[{matcher:'unmatched',hooks:[{command:`'${process.execPath}' '${peer}' hook`}]}]}}));
 if(mode==='empty-response')writeFileSync(peer,`import {appendFileSync,readFileSync,existsSync} from 'node:fs';const params=JSON.parse(readFileSync(0,'utf8'));appendFileSync(${JSON.stringify(asksFile)},JSON.stringify({params,before:existsSync(${JSON.stringify(actions)})})+'\\n');console.log('{}');`);
 const driver=spec.driver;
 let args=driver==='claudeAgent'?['--input-format','stream-json','--mcp-config',configFile]:driver==='codex'?Object.entries(mounts).flatMap(([name,s])=>['-c',`mcp_servers.${name}.command=${JSON.stringify(s.command)}`,'-c',`mcp_servers.${name}.args=${JSON.stringify(s.args)}`,...Object.entries(s.env??{}).flatMap(([k,v])=>['-c',`mcp_servers.${name}.env.${k}=${JSON.stringify(v)}`])]):driver==='antigravityAgent'?['--print',appPrompt]:[];
 // Missing means the fake never installs/consults a native decision callback.
 // The same gated handle must refuse the action, regardless of engine family.
 const loader=join(root,'missing-decision.mjs');
 writeFileSync(loader,`import {registerHooks} from 'node:module';registerHooks({load(url,ctx,next){const r=next(url,ctx);if(!url.endsWith('/no-limits-live/mounted-tools.mjs'))return r;const s=typeof r.source==='string'?r.source:Buffer.from(r.source).toString();return {...r,source:s.replace('export function createMountedTools(mounts,authorize,{keepAlive=false}={}){','export function createMountedTools(mounts,authorize,{keepAlive=false}={}){authorize=undefined;')};}});`);
 const child=spawn(process.execPath,[...(missing?['--import',loader]:[]),config.cli,...args],{cwd:root,env:{...process.env,...config.environment,HOME:root,MURAGE_MCP_CONFIG:configFile,MURAGE_PI_GATE:'fixture-gate',S3_STATE_DIR:state,NOLIM_FIXTURE_ROOT:root},stdio:['pipe','pipe','pipe']});
 const frames=[],asks=[];let errors='',timer;
 const send=m=>child.stdin.write(JSON.stringify(m)+'\n');
 try{
  await new Promise((resolve,reject)=>{
   timer=setTimeout(()=>reject(Error('Native protocol deadline: '+errors)),12000);child.stderr.on('data',b=>errors+=b);
   child.once('error',reject);child.once('close',code=>code===0||driver==='antigravityAgent'&&code===1?resolve():reject(Error(errors)));
   createInterface({input:child.stdout}).on('line',line=>{try{
    const m=JSON.parse(line);frames.push(m);
    const ask=m.method==='session/request_permission'||m.method==='mcpServer/elicitation/request'||m.method==='approval/requested'||m.type==='extension_ui_request';
    if(ask){asks.push({frame:m,before:existsSync(actions)});
     if(m.method==='session/request_permission')send({jsonrpc:'2.0',id:m.id,result:{outcome:{outcome:'selected',optionId:allowed?'allow':'deny'}}});
     if(m.method==='mcpServer/elicitation/request')send({jsonrpc:'2.0',id:m.id,result:{action:allowed?'accept':'decline'}});
     if(m.method==='approval/requested')send({jsonrpc:'2.0',id:4,method:'approval/decide',params:{approvalId:m.params.approvalId,choiceId:allowed?'c-once':'c-deny'}});
     if(m.type==='extension_ui_request')send({type:'extension_ui_response',id:m.id,value:JSON.stringify({allow:allowed})});
    }
    if(!['claudeAgent','codex','piAgent','museCode','antigravityAgent'].includes(driver)&&m.id===1)send({id:2,jsonrpc:'2.0',method:'session/prompt',params:{prompt:[{type:'text',text:appPrompt}]}});
    if(driver==='museCode'&&m.id===1)send({id:2,jsonrpc:'2.0',method:'turn/start',params:{sessionId:m.result.session.sessionId,commandId:'fixture-turn',input:appPrompt}});
    if(m.type==='result'||m.method==='turn/completed'||m.type==='agent_end'||(!['claudeAgent','codex','piAgent','museCode','antigravityAgent'].includes(driver)&&m.id===2))child.stdin.end();
   }catch(error){reject(error);}});
   if(driver==='claudeAgent')send({type:'user',message:{content:appPrompt}});
   else if(driver==='codex')send({id:1,method:'turn/start',params:{threadId:'fixture-thread',input:appPrompt}});
   else if(driver==='piAgent')send({type:'prompt',message:appPrompt});
   else if(driver==='museCode')send({id:1,method:'session/start',params:{config:{mcpServers:mounts}}});
   else if(driver==='antigravityAgent')child.stdin.end();
   else send({id:1,jsonrpc:'2.0',method:'session/new',params:{mcpServers:Object.entries(mounts).map(([name,s])=>({name,...s}))}});
  });
  if(existsSync(asksFile))asks.push(...readFileSync(asksFile,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));
  return {...fixture,frames,asks,errors};
 }catch(error){fixture.close();throw error;}finally{clearTimeout(timer);child.kill();}
}
