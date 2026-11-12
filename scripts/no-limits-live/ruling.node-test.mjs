import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scenarios, fieldRows, engineSpecs, assertReleaseReady } from './scenarios.mjs';
import { judgeScenario, CardLedger } from './counts.mjs';

const ok = { complete: true, ended: true, actionProven: true, cards: [], events: [], messages: [] };
const run = { id: 'ordinary', actor: 'owner', level: 'unlimited', expected: 'RUN' };
test('11-12 only independently specified wipes may card at No limits', () => {
  for (const id of ['deny-script', 'cron-write-cards', 'webhook-routine', 'webhook-read', 'webhook-write', 'webhook-in-owner-room']) {
    assert.equal(scenarios.find(s => s.id === id)?.expected, 'RUN', id);
  }
  for (const id of ['deny-browser-never','deny-app-denied','deny-app-revoked']) assert.equal(scenarios.find(s=>s.id===id)?.expected,'RUN',id);
  assert.equal(scenarios.find(s=>s.id==='deny-host-declined')?.expected,'OFF_WITH_LINE');
  for (const s of scenarios.filter(s => s.level === 'unlimited' && s.expected === 'CARD')) assert.equal(s.why, 'wipe', s.id);
  assert.doesNotThrow(() => assertReleaseReady());
  assert.ok(fieldRows.every(s => !s.dep));
});
test('guests and non-owners keep Ask on both legacy high-level bot profiles', () => {
  for (const actor of ['guest', 'non-owner']) for (const botLevel of ['full', 'unlimited']) {
    const s = scenarios.find(s => s.actor === actor && s.botLevel === botLevel && s.legacy);
    assert.equal(s?.level, 'ask'); assert.equal(s?.expected, 'CARD'); assert.equal(s?.legacy, true);
  }
  for (const origin of ['phone', 'channel-dm']) {
    assert.ok(scenarios.some(s => s.origin === origin && s.expected === 'RUN'));
    if(origin==='channel-dm')assert.ok(scenarios.some(s => s.origin === origin && s.channelMessages === false && s.expected === 'OFF_WITH_LINE'));
  }
});
test('silent denies, release refusals, and failed tool results cannot pass', () => {
  assert.equal(judgeScenario(run, ok).verdict, 'PASS');
  for (const patch of [
    { refusals: [{ kind: 'refuse' }] },
    { decisions: [{ decision: 'refuse' }] },
    { events: [{ type: 'request.resolved', behavior: 'deny' }] },
    { events: [{ type: 'item.completed', itemType: 'tool', ok: false }] },
    { messages: [{ role: 'bot', kind: 'text', text: 'Murage could not confirm this request. Nothing was run.' }] },
  ]) assert.equal(judgeScenario(run, { ...ok, ...patch }).verdict, 'FAIL', JSON.stringify(patch));
});
test('non-wipe card mutant fails; wipe control cannot be relabeled', () => {
  const card = { requestId: 'x', why: 'deny', evidence: [{ kind: 'deny' }] };
  assert.equal(judgeScenario(run, { ...ok, cards: [card] }).verdict, 'FAIL');
  const wipe = { ...run, expected: 'CARD', why: 'wipe', cls: 'home' };
  assert.equal(judgeScenario(wipe, { ...ok, cards: [card] }).verdict, 'FAIL');
  assert.equal(judgeScenario(wipe, { ...ok, cards: [{ ...card, why: 'wipe', evidence: [{ kind: 'wipe', class: 'home' }] }] }).verdict, 'PASS');
  assert.equal(judgeScenario(wipe, ok).verdict, 'FAIL');
});
test('channel-off requires a capability witness, zero cards and one settings line', () => {
 const spec=scenarios.find(s=>s.id==='owner-channel-dm-off');
 const obs={...ok,featureOff:{feature:'channel-messages',actionExecuted:false,actionNotRunProven:true,continued:true,ownerLines:['Channel messages are off. Turn them on in Settings > Channels.']}};
 assert.equal(judgeScenario(spec,obs).verdict,'PASS');
 assert.equal(judgeScenario(spec,ok).verdict,'FAIL');
 assert.equal(judgeScenario(spec,{...obs,featureOff:{...obs.featureOff,actionExecuted:true}}).verdict,'FAIL');
});
test('guest cards cannot hide a thread inheriting the bot level', () => {
  const s = { ...run, level:'ask', expected:'CARD', requiresAsk:true, why:'base' };
  const card = { why:'base', reason:'always-ask', evidence:[] };
  assert.equal(judgeScenario(s, { ...ok, effectiveLevel:'ask', cards:[card] }).verdict,'PASS');
  for(const effectiveLevel of ['full','unlimited',undefined])
    assert.equal(judgeScenario(s, { ...ok, effectiveLevel, cards:[card] }).verdict,'FAIL');
});
test('every registered shipped driver and the separate Sol lane are listed', async () => {
  const { discoverDrivers } = await import('./engine-inventory.mjs');
  const discovered = discoverDrivers();
  assert.ok(discovered.length >= 22);
  for (const driver of discovered) assert.ok(engineSpecs.some(e => e.driver === driver.driver), driver.driver);
  for (const id of ['claude', 'codex', 'gemini', 'fuigo', 'gpt-sol', 'muse', 'openclaw', 'antigravity', 'pi', 'grok-build']) assert.ok(engineSpecs.some(e => e.id === id), id);
});
test('unrun engines produce failed rows and an exact machine summary', async () => {
  const { completeMatrix, machineSummary } = await import('./counts.mjs');
  const engines = [{ id: 'missing', status: 'UNPROVEN' }];
  const rows = completeMatrix([], engines, [run]);
  assert.equal(rows.length, 1); assert.equal(rows[0].verdict, 'FAIL'); assert.equal(rows[0].skipped, false);
  assert.equal(machineSummary({ rows }), 'GNL-RESULT rows=1 pass=0 nonwipe_cards=0 refusals=0 skipped=0');
  const mutant = judgeScenario(run, { ...ok, cards: [{ why: 'deny' }] });
  assert.match(machineSummary({ rows: [mutant] }), /nonwipe_cards=1/);
  assert.equal(machineSummary({rows:[mutant],replay:{rows:257,pass:256,nonwipe_cards:1,refusals:2,skipped:0,controls:{rows:3,pass:3}}}),
    'GNL-RESULT rows=261 pass=259 nonwipe_cards=2 refusals=2 skipped=0');
});
test('one platform flag selects portable harmless and wipe commands without host paths', async () => {
  const { platformCommands } = await import('./platform.mjs');
  for (const platform of ['linux', 'darwin', 'win32']) {
    const c = platformCommands(platform, platform === 'win32' ? 'C:\\fixture\\work' : '/fixture/work', platform === 'win32' ? 'C:\\fixture\\home' : '/fixture/home');
    assert.ok(c.run.includes('action.done')); assert.ok(c.wipe.includes('fixture')); assert.ok(c.protectedWrite.includes('fixture'));
    if (platform === 'win32') { assert.match(c.run, /Set-Content/); assert.match(c.wipe, /Remove-Item/); }
  }
  assert.throws(() => platformCommands('unknown', '/fixture', '/fixture/home'));
});
test('Windows scenario commands use native paths and PowerShell syntax',async()=>{
  const {scenarioCommand}=await import('./platform.mjs');
  const paths={platform:'win32',cwd:'C:\\fixture path\\work',home:'C:\\fixture path\\home',root:'C:\\fixture path'};
  for(const id of ['cd','cd-ls','commit-push-remove','cron-write-cards','protected-symlink-write','opaque-eval','wipe-home']) {
    const command=scenarioCommand(id,paths);assert.ok(command.includes('fixture path'),id);assert.doesNotMatch(command,/\/etc\/cron|\brm -rf\b|\bprintf\b/,id);
  }
  assert.match(scenarioCommand('protected-symlink-write',paths),/Set-Content/);
  assert.match(scenarioCommand('wipe-home',paths),/Remove-Item/);
});
test('legacy fixture preserves high-level flags while removing the new explicit marker',async()=>{
  const {legacyRecord}=await import('./legacy-fixture.mjs');
  const original={id:'fixture',autoApprove:true,fullAccess:true,noLimits:true,permissionRev:7,permissionExplicit:true,tasks:[{threadId:'t',permissionExplicit:true,noLimits:true}]};
  const value=legacyRecord(original);assert.equal(value.permissionExplicit,undefined);assert.equal(value.tasks[0].permissionExplicit,undefined);
  assert.equal(value.noLimits,true);assert.equal(value.fullAccess,true);assert.equal(value.permissionRev,7);assert.equal(original.permissionExplicit,true);
});

test('explicit bot levels apply to guests without inheriting a thread level; missing origin stays Ask', () => {
  for (const actor of ['guest', 'non-owner']) for (const botLevel of ['full', 'unlimited']) {
    const spec = scenarios.find(s => s.id === `${actor}-explicit-${botLevel}`);
    assert.equal(spec?.expected, 'RUN'); assert.equal(spec?.level, botLevel);
    assert.equal(spec?.permissionExplicit, true); assert.equal(spec?.requiresAsk, undefined);
  }
  const missing = scenarios.find(s => s.id === 'missing-origin');
  assert.equal(missing?.actor, 'non-owner'); assert.equal(missing?.level, 'ask');
  assert.equal(missing?.requiresAsk, true); assert.equal(missing?.expected, 'CARD');
  assert.equal(missing?.origin, undefined); assert.equal(missing?.missingOrigin, true);
});
test('unknown delete runs while the same shape naming home requires a wipe card', () => {
  const unknown = scenarios.find(s => s.id === 'unknown-delete');
  assert.equal(unknown?.expected, 'RUN'); assert.equal(unknown?.level, 'unlimited');
  const home = scenarios.find(s => s.id === 'unknown-delete-home');
  assert.equal(home?.expected, 'CARD'); assert.equal(home?.why, 'wipe'); assert.equal(home?.cls, 'home');
});

test('stored permission rules require allow receipts and no approval surface', async () => {
 const {observe}=await import('./observe.mjs'); const {hashInput}=await import('./oracle-class.mjs');
 const request={engine:'fixture',tool:'browser',input:{origin:'http://fixture.invalid'},class:'permission-rule'};
 const spec={...run,requests:[request]}; const identity={generation:'g',requestId:'r',engine:request.engine,tool:request.tool,inputHash:hashInput(request.input)};
 const snapshot={complete:true,errors:[],taps:[{...identity,type:'request'},{...identity,type:'answer',state:'accepted',behavior:'allow'}],registrations:[identity],records:[],messages:[],queues:[],electron:[],mirrors:[]};
 assert.equal(observe(spec,snapshot).verdict,'PASS');
 for(const patch of [{taps:[snapshot.taps[0],{...snapshot.taps[1],behavior:'deny'}]},{records:[{...identity,id:'a',why:'deny'}]},{queues:[{approvalId:'a'}]},{electron:[{approvalId:'a'}]},{mirrors:[{approvalId:'a'}]}]) assert.equal(observe(spec,{...snapshot,...patch}).verdict,'FAIL');
});

test('missing origin requires an ingress witness and explicit bot rows require the stored explicit marker', () => {
  const missing = { ...run, actor: 'non-owner', level: 'ask', expected: 'CARD', why: 'base', requiresAsk: true, missingOrigin: true };
  const observation = { ...ok, effectiveLevel: 'ask', cards: [{ why: 'base', reason: 'always-ask', evidence: [] }] };
  assert.equal(judgeScenario(missing, { ...observation, missingOriginProven: true }).verdict, 'PASS');
  assert.equal(judgeScenario(missing, observation).verdict, 'FAIL');
  const explicit = { ...run, actor: 'guest', permissionExplicit: true };
  assert.equal(judgeScenario(explicit, { ...ok, botPermissionExplicit: true }).verdict, 'PASS');
  for (const botPermissionExplicit of [undefined, false])
    assert.equal(judgeScenario(explicit, { ...ok, botPermissionExplicit }).verdict, 'FAIL');
  const card = judgeScenario(explicit, { ...ok, botPermissionExplicit: true, cards: [{ why: 'base' }] });
  assert.equal(card.verdict, 'FAIL'); assert.equal(card.nonwipeCardCount, 1);
});

test('unknown-delete commands use a fixture-only dynamic target and home controls name the fixture home on every OS', async () => {
  const { scenarioCommand } = await import('./platform.mjs');
  for (const platform of ['linux', 'darwin', 'win32']) {
    const paths = platform === 'win32' ? { platform, cwd: 'C:\\fixture path\\work', home: 'C:\\fixture path\\home', root: 'C:\\fixture path' }
      : { platform, cwd: '/fixture path/work', home: '/fixture path/home', root: '/fixture path' };
    const unknown = scenarioCommand('unknown-delete', paths), home = scenarioCommand('unknown-delete-home', paths);
    assert.match(unknown, /delete-target.txt/); assert.match(unknown, /nolim_unknown/); assert.match(unknown, /action.done/);
    assert.ok(home.includes(paths.home));
    if (platform === 'win32') { assert.match(unknown, /Remove-Item/); assert.doesNotMatch(unknown, /\brm\b|\bprintf\b/); }
    else assert.match(unknown, /\$\{nolim_unknown:\?\}/);
  }
});
test('live runner retains independently observed feature-off evidence and structured refusal events', async () => {
 const {mkdtempSync,mkdirSync,writeFileSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {runScenario}=await import('./run.mjs');const {CardLedger}=await import('./counts.mjs');
 const root=mkdtempSync(join(tmpdir(),'gnl-off-runner-'));const spec=scenarios.find(s=>s.id==='deny-host-declined');
 const threadId='off-thread',bot={id:'off-bot',threadId},calls=[];
 const obs={...ok,threadIds:[threadId]};
 const client={ledger:new CardLedger(),bot:async()=>bot,api:async(...args)=>{calls.push(args);return {};},turn:async()=>obs,decisions:()=>[],messages:async()=>[],stop:async()=>{}};
 const work=join(root,'work'),home=join(root,'home'),config=join(root,'gitconfig');mkdirSync(work);mkdirSync(home);mkdirSync(join(home,'.ssh'));writeFileSync(config,'');
 const featureOff={feature:'host-computer',actionExecuted:false,actionNotRunProven:true,continued:true,ownerLines:['Computer access is off. Turn it on in the bot Computer panel in Settings.']};
 const f={root,home,work,client,platform:process.platform,gitEnv:{...process.env,GIT_CONFIG_GLOBAL:config,GIT_CONFIG_SYSTEM:config,GIT_CONFIG_NOSYSTEM:'1'},observeRow:async()=>({verdict:'PASS'}),featureOffWitnesses:{[spec.id]:async()=>featureOff}};
 try {
  const result=await runScenario(f,{id:'fixture',model:'fixture'},spec,{});
  assert.equal(result.verdict,'PASS',result.errors.join('; '));assert.deepEqual(result.featureOff,featureOff);
  assert.ok(calls.some(([method,path,body])=>method==='PATCH'&&path===`/api/bots/${bot.id}`&&body.hostComputerConsent==='declined'));
  obs.events=[{type:'request.resolved',behavior:'deny',requestId:'blocked'}];
  const second=await runScenario(f,{id:'second',model:'fixture'},spec,{});
  assert.equal(second.verdict,'FAIL');assert.ok(second.refusals.some(r=>r.requestId==='blocked'));
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('Ask card classification requires the exact canonical approval, request, thread and message join',()=>{
 const spec={id:'legacy',actor:'non-owner',level:'ask',expected:'CARD',why:'base',requiresAsk:true};
 const make=()=>{const ledger=new CardLedger();ledger.observe('thread',{id:'message',kind:'options',card:{requestId:'request',approvalId:'approval'}});return ledger;};
 const record={id:'approval',source_kind:'engine',thread_id:'thread',request_id:'request',chat_message_id:'message',why:'base',evidence:JSON.stringify({items:[],initiator:{k:'other-human'}})};
 const check=ledger=>judgeScenario(spec,{...ok,effectiveLevel:'ask',cards:ledger.forThreads(['thread']),errors:ledger.problems(['thread'])});
 const ledger=make();assert.equal(check(ledger).verdict,'FAIL');ledger.correlate([record]);assert.equal(check(ledger).verdict,'PASS');
 for(const patch of [{id:'wrong'},{thread_id:'wrong'},{request_id:'wrong'},{chat_message_id:'wrong'},{why:'wipe'},{source_kind:'unknown'},{evidence:'{}'},{evidence:JSON.stringify({items:[],initiator:{k:'owner-typed'}})}]){
  const mutated=make();mutated.correlate([{...record,...patch}]);assert.equal(check(mutated).verdict,'FAIL',JSON.stringify(patch));
 }
 const duplicate=make();duplicate.correlate([record,record]);assert.equal(check(duplicate).verdict,'FAIL');
 const conflict=make();conflict.cards.get('thread:request').why='wipe';conflict.correlate([record]);assert.equal(check(conflict).verdict,'FAIL');
});

test('registered card evidence joins the exact durable product record',async()=>{
 const {CardLedger}=await import('./counts.mjs');const l=new CardLedger(),message={id:'m',kind:'options',card:{requestId:'r',requestRef:'r',approvalId:'a'}};
 l.observe('t',message);const record={id:'a',thread_id:'t',chat_message_id:'m',request_id:'r',why:'base',actor_kind:'other',evidence:JSON.stringify({items:[]})};
 l.bindRegistration('t',message,record);assert.equal(l.forThreads(['t'])[0].why,'base');assert.equal(l.forThreads(['t'])[0].unattended,true);
 for(const patch of [{id:'wrong'},{thread_id:'other'},{chat_message_id:'other'},{request_id:'other'},{evidence:'{}'},{why:'legacy'}])assert.throws(()=>l.bindRegistration('t',message,{...record,...patch}));
 assert.throws(()=>l.bindRegistration('t',message,undefined));
 const empty=new CardLedger();assert.throws(()=>empty.bindRegistration('t',message,record));assert.equal(empty.forThreads(['t']).length,0);
});
