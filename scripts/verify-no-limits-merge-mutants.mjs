// SPDX-License-Identifier: AGPL-3.0-or-later
// Run only in the network-disabled test container. Mutations touch a fresh
// temporary source copy, never the checkout or a running Murage installation.
import {cpSync,existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {safeWipeSync} from '../server/testing/safe-wipe.mjs';

if(process.env.CI!=='1')throw Error('Use the isolated test container');
const source=process.cwd(),out=resolve(process.argv[2]??'evidence/nolim-merge/mutants');
mkdirSync(out,{recursive:true});
const root=mkdtempSync(join(tmpdir(),'nolim-merge-mutants-'));
const skip=/^(?:node_modules|\.git|\.nolim|evidence$|dist|build$|\.cache$)/;
for(const entry of readdirSync(source))if(!skip.test(entry))cpSync(join(source,entry),join(root,entry),{recursive:true});
symlinkSync(join(source,'node_modules'),join(root,'node_modules'),'dir');
const core='server/decision/no-limits-merge-rulings.test.ts';
const ui='src/components/NoLimitsFollowers.test.ts';
const outside='server/no-limits-outside-store-api.test.ts';
const upgrade='server/no-limits-upgrade-api.test.ts';
function run(id,files,pattern){
 const json=join(out,`${id}.json`),log=join(out,`${id}.log`);
 const args=['node_modules/vitest/vitest.mjs','run',...files,'--maxWorkers=1','--reporter=default','--reporter=json',`--outputFile=${json}`,...(pattern?['-t',pattern]:[])];
 const result=spawnSync(process.execPath,args,{cwd:root,env:process.env,encoding:'utf8',maxBuffer:64*1024*1024,timeout:180000});
 writeFileSync(log,`${result.stdout??''}${result.stderr??''}`);
 const report=existsSync(json)?JSON.parse(readFileSync(json,'utf8')):undefined;
 const failures=report?.testResults.flatMap(file=>file.assertionResults.filter(test=>test.status==='failed').map(test=>test.fullName))??[];
 return {code:result.status,failures,log,json};
}
function assertSemanticMutation(id,file,original,changed){
 if(changed===original)throw Error(`Mutation anchor missing: ${id}`);
 if(file.endsWith('.json')&&isDeepStrictEqual(JSON.parse(original),JSON.parse(changed)))throw Error(`Semantic mutation missing: ${id}`);
}
const specs=[
 ['H6-git-dry-run','server/no-limits-wipe.ts',s=>s.replace("if(nonmutating)continue;",''),[core],'H6 Git push dry runs'],
 ['C1-antigravity-narrow','server/drivers/antigravity.ts',s=>s.replace('decision.updatedInput && !current.noLimits()','decision.updatedInput'),['server/drivers/no-limits-provider-release-1019.test.ts'],'non-wipe updated input'],
 ['H6-full-reader','server/decision/action.ts',s=>s.replace(' const dispatched=dispatchedCall(effective,payload);',' deletes.push(...connectorWipes(effective,payload));\n const dispatched=dispatchedCall(effective,payload);'),['server/no-limits-legacy-readers.test.ts'],'describe and describeAction'],
 ['H6-ruby-wipe','server/no-limits-wipe.ts',s=>s.replace("if(command.program==='ruby'){const literal=","if(false){const literal="),[core],'H6 a visible Ruby'],
 ['H8-native-wipe','src/locales/en.json',s=>{const pack=JSON.parse(s);pack['noLimits.v1.engineAsks']=pack['noLimits.v1.engineAsks'].replace('except for a likely wipe or catastrophe','including a likely wipe or catastrophe');return JSON.stringify(pack);},['src/components/PermissionModeMenu.test.ts'],'H8 No limits explains'],
 ['H8-fr-address','src/locales/fr.json',s=>{const pack=JSON.parse(s);pack['noLimits.v1.warning']=pack['noLimits.v1.warning'].replace('Tes bots','Vos bots');return JSON.stringify(pack);},['src/locales/locale-copy.test.ts'],'fr uses informal address only'],
 ['H8-hi-protected','src/locales/hi.json',s=>{const pack=JSON.parse(s);pack['noLimits.v1.warning']=pack['noLimits.v1.warning'].replace('संरक्षित फ़ाइलें','सुरक्षित फ़ाइलें');return JSON.stringify(pack);},['src/locales/locale-copy.test.ts'],'hi has no "safe" wording'],
 ['H8-native-menu','src/components/PermissionModeMenu.tsx',s=>s.replace('entry.mode === "unlimited" ? t("noLimits.v1.engineAsks", { engine: cannotAskEngine }) : cannotAskNote(cannotAskEngine)','cannotAskNote(cannotAskEngine)'),['src/components/PermissionModeMenu.test.ts'],'H8 No limits explains'],
 ['H8-entry-points','src/locales/en-ux/l1.json',s=>{const pack=JSON.parse(s);pack['ux.l1.level.unlimitedDetail']='No limits still asks before protected writes.';return JSON.stringify(pack);},['src/locales/nolimits-v1-copy.test.ts'],'H8 all No limits entry points'],
 ['H6-C3-absolute-files','scripts/release-gate/gate-1019.mjs',s=>s.replace("'server/nolimits-means-it.test.ts', ",''),['scripts/no-limits-live/ruling-1019.test.mjs'],'formerly red mandatory'],
 ['N1-native-fallback','server/drivers/antigravity.ts',s=>s.replace('const skipPermissions = noLimits() || unmanagedPermissions;', 'const skipPermissions = unmanagedPermissions;'),['server/drivers/antigravity-auto.test.ts'],'runs after setup'],
 ['N5-native-state','server/drivers/acp/fuigo-no-limits.ts',s=>s.replace('if(!pathExists(join(realHome,name)))mkdirSync','if(true)mkdirSync'),['server/drivers/acp/fuigo-policy.test.ts'],'N5 No limits resumes'],
 ['H3-resolved-home','server/no-limits-word-paths.ts',s=>s.replace("ctx.bound.get(part.name)\n      ?", "false\n      ?"),[core],'literal home assignment'],
 ['H5-own-recovery','server/index.ts',s=>s.replace('if(policy?.permission.noLimits)return {bot:settings?', 'if(false)return {bot:settings?'),['server/service-no-limits-routes-api.test.ts'],'H5 own tools'],
 ['H5-browser-never','server/browser-extension-service.ts',s=>{const start=s.indexOf('    if(serviceOwnerNoLimits(options.authorityFor?.(entry.context))) {');const end=s.indexOf('    const ownerRead = ownerReadTurn(entry, scope);',start);const branch=s.slice(start,end);s=s.slice(0,start)+s.slice(end);const at=s.indexOf('    // EXT-RESTART 4.1 (ruling 3');return s.slice(0,at)+branch+s.slice(at);},['server/browser-extension-service.test.ts'],'H5 No limits uses central'],
 ['C3-runner-ruling','scripts/no-limits-live/scenarios.mjs',s=>s.replace("row('deny-script', 'owner', 'unlimited', 'RUN')","row('deny-script', 'owner', 'unlimited', 'CARD')"),['scripts/no-limits-live/ruling-1019.test.mjs'],'deny-script runs'],
 ['C1-Stop','server/decision/implementation.ts',s=>s.replace('if(e?.cancelled)return false;','if(false)return false;'),[core],'explicit Stop'],
 ['H5-email-runtime','server/email/runtime.ts',s=>s.replace('authorityFor:this.options.authorityFor','authorityFor:undefined'),['server/email/queue-identity.test.ts'],'registered owner-turn authority'],
 ['H6-email-queue','server/email/send-service.ts',s=>s.replace('type ProducerApprovalQueue,','ProducerApprovalQueue,').replace("this.approvals=serviceQueue('email');","this.approvals=new ProducerApprovalQueue('email');"),['server/email/queue-identity.test.ts'],'startup reuses'],
 ['H6-image-turn','server/image-operations.ts',s=>s.replace('...(actor.turnId?{turnId:actor.turnId}:{})','...{}'),['server/image-operations.test.ts'],'name the producing turn'],
 ['H6-image-revoked','server/image-operations.ts',s=>s.replace('this.approvalActors.get(requestId)?.assertActive();','void 0;'),['server/image-operations.test.ts'],'rechecks actor revocation when the owner answers'],
 ['C1','server/decision/implementation.ts',s=>s.replace(/const wipeOnly=ownerEligible\(authority\(e.threadId,e.authority.botId,e.authority.generation\)\);/,'const wipeOnly=false;'),[core],'^C1 '],
 ['C2','server/store.ts',s=>s.replace('const guestLevel = explicitNoLimits(bot)?bot:{autoApprove:false,fullAccess:false,noLimits:false};','const guestLevel = bot;'),[core],'^C2 legacy'],
 ['C2-predicate','server/no-limits-origin.ts',s=>s.replace('if (guest) return explicitNoLimits(bot);','if (guest) return bot.noLimits===true;'),[core],'^C2 legacy'],
 ['H1-snapshot','server/decision/implementation.ts',s=>s.replace('if(!ownerEligible(a)&&(!snapshot','if((!snapshot'),[core],'^H1 an owner-only'],
 ['H1-phone','server/decision/implementation.ts',s=>s.replace("const recovered=!live||!p||p.initiator.k==='other-human'?","const recovered=!live||!p?"),[core],'^H1 queued phone'],
 ['H2','server/decision/implementation.ts',s=>s.replace('if(recovered&&(!botId','if(false&&recovered&&(!botId'),[core],'^H2 '],
 ['H3','server/no-limits-wipe.ts',s=>s.replace('if(evaluated?.text&&evaluated.text!==text)',"if(evaluated?.unresolved)return {rule:'disk-erase',what:'Unresolved eval'};\n   if(evaluated?.text&&evaluated.text!==text)"),[core],'^H3 '],
 ['H5','server/service-no-limits.ts',s=>s.replace(/if\(facts.origin==='unproven'\)return [^;]+;/,"if(facts.origin==='unproven')return false;"),[core],'^H5 '],
 ['M1','server/index.ts',s=>s.replace(/(function continueWithoutOutsideStore\([\s\S]*?)return true;/,'$1return false;'),[outside]],
 ['H7-M3','src/components/NoLimitsFollowers.tsx',s=>s.replace('const open=upgrade&&!seen&&status?.enabled===true;','const open=false;'),[ui],'H7 H8 M3'],
 ['H7-chats','server/index.ts',s=>s.replace(')),...chatLower]', '))]'),[upgrade]],
 ['H8','src/locales/en.json',s=>{const pack=JSON.parse(s);pack['noLimits.v1.warning']='Murage still asks before changing protected files.';return JSON.stringify(pack);},[ui],'H7 H8 M3'],
];
const evidenceFiles=[...new Set([core,outside,upgrade,ui,...specs.flatMap(spec=>[spec[1],...spec[3]])])].sort();
const sourceFiles=Object.fromEntries(evidenceFiles.map(file=>[file,createHash('sha256').update(readFileSync(join(source,file))).digest('hex')]));
const proof={sourceFiles,generatedAt:new Date().toISOString(),baseline:null,mutants:[],restored:null,verdict:'FAIL'};
try{
 proof.baseline=run('baseline',[core,outside,upgrade,ui]);
 if(proof.baseline.code!==0)throw Error('Baseline must be GREEN');
 for(const [id,file,mutate,files,pattern]of specs.filter(spec=>!process.env.MERGE_MUTANTS_ONLY||spec[0].match(process.env.MERGE_MUTANTS_ONLY))){
  const path=join(root,file),original=readFileSync(path,'utf8'),changed=mutate(original);
  assertSemanticMutation(id,file,original,changed);
  let red;
  try{writeFileSync(path,changed);red=run(`${id}-red`,files,pattern);}finally{writeFileSync(path,original);}
  const restored=run(`${id}-restored`,files,pattern);
  const killed=red.code===1&&red.failures.length>0&&restored.code===0;
  proof.mutants.push({id,killed,red,restored});
  writeFileSync(join(out,'proof.json'),JSON.stringify(proof,null,2));
  process.stdout.write(`${id}: ${killed?'KILLED, restored GREEN':'INVALID PROOF'}\n`);
  if(!killed)throw Error(`Mutant did not produce an assertion RED: ${id}`);
 }
 proof.restored=run('all-restored',[core,outside,upgrade,ui]);
 if(proof.restored.code!==0)throw Error('Restored suite must be GREEN');
 proof.verdict='PASS';
}finally{
 writeFileSync(join(out,'proof.json'),JSON.stringify(proof,null,2));
 safeWipeSync(root,{reason:'isolated No limits merge mutation fixture'});
}
