// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from "node:crypto";
import { readBrowserSetupCard, type BrowserSetupCardData } from "../shared/browser-setup-card.ts";
import { isOwnerOrigin, type Store, type BotRecord } from "./store.ts";
type SetupStore = Pick<Store,"messagesFor"|"appendMessage"|"patchMessage"|"bots"|"groups">;
export type BrowserSetupStatus = { profiles: {profileId:string;browser:string}[]; bindings: {bindingId?:string;botId:string;threadId:string;profileId:string;state:string}[] };
type Options = {
  store: SetupStore;
  owner: (botId:string,threadId:string)=>BotRecord | null;
  startHelper: (browser?: "chrome" | "edge" | "brave")=>Promise<unknown>;
  status: ()=>BrowserSetupStatus;
  /** enableTools: only Set up turns the bot browser toggle on; Continue never does. */
  optIn: (botId:string,profileId?:string,browser?:"chrome"|"edge"|"brave",enableTools?:boolean)=>void;
  continueTask: (setup:BrowserSetupCardData)=>Promise<void>;
  /** The owner pressed Continue on the setup card while the task they stopped is still the newest: start a new task (a new binding, no grants). */
  startNewTask?: (bindingId:string)=>Promise<unknown>;
};
function refusal(message:string):never{throw Object.assign(new Error(message),{status:409});}
export class BrowserExtensionSetup {
  private options: Options;
  private working = new Set<string>();
  constructor(options:Options){this.options=options;}
  request(botId:string,threadId:string,reason:string="") {
    const bot=this.options.owner(botId,threadId);if(!bot)refusal("This conversation cannot request browser setup.");
    const messages=this.options.store.messagesFor(threadId);
    // Only the owner's own words anchor a browser request: a message of unproven or other origin never does.
    const ownerMessage=messages.findLast(message=>message.role==='user'&&message.kind==='text'&&message.text?.trim()&&(message.origin===undefined||isOwnerOrigin(message.origin)));
    if(!ownerMessage)refusal("Ask for a task in this conversation before connecting a browser.");
    const existing=messages.find(message=>{const setup=readBrowserSetupCard(message.card);return setup?.botId===botId&&setup.ownerMessageId===ownerMessage.id&&!setup.resumed&&!message.card?.answered;});
    if(existing)return {messageId:existing.id,pending:true};
    // A bot the owner already connected keeps that connection: no second offer
    // and no browser question, only the check before its task continues.
    const remembered:Partial<BrowserSetupCardData>=bot.useMyChrome&&bot.browserTransport==='extension'&&bot.browserExtensionProfileId?{decision:'accepted',remembered:true,profileId:bot.browserExtensionProfileId,...(bot.browserExtensionBrowser?{browser:bot.browserExtensionBrowser}:{})}:{};
    const browserSetup:BrowserSetupCardData={requestKey:randomUUID(),botId,threadId,ownerMessageId:ownerMessage.id,...remembered};
    const message=this.options.store.appendMessage(threadId,{role:'bot',kind:'options',from:{botId:bot.id,name:bot.name,color:bot.color},card:remembered.decision
      ?{title:'Continue with your browser?',subtitle:reason.trim().slice(0,240)||'Your browser connection is remembered for this bot. Check it, then continue.',options:['Check connection and continue','Not now'],browserSetup}
      :{title:'Use your browser for this task?',subtitle:reason.trim().slice(0,240)||'You can connect your signed-in browser, or keep using Murage without it.',options:['Set up','Not now'],browserSetup}});
    return {messageId:message.id,pending:true};
  }
  private card(threadId:string,messageId:string){const message=this.options.store.messagesFor(threadId).find(item=>item.id===messageId);const setup=readBrowserSetupCard(message?.card);if(!message?.card||!setup||setup.threadId!==threadId||!this.options.owner(setup.botId,threadId))refusal("This browser setup request is no longer available.");return {message,setup};}
  private patch(threadId:string,messageId:string,patch:Partial<BrowserSetupCardData>){const {message,setup}=this.card(threadId,messageId);this.options.store.patchMessage(threadId,messageId,{card:{...message.card!,browserSetup:{...setup,...patch}}});}
  async answer(threadId:string,messageId:string,action:'accept'|'decline'|'continue',profileId?:string,browser?:'chrome'|'edge'|'brave') {
    const {message,setup}=this.card(threadId,messageId);if(setup.resumed)return {resumed:true};
    // Expired (a restore) or otherwise closed: never continue an old request.
    if(message.card?.answered)refusal("This browser setup request has expired. Ask again.");
    if(this.working.has(setup.requestKey))refusal("Browser setup is already updating.");
    this.working.add(setup.requestKey);
    try {
      if(action==='decline') {if(setup.decision==='accepted'&&!setup.remembered)refusal("Browser setup was already accepted. You can switch browsers in the Browser panel.");this.patch(threadId,messageId,{decision:'declined',continueRequested:true,error:undefined});}
      else if(action==='accept') {
        if(setup.decision==='declined')refusal("This browser setup request was declined.");
        await this.options.startHelper(browser ?? "chrome");
        // After the await, resolve the durable card again rather than trusting stale owner state.
        this.card(threadId,messageId);this.options.optIn(setup.botId,undefined,browser ?? "chrome",true);
        this.patch(threadId,messageId,{decision:'accepted',continueRequested:false,error:undefined});
      } else {
        if(setup.decision!=='accepted')refusal("Choose Set up before continuing with your browser.");
        const status=this.options.status();const chosen=profileId??setup.profileId??(status.profiles.length===1?status.profiles[0].profileId:undefined);
        if(!chosen||!status.profiles.some(profile=>profile.profileId===chosen))refusal("Connect the extension and choose its browser profile before continuing.");
        // Only the newest task counts. One the owner stopped is final: Continue here starts a new one (RES-003), it never asks for a Resume the extension would refuse.
        const newest=status.bindings.filter(binding=>binding.botId===setup.botId&&binding.threadId===threadId&&binding.profileId===chosen).at(-1);
        if(newest?.state==='stopped'){
          if(!newest.bindingId||!this.options.startNewTask)refusal("Start a new browser task in Murage for Chrome, then choose Continue again.");
          try{await this.options.startNewTask!(newest.bindingId!);}catch{refusal("Start a new browser task in Murage for Chrome, then choose Continue again.");}
        }
        else if(newest&&newest.state!=='active')refusal("Resume the browser task in the extension before continuing here.");
        // Continue confirms the profile only. A browser toggle the owner switched
        // off stays off until the owner turns it back on.
        const owner=this.options.owner(setup.botId,threadId);
        if(owner?.browser===false)refusal(`Browser tools are off for ${owner.name}. Turn them on in ${owner.name}'s settings, then choose Continue again.`);
        this.options.optIn(setup.botId,chosen,undefined,false);this.patch(threadId,messageId,{profileId:chosen,continueRequested:true,error:undefined});
      }
    } finally {this.working.delete(setup.requestKey);}
    void this.drain();return this.card(threadId,messageId).setup;
  }
  /** Called when a turn settles, never on a connection heartbeat alone. */
  async drain():Promise<void>{
    const threads=new Set<string>();for(const owner of [...this.options.store.bots,...this.options.store.groups]){threads.add(owner.threadId);for(const task of owner.tasks??[])threads.add(task.threadId);}
    for(const threadId of threads)for(const message of this.options.store.messagesFor(threadId)){
      const setup=readBrowserSetupCard(message.card);if(!setup||message.card?.answered||setup.resumed||!setup.continueRequested||this.working.has(setup.requestKey))continue;
      const bot=this.options.owner(setup.botId,threadId);if(!bot||bot.busy)continue;
      if(setup.decision==='accepted'){
        const status=this.options.status();
        // Only the newest task for this conversation counts: one the owner stopped is final and a newer one replaces it.
        const newest=status.bindings.filter(binding=>binding.botId===setup.botId&&binding.threadId===threadId&&binding.profileId===setup.profileId).at(-1);
        if(!status.profiles.some(profile=>profile.profileId===setup.profileId)||(newest&&newest.state!=='active')){
          this.patch(threadId,message.id,{continueRequested:false,error:'The browser connection changed. Check it, then choose Continue again.'});continue;
        }
      } else if(setup.decision!=='declined')continue;
      this.working.add(setup.requestKey);
      // Consume before dispatch: a lost response or process restart never replays the task.
      this.patch(threadId,message.id,{resumed:true,continueRequested:false});
      try{await this.options.continueTask(setup);}catch{this.patch(threadId,message.id,{error:'The task could not continue. Send a new message when you are ready.'});}finally{this.working.delete(setup.requestKey);}
    }
  }
}
