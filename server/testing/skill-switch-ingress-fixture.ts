// Test-local authenticated ingress seam owner: skills lane. No capability is returned or serialized.
/** Runs only in launchVerificationServer's isolated child loader. */
export function skillSwitchIngressFixtureSource(url: string, source: string): string {
  if(url.endsWith('/server/atomic.ts'))return "import {fixtureBeforeAtomic,fixtureAfterAtomic,fixtureAfterBarrier} from './testing/skill-switch-counts-fixture.mjs';\n"+source
    .replace('  writeFileAtomicInner(path, data, options);','  fixtureBeforeAtomic(path,data);writeFileAtomicInner(path, data, options);fixtureAfterAtomic(path,data);')
    .replace('try { fsyncSync(fd); return "synced"; }','try { fsyncSync(fd); fixtureAfterBarrier(path); return "synced"; }');
  if (url.endsWith('/server/skill-switch-settlement.ts')) {
    source = "import {appendFileSync as fixtureIngressWrite} from 'node:fs';import {join as fixtureIngressJoin} from 'node:path';import {DATA_DIR as fixtureIngressRoot} from './config.ts';\n" + source;
    source = source.replace('      const input = item.call.input as', `      const mode=(context.invocation as {headers?:Record<string,string>}).headers?.['x-fixture-issuer-mode'];
      if(mode==='missing-session')context={...context,session:undefined};
      if(mode==='revoked-session'&&context.session)context={...context,session:{...context.session,live:()=>false}};
      if(mode==='fresh-failed'||mode==='fresh-missing')context={...context,freshAuth:mode==='fresh-failed'?'failed':'missing'};
      fixtureIngressWrite(fixtureIngressJoin(fixtureIngressRoot,'fixture-owner-issuer.jsonl'),JSON.stringify({kind:context.kind,stage:'guard',mode})+'\\n');
      const input = item.call.input as`);
    source = source.replace('      registry.set(token,', `      fixtureIngressWrite(fixtureIngressJoin(fixtureIngressRoot,'fixture-owner-issuer.jsonl'),JSON.stringify({kind:context.kind,stage:'insert',mode})+'\\n');
      registry.set(token,`);
    return source;
  }
  if (!url.endsWith('/server/index.ts')) return source;
  source="import {fixtureSkillRetired} from './testing/skill-switch-counts-fixture.mjs';\n"+source;
  source=source.replace('  } finally { decisionProvenance.delete(generation); }','  } finally { fixtureSkillRetired(decisionProvenance.get(generation)?.botId);decisionProvenance.delete(generation); }');
  source=source.replace('      if (!request || !isSkillSwitchAction(request.action)',`      if(url.searchParams.get('fixtureReplay')==='1'&&record){
        const saved=JSON.parse(readFileSync(join(DATA_DIR,'decision-queues','skill.json'),'utf8'));
        let entry=saved.entries.find(row=>row.item.approvalId===record.ref.approvalId);
        if(entry&&url.searchParams.get('fixtureCompact')==='1'){
          producerQueue('skill').updateProgress(entry.item.ref,{projected:true});
          entry=JSON.parse(readFileSync(join(DATA_DIR,'decision-queues','skill.json'),'utf8')).entries.find(row=>row.item.approvalId===record.ref.approvalId);
        }
        if(!entry)return json(res,200,{state:'unconfirmed'});
        return json(res,200,await producerQueue('skill').respond(entry.item,{behavior:'allow'},{answerId:entry.answerId??'fixture-replay'}${source.includes('const skillOwnerSettlement = createOwnerSettlementRegistry')?",automaticSettlement('replay')":''}));
      }
      if (!request || !isSkillSwitchAction(request.action)`);
  source = 'let fixtureBoundaryActive=false;\n' + source;
  source = source.replace('function scheduleDecisionLevelChange(botId: string): void {', 'function scheduleDecisionLevelChange(botId: string): void {if(fixtureBoundaryActive)return;');
  source = source.replace('  if (onOwnerBrowser(req.headers)) return browserFreshAuth(req, threadId, requestId, behavior, body);', `  if(req.headers['x-fixture-issuer-mode']==='endpoint-fresh-failed')return {ok:false,status:403,body:{error:'Fixture fresh authentication refused',code:'fresh_auth_failed'}};
  if (onOwnerBrowser(req.headers)) return browserFreshAuth(req, threadId, requestId, behavior, body);`);
  const anchor = '      const input = item.call.input as SwitchInput;';
  const start = source.indexOf('    if (skillReviewMatch) {');
  if (start < 0) throw new Error('private review fixture anchor missing');
  const before = source.slice(0, start), tail = source.slice(start).replace(anchor,anchor+`
      if(url.searchParams.get('fixtureBulkSeed')==='1'){
        const surface=approveAllSurface(req,url);if(!surface.ok)return json(res,surface.status,surface.body);
        const batch=approveAllBatches.create(surface.key,surface.deviceId,[{threadId:record.threadId,requestId:record.action.requestId,digest:approvalDigestSync(record.threadId,record.action.requestId,message!.card!)}]);
        return json(res,200,{batchId:batch.batchId});
      }
  `);
  if(!source.includes('const skillOwnerSettlement = createOwnerSettlementRegistry'))return before+tail.replace(anchor,anchor+`
      if(url.searchParams.get('fixturePosture')==='no-limits'){
        const bot=store.bot(record.botId)!;const levels={autoApprove:true,fullAccess:true,noLimits:true};
        fixtureBoundaryActive=true;try{store.patchBot(bot.id,{...levels,tasks:bot.tasks?.map(task=>({...task,...levels}))});}finally{fixtureBoundaryActive=false;}
      }
      if(url.searchParams.get('fixtureBoundary')==='1'){
        const bot=store.bot(record.botId)!;const levels={autoApprove:true,fullAccess:true,noLimits:true};
        fixtureBoundaryActive=true;
        try{store.patchBot(bot.id,{...levels,tasks:bot.tasks?.map(task=>({...task,...levels}))});}finally{fixtureBoundaryActive=false;}
        const receipt=await producerQueue('skill').respond(item,{behavior:'allow'},{answerId:'fixture-boundary-answer'});
        return json(res,200,receipt);
      }
  `);
  source = before + tail.replace(anchor, anchor + `
      if(url.searchParams.get('fixturePosture')==='no-limits'){
        const bot=store.bot(record.botId)!;const levels={autoApprove:true,fullAccess:true,noLimits:true};
        fixtureBoundaryActive=true;try{store.patchBot(bot.id,{...levels,tasks:bot.tasks?.map(task=>({...task,...levels}))});}finally{fixtureBoundaryActive=false;}
      }
      const fixtureKind=url.searchParams.get('fixtureIssuer');
      if(['preview','bulk','bulk-fallback','level-upgrade'].includes(fixtureKind??'')){
        const current=inspectSkillSwitch(record.botId,input);
        skillOwnerSettlement.issue(item,{kind:fixtureKind as 'preview'|'bulk'|'bulk-fallback'|'level-upgrade',authorized:mayApprove(req,url),affirmative:true,
          freshAuth:'not-required',session:skillOwnerSession(req,url),invocation:req,invocationLive:()=>true,cardLive:()=>true,
          reviewedPreview:input.previewSha256,reviewedVerdict:input.verdictHash,currentPreview:current.previewSha256,currentVerdict:input.verdictHash!});
      }
      if(url.searchParams.get('fixtureBoundary')==='1'){
        const bot=store.bot(record.botId)!;const levels={autoApprove:true,fullAccess:true,noLimits:true};
        fixtureBoundaryActive=true;
        try{store.patchBot(bot.id,{...levels,tasks:bot.tasks?.map(task=>({...task,...levels}))});}
        finally{fixtureBoundaryActive=false;}
        const receipt=await producerQueue('skill').respond(item,{behavior:'allow'},{answerId:'fixture-boundary-answer'},automaticSettlement('level-upgrade'));
        return json(res,200,receipt);
      }
`);
  return source;
}

export function skillSwitchCountFixtureSource(url:string,source:string):string {
  if(url.endsWith('/server/decision/implementation.ts')){
    source="import {fixtureSkillSelection} from '../testing/skill-switch-counts-fixture.mjs';\n"+source;
    const start=source.indexOf('export async function onLevelChange('),end=source.indexOf('\nasync function cancelEntry',start);
    source=source.slice(0,start)+source.slice(start,end)
      .replace('records.openRecords(database())','fixtureSkillSelection(records.openRecords(database()))')
      .replace('records.openBasePage(database(),botId,after)','fixtureSkillSelection(records.openBasePage(database(),botId,after))')+source.slice(end);
  }
  if(url.endsWith('/server/skill-switch-executor.ts')){
    source="import {fixtureSkillPhase} from './testing/skill-switch-counts-fixture.mjs';\n"+source;
    source=source.replace('return (botId: string, input: SwitchInput, delivery?: SkillDeliveryContext): void => {',"return (botId: string, input: SwitchInput, delivery?: SkillDeliveryContext): void => fixtureSkillPhase('final',()=>{")
      .replace('\n  };\n}', '\n  });\n}');
  }
  if(url.endsWith('/server/narrow-denials.ts')){
    source="import {fixtureSkillPhase,fixtureSkillPopulation} from './testing/skill-switch-counts-fixture.mjs';\n"+source;
    source=source.replace('pendingApprovals(): readonly PendingQueueApproval[] {','pendingApprovals(): readonly PendingQueueApproval[] {fixtureSkillPopulation(this.entries.size);');
    source=source.replace('const run=async():Promise<RequestDelivery>=>{',"const run=async():Promise<RequestDelivery>=>fixtureSkillPhase('delivery',async()=>{")
      .replace('    };\n    const dispatch=()=>skillSettlementWork.item(run)', '    });\n    const dispatch=()=>skillSettlementWork.item(run)');
  }
  if(url.endsWith('/server/skills.ts')){
    source="import {fixtureSkillPhase,fixtureSkillEvent} from './testing/skill-switch-counts-fixture.mjs';\n"+source;
    if(source.includes('export function readSkillSwitchTarget(')){
      source=source.replace('export function readSkillSwitchTarget(','function fixtureReadSkillSwitchTarget(')
        .replace('export function applySkillSwitchTarget(','function fixtureApplySkillSwitchTarget(');
      source+=`\nexport function readSkillSwitchTarget(botId:string,name:string){return fixtureSkillPhase('validation',()=>fixtureReadSkillSwitchTarget(botId,name));}
export function applySkillSwitchTarget(target:SkillSwitchTarget,action:'turn_on'|'turn_off'|'delete',options:{acknowledged?:string}={}){return fixtureSkillPhase('primitive',()=>fixtureApplySkillSwitchTarget(target,action,options));}\n`;
    }else{
      source=source.replace('export function listSkills(','function fixtureListSkills(').replace('export function setSkillEnabled(','function fixtureSetSkillEnabled(');
      source+=`\nexport function listSkills(botId:string){return fixtureSkillPhase('validation',()=>{fixtureSkillEvent('list');return fixtureListSkills(botId);});}
export function setSkillEnabled(...args:Parameters<typeof fixtureSetSkillEnabled>){return fixtureSkillPhase('primitive',()=>fixtureSetSkillEnabled(...args));}\n`;
    }
    source=source.replace('export function listSkills(botId: string): SkillListing[] {',"export function listSkills(botId: string): SkillListing[] {fixtureSkillEvent('list');");
  }
  if(url.endsWith('/server/skill-guard/scan.ts')){
    source="import {fixtureSkillEvent} from '../testing/skill-switch-counts-fixture.mjs';\n"+source;
    const anchor='): SkillScan {';
    source=source.replace(anchor,anchor+"fixtureSkillEvent('scan');");
  }
  return source;
}
