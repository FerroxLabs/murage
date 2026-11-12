import {availability} from './replay-decide.mjs';
// Policy + final release replay. Called only inside run.mjs's fresh HOME/data
// child. Tool arguments are DATA: neither a shell nor a provider is launched.
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {readFileSync,writeFileSync} from 'node:fs';
import {storedRuleLabel,matchingSavedRule} from './saved-rule.mjs';
export async function productionAdapter({ dataDir, home, platform }) {
  if (resolve(process.env.MURAGE_DATA_DIR ?? '.') !== resolve(dataDir) || resolve(process.env.HOME ?? '.') !== resolve(home)) throw Error('Isolated replay environment required before importing product');
  const d = await import('../../server/decision/index.ts');
  const { openReplayRequest } = await import('../../server/testing/replay-source.ts');
  const { guardEngineRelease } = await import('../../server/decision/provider-release.ts');
  const { Store } = await import('../../server/store.ts');
  const { closeDatabase } = await import('../../server/database.ts');
  const { autoVerdict } = await import('../../server/auto-approve.ts');
  const store = new Store();
  const {builtInBrowserEnabled,loadConfig}=await import('../../server/config.ts');
  const {autoHostDeclined}=await import('../../server/host-computer-consent.ts');
  return {
    async decide(row) {
      if(availability(row).status!=='available')throw Error('UNPROVEN recorded denial context or input');
      const saved=storedRuleLabel(row.label)?matchingSavedRule(row):undefined;
      let bot = store.createBot({ name:'Replay fixture' }, { seedMessages:false });
      const level = row.level ?? 'unlimited';
      const flags = { autoApprove:level !== 'ask', fullAccess:['full','unlimited'].includes(level), noLimits:level === 'unlimited' };
      store.patchBot(bot.id, { ...flags, permissionExplicit:true, cwd:home });
      bot=store.bot(bot.id);
      // Install the setting before any permission request is admitted. These
      // are the same predicates/flags the production mounts read, with an inert
      // replay transport. Lines here describe replay disposition, not product UI.
      if(row.label.kind==='feature-off') {
        const feature=row.label.feature;
        if(feature==='browser') {
          const path=join(dataDir,'config.json'),cfg=JSON.parse(readFileSync(path,'utf8'));
          cfg.features={...cfg.features,browser:false};writeFileSync(path,JSON.stringify(cfg));
        } else if(feature==='host-computer')store.patchBot(bot.id,{hostComputerConsent:'declined'});
        else if(feature==='app-integration')store.patchBot(bot.id,{composio:false});
        else if(feature==='channel-messages')store.patchBot(bot.id,{fullAccessChannelMessages:false});
        else throw Error('Unknown disabled replay capability');
        const current=store.bot(bot.id);
        const disabled=feature==='browser'?!builtInBrowserEnabled(loadConfig()):feature==='host-computer'?autoHostDeclined(current):feature==='app-integration'?current.composio===false:current.fullAccessChannelMessages===false;
        if (disabled) return {kind:'off',cards:0,actionExecuted:false,featureOff:{feature,settingInstalled:true,actionExecuted:false,actionNotRunProven:true,continued:true,
          ownerLines:[`${feature} is off. Turn it on in Settings.`]}};
      }
      // Persist the supplied rule snapshot in this fixture; read it back for
      // both the decision source and the independent installation witness.
      const rulePath=join(dataDir,`replay-rule-${bot.id}.json`);
      writeFileSync(rulePath,JSON.stringify(saved?[saved]:[]));
      const installed=()=>JSON.parse(readFileSync(rulePath,'utf8'));

      const actor = row.label.actor;
      const generation = randomUUID(), turnId = randomUUID(), requestId = randomUUID(), providerInstanceId = 'replay-data-only';
      const initiator = actor === 'owner-routine' ? { k:'routine-run',form:'run',sourceRunId:'fixture-run',sourceBotId:bot.id,recipientGeneration:generation,trigger:'schedule' }
        : actor === 'webhook' ? { k:'webhook' }
        : actor === 'owner-channel' || actor === 'owner-phone' ? { k:'owner-channel-dm',channel:actor === 'owner-phone'?'phone':'telegram' }
        : ['guest','non-owner','other'].includes(actor) ? { k:'guest' } : { k:'owner-typed' };
      const provenance = { generation,botId:bot.id,threadId:bot.threadId,principal:['guest','non-owner','other'].includes(actor)?'guest':'fixture-owner',initiator,roomOwnerOnly:!['guest','non-owner','other'].includes(actor),at:Date.now() };
      const input = structuredClone(row.fullToolInput);
      const event = { type:'request.opened',providerInstanceId,threadId:bot.threadId,turnId,requestId,
        tool:row.tool,requestType:'permission',summary:'Recorded replay operation',
        toolEngine:row.engine ?? (platform === 'win32'?'codex':'claude'),toolCall:{name:row.tool,input},
        ...(row.toolInputTruncated?{toolInputTruncated:true}:{}) };
      d.installDecisionHost({store,view:()=>({title:'Replay operation',subtitle:'Isolated recorded input'})});
      d.installEngineApprovalBuilder(()=>({options:['Allow','Deny']}));
      d.installDenySources({revision:()=>['fixture'],resolve:()=>installed()});
      let delivered, refused = false, interrupted = false;
      d.installDecisionTransport({respond:async(target,answer)=>{
        if(answer.behavior === 'allow') {
          // This is the same final guard called by the native driver writers.
          // A non-wipe hold/refusal here must invalidate a RUN from decide.
          delivered=guardEngineRelease(target, row.updatedInput);
          if(!delivered)refused=true;
        } else refused=true;
        return {state:'accepted'};
      },interrupt:async()=>{refused=true;interrupted=true;}});
      const handle=openReplayRequest({event,provenance,level});
      if(row.fault==='lost-live-record')d.installProvenanceReader({turnGenerationFor:()=>generation,provenance:()=>provenance,live:()=>undefined});
      const context = {
        noLimitsOrigin:actor === 'owner-routine'?'routine':actor === 'webhook'?'webhook':actor === 'owner-channel'||actor === 'owner-phone'?'owner-channel':['guest','non-owner','other'].includes(actor)?'other-human':'owner',
        fullAccessOrigin:actor === 'owner-routine'?'routine':actor === 'owner-channel'||actor === 'owner-phone'?'owner-channel':actor === 'webhook'?'other':['guest','non-owner','other'].includes(actor)?'other':'owner',
        ownerStarted:row.ownerStarted ?? ['owner','owner-channel','owner-phone'].includes(actor),
        unattended:actor === 'owner-routine'||actor === 'webhook',automated:actor === 'owner-routine'||actor === 'webhook',
        channelOwner:actor === 'owner-channel'||actor === 'owner-phone',
        outsideRead:row.outsideRead ?? null,workFolder:home,commandCwd:home,
        commandText:typeof input?.command === 'string'?input.command:undefined,
        call:{engine:event.toolEngine,toolCall:{name:row.tool,input}},promptFacts:{cwd:home,home},
      };
      const base = autoVerdict({ ...bot,...flags },row.tool,'Recorded replay operation',context);
      const outcome=d.decide(handle,()=>base);
      await d.deliverRequest(handle);
      const independent=new DatabaseSync(join(dataDir,'messages.db'),{readOnly:true});
      let shown,records;
      try {
        independent.exec('PRAGMA query_only=ON');
        records=independent.prepare("SELECT id,why,request_id,chat_message_id FROM approval_records WHERE thread_id=? AND why!='question'").all(bot.threadId);
        shown=independent.prepare("SELECT id,json FROM messages WHERE thread_id=? AND kind='options'").all(bot.threadId).flatMap(m=>{
          const card=JSON.parse(m.json)?.card;if(!card||card.intake||card.setup||card.questions)return [];
          const record=records.find(r=>r.id===card.approvalId&&r.chat_message_id===m.id&&r.request_id===requestId&&card.requestId===requestId);
          return [{approvalId:record?.id,messageId:m.id,requestId:record?.request_id,why:record?.why??'unclassified'}];
        });
      }finally{independent.close();}
      // Both entry points and the final writer must agree. No candidate label
      // is used to decide what operation was asked for.
      if(records.some(r=>!shown.some(s=>s.approvalId===r.id)))return {kind:'hold',cards:shown.length,refusals:1};
      if(shown.length)return {kind:'card',cards:shown.length,presentations:shown,why:shown.length===1?shown[0].why:'multiple',autoCards:base.approve === null?1:0,refusals:outcome.kind === 'refuse'?1:0};
      if(outcome.kind === 'refuse'||refused||outcome.kind === 'run'&&delivered !== true)return {kind:'refuse'};
      if(base.approve === null)return {kind:'unproven',cards:0,presentations:[],reason:'Approval verdict has no durable presentation'};
      return {kind:outcome.kind,actionExecuted:delivered===true,...(saved?{permissionRuleWitness:{source:saved.ruleId,ruleInstalled:installed().some(r=>JSON.stringify(r)===JSON.stringify(saved)),actionExecuted:delivered===true}}:{})};
    },
    async close() { const {flushCoalesced}=await import('../../server/atomic.ts');flushCoalesced();closeDatabase(); },
  };
}
