// Mutation/test owner: skills lane. Producer receipt and decision scheduler owner: decision lane.
// Run only inside the lane container. Evidence must be outside the checkout.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join,relative} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const gate='server/skill-switch-executor.ts',tokens='server/skill-switch-settlement.ts',queue='server/narrow-denials.ts';
const snapshot='server/skill-switch.ts',bounds='server/skill-switch-bounds.ts',skills='server/skills.ts',decision='server/decision/implementation.ts';
const unit='server/skill-switch-settlement.test.ts',api='server/skill-switch-api.test.ts',counts='server/skill-switch-bounds.test.ts';
const replace=(file,from,to)=>(files)=>{const text=files.get(file)??readFileSync(file,'utf8');if(!text.includes(from))throw Error(`missing mutation anchor in ${file}`);files.set(file,text.replace(from,to));};
const many=(...patches)=>files=>patches.forEach(p=>p(files));
const catalog=[];
const add=(id,test,pattern,patch,note)=>catalog.push({id,test,pattern,patch,note});
const ownerLine="const owner = settlement.kind === 'owner' && proof.validate(settlement.token, delivery.item) && policy.owner(delivery.item);";
const consume="if (settlement.kind !== 'owner' || !policy.owner(delivery.item) || !proof.consume(settlement.token, delivery.item))";
add('M01',api,'registered acceptor boundary',many(replace(gate,ownerLine,'const owner = true;'),replace(gate,consume,'if (false)')),'Cohesive absence-as-owner regression; must enable and acknowledge at the real registered boundary.');
add('M02',unit,'owner_tag_or_cast',replace(tokens,"const b = token && typeof token === 'object' ? registry.get(token) : undefined;","if(token&&typeof token==='object'&&!registry.has(token))return {item:itemBinding(item),context:{session:{principal:'owner'}} as never,behavior:'allow',used:false};\n    const b = token && typeof token === 'object' ? registry.get(token) : undefined;"));
for(const field of ['approvalId','ref','epoch','action','input','bot']){
  add(`M03-${field}`,unit,`token_is_bound.*${field}`,files=>{
    let source=readFileSync(tokens,'utf8');const start=source.indexOf('const itemBinding ='),end=source.indexOf('\n\n/** A server',start);
    if(start<0||end<0)throw Error('missing binding seam');
    const omit=field==='action'?"delete copy.call.input.action;":field==='input'?"delete copy.call.input.skillSha256;":field==='bot'?"delete copy.call.input.botId;":`delete copy.${field};`;
    files.set(tokens,source.slice(0,start)+`const itemBinding=(item:PendingQueueApproval):string=>{const copy=JSON.parse(JSON.stringify(item));${omit}return createHash('sha256').update(JSON.stringify(copy)).digest('hex');};`+source.slice(end));
  });
}
add('M04',unit,'owner_session_revoked',replace(tokens,'eligible(b.context) ? b : undefined','eligible({...b.context,session:b.context.session?{...b.context.session,live:()=>true}:undefined}) ? b : undefined'));
add('M04-cloud', 'server/decision-wiring/actor-wiring.test.ts','cloud owner settlement remains bound',replace('server/index.ts','&&device.id===current.id',''));
add('M05',unit,'owner_allow_after_verdict_flip',replace(snapshot,' || skillVerdictHash(listing.scan) !== input.verdictHash',''));
add('M06',unit,'recovery_open_and_pending_review',many(replace(gate,ownerLine,ownerLine.slice(0,-1)+" || settlement.kind==='automatic'&&settlement.cause==='recovery';"),replace(gate,consume,"if (settlement.kind==='owner' && (!policy.owner(delivery.item) || !proof.consume(settlement.token, delivery.item)))")));
add('M07',unit,'expired owner invocation',many(replace(tokens,'eligible(b.context) ? b : undefined','eligible({...b.context,invocationLive:()=>true}) ? b : undefined'),replace(tokens,'registry.delete(token);','void token;')));
add('M08-flight',unit,'replay_is_automatic_and_receipt_is_idempotent$',replace(queue,'const flying=this.flights.get(item.ref);if(flying)return flying;',''));
add('M08-receipt',unit,'receipt_lookup_short_circuits_skill_work$',replace(queue,"    if (entry.state === 'accepted') return", "    if(entry.state==='accepted')entry.state='waiting';\n    if (entry.state === 'accepted') return"));
add('M09',unit,'automatic_review_guard_covers_every_action',replace(gate,"if (!owner && (target.listing.scan?.verdict === 'review' || input.action === 'turn_on' && target.listing.scan?.verdict !== 'clean'))","if (false)"));
add('M10',unit,'execution_rechecks_after_preflight',many(replace(skills,'const switchTargets = new WeakMap',"const unsafeSwitchTargets=new Map<string,SkillSwitchTarget>();\nconst switchTargets = new WeakMap"),replace(skills,'  if (!isSkillName(name)) return;\n  const path=manifestPath(botId);',"  if(unsafeSwitchTargets.has(botId+name))return unsafeSwitchTargets.get(botId+name);\n  if (!isSkillName(name)) return;\n  const path=manifestPath(botId);"),replace(skills,'switchTargets.set(target,{botId,name,manifest,entry,directory,manifestText});return target;','switchTargets.set(target,{botId,name,manifest,entry,directory,manifestText});unsafeSwitchTargets.set(botId+name,target);return target;')));
for(const [field,from] of [['skillSha256',' || listing.sha256 !== input.skillSha256'],['scanContentHash','listing.scan.contentHash !== input.scanContentHash || '],['enabledBefore',' || listing.enabled !== input.enabledBefore'],['source','listing.source !== input.source || '],['shared',"/^(collection|library):/.test(listing.source) !== input.shared"]]){
  add(`M11-${field}`,unit,`all_snapshot_fields.*${field}`,replace(snapshot,from,field==='shared'?'false':''));
}
add('M11-previewSha256',unit,'all_snapshot_fields.*previewSha256',replace(gate,'if (previewHash !== input.previewSha256)','if (false)'));
add('M12',unit,'missing_proof_is_not_permission',replace(gate,"policy.automatic(delivery.item, settlement.kind === 'automatic' ? settlement.cause : 'unspecified')","true"));
add('M12-protected',api,'automatic_cannot_bypass_protected',replace('server/index.ts',"||record.why==='deny'||record.why==='wipe'",''));
add('M13',unit,'acknowledgement_only_from_valid_owner_token',replace(gate,"owner && input.action === 'turn_on' ? {acknowledged:target.listing.scan!.contentHash} : {}","input.action === 'turn_on' ? {acknowledged:input.acknowledged??target.listing.scan!.contentHash} : {}"));
add('M13-off-delete',unit,'acknowledgement_only_from_valid_owner_token owner',replace(gate,"owner && input.action === 'turn_on' ? {acknowledged:target.listing.scan!.contentHash} : {}","owner ? {acknowledged:target.listing.scan!.contentHash} : {}"));
add('M14',unit,'blocked_or_unknown.*primitive boundary',replace(skills,"    if(entry.scan?.verdict==='blocked')throw new Error(BLOCKED_MESSAGE);",''));
add('M15',api,'no_limits_review_is_status_not_card',many(replace('server/index.ts','if(attended&&needsReview&&noLimitsAppliesTo(origin,peerContactSettings(from.id,fromThreadId)))','if(false)'),replace('server/index.ts','withSkillSwitchAuthority(internalClaim, attended,','withSkillSwitchAuthority(internalClaim, attended && !needsReview,')));
add('M15-origin',api,'owner_racing_no_limits_cannot_use_missing_origin',replace(tokens,'attended===false','attended!==true'));
add('M16',unit,'domain_refusal_never_becomes_allowed',many(replace(queue,"state:uncertain ? 'unconfirmed' as const : 'not-run' as const,result,code","state:uncertain ? 'unconfirmed' as const : 'accepted' as const,result,code"),replace(queue,"return {state:uncertain ? 'unconfirmed' : 'not-run',message:result,code};","return {state:uncertain ? 'unconfirmed' : 'accepted',message:result,code};")));
add('M17',api,'setup_waits_no_limits_runs_now',replace('server/setup-at-settle.ts','    const entry = { ...input, origin: row.origin };',"    row.settled=true;void hooks.apply();return true;\n    const entry = { ...input, origin: row.origin };"));
add('M18',unit,'legacy_snapshot_is_not_backfilled',many(replace(gate,'checkSkillSwitchSnapshot, type SwitchInput','checkSkillSwitchSnapshot, skillVerdictHash, type SwitchInput'),replace(gate,'    const target = inspectSkillSwitch(botId, input);',"    if(!input.verdictHash){const current=readSkillSwitchTarget(botId,input.name)!;input={...input,schema:1,previewSha256:current.previewSha256,verdictHash:skillVerdictHash(current.listing.scan),source:current.listing.source,shared:/^(collection|library):/.test(current.listing.source),scanContentHash:current.listing.scan!.contentHash};}\n    const target = inspectSkillSwitch(botId, input);")));
add('M19',unit,'C01.*durable_before_effect$',replace(queue,"      this.replace({...entry,state:'effect-started',authorization:copy(authorization)});","      void authorization;"));
add('M20',unit,'C01.*barrier failure',replace(queue,"      this.replace({...entry,state:'effect-started',authorization:copy(authorization)});","      try{this.replace({...entry,state:'effect-started',authorization:copy(authorization)});}catch{}"));
add('M21',unit,'C02',replace(queue,"    if (entry.state === 'effect-started' || entry.state === 'unconfirmed'", "    if(entry.state==='effect-started')entry.state='pending-before-effect';\n    if (entry.state === 'effect-started' || entry.state === 'unconfirmed'"));
add('M22',unit,'C03',replace(queue,"state:uncertain ? 'unconfirmed' as const : 'not-run' as const,result,code","state:uncertain ? 'pending-before-effect' as const : 'not-run' as const,result,code"));
add('M23',unit,'C04.*real decision projection',replace(decision,"if(item?.call.tool==='switch_skill'){const receipt=q?.receipt?.(item);",`if(item?.call.tool==='switch_skill'){const receipt=q?.receipt?.(item);
  if(receipt?.state==='already'&&row.delivery==='pending'){
    const accept=(q as unknown as {toolAccepts:Map<string,(...args:any[])=>unknown>}).toolAccepts.get(item.call.tool);
    if(accept)try{await accept(item,answer,{item,settlement,beginEffect:()=>{throw new Error('effect already committed');}});}catch{}
  }
`),'Projection-trust regression calls the real registered acceptor despite an authoritative accepted receipt; the effect fence stays intact.');
add('M24-renewal',unit,'C05.*renewal_compaction_and_legacy$',replace(queue,"if (item.call.tool === 'switch_skill' || entry!.state==='accepted'", "if (entry!.state==='accepted'"));
add('M24-tombstone',unit,'C05.*past 1024',replace(queue,'const entries = [...terminal, ...waiting, ...protectedEntries.filter(terminalEntry)];','const entries = [...terminal, ...waiting];'));
add('M24-legacy',unit,'C05.*legacy (pending|failed)',replace(queue,"    if (entry.state === 'effect-started' || entry.state === 'unconfirmed'", "    if(entry.version!==2&&['pending','failed'].includes(entry.state)){entry.version=2;entry.state='pending-before-effect';}\n    if (entry.state === 'effect-started' || entry.state === 'unconfirmed'"));
for(const [id,kind,test] of [['M25','preview','I01'],['M26-bulk','bulk','I02'],['M26-fallback','bulk-fallback','I02'],['M27','level-upgrade','I03']])add(id,api,test,replace(tokens,"c.kind === 'single-card'",`(c.kind === 'single-card'||c.kind === '${kind}')`));
add('M28',api,'I04',replace(tokens,'&& !!c.session && c.session.live()','&& true'));
add('M29',api,'I05',replace(tokens,"(c.freshAuth === 'satisfied' || c.freshAuth === 'not-required')",'true'));
add('M30-listing',counts,'B01',replace(skills,'  const path=manifestPath(botId);',"  listSkills(botId).find(skill=>skill.name===name);\n  const path=manifestPath(botId);"));
add('M30-descendant',counts,'B01',replace(skills,'  const {botId,name,entry}=state;','  const {botId,name,entry}=state;syncSkillLinks(botId);'));
add('M30-delete',counts,'B01.*delete',replace(skills,"  if(action!=='delete')return;","  if(action!=='delete')return;removeReviewedRevisionsNamed(state.botId,state.name);"));
add('M31-content',counts,'B02',files=>{
  let source=readFileSync(bounds,'utf8').replace('openSync, readSync','openSync, readFileSync, readSync');
  const start=source.indexOf('    const bytes = Buffer.alloc'),end=source.indexOf('    const after = fstatSync(fd);',start);
  if(start<0||end<0)throw Error('missing bounded read seam');
  files.set(bounds,source.slice(0,start)+'    const bytes=Buffer.from(readFileSync(fd));let length=bytes.length;\n'+source.slice(end));
});
add('M31-metadata',counts,'B02',many(replace(bounds,'openSync, readSync','openSync, readFileSync, readSync'),replace(bounds,'JSON.parse(readSwitchFile(path, SWITCH_LIMITS.metadata))',"JSON.parse(readFileSync(path,'utf8'))")));
add('M31-findings',counts,'B02',replace(snapshot,'if (scan.findings.length > SWITCH_LIMITS.findings) throw new SkillSwitchLimit();','if (scan.findings.length > SWITCH_LIMITS.findings) scan.findings=scan.findings.slice(0,SWITCH_LIMITS.findings);'));
add('M31-utf8',counts,'B02.*invalid UTF-8',replace(bounds,"new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length))","bytes.subarray(0, length).toString('utf8')"));
add('M32-repeat',counts,'B01',replace(skills,'  const {botId,name,entry}=state;',"  const {botId,name,entry}=state;scanSkill({name,description:entry.description,triggerTerms:[],files:[{path:'SKILL.md',content:target.text}]});"));
add('M32-budget',counts,'B03.*share_budget$',replace(skills,
  "if(!entry.scan||entry.scan.scannerVersion!==SKILL_SCANNER_VERSION||entry.scan.contentHash!==skillContentHash(input))\n    throw new Error('The skill check needs refreshing in Skills. Nothing was changed.');",
  "if(!entry.scan||entry.scan.scannerVersion!==SKILL_SCANNER_VERSION||entry.scan.contentHash!==skillContentHash(input)){entry.scan=scanSkill(input);writeManifest(botId,manifest);}"),
  'Restore an unbudgeted scanner refresh through the actual zero-scan settlement boundary.');
add('M32-delete',counts,'B03.*deletion plan cap',replace(skills,'||plan.length>=SWITCH_LIMITS.deleteFiles',''));
add('M33-selection',counts,'B04',replace(decision," if(!q.pendingPage){for(const item of q.pendingApprovals())yield item;return;}"," for(const item of q.pendingApprovals())yield item;return;"));
add('M33-yield',counts,'B04',replace(decision,'const settlementYield=()=>new Promise<void>(resolve=>setImmediate(resolve));','const settlementYield=()=>Promise.resolve();'));
add('M33-global',counts,'shared tick budgets.*concurrent',replace('server/skill-settlement-work.ts','drain: <T>(work: () => T | Promise<T>) => lane.drain(work),','drain: <T>(work: () => T | Promise<T>) => Promise.resolve().then(work),'));
add('M33-proof',api,'B04 real HTTP',replace('server/index.ts','for(const port of decisionQueuePorts.values())if(!port.hasPendingProof||port.hasPendingProof(rawProof))return;',"for(const port of decisionQueuePorts.values())if(port.pendingApprovals().some(other=>JSON.stringify(other.proof)===JSON.stringify(rawProof)))return;"));
add('M33-retirement',api,'B04 real HTTP',replace('server/index.ts','const waiting = [...decisionQueuePorts.values()].some(port => !port.hasPendingProof || port.hasPendingProof(proof));','const waiting = [...decisionQueuePorts.values()].some(port => port.pendingApprovals().some(item => JSON.stringify(item.proof) === JSON.stringify(proof)));'));
add('M33-offset',counts,'B04',files=>{
  let source=readFileSync(queue,'utf8');const start=source.indexOf('    let lo=0,hi=this.pendingKeys.length;'),end=source.indexOf('\n  }\n  private commit',start);
  if(start<0||end<0)throw Error('missing keyset page seam');
  files.set(queue,source.slice(0,start)+`    const lo=Number(after)||0,keys=this.pendingKeys.slice(lo,lo+limit+1);return {items:keys.slice(0,limit).map(key=>frozen(copy(this.entries.get(key)!.item))),...(keys.length>limit?{next:String(lo+limit)}:{})};`+source.slice(end));
});
add('M34-late',unit,'B05.*work$',replace(queue,'    const receipt=this.receipt(item);if(receipt)return Promise.resolve(receipt);',`    const receipt=this.receipt(item);
    if(receipt?.state==='already'){const accept=this.toolAccepts.get(item.call.tool);if(accept)return Promise.resolve().then(()=>accept(item,answer,this.switchContext(item,settlement))).catch(()=>{}).then(()=>receipt);}
    if(receipt)return Promise.resolve(receipt);`));
add('M34-writes',unit,'B05.*work$',replace(queue,"    if (entry.state === 'accepted') return", "    if(entry.state==='accepted')this.replace({...entry});\n    if (entry.state === 'accepted') return"));
add('M34-lookup',unit,'B05.*work$',replace(queue,'    const entry = this.entries.get(item.ref);\n    if (!entry || !same(entry.item,item))', '    const entry = [...this.entries.values()].find(entry=>entry.item.ref===item.ref);\n    if (!entry || !same(entry.item,item))'));

if(process.argv.includes('--list')){console.log(JSON.stringify(catalog.map(({id,test,pattern,note})=>({id,test,pattern,note})),null,2));process.exit(0);}
const evidence=resolve(process.env.MURAGE_EVIDENCE_DIR??'');
if(!process.env.MURAGE_EVIDENCE_DIR||!relative(process.cwd(),evidence).startsWith('..'))throw Error('MURAGE_EVIDENCE_DIR must be outside the checkout');
mkdirSync(evidence,{recursive:true});
const selected=(process.env.SKILL_MUTANTS??'').split(',').filter(Boolean);
const results=[];
for(const mutant of catalog.filter(m=>!selected.length||selected.includes(m.id))){
  const edits=new Map(),backup=new Map();let result={id:mutant.id,status:'open',note:mutant.note};
  try{
    mutant.patch(edits);
    for(const [path,source]of edits){backup.set(path,readFileSync(path,'utf8'));writeFileSync(path,source);}
    const report=join(evidence,`${mutant.id}.json`),log=join(evidence,`${mutant.id}.log`);
    const run=spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run',mutant.test,'--maxWorkers=1','--testNamePattern='+mutant.pattern,'--reporter=default','--reporter=json','--outputFile='+report],{encoding:'utf8',timeout:240_000,maxBuffer:32*1024*1024,env:process.env});
    const output=(run.stdout??'')+(run.stderr??'');writeFileSync(log,output);
    let parsed;try{parsed=JSON.parse(readFileSync(report,'utf8'));}catch{}
    const failed=parsed?.testResults?.flatMap(s=>s.assertionResults??[]).filter(t=>t.status==='failed')??[];
    result={...result,status:run.status!==0&&failed.length?'killed':run.status===0?'survived':'invalid',exit:run.status,failed:failed.map(t=>({name:t.fullName,messages:t.failureMessages})),sourceHash:createHash('sha256').update([...edits].map(([p,s])=>p+s).join('\n')).digest('hex')};
    if(mutant.id==='M01'){
      const match=/M01_BOUNDARY (\{[^\n]+\})/.exec(output);let observed;try{observed=JSON.parse(match?.[1]??'');}catch{}
      result.observed=observed;
      if(!observed?.enabled||observed.primitiveCalls!==1||!observed.acknowledged||observed.acknowledged!==observed.scanHash)result.status='invalid';
    }
    if(mutant.id==='M32-budget'){
      const match=/SCANNER_BUDGET (\{[^\n]+\})/.exec(output);let observed;try{observed=JSON.parse(match?.[1]??'');}catch{}
      result.observed=observed;if(observed?.limit!==0||!(observed.scans>0))result.status='invalid';
    }
    if(mutant.note?.startsWith('OPEN:'))result.status='open';
  }catch(error){result={...result,status:'invalid',error:String(error)};}
  finally{for(const [path,source]of backup)writeFileSync(path,source);}
  results.push(result);writeFileSync(join(evidence,'mutants.json'),JSON.stringify(results,null,2));
  console.log(JSON.stringify({id:result.id,status:result.status,failed:result.failed?.length,error:result.error}));
}
process.exitCode=results.every(r=>r.status==='killed')?0:1;
