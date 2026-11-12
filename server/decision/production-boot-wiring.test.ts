import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import ts from 'typescript';
import { launchVerificationServer, runControlMurage, type VerificationServer } from '../../scripts/control-murage.ts';

// This bridge adds a fixture-only HTTP operation to the REAL index.ts child.
// It installs no decision dependencies: the production boot owns every hook,
// source, claim verifier, host and transport. Requests carry real desktop proof.
const bridge = `
    if (path === '/api/wiring-fixture' && method === 'POST') {
      const body = await readBody(req);
      const bot = store.bot(body.botId);
      if (!bot) return json(res, 404, {error:'bot missing'});
      const result = await withOwnerDecisionAuthority(req, url, bot.id, bot.threadId, async authority => {
        if (body.op === 'sync') {
          const queue = producerQueue('peer'), ref = randomUUID();
          const opened = queue.open({authority,ref,tool:'ask_user',input:{text:'fixture'},
            action:{requestId:ref,tool:'ask_user',options:['Allow','Deny']},
            view:{title:'Fixture',subtitle:'Sync delivery'},base:{approve:null,source:'no-grant'}});
          if (opened.outcome.kind !== 'card') return opened.outcome;
          queue.presentNow(opened, opened.outcome.ref, () => {});
          return queue.answerNow(opened.outcome.ref.approvalId,{behavior:'allow'});
        }
        if (body.op === 'highlevel') {
          store.markThreadHighLevel(bot.threadId);
          const event={type:'request.opened',requestType:'permission',threadId:bot.threadId,
            requestId:'wiring-hl-'+randomUUID(),turnId:'wiring-turn',providerInstanceId:'fixture',
            toolEngine:body.engine ?? 'acp',toolKind:'execute',toolCall:{name:body.engine==='pi'?'bash':'Bash',input:{command:'printf fixture'}},
            ...(body.engine ? {} : {toolIdentity:{namespace:'claude',name:'Bash'}})};
          bus.publish(event);
          return {backstop:globalThis.__wiringHighlevel};
        }
        if (body.op === 'memory-open') {
          const {setMemoryMode}=await import('./memory/repository.ts');
          const {reconcileMemoryRoster}=await import('./memory/policy.ts');
          const {saveMemoryCandidate,openMemoryRequest,presentMemoryRequest}=await import('./memory/authority.ts');
          reconcileMemoryRoster({bots:store.bots,groups:store.groups});
          setMemoryMode('capture');
          store.appendMessage(bot.threadId,{role:'user',origin:'desktop',kind:'text',text:'Fixture owner note for recovery'});
          setMemoryMode('active');
          const row=database().prepare("SELECT id,revision FROM memory_sources WHERE thread_id=? AND state='active' ORDER BY rowid DESC LIMIT 1").get(bot.threadId);
          const principal=threadHumanPrincipal(bot.threadId), registry=new InternalCapabilities();
          registry.begin(bot.id,bot.threadId,authority.identity.generation,principal);
          const token=registry.mint({botId:bot.id,threadId:bot.threadId,generation:authority.identity.generation,kind:'memory',depth:0,skillAuthoring:false,humanPrincipal:principal});
          const access=memoryAccess(registry,registry.resolve('Bearer '+token),()=>({bots:store.bots,groups:store.groups}));
          const id=saveMemoryCandidate('Fixture remembered note',[{sourceId:String(row.id),revision:Number(row.revision),startByte:0,endByte:7}],'restart-'+randomUUID(),access);
          database().prepare("UPDATE memory_records SET state='candidate' WHERE id=?").run(id);
          const opened=openMemoryRequest(authority,access,id,1);
          if(opened.outcome.kind!=='card')return opened.outcome;
          presentMemoryRequest(opened,opened.outcome.ref,access,id,1);
          return {candidateId:id,approvalId:opened.outcome.ref.approvalId};
        }
        if (body.op === 'memory-keep') {
          const {memoryApprovalQueue}=await import('./memory/authority.ts');
          const delivery=memoryApprovalQueue().answerNow(body.approvalId,{behavior:'allow'});
          const record=database().prepare('SELECT state FROM memory_records WHERE id=?').get(body.candidateId);
          return {delivery,state:record?.state};
        }
        if (body.op === 'access-open') {
          store.patchBot(bot.id,{chiefOfStaff:true});
          const current=store.bot(bot.id);
          const request=requestBotAccess(store,current,{botId:bot.id,revision:current.connectedAppAccess?.revision ?? 0,
            grants:[{toolkit:'gmail',accountId:'fixture-account',tools:['GMAIL_FETCH_EMAILS']}],allowWrites:false},Date.now(),
            {authority,threadId:bot.threadId,accounts:await currentConnectedAccessAccounts({remembered:false})});
          return {...request,threadId:bot.threadId};
        }
        if (body.op === 'preflight') {
          store.patchBot(bot.id,{autoApprove:true,fullAccess:true,noLimits:true});
          const {approvalDecision}=await import('./approval-decision.ts');
          return {folder:approvalDecision(bot.threadId,'folder_trust',{folder:'/tmp/fixture',sources:['config']},true),
            shell:approvalDecision(bot.threadId,'shell',{command:'printf fixture'},true),
            wipe:approvalDecision(bot.threadId,'shell',{command:'rm -rf ~'},true),
            denied:approvalDecision(bot.threadId,'folder_trust',{folder:'/tmp/fixture'},true,'owner-denied')};
        }
        if (body.op === 'refuse') {
          store.patchBot(bot.id,{autoApprove:false,fullAccess:false,noLimits:false});
          const outcomes=[];
          for(let i=0;i<2;i++){
            const requestId='wiring-refusal-'+randomUUID();
            bus.publish({type:'request.opened',requestType:'permission',threadId:bot.threadId,
              requestId,tool:'Bash',toolCall:{name:'Bash',input:{command:'printf fixture'}}});
            outcomes.push(decide(openRequest({kind:'engine',threadId:bot.threadId,requestId}),()=>({approve:null,source:'no-grant'})));
          }
          return outcomes;
        }
        throw new Error('unknown fixture operation');
      });
      return json(res,200,result);
    }
`;
let fixture: VerificationServer;
let headers: Record<string,string>;
let botId: string;
const actions:unknown[]=[];
let logNumber=0;
function retainLog():void {
  mkdirSync('evidence/wiring-fix',{recursive:true});
  copyFileSync(fixture.info.logPath,`evidence/wiring-fix/boot-server-${logNumber++}.log`);
}
async function restart():Promise<void> {retainLog();await fixture.restart();}
async function api(method:string,path:string,body?:unknown) {
  const res = await fetch(fixture.info.url+path,{method,headers,body:body === undefined ? undefined : JSON.stringify(body)});
  const result={status:res.status,body:await res.json() as any};
  actions.push({method,path,body,result});return result;
}
beforeAll(async () => {
  // Deliberately omit C2's install only in this child to exercise the missing-
  // builder refusal even after ask-cards merges. No decision module is mocked.
  const indexSource=readFileSync(new URL('../index.ts',import.meta.url),'utf8');
  const syntax=ts.createSourceFile('index.ts',indexSource,ts.ScriptTarget.Latest,true);
  const omitted:Array<[number,number]>=[];
  function visit(node:ts.Node):void {
    if(ts.isExpressionStatement(node)&&ts.isCallExpression(node.expression)&&node.expression.expression.getText(syntax)==='installEngineApprovalBuilder') omitted.push([node.getStart(syntax),node.end]);
    ts.forEachChild(node,visit);
  }
  visit(syntax);
  fixture = await launchVerificationServer({},undefined,{instrumentationSource:`
    const {registerHooks}=await import('node:module');
    registerHooks({load(url,context,next){
      const loaded=next(url,context);
      if(url.endsWith('/server/index.ts')) {
        let source=String(loaded.source); const anchor='    const accessRoute =';
        for(const [start,end] of ${JSON.stringify(omitted.reverse())}) source=source.slice(0,start)+source.slice(end);
        if(!source.includes(anchor)) throw new Error('fixture bridge anchor missing');
        return {...loaded,source:source.replace(anchor,${JSON.stringify(bridge)}+anchor)
          .replace('async function currentConnectedAccessAccounts(options: { remembered?: boolean } = {}) {', 'async function currentConnectedAccessAccounts(options: { remembered?: boolean } = {}) { return [{toolkit:"gmail",accountId:"fixture-account"}];')
          .replace('      if (highlevelBackstop) {', ${JSON.stringify("      if (event.requestId?.startsWith('wiring-hl-')) globalThis.__wiringHighlevel = highlevelBackstop ?? null;\n      if (highlevelBackstop) {")})};
      }
      return loaded;
    }});
  `}).catch(error=>{ const path=String(error.message).split('see ')[1]; if(path) console.error(readFileSync(path.trim(),'utf8').slice(-4000)); throw error; });
  const proof = await (await fetch(fixture.info.url+'/api/desktop-secret')).json() as {secret:string};
  headers={'content-type':'application/json','x-murage-surface':'desktop','x-murage-surface-secret':proof.secret};
  const made=await api('POST','/api/bots',{name:'Wiring fixture',modelSelection:{instanceId:'fixture',model:'fake-model'}});
  expect(made.status,JSON.stringify(made.body)).toBe(201);
  botId=made.body.bot.id;
},150_000);
afterAll(async()=>{
  if(!fixture)return;
  try {
    mkdirSync('evidence/wiring-fix',{recursive:true});
    const env={...process.env,MURAGE_DATA_DIR:fixture.info.dataDir};
    const control:unknown[]=[];
    for(const command of [['doctor'],['wait','--bot',botId,'--timeout','1'],['messages','--bot',botId,'--limit','10']]) {
      const args=[...command,'--url',fixture.info.url];
      control.push({args,result:await runControlMurage(args,{env})});
    }
    writeFileSync('evidence/wiring-fix/boot-actions.json',JSON.stringify({fixture:fixture.info,actions,control},null,2));
    retainLog();
    copyFileSync(fixture.info.logPath,'evidence/wiring-fix/boot-server.log');
    writeFileSync('evidence/wiring-fix/fixture.json',JSON.stringify(fixture.info,null,2));
  } finally {
    await fixture.close();
  }
});
it('C1 production boot installs synchronous queue deliveries',async()=>{
  const result=await api('POST','/api/wiring-fixture',{botId,op:'sync'});
  expect(result.status,JSON.stringify(result.body)).toBe(200);
  expect(result.body).toEqual({state:'accepted'});
});
it('C1 production owner bot-access PUT applies the reviewed grant',async()=>{
  const opened=await api('POST','/api/wiring-fixture',{botId,op:'access-open'});
  expect(opened.status,JSON.stringify(opened.body)).toBe(200);
  const reviewed=await api('PUT',`/api/bots/${botId}/access`,{action:'approve',requestId:opened.body.requestId,revision:opened.body.revision});
  expect(reviewed.status,JSON.stringify(reviewed.body)).toBe(200);
  expect(reviewed.body.policy.grants).toEqual([{toolkit:'gmail',accountId:'fixture-account',tools:['GMAIL_FETCH_EMAILS']}]);
});

it.each(['acp','claude','codex','pi'])('H1 production request.opened allows a proved %s shell through the normal decision path',async engine=>{
  const result=await api('POST','/api/wiring-fixture',{botId,op:'highlevel',engine});
  expect(result.status,JSON.stringify(result.body)).toBe(200);
  expect(result.body).toEqual({backstop:null});
});

it('H2 production boot revalidates Keep after the durable memory queue is reopened by restart',async()=>{
  const opened=await api('POST','/api/wiring-fixture',{botId,op:'memory-open'});
  expect(opened.status,JSON.stringify(opened.body)).toBe(200);
  expect(opened.body.approvalId,JSON.stringify(opened.body)).toEqual(expect.any(String));
  await restart();
  const proof=await (await fetch(fixture.info.url+'/api/desktop-secret')).json() as {secret:string};
  headers['x-murage-surface-secret']=proof.secret;
  const kept=await api('POST','/api/wiring-fixture',{botId,op:'memory-keep',...opened.body});
  expect(kept.status,JSON.stringify(kept.body)).toBe(200);
  expect(kept.body).toEqual({delivery:{state:'accepted'},state:'active'});
},60_000);

it('M1 production boot supplies fresh accounts to the generic approval answer after restart',async()=>{
  const opened=await api('POST','/api/wiring-fixture',{botId,op:'access-open'});
  expect(opened.status,JSON.stringify(opened.body)).toBe(200);
  expect(opened.body.status).toBe('Waiting for owner review');
  await restart();
  const proof=await (await fetch(fixture.info.url+'/api/desktop-secret')).json() as {secret:string};
  headers['x-murage-surface-secret']=proof.secret;
  const answered=await api('POST',`/api/threads/${opened.body.threadId}/respond`,{requestId:opened.body.requestId,behavior:'allow'});
  expect(answered.status,JSON.stringify(answered.body)).toBe(200);
  const access=await api('GET',`/api/bots/${botId}/access`);
  expect(access.body.policy.grants).toEqual([{toolkit:'gmail',accountId:'fixture-account',tools:['GMAIL_FETCH_EMAILS']}]);
},60_000);

it('M2 production boot gives folder trust and native preflight the live owner No limits policy',async()=>{
  const result=await api('POST','/api/wiring-fixture',{botId,op:'preflight'});
  expect(result.status,JSON.stringify(result.body)).toBe(200);
  expect(result.body.folder.verdict).toBe('run');
  expect(result.body.shell.verdict).toBe('run');
  expect(result.body.wipe.verdict).toBe('card');
  expect(result.body.denied.verdict).toBe('card');
});

it('M3 production refusals log a safe cause once per process and remain visible',async()=>{
  const result=await api('POST','/api/wiring-fixture',{botId,op:'refuse'});
  expect(result.status,JSON.stringify(result.body)).toBe(200);
  expect(result.body).toHaveLength(2);
  for(const outcome of result.body)expect(outcome).toEqual({kind:'refuse',message:'Murage could not confirm this request. Nothing was run.'});
  await expect.poll(()=>readFileSync(fixture.info.logPath,'utf8').match(/engine-approval-builder-missing/g)?.length ?? 0).toBe(1);
});
