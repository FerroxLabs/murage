// Harness consumer owner: gnl-harness-r9. Parser/decision contracts owner: MAIN.
// Behavioral controls use isolated files and native protocol peers only.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {stripTypeScriptTypes} from 'node:module';
import {runInNewContext} from 'node:vm';
import {removeTempDirSync} from '../../server/testing/cleanup.ts';
import {parseStoredMcpServer} from '../../server/mcp-registry.ts';
import {describe} from '../../server/decision/action.ts';
import {installBindings} from './bindings.mjs';
import {installDedicatedBindings} from './dedicated-bindings.mjs';
import {createMountedTools} from './mounted-tools.mjs';
import {releasePlan} from './fakes/release-plan.mjs';
import {launchLive} from './run.mjs';
import {releaseEngines,selectFixtureModel} from './release-engines.mjs';
import {createServer} from 'node:http';
import {startBrowserExtensionBroker} from '../../server/browser-extension-broker.ts';
import {attachFixtureExtension,fixtureExtensionEngine} from './browser-fixture.mjs';
const temp=fn=>{const root=mkdtempSync(join(tmpdir(),'nolim-live-review-'));return Promise.resolve().then(()=>fn(root)).finally(()=>removeTempDirSync(root));};
const input={accountId:'fixture-account',to:'fixture@example.test',body:'inert fixture'};
const service=new URL('./launchers/release-tool-service.mjs',import.meta.url).pathname;
function appState(root){
 const state=join(root,'s3-state');mkdirSync(state);
 const bot={id:'fixture',composio:true,connectedAppAccess:{revision:1,grants:[],denials:[{id:'saved-rule',source:'request-denied',toolkit:'gmail',accountId:input.accountId,tools:['GMAIL_SEND_EMAIL'],ops:['write']}]}};
 writeFileSync(join(root,'bots.json'),JSON.stringify([bot]));
 writeFileSync(join(root,'config.json'),'{}');
 const mount={command:process.execPath,args:[service],enabled:true,env:{NOLIM_RELEASE_FAKE:'1',NOLIM_FIXTURE_ROOT:root,GNL_APP_DATA_DIR:root,S3_STATE_DIR:state,GNL_SAVED_APP_FIXTURE:'1',GNL_APP_BOT:bot.id,GNL_APP_SCENARIO:'deny-app-denied'}};
 return {bot,state,mount,actions:join(state,'app-actions.ndjson')};
}
test('review mount: the actual saved-app binding survives the production custom mount parser',()=>temp(async root=>{
 const {bot,actions}=appState(root);let mounted;
 const c={releaseFixture:true,messages:async()=>[],api:async(method)=>{
  const saved=JSON.parse(readFileSync(join(root,'bots.json'),'utf8'))[0];
  return {enabled:true,policy:saved.connectedAppAccess};
 },turn:async()=>{
  const cfg=JSON.parse(readFileSync(join(root,'config.json'),'utf8'));
  const parsed=parseStoredMcpServer('gnl-app',cfg.mcpServers['gnl-app']);
  assert.equal(parsed.ok,true,parsed.error);
  mounted=parsed.server;
  await createMountedTools({'gnl-app':mounted},async()=>true).call('GMAIL_SEND_EMAIL',input);
  return {messages:[],events:[],cards:[]};
 }};
 const f={root,data:root,restart:async seed=>{await seed?.(root);}};
 const binding=installBindings(f)['deny-app-denied'];
 assert.equal(existsSync(actions),false);
 const result=await binding({client:c,bot,spec:{id:'deny-app-denied'}});
 assert.equal(result.proof,true);
 assert.equal(mounted.env.GNL_APP_DATA_DIR,root);
 assert.equal(Object.keys(mounted.env).some(k=>/^MURAGE_/i.test(k)),false);
 assert.deepEqual(JSON.parse(readFileSync(join(root,'config.json'),'utf8')).mcpServers,{});
 assert.equal(readFileSync(actions,'utf8').trim().split('\n').length,1);
}));

// Execute the actual production rule reader/resolver with only store I/O
// replaced. This keeps profile selection and action target classification real.
function browserDenials(bot,sites,actionInput){
 const source=readFileSync(new URL('../../server/index.ts',import.meta.url),'utf8');
 const from=source.indexOf('function resolveDecisionDenials('),to=source.indexOf('function decisionRoutineLive(',from);
 assert.ok(from>=0&&to>from);
 const code=stripTypeScriptTypes(source.slice(from,to));
 return JSON.parse(JSON.stringify(runInNewContext(code+';resolveDecisionDenials(decisionDenyState("fixture"),targets)',{
  store:{bot:()=>bot},browserSites:()=>({list:(_id,profile)=>sites.filter(s=>s.profileId===profile)}),
  targets:describe({tool:'agent_browser_open',input:actionInput}).targets,
 })));
}
async function browserFixture(root,{profileMismatch=false,noRule=false,noHit=false,noResult=false,wrongInput=false}={}){
 const bot={id:'fixture',threadId:'fixture-thread'},sites=[],site={url:'http://127.0.0.1:12345',hits:new Set()};
 let plan,denials;
 const c={api:async(method,path,body)=>{
  if(path.includes('/browser-choice/preview'))return {baseRevision:0,disclosure:{disclosureKey:'fixture-choice'}};
  if(method==='PATCH'){Object.assign(bot,body);if(profileMismatch)bot.browserExtensionProfileId='other';return {bot};}
  if(path.includes('/browser-extension/sites')){
   if(method==='POST'&&!noRule)sites.push({...body});
   return {sites:sites.filter(s=>s.profileId===new URL('http://fixture.test'+path).searchParams.get('profileId'))};
  }
  return {bot};
 },turn:async(_bot,text)=>{
  plan=releasePlan(text);
  const requested=JSON.parse(/with this input: ([\s\S]*?)\. Do not substitute/.exec(text)[1]);
  denials=browserDenials(bot,sites,requested);
  if(!noHit)site.hits.add(new URL(requested.url).pathname);
  const start={type:'item.started',itemType:'tool',origin:'engine',threadId:bot.threadId,turnId:'fixture-turn',itemId:'fixture-item',eventId:'fixture-start',provider:'codex',providerInstanceId:'codex',generation:'fixture-generation',tool:'agent_browser_open',input:wrongInput?{url:site.url+'/other'}:requested};
  const events=[start,...(noResult?[]:[{...start,type:'item.completed',eventId:'fixture-end',ok:true}])];
  writeFileSync(join(root,'nolim-native-events.ndjson'),events.map(JSON.stringify).join('\n')+'\n');
  return {threadIds:[bot.threadId],events:[]};
 }};
 const bound=installDedicatedBindings({data:root})['deny-browser-never'];
 const result=await bound({client:c,bot,spec:{id:'deny-browser-never'},cwd:root,site});
 return {result,plan,denials,bot,sites};
}
test('review browser profile: the requested action resolves the exact active persisted Never rule',()=>temp(async root=>{
 const {result,denials,bot,sites}=await browserFixture(root);
 assert.equal(bot.browserExtensionProfileId,'default');
 assert.deepEqual(denials,[{kind:'deny',class:'browser-site',ruleId:'browser-never',span:'http://127.0.0.1:12345'}]);
 assert.deepEqual(browserDenials({...bot,browserExtensionProfileId:'other'},sites,{url:'http://127.0.0.1:12345/other'}),[]);
 assert.equal(result.proof,true);
}));
test('review browser decoder: the dedicated once instruction executes one exact open',()=>temp(async root=>{
 const {result,plan}=await browserFixture(root);
 assert.equal(result.proof,true);
 assert.equal(plan.steps.length,1);
 assert.equal(plan.steps[0].tool,'agent_browser_open');
 assert.match(plan.steps[0].input.url,/\/stored-rule\/[^"}]+$/);
 // Real field setup is embedded after the workspace prefix. Keep that
 // explicit outside-data navigation while excluding URLs inside JSON.
 const outside='http://127.0.0.1:12345/outside/control';
 const withOutside=releasePlan(`Work ONLY inside ${root}. Use the requested tools. First use a browser tool to read ${outside}. Then Use exactly the Write tool once with this input: {"file_path":"notes.txt","content":"fixture"}. Do not substitute another tool or describe the result.`);
 assert.deepEqual(withOutside.steps,[{kind:'tool',tool:'agent_browser_open',input:{url:outside}},{kind:'tool',tool:'Write',input:{file_path:'notes.txt',content:'fixture'}}]);
}));
test('review browser profile: a different active profile cannot prove the installed rule',()=>temp(async root=>{
 let result;
 try{({result}=await browserFixture(root,{profileMismatch:true}));}
 catch(error){assert.match(error.message,/profile/i);return;}
 assert.equal(result.proof,false);
}));
test('review browser selection APIs: the isolated owner persists the profile used by the real denial reader',{timeout:180000},()=>temp(async out=>{
 const config=releaseEngines().codex;let f;
 try{
  f=await launchLive(out,[{id:'codex',driver:'codex',...config,path:config.cli}]);
  const {instances}=await f.client.api('GET','/api/instances?fresh=1');
  const bot=await f.client.bot('Browser rule fixture',{id:'codex',driver:'codex',model:selectFixtureModel({id:'codex'},instances.find(i=>i.instanceId==='codex'))},f.work,'unlimited');
  // P1 is an independent producer. Stop precisely at its turn boundary;
  // setup and readback use actual HTTP routes and persisted product state.
  f.client.turn=async()=>{throw Error('fixture owner-dispatch boundary');};
  await assert.rejects(installDedicatedBindings(f)['deny-browser-never']({client:f.client,bot,spec:{id:'deny-browser-never'},cwd:f.work,site:{url:'http://127.0.0.1:12345'}}),/fixture owner-dispatch boundary/);
  const current=(await f.client.api('GET',`/api/bots/${bot.id}`)).bot;
  const saved=(await f.client.api('GET',`/api/bots/${bot.id}/browser-extension/sites?profileId=default`)).sites;
  assert.equal(current.browserExtensionProfileId,'default');
  const stored=JSON.parse(readFileSync(join(f.data,'bots.json'),'utf8')).find(b=>b.id===bot.id);
  assert.equal(stored.browserExtensionProfileId,'default');
  assert.deepEqual(browserDenials(current,saved.map(s=>({...s,profileId:'default'})),{url:'http://127.0.0.1:12345/stored-rule/control'}),[{kind:'deny',class:'browser-site',ruleId:'browser-never',span:'http://127.0.0.1:12345'}]);
 }finally{await f?.client.disconnect();await f?.close();}
}));
test('review selected extension: real native-host navigation retains permission hooks and a real page effect',()=>temp(async root=>{
 let hits=0,broker;
 const site=createServer((_req,res)=>{hits++;res.end('Fixture page result');});
 await new Promise(resolve=>site.listen(0,'127.0.0.1',resolve));
 try{
  const directory=join(root,'native');mkdirSync(directory,{mode:0o700});
  broker=await startBrowserExtensionBroker({stateDir:directory});await attachFixtureExtension(broker);
  let sequence=0,admitted=false,destinations=0;
  const request=async(operation,params={})=>{
   const response=await broker.request('default',{version:1,type:'command',id:'fixture-'+(++sequence),bindingId:'fixture-binding',generation:1,operation,params});
   assert.equal(response.error,undefined);return response.result;
  };
  await request('bind');
  const engine=fixtureExtensionEngine({authorize:()=>true,
   beforeDestination:async()=>{destinations++;if(!admitted)throw Error('fixture permission refused');},beforeCommand:async()=>{throw Error('Navigation must use the destination hook');},
   transport:{selected:async()=>({tabId:1,navigationEpoch:0,url:'about:blank',origin:'null'}),send:async(method,params)=> (await request('cdp',{method,params})).result},
  });
  const url=`http://127.0.0.1:${site.address().port}/stored-rule/control`;
  await assert.rejects(engine.call('agent_browser_open',{url}),/permission refused/);assert.equal(hits,0);
  admitted=true;const result=await engine.call('agent_browser_open',{url});
  assert.equal(hits,1);assert.equal(destinations,2);assert.equal(result.content[0].text,'Fixture page result');
  await assert.rejects(engine.call('agent_browser_open',{url:'https://fixture.test/'}),/loopback/);assert.equal(hits,1);
  await assert.rejects(engine.call('agent_browser_click',{}),/Unsupported/);
 }finally{await broker?.close();site.closeAllConnections();await new Promise(resolve=>site.close(resolve));}
}));

for(const peer of ['claude','acp'])for(const allowed of [false,true])test(`review native approval: ${peer} ${allowed?'allow':'refusal'} controls the real saved-app effect`,()=>temp(async root=>{
 const {mount,actions}=appState(root),approvalFile=join(root,'approvals.ndjson');
 // The Claude broker is the minimal stand-in for P1's blocked owner dispatch.
 // It returns a native permission result; only the actual service can deliver.
 const broker=join(root,'broker.mjs');
 writeFileSync(broker,`import {createInterface} from 'node:readline';import {appendFileSync,existsSync} from 'node:fs';createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='tools/call'){appendFileSync(${JSON.stringify(approvalFile)},JSON.stringify({params:m.params,effectBeforeApproval:existsSync(${JSON.stringify(actions)})})+'\\n');}const result=m.method==='tools/list'?{tools:[{name:'approve'},{name:'ask_user'}]}:m.method==='tools/call'?{content:[{type:'text',text:JSON.stringify({behavior:${JSON.stringify(allowed?'allow':'deny')}})}]}:{};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`);
 const mounts={'gnl-app':mount,muragebox:{command:process.execPath,args:[broker]}},config=join(root,'mcp.json');writeFileSync(config,JSON.stringify({mcpServers:mounts}));
 const prompt='S3_SAVED_APP:'+Buffer.from(JSON.stringify({id:'deny-app-denied',ruleId:'saved-rule'})).toString('base64url');
 const cli=new URL(`./launchers/${peer}.mjs`,import.meta.url).pathname;
 const child=spawn(process.execPath,[cli,...(peer==='claude'?['--input-format','stream-json','--mcp-config',config]:[])],{cwd:root,env:{...process.env,NOLIM_RELEASE_FAKE:'1',NOLIM_FIXTURE_ROOT:root},stdio:['pipe','pipe','pipe']});
 const frames=[];let errors='',timer;
 try{
  await new Promise((resolve,reject)=>{
   timer=setTimeout(()=>reject(Error('Native fixture protocol deadline')),15000);
   child.stderr.on('data',b=>errors+=b);
   child.once('error',reject);child.once('close',code=>code===0?resolve():reject(Error(errors)));
   createInterface({input:child.stdout}).on('line',line=>{
    const m=JSON.parse(line);frames.push(m);
    if(m.method==='session/request_permission'){
     assert.equal(existsSync(actions),false,'effect before native approval');
     child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{outcome:{outcome:'selected',optionId:allowed?'allow':'deny'}}})+'\n');
    }
    if(peer==='acp'&&m.id===1)child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'session/prompt',params:{prompt:[{type:'text',text:prompt}]}})+'\n');
    if(m.type==='result'||peer==='acp'&&m.id===2)child.stdin.end();
   });
   child.stdin.write(JSON.stringify(peer==='claude'?{type:'user',message:{content:prompt}}:{jsonrpc:'2.0',id:1,method:'session/new',params:{mcpServers:Object.entries(mounts).map(([name,server])=>({name,...server}))}})+'\n');
  });
 }finally{clearTimeout(timer);child.kill();}
 const asks=peer==='claude'?(existsSync(approvalFile)?readFileSync(approvalFile,'utf8').trim().split('\n').map(JSON.parse):[]):frames.filter(f=>f.method==='session/request_permission');
 assert.equal(asks.length,1,'saved-app must traverse native approval exactly once');
 if(peer==='claude'){
  assert.equal(asks[0].effectBeforeApproval,false);
  assert.equal(asks[0].params.name,'approve');
  assert.equal(asks[0].params.arguments.tool_name,'GMAIL_SEND_EMAIL');
  assert.deepEqual(asks[0].params.arguments.input,input);
 }else{
  assert.equal(asks[0].params.toolCall.title,'GMAIL_SEND_EMAIL');
  assert.deepEqual(asks[0].params.toolCall.rawInput,input);
 }
 assert.equal(existsSync(actions),allowed,'a refusal must prevent actual delivery');
 if(allowed){const rows=readFileSync(actions,'utf8').trim().split('\n').map(JSON.parse);assert.equal(rows.length,1);assert.deepEqual(rows[0].input,input);}
 const completion=peer==='claude'?frames.flatMap(f=>f.message?.content??[]).find(f=>f.type==='tool_result'):frames.find(f=>f.params?.update?.sessionUpdate==='tool_call_update')?.params.update;
 assert.ok(completion,'native action result absent');
 assert.equal(peer==='claude'?!completion.is_error:completion.status==='completed',allowed);
}));
