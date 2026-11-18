import { browserCopy } from '../shared/browser-copy.ts';
import { BrowserLifecycleGate } from './browser-lifecycle-gate.ts';
import { SessionGate } from './browser-session-gate.ts';
import { resolveBrowserDestination, ownerMoveDisclosure, guardLoosened, type BrowserMode, type BrowserSelection, type DestinationContext } from './browser-mode-policy.ts';
import { directBrowserMutex as directMutex, type DirectReservation } from './browser-direct-reservation.ts';
export type { DirectReservation } from './browser-direct-reservation.ts';
export type BrowserChoice = BrowserSelection & {baseRevision:number;disclosureKey:string;requestedAt?:number};
export type BrowserRelease = BrowserSelection & {revision:number;key:string|null;attempts?:number;reason?:string};
export type BrowserChoiceBot = {id:string;name:string;busy?:boolean;browserMode?:BrowserMode;selectionRevision?:number;browserSelectionRevision?:number;browserSetupRevision?:number;browserProfile?:string;useMyChrome?:true;browserTransport?:'extension';browserExtensionProfileId?:string;browserExtensionBrowser?:'chrome'|'edge'|'brave';browserApproval?:'step'|'task'|'full';pendingBrowserChoice?:BrowserChoice;previousBrowserChoice?:BrowserSelection;browserRelease?:BrowserRelease};
export function browserSelection(bot:BrowserChoiceBot):BrowserSelection {
  const mode=(['builtin','chrome-extension','chrome-direct'].includes(bot.browserMode??'')?bot.browserMode:undefined) ?? (bot.useMyChrome === true ? bot.browserTransport==='extension'?'chrome-extension':'chrome-direct':'builtin');
  return {mode,profile:mode==='builtin'?bot.browserProfile:mode==='chrome-extension'?bot.browserExtensionProfileId:undefined,browser:mode==='chrome-extension'?bot.browserExtensionBrowser:mode==='chrome-direct'?'chrome':undefined};
}
export function derivedBrowserFields(choice:BrowserSelection):Partial<BrowserChoiceBot> {
  return {browserMode:choice.mode,useMyChrome:choice.mode === 'builtin' ? undefined : true,browserTransport:choice.mode === 'chrome-extension' ? 'extension' : undefined,
    ...(choice.mode === 'builtin' ? {browserProfile:choice.profile} : {}),browserExtensionProfileId:choice.mode === 'chrome-extension' ? choice.profile : undefined,browserExtensionBrowser:choice.mode === 'chrome-extension' ? choice.browser : undefined};
}
export function browserChoiceError(code:string,name:string) {
  const text:Record<string,string>={revision_changed:browserCopy("browser.server.browser-mode-transition.1",{value0: name}),disclosure_stale:browserCopy("browser.server.browser-mode-transition.2"),held:browserCopy("browser.server.browser-mode-transition.3",{value0: name}),paused_binding:browserCopy("browser.server.browser-mode-transition.4",{value0: name}),direct_reserved:browserCopy("browser.server.browser-mode-transition.5"),release_pending:browserCopy("browser.server.browser-mode-transition.6",{value0: name}),invalid_choice:browserCopy("browser.server.browser-mode-transition.7")};
  return Object.assign(new Error(text[code]??code),{status:409,code});
}
type Deps={lifecycle:BrowserLifecycleGate;sessions:SessionGate;bot:(id:string)=>BrowserChoiceBot|undefined;bots:()=>BrowserChoiceBot[];reservation:()=>DirectReservation|undefined;
 write:(id:string,patch:Partial<BrowserChoiceBot>,reservation:DirectReservation|undefined)=>void;
 key:(bot:BrowserChoiceBot)=>string|null;blocksCommit:(key:string)=>string|null;paused:(id:string)=>boolean;
 release:(botId:string,release:BrowserRelease)=>Promise<void>;destinationContext:()=>DestinationContext;beforeWrite?:()=>Promise<void>;validateCommit?:()=>void;onPendingRefused?:(id:string,error:unknown)=>void;onApplied?:(id:string)=>void;};
// One mutex for the process, always below a bot lifecycle mutex, above sessions.

export class BrowserModeTransition {
  private readonly d:Deps;
  constructor(deps:Deps){this.d=deps;deps.lifecycle.onIdle(id=>this.applyPendingLocked(id));deps.lifecycle.onAfterIdle(id=>this.d.onApplied?.(id));}
  private bot(id:string){const b=this.d.bot(id);if(!b)throw Object.assign(new Error(browserCopy("browser.server.browser-mode-transition.8")),{status:404});return b;}
  preview(id:string,choice:BrowserSelection){
    const bot=this.bot(id),destination=resolveBrowserDestination(bot,choice,{...this.d.destinationContext(),bots:this.d.bots()});
    return {destination,disclosure:ownerMoveDisclosure({...browserSelection(bot),revision:bot.selectionRevision??0},destination,bot.browserApproval),baseRevision:bot.selectionRevision??0};
  }
  applyBrowserChoice(id:string,choice:BrowserChoice){return this.d.lifecycle.run(id,()=>this.applyLocked(id,choice)).then(result=>{this.d.onApplied?.(id);return result;});}
  private validate(bot:BrowserChoiceBot,choice:BrowserChoice){
    this.d.validateCommit?.();
    if(!Number.isSafeInteger(choice.baseRevision)||choice.baseRevision !== (bot.selectionRevision??0))throw browserChoiceError('revision_changed',bot.name);
    if(!['builtin','chrome-extension','chrome-direct'].includes(choice.mode))throw browserChoiceError('invalid_choice',bot.name);
    if(choice.browser!==undefined&&!['chrome','edge','brave'].includes(choice.browser))throw browserChoiceError('invalid_choice',bot.name);
    if(choice.mode==='chrome-extension'&&choice.profile!==undefined&&!/^[A-Za-z0-9_-]{1,128}$/.test(choice.profile))throw browserChoiceError('invalid_choice',bot.name);
    if(choice.profile!==undefined && (typeof choice.profile!=='string'||!choice.profile.length||choice.profile.length>128))throw browserChoiceError('invalid_choice',bot.name);
    if(choice.mode==='builtin'&&choice.profile&&choice.profile!=='guest'&&!this.d.destinationContext().profiles?.some(p=>p.id===choice.profile))throw browserChoiceError('invalid_choice',bot.name);
    if(choice.disclosureKey !== this.preview(bot.id,choice).disclosure.disclosureKey)throw browserChoiceError('disclosure_stale',bot.name);
    const reservation=this.d.reservation();
    if(choice.mode==='chrome-direct'&&reservation&&reservation.botId!==bot.id){const error=browserChoiceError('direct_reserved',bot.name);const holder=this.d.bot(reservation.botId);if(holder)error.message=browserCopy("browser.server.browser-mode-transition.9",{value0: holder.name});throw error;}
  }
  private async applyLocked(id:string,choice:BrowserChoice, idleAcknowledged = false){
    const bot=this.bot(id);
    // R is the sole exception to effect-free V: a pre-existing durable marker
    // must be recovered before another choice can replace it (S134 4.4).
    if(bot.browserRelease && !(await this.recoverLocked(id, idleAcknowledged)))throw browserChoiceError('release_pending',bot.name);
    await this.d.beforeWrite?.();
    this.validate(bot,choice);
    if((bot.busy && !idleAcknowledged) || this.d.lifecycle.hasLease(id)){
      this.d.write(id,{pendingBrowserChoice:{...choice,requestedAt:Date.now()}},this.d.reservation());return {queued:true as const,pending:bot.pendingBrowserChoice};
    }
    if(this.d.paused(id))throw browserChoiceError('paused_binding',bot.name);
    await directMutex.run(['direct'],async()=>{
      this.validate(bot,choice);
      const old=browserSelection(bot),revision=(bot.selectionRevision??0)+1,patch=derivedBrowserFields(choice);
      const oldKey=this.d.key(bot),newKey=this.d.key({...bot,...patch});
      await this.d.sessions.run([oldKey,newKey].filter((key):key is string=>key!==null),async()=>{
        await this.d.beforeWrite?.();
        this.validate(bot,choice);
        // No await from the final probes to the atomic write.
        if(this.d.paused(id))throw browserChoiceError('paused_binding',bot.name);
        for(const key of [oldKey,newKey]){const block=key&&this.d.blocksCommit(key);if(block)throw browserChoiceError(block,bot.name);}
        let reservation=this.d.reservation();
        if(choice.mode==='chrome-direct')reservation={botId:id,revision,state:'held'};
        else if(old.mode==='chrome-direct'&&reservation?.botId===id)reservation={...reservation,state:'releasing'};
        this.d.write(id,{...patch,selectionRevision:revision,browserSelectionRevision:revision,browserSetupRevision:choice.mode==='chrome-extension'?revision:undefined,
          previousBrowserChoice:bot.previousBrowserChoice && JSON.stringify(old) !== JSON.stringify(choice) && bot.previousBrowserChoice.mode===choice.mode && bot.previousBrowserChoice.profile===choice.profile && bot.previousBrowserChoice.browser===choice.browser ? undefined : guardLoosened(old.mode,choice.mode)?old:undefined,
          pendingBrowserChoice:undefined,browserRelease:{...old,revision:revision-1,key:oldKey}},reservation);
      });
    });
    await this.recoverLocked(id, idleAcknowledged);
    return {applied:true as const,bot};
  }
  recover(id:string){return this.d.lifecycle.run(id,()=>this.recoverLocked(id));}
  async recoverLocked(id:string, idleAcknowledged = false):Promise<boolean>{
    const bot=this.bot(id),release=bot.browserRelease;if(!release)return true;
    if(this.d.lifecycle.hasLease(id)||(bot.busy && !idleAcknowledged))return false;
    try {
      let timer:ReturnType<typeof setTimeout>|undefined;
      try {await Promise.race([this.d.release(id,release),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error(browserCopy("browser.server.browser-mode-transition.10"))),10000);})]);}finally{clearTimeout(timer);}
      await directMutex.run(['direct'],async()=>{
        await this.d.beforeWrite?.();
        if(bot.browserRelease!==release)return;
        const reservation=this.d.reservation();
        this.d.write(id,{browserRelease:undefined},release.mode==='chrome-direct'&&reservation?.botId===id&&reservation.state==='releasing'?undefined:reservation);
      });
      return !bot.browserRelease;
    } catch(error){
      await this.d.beforeWrite?.();
      if(bot.browserRelease===release)this.d.write(id,{browserRelease:{...release,attempts:(release.attempts??0)+1,reason:error instanceof Error?error.message:browserCopy("browser.server.browser-mode-transition.11")}},this.d.reservation());
      return false;
    }
  }
  private async applyPendingLocked(id:string){
    const bot=this.d.bot(id);if(!bot||bot.busy||this.d.lifecycle.hasLease(id))return;
    if(!(await this.recoverLocked(id, true)))return;
    if(bot.pendingBrowserChoice)try{await this.applyLocked(id,bot.pendingBrowserChoice,true);}catch(error){
      if(['revision_changed','disclosure_stale'].includes((error as {code?:string}).code??'')){await this.d.beforeWrite?.();this.d.write(id,{pendingBrowserChoice:undefined},this.d.reservation());}
      this.d.onPendingRefused?.(id,error);
    }
  }
  applyPending(id:string){return this.d.lifecycle.run(id,()=>this.applyPendingLocked(id)).then(()=>{this.d.onApplied?.(id);});}
  afterHoldEnded(key:string){for(const bot of this.d.bots())if(bot.browserRelease?.key===key||(bot.pendingBrowserChoice&&(this.d.key(bot)===key||this.d.key({...bot,...derivedBrowserFields(bot.pendingBrowserChoice)})===key)))void this.applyPending(bot.id).catch(error=>this.d.onPendingRefused?.(bot.id,error));}
  async switchNow(id:string,revision:number,interrupt:()=>Promise<void>){
    const bot=this.bot(id);
    if(revision!==(bot.selectionRevision??0)||!bot.pendingBrowserChoice)return {stale:true};
    // Never hold the lifecycle gate while waiting for the provider to stop.
    let timer:ReturnType<typeof setTimeout>|undefined;
    const deadline=Date.now()+15000;
    try {
      const stopped=await Promise.race([interrupt().then(()=>true),new Promise<false>(resolve=>{timer=setTimeout(()=>resolve(false),15000);})]);
      if(!stopped)return {stopping:true};
      while(this.d.lifecycle.hasLease(id)||this.bot(id).busy){
        if(Date.now()>=deadline)return {stopping:true};
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      if((this.bot(id).selectionRevision??0)!==revision)return {stale:true};
      await this.applyPending(id);return {applied:!this.bot(id).pendingBrowserChoice};
    }finally{clearTimeout(timer);}
  }
  completeSetup(id:string,revision:number,profile:string,browser:'chrome'|'edge'|'brave'){
    return this.d.lifecycle.run(id,async()=>{
      await this.d.beforeWrite?.();
      const bot=this.bot(id);
      if(bot.browserMode!=='chrome-extension'||bot.browserSetupRevision!==revision||bot.selectionRevision!==revision||bot.browserRelease||bot.busy||this.d.lifecycle.hasLease(id))return false;
      if(bot.browserExtensionProfileId||!profile||profile.length>128||browser!==(bot.browserExtensionBrowser??'chrome')||this.d.paused(id))return false;
      this.d.write(id,{browserExtensionProfileId:profile,browserExtensionBrowser:browser,browserSetupRevision:undefined},this.d.reservation());
      return true;
    });
  }
  cancel(id:string,revision:number){return this.d.lifecycle.run(id,async()=>{await this.d.beforeWrite?.();const bot=this.bot(id);if(revision!==(bot.selectionRevision??0))throw browserChoiceError('revision_changed',bot.name);this.d.write(id,{pendingBrowserChoice:undefined},this.d.reservation());});}
}
