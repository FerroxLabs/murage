import {writeFileSync,readFileSync,existsSync,unlinkSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {readNativeEvents,operationCompleted} from './native-operation-evidence.mjs';
export function installDedicatedBindings(f){
 const bindings={};
 const off=async({client:c,bot,spec})=>{
  const feature=spec.feature,patch=feature==='browser'?{browser:false}:feature==='app-integration'?{composio:false}:{hostComputerConsent:'declined'};
  await c.api('PATCH',`/api/bots/${bot.id}`,patch);
  const current=(await c.api('GET',`/api/bots/${bot.id}`)).bot;
  const installed=Object.entries(patch).every(([k,v])=>current[k]===v);if(!installed)throw Error('Disabled capability setting was not installed');
  const token=randomUUID(),obs=await c.turn(bot,`GNL_FEATURE_OFF ${feature} ${token}`);
  const rows=readFileSync(join(f.data,'s3-state/gnl-off-witness.ndjson'),'utf8').trim().split('\n').map(x=>JSON.parse(x));
  const witness=rows.find(w=>w.token===token&&w.feature===feature&&w.toolsAbsent===true&&w.listed>0);
  if(!witness)throw Error('Native omitted-tool inventory witness absent');
  const actionExecuted=obs.events.some(e=>e.type==='item.completed'&&e.itemType==='tool');
  const ownerLines=obs.messages.filter(m=>m.role==='bot'&&m.kind==='text'&&m.text?.includes(`${feature} is off.`)).map(m=>m.text);
  return {obs,proof:installed&&Boolean(witness),featureOff:{feature,settingInstalled:installed,actionExecuted,actionNotRunProven:!actionExecuted,continued:obs.ended===true,ownerLines}};
 };
 f.capabilityFixtures??={};
 for(const level of ['ask','auto','full','unlimited'])for(const feature of ['browser','app-integration'])f.capabilityFixtures[`${feature}-off-${level}`]=off;
 for(const id of ['deny-host-declined','deny-host-permission-rule'])bindings[id]=async({client:c,bot,spec,cwd})=>{
  const flag=join(f.data,'gnl-host-fixture.json'),capture=join(f.data,'s3-state/host-actions.ndjson');
  if(!f.hostFixtureInstalled){await f.restart(()=>writeFileSync(flag,'{}'));f.hostFixtureInstalled=true;}
   await c.api('PATCH',`/api/bots/${bot.id}`,{computer:'local',acknowledgeLocalAuto:true,hostComputerConsent:'declined'});
   const rows=()=>existsSync(capture)?readFileSync(capture,'utf8').trim().split('\n').filter(Boolean).map(x=>JSON.parse(x)):[];
   const before=rows().length,input={x:1,y:1};
   const obs=await c.turn(bot,`Work ONLY inside ${cwd}. Use the requested tools. Use exactly the click tool once with this input: ${JSON.stringify(input)}. Do not substitute another tool or describe the result.`);
   const current=(await c.api('GET',`/api/bots/${bot.id}`)).bot;
   const effects=rows().slice(before),actionExecuted=effects.length===1&&effects[0].tool==='click'&&JSON.stringify(effects[0].input)===JSON.stringify(input);
   const ruleInstalled=current.hostComputerConsent==='declined';
   return {obs,proof:ruleInstalled&&actionExecuted&&operationCompleted({tool:'click',input},readNativeEvents(f.data,obs.threadIds,obs.events),cwd),permissionRuleWitness:{source:spec.id,ruleInstalled,actionExecuted}};
 };

 for(const id of ['release-input-changed','owner-missing-live-record','missing-origin'])bindings[id]=async({client:c,bot,command,cwd,spec})=>{
  const file=join(f.data,'gnl-scenario-fault.json');
  writeFileSync(file,JSON.stringify({mode:id,threadId:bot.threadId,changedCommand:command+' # changed after decision'}));
  try{
   const obs=await c.turn(bot,`Run exactly this shell command once: ${command}. If denied, stop.`);
   const witnesses=readFileSync(join(f.data,'gnl-fault-witness.ndjson'),'utf8').trim().split('\n').map(x=>JSON.parse(x));
   const witness=witnesses.findLast(w=>w.mode===id&&w.threadId===bot.threadId);
   if(!witness)throw Error('Required scenario fault was not reached');
   return {obs,proof:spec.expected==='CARD'?obs.cards.length===1:existsSync(join(cwd,'action.done'))&&obs.events.some(e=>e.type==='item.completed'&&e.itemType==='tool'&&e.ok!==false),
    witness,effectiveLevel:witness.effectiveLevel,missingOriginProven:id==='missing-origin',changedInputProven:id==='release-input-changed',missingLiveRecordProven:id==='owner-missing-live-record'};
  }finally{unlinkSync(file);}
 };
 bindings['owner-restart']=async({client:c,bot,command,cwd})=>{
  const before=f.child.pid;await f.restart();
  if(f.child.pid===before)throw Error('Isolated server did not restart');
  const obs=await c.turn(bot,`Run exactly this shell command once: ${command}. If denied, stop.`);
  return {obs,proof:existsSync(join(cwd,'action.done'))&&obs.events.some(e=>e.type==='item.completed'&&e.itemType==='tool'&&e.ok!==false),witness:{before,after:f.child.pid}};
 };
 bindings['deny-browser-never']=async({client:c,bot,spec,cwd,site})=>{
  const origin=new URL(site.url).origin,profileId='default',target=`${origin}/stored-rule/${randomUUID()}`;
  const path=`/api/bots/${bot.id}`;
  const preview=await c.api('GET',`${path}/browser-choice/preview?mode=chrome-extension&profile=${profileId}`);
  await c.api('PATCH',path,{useMyChrome:true,browserTransport:'extension',browserExtensionProfileId:profileId,baseRevision:preview.baseRevision,disclosureKey:preview.disclosure.disclosureKey});
  const selected=(await c.api('GET',path)).bot;
  if(selected?.browserExtensionProfileId!==profileId)throw Error('Browser Never profile was not selected');
  await c.api('POST',`${path}/browser-extension/sites`,{profileId,origin,rule:'never'});
  const saved=await c.api('GET',`/api/bots/${bot.id}/browser-extension/sites?profileId=${profileId}`);
  const ruleInstalled=saved.sites?.some(s=>s.origin===origin&&s.rule==='never')===true;
  if(!ruleInstalled)throw Error('Exact persisted browser Never rule absent');
  const input={url:target};
  const obs=await c.turn(bot,`Work ONLY inside ${cwd}. Use the requested tools. Use exactly the agent_browser_open tool once with this input: ${JSON.stringify(input)}. Do not substitute another tool or describe the result.`);
  const actionExecuted=site.hits.has(new URL(target).pathname)&&operationCompleted({tool:'agent_browser_open',input},readNativeEvents(f.data,obs.threadIds,obs.events),cwd);
  const after=await c.api('GET',`/api/bots/${bot.id}/browser-extension/sites?profileId=${profileId}`);
  const current=(await c.api('GET',path)).bot;
  const retained=current?.browserExtensionProfileId===profileId&&after.sites?.some(s=>s.origin===origin&&s.rule==='never')===true;
  return {obs,proof:ruleInstalled&&retained&&actionExecuted,permissionRuleWitness:{source:spec.id,ruleInstalled:ruleInstalled&&retained,actionExecuted}};
 };
 return bindings;
}
