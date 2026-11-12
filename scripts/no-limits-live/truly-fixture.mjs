// Only fake engine/native relay setup. No Flux/email/provider calls.
// Scheduler scenarios model an idle host; CI load is not permission evidence.
import '../../server/testing/idle-load-preload.mjs';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
export async function installTrulyFixture({staleTerms=false}={}){
 const dir=process.env.MURAGE_DATA_DIR;if(!dir)throw Error('isolated fixture required');
 const path=join(dir,'config.json'),cfg=JSON.parse(readFileSync(path,'utf8'));
 const state=join(dir,'truly-state');mkdirSync(state,{recursive:true});
 cfg.instances.verification.config.cli=fileURLToPath(new URL('../../server/drivers/testing/workflow-claude.mjs',import.meta.url));
 cfg.instances.verification.environment={S3_STATE_DIR:state,S3_EVENT_LOG:join(dir,'truly-native.ndjson')};
 delete cfg.flux;
 if(staleTerms){
  cfg.noLimitsTermsVersion=0;
  const {Store}=await import('../../server/store.ts');
  const store=new Store(()=>({instanceId:'verification',model:'sonnet'}));
  const bot=store.createBot({name:'Stale terms fixture'},{seedMessages:false});
  store.patchBot(bot.id,{autoApprove:true,fullAccess:true,noLimits:true,permissionExplicit:true,noLimitsAcknowledgedAt:1,fullAccessAcknowledgedAt:1,cwd:dir,autoReview:'off'});
  writeFileSync(join(dir,'truly-stale-bot.json'),JSON.stringify(store.bot(bot.id)));
 }
 if(!staleTerms){
  // Persist a pre-inheritance owner's thread before the real server boots.
  const {Store}=await import('../../server/store.ts');
  const store=new Store(()=>({instanceId:'verification',model:'sonnet'}));
  const bot=store.createBot({name:'Old owner default fixture'},{seedMessages:false});
  store.createTask(bot.id,'Second default fixture',false);
  store.patchBot(bot.id,{autoApprove:true,fullAccess:true,noLimits:true,permissionExplicit:true,noLimitsAcknowledgedAt:1,fullAccessAcknowledgedAt:1,cwd:dir,autoReview:'off'},{preserveTaskSettings:true});
  writeFileSync(join(dir,'truly-old-owner-bot.json'),JSON.stringify(store.bot(bot.id)));
 }
 writeFileSync(path,JSON.stringify(cfg));
 // A fake channel receipt enters the real scheduler with a verified fixture
 // principal. Only the transport is fake; levels, dispatch and decisions are real.
 const {RoutineManager}=await import('../../server/routines.ts');
 const {observeVerifiedHuman,linkHumanBinding,resolveHumanBinding}=await import('../../server/human-principals.ts');
 const {ownerMemoryTicket}=await import('../../server/memory/authority.ts');
 const principal=as=>{const binding=observeVerifiedHuman({platform:'telegram',authorityId:'truly',connectionId:'truly-channel',userId:as});linkHumanBinding(ownerMemoryTicket(),{bindingId:binding,expectedRevision:1,as:as==='owner'?'owner':'person'});return resolveHumanBinding(binding);};
 const owner=principal('owner'),guest=principal('guest'),enqueue=RoutineManager.prototype.enqueueWebhook;
 RoutineManager.prototype.enqueueWebhook=function(input){
  if(input.webhookName.startsWith('truly-R3-guest'))input={...input,telegramConnectionId:'truly-channel',humanPrincipal:guest};
  else if(input.webhookName.startsWith('truly-R3-channel'))input={...input,telegramConnectionId:'truly-channel',humanPrincipal:owner};
  return enqueue.call(this,input);
 };
 const original=globalThis.fetch;
 globalThis.fetch=async(input,init)=>{const url=new URL(String(input instanceof Request?input.url:input));if(url.hostname!=='127.0.0.1'&&url.hostname!=='localhost')throw Error('external network refused by fake fixture');return original(input,init);};
}
