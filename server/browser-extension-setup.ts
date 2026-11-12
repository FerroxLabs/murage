import { serviceNoLimits } from './service-no-limits.ts';
import { browserCopy } from '../shared/browser-copy.ts';
import { serviceQueue, producerBase, type ServiceAuthority, type ServiceAuthorityReader } from './narrow-denials.ts';
import { readApproval, lookupApproval } from './decision/index.ts';
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from "node:crypto";
import { readBrowserSetupCard, type BrowserSetupCardData } from "../shared/browser-setup-card.ts";
import { isOwnerOrigin, type Store, type BotRecord } from "./store.ts";
import { murageLine } from "./murage-line.ts";
import { DRAFT_ONLY_BROWSER_REFUSAL } from "./draft-only.ts";
type SetupStore = Pick<Store,"keyedCards"|"keyedCardsEverywhere"|"messageById"|"newestMatching"|"appendMessage"|"patchMessage"|"bots"|"groups">;
export type BrowserSetupStatus = { profiles: {profileId:string;browser:string}[]; bindings: {bindingId?:string;botId:string;threadId:string;profileId:string;state:string;pausedReason?:string}[] };
type Options = {
  authorityFor?:ServiceAuthorityReader;
  store: SetupStore;
  owner: (botId:string,threadId:string)=>BotRecord | null;
  startHelper: (browser?: "chrome" | "edge" | "brave")=>Promise<unknown>;
  status: ()=>BrowserSetupStatus;
  /** enableTools: only Set up turns the bot browser toggle on; Continue never does. */
  optIn: (botId:string,profileId?:string,browser?:"chrome"|"edge"|"brave",enableTools?:boolean,revision?:number)=>void|Promise<void>;
  previewChoice?: (botId:string)=>NonNullable<BrowserSetupCardData['browserChoice']>;
  applyChoice?: (botId:string,choice:NonNullable<BrowserSetupCardData['browserChoice']>)=>Promise<{queued?:true;applied?:true}>;
  enableTools?: (botId:string,revision:number)=>Promise<void>;
  continueTask: (setup:BrowserSetupCardData)=>Promise<void>;
  /** The owner pressed Continue on the setup card while the task they stopped is still the newest: start a new task (a new binding, no grants). */
  startNewTask?: (bindingId:string)=>Promise<unknown>;
  /** The provider turn running in this conversation now (internal-capabilities.ts providerTurnOf), from the server's own turn state, never a request. The card quotes the bot's reason, so it names that turn. */
  turnOf?: (threadId:string)=>string|undefined;
};
function refusal(message:string):never{throw Object.assign(new Error(message),{status:409});}
export class BrowserExtensionSetup {
  private options: Options;
  private working = new Set<string>();
  constructor(options:Options){
    this.options=options;
    const accept=(item:import('./decision/index.ts').PendingQueueApproval,answer:import('./decision/index.ts').ApprovalAnswer)=>{
      const setup=readBrowserSetupCard(item.call.approval.action);
      if(!setup||!options.owner(setup.botId,setup.threadId))refusal('This browser setup request is no longer available.');
      serviceQueue('browser').updateProgress(item.ref,{decision:answer.behavior==='allow'?'accepted':'declined'});
    };
    serviceQueue('browser').registerDelivery('request_browser_connection',accept,accept);
  }
  request(botId:string,threadId:string,reason:string="",authority?:ServiceAuthority) {
    const bot=this.options.owner(botId,threadId);if(!bot)refusal(browserCopy("browser.server.browser-extension-setup.1"));
    // a draft-only bot works without the owner's browser (server/draft-only.ts)
    if(bot.draftOnly)refusal(DRAFT_ONLY_BROWSER_REFUSAL);
    // Only the owner's own words anchor a browser request: a message of unproven or other origin never does.
    // The newest such line is found from the end of the thread: the work is the rows written since it.
    const ownerMessage=this.options.store.newestMatching(threadId,message=>message.role==='user'&&message.kind==='text'&&Boolean(message.text?.trim())&&(message.origin===undefined||isOwnerOrigin(message.origin)),Number.POSITIVE_INFINITY);
    if(!ownerMessage)refusal(browserCopy("browser.server.browser-extension-setup.2"));
    // The offers still open in this conversation are kept by key (keyed_card), so this is those offers and never the thread.
    const existing=this.options.store.keyedCards(threadId,'browser').find(message=>{const setup=readBrowserSetupCard(message.card);return setup?.botId===botId&&setup.ownerMessageId===ownerMessage.id&&!setup.resumed&&!message.card?.answered;});
    if(existing)return {messageId:existing.id,pending:true};
    // A bot the owner already connected keeps that connection: no second offer
    // and no browser question, only the check before its task continues.
    const remembered:Partial<BrowserSetupCardData>=bot.useMyChrome&&bot.browserTransport==='extension'&&bot.browserExtensionProfileId?{decision:'accepted',remembered:true,profileId:bot.browserExtensionProfileId,...(bot.browserExtensionBrowser?{browser:bot.browserExtensionBrowser}:{})}:{};
    const browserSetup:BrowserSetupCardData={requestKey:randomUUID(),botId,threadId,ownerMessageId:ownerMessage.id,browserChoice:this.options.previewChoice?.(botId),selectionRevision:bot.selectionRevision,selectedMode:bot.browserMode,...remembered};
    const verified=authority??this.options.authorityFor?.(threadId,botId);
    const queue=serviceQueue('browser'),title=remembered.decision?'Continue with your browser?':'Use your browser for this task?',subtitle=reason.trim().slice(0,240)||'You can connect your signed-in browser, or keep using Murage without it.';
    const opened=queue.open({authority:verified,ref:browserSetup.requestKey,tool:'request_browser_connection',input:{reason},
      action:{requestId:browserSetup.requestKey,tool:'request_browser_connection',options:remembered.decision?['Check connection and continue','Not now']:['Set up','Not now'],browserSetup},view:{title,subtitle},base:producerBase(!serviceNoLimits(verified?.identity?.generation??'',threadId,botId))});
    const run=queue.executeNow(opened,()=>{
      const status=this.options.status(),profile=bot.browserExtensionProfileId??(status.profiles.length===1?status.profiles[0].profileId:undefined);
      if(profile&&status.profiles.some(item=>item.profileId===profile)){this.options.optIn(botId,profile,bot.browserExtensionBrowser,true);return {messageId:'',pending:false,connected:true};}
      const message=this.options.store.appendMessage(threadId,murageLine({role:'bot',kind:'text',text:'Connect the browser extension in the Browser panel to make this browser available.'}));
      return {messageId:message.id,pending:false,connected:false};
    });
    if(run.kind==='executed')return run.value;
    if(run.kind==='refuse')refusal(run.message);
    queue.presentNow(opened,run.ref);
    const message={id:readApproval(run.ref.approvalId)!.chatMessageId};
    return {messageId:message.id,pending:true};
  }
  private card(threadId:string,messageId:string){const message=this.options.store.messageById(threadId,messageId);const setup=readBrowserSetupCard(message?.card);if(!message?.card||!setup||setup.threadId!==threadId||!this.options.owner(setup.botId,threadId))refusal("This browser setup request is no longer available.");return {message,setup:{...setup,...serviceQueue('browser').progressFor(setup.requestKey)} as BrowserSetupCardData};}
  pendingApprovals(){return serviceQueue('browser').pendingApprovals().filter(item=>item.call.tool==='request_browser_connection');}
  approvalQueue(){return serviceQueue('browser');}
  private patch(threadId:string,messageId:string,patch:Partial<BrowserSetupCardData>){const {setup}=this.card(threadId,messageId);serviceQueue('browser').updateProgress(setup.requestKey,patch);}

  async answer(threadId:string,messageId:string,action:'accept'|'decline'|'continue',profileId?:string,browser?:'chrome'|'edge'|'brave') {
    const {setup}=this.card(threadId,messageId);if(setup.resumed)return {resumed:true};
    const record=lookupApproval(threadId,messageId);
    if(!record)refusal('This browser setup request is no longer available.');
    if(record.state==='open')await serviceQueue('browser').answer(record.ref.approvalId,{behavior:action==='decline'?'deny':'allow'});

    // an older card for a bot that is draft-only now: nothing connects, before the helper starts
    if(action!=='decline'&&this.options.owner(setup.botId,threadId)?.draftOnly)refusal(DRAFT_ONLY_BROWSER_REFUSAL);
    // Expired (a restore) or otherwise closed: never continue an old request.
    if(record.state==='expired'||record.state==='cancelled')refusal("This browser setup request has expired. Ask again.");
    if(this.working.has(setup.requestKey))refusal("Browser setup is already updating.");
    this.working.add(setup.requestKey);
    try {
      if(action==='decline') {if(setup.decision==='accepted'&&!setup.remembered)refusal(browserCopy("browser.server.browser-extension-setup.14"));this.patch(threadId,messageId,{decision:'declined',continueRequested:true,error:undefined});}
      else if(action==='accept') {
        if(setup.decision==='declined')refusal(browserCopy("browser.server.browser-extension-setup.15"));
        if(setup.browserChoice&&browser&&browser!==(setup.browserChoice.browser??'chrome'))refusal(browserCopy("browser.server.browser-extension-setup.16"));
        if(this.options.applyChoice){
          if(!setup.browserChoice)refusal(browserCopy("browser.server.browser-extension-setup.17"));
          const result=await this.options.applyChoice(setup.botId,setup.browserChoice!);
          this.patch(threadId,messageId,{decision:'accepted',selectedMode:setup.browserChoice!.mode,selectionRevision:result.queued?setup.browserChoice!.baseRevision+1:this.options.owner(setup.botId,threadId)?.selectionRevision,queuedAcceptance:!!result.queued,continueRequested:false,error:undefined});
          if(result.applied)await this.options.enableTools?.(setup.botId,this.options.owner(setup.botId,threadId)?.selectionRevision??0);
          if(result.queued||setup.browserChoice!.mode!=='chrome-extension')return this.card(threadId,messageId).setup;
        }
        const revision=this.options.owner(setup.botId,threadId)?.selectionRevision;
        await this.options.startHelper(browser ?? "chrome");
        // After the await, resolve the durable card again rather than trusting stale owner state.
        this.card(threadId,messageId);await this.options.optIn(setup.botId,undefined,browser ?? "chrome",true,...(revision===undefined?[]:[revision]));
        this.patch(threadId,messageId,{decision:'accepted',continueRequested:false,error:undefined});
      } else {
        if(setup.decision!=='accepted')refusal(browserCopy("browser.server.browser-extension-setup.18"));
        const current=this.options.owner(setup.botId,threadId);
        if(setup.selectionRevision!==undefined&&current?.selectionRevision!==setup.selectionRevision)refusal(browserCopy("browser.server.browser-extension-setup.19"));
        if(setup.selectedMode==='chrome-direct'){
          if(current?.browser===false)refusal(browserCopy("browser.server.browser-extension-setup.20",{value0: current.name}));
          this.patch(threadId,messageId,{continueRequested:true,error:undefined});
        } else {
        const status=this.options.status();const chosen=profileId??setup.profileId??(status.profiles.length===1?status.profiles[0].profileId:undefined);
        if(!chosen||!status.profiles.some(profile=>profile.profileId===chosen)){
          // The remembered profile is gone but another is live (the extension was reinstalled): point the owner at the Browser panel, where they confirm the new one. Never rebound here.
          if(chosen&&!profileId&&status.profiles.length>0)refusal(browserCopy("browser.server.browser-extension-setup.21"));
          refusal(browserCopy("browser.server.browser-extension-setup.22"));
        }
        // Only the newest task counts. One the owner stopped is final: Continue here starts a new one (RES-003), it never asks for a Resume the extension would refuse.
        const newest=status.bindings.filter(binding=>binding.botId===setup.botId&&binding.threadId===threadId&&binding.profileId===chosen).at(-1);
        if(newest?.state==='stopped'){
          if(!newest.bindingId||!this.options.startNewTask)refusal(browserCopy("browser.server.browser-extension-setup.23"));
          try{await this.options.startNewTask!(newest.bindingId!);}catch{refusal(browserCopy("browser.server.browser-extension-setup.24"));}
        }
        // EXT-RESTART 3.7: a task paused because Chrome or Murage closed says so.
        else if(newest&&newest.state==='paused'&&newest.pausedReason==='connection_lost')refusal(browserCopy("browser.server.browser-extension-setup.25"));
        else if(newest&&newest.state!=='active')refusal(browserCopy("browser.server.browser-extension-setup.26"));
        // Continue confirms the profile only. A browser toggle the owner switched
        // off stays off until the owner turns it back on.
        const owner=this.options.owner(setup.botId,threadId);
        if(owner?.browser===false)refusal(browserCopy("browser.server.browser-extension-setup.27",{value0: owner.name,value1: owner.name}));
        await this.options.optIn(setup.botId,chosen,undefined,false,...(setup.selectionRevision===undefined?[]:[setup.selectionRevision]));this.patch(threadId,messageId,{profileId:chosen,selectionRevision:this.options.owner(setup.botId,threadId)?.selectionRevision,continueRequested:true,error:undefined});
        }
      }
    } finally {this.working.delete(setup.requestKey);}
    void this.drain();return this.card(threadId,messageId).setup;
  }
  /** Called when a turn settles, never on a connection heartbeat alone. */
  async drain():Promise<void>{
    const threads=new Set<string>();for(const owner of [...this.options.store.bots,...this.options.store.groups]){threads.add(owner.threadId);for(const task of owner.tasks??[])threads.add(task.threadId);}
    // Use the durable continuation queue, including answered cards.
    for(const item of serviceQueue('browser').continuations('request_browser_connection')){
      const record=readApproval(item.approvalId);
      if(!record||record.state==='cancelled'||record.state==='expired'||record.state==='superseded')continue;
      const threadId=record.threadId,message=this.options.store.messageById(threadId,record.chatMessageId);
      if(!message)continue;
      if(!threads.has(threadId))continue;
      const raw=readBrowserSetupCard(message.card);const setup=raw?{...raw,...serviceQueue('browser').progressFor(raw.requestKey)} as BrowserSetupCardData:null;if(!setup||setup.resumed||!setup.continueRequested||this.working.has(setup.requestKey))continue;
      const bot=this.options.owner(setup.botId,threadId);if(!bot||bot.busy)continue;
      if(setup.queuedAcceptance){
        if(bot.pendingBrowserChoice||bot.browserRelease)continue;
        if(bot.selectionRevision!==setup.selectionRevision||bot.browserMode!==setup.selectedMode){
          this.patch(threadId,message.id,{queuedAcceptance:false,error:browserCopy("browser.server.browser-extension-setup.28")});continue;
        }
        this.working.add(setup.requestKey);
        // Consume before the async enable so another drain cannot enable twice.
        this.patch(threadId,message.id,{queuedAcceptance:false});
        try{
          await this.options.enableTools?.(setup.botId,setup.selectionRevision!);
          if(setup.selectedMode==='chrome-extension')await this.options.startHelper(setup.browserChoice?.browser??'chrome');
        }catch(error){this.patch(threadId,message.id,{error:error instanceof Error?error.message:String(error)});}
        finally{this.working.delete(setup.requestKey);}
      }
      if(!setup.continueRequested)continue;
      if(setup.decision==='accepted'&&setup.selectionRevision!==undefined&&setup.selectionRevision!==bot.selectionRevision){
        this.patch(threadId,message.id,{continueRequested:false,error:browserCopy("browser.server.browser-extension-setup.29")});continue;
      }
      if(setup.decision==='accepted'&&setup.selectedMode!=='chrome-direct'){
        const status=this.options.status();
        // Only the newest task for this conversation counts: one the owner stopped is final and a newer one replaces it.
        const newest=status.bindings.filter(binding=>binding.botId===setup.botId&&binding.threadId===threadId&&binding.profileId===setup.profileId).at(-1);
        if(!status.profiles.some(profile=>profile.profileId===setup.profileId)||(newest&&newest.state!=='active')){
          this.patch(threadId,message.id,{continueRequested:false,error:browserCopy("browser.server.browser-extension-setup.30")});continue;
        }
      } else if(setup.decision!=='declined'&&setup.decision!=='accepted')continue;
      this.working.add(setup.requestKey);
      // Consume before dispatch: a lost response or process restart never replays the task.
      this.patch(threadId,message.id,{resumed:true,continueRequested:false});
      try{await this.options.continueTask(setup);}catch{this.patch(threadId,message.id,{error:browserCopy("browser.server.browser-extension-setup.31")});}finally{this.working.delete(setup.requestKey);}
    }
  }
}
