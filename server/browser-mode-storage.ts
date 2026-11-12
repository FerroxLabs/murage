import { existsSync, readFileSync } from 'node:fs';
import { writeFileAtomic } from './atomic.ts';
import { browserSelection, derivedBrowserFields, type BrowserChoiceBot, type DirectReservation } from './browser-mode-transition.ts';
const fields=['browserMode','selectionRevision','browserSelectionRevision','browserSetupRevision','browserProfile','useMyChrome','browserTransport','browserExtensionProfileId','browserExtensionBrowser','pendingBrowserChoice','previousBrowserChoice','browserRelease'] as const;
type Root={version:1;migrated:true;bots:Record<string,Partial<BrowserChoiceBot>>;chromeDirectReservation?:DirectReservation};
const pick=(bot:BrowserChoiceBot):Partial<BrowserChoiceBot>=>Object.fromEntries(fields.map(k=>[k,bot[k]]));
/** This store root is authoritative for browser selections. Selection, migration
 * marker and the cross-bot reservation share one atomic file replacement.
 * bots.json carries derived compatibility fields; a crash before its next write
 * cannot change the selection, since this root is overlaid before sanitizing. */
export class BrowserModeStorage {
  private root:Root={version:1,migrated:true,bots:{}};
  private readonly file:string;
  private readonly write:(file:string,data:string)=>void;
  constructor(file:string,write:(file:string,data:string)=>void=(file,data)=>writeFileAtomic(file,data,{mode:0o600})){this.file=file;this.write=write;}
  get reservation(){return this.root.chromeDirectReservation;}
  load(bots:BrowserChoiceBot[]){
    const before=JSON.stringify(bots);
    const saved:unknown=existsSync(this.file)?JSON.parse(readFileSync(this.file,'utf8')):undefined;
    if(saved!==undefined){
      const value=saved as Root;
      if(!value||value.version!==1||value.migrated!==true||!value.bots||Array.isArray(value.bots)||typeof value.bots!=='object')throw new Error('Invalid browser choice state');
      const r=value.chromeDirectReservation;
      if(r&&(!['held','releasing'].includes(r.state)||typeof r.botId!=='string'||!Number.isSafeInteger(r.revision)||r.revision<0))throw new Error('Invalid direct reservation');
      for(const b of Object.values(value.bots))if(!['builtin','chrome-extension','chrome-direct'].includes(b.browserMode??'')||!Number.isSafeInteger(b.selectionRevision)||b.selectionRevision!<0)throw new Error('Invalid browser selection');
      this.root=value;
    }
    const next:Root={...this.root,bots:{...this.root.bots}},staged:BrowserChoiceBot[]=[];
    const ids=new Set(bots.map(bot=>bot.id));
    for(const id of Object.keys(next.bots))if(!ids.has(id))delete next.bots[id];
    if(next.chromeDirectReservation&&!ids.has(next.chromeDirectReservation.botId))next.chromeDirectReservation=undefined;
    let direct=next.chromeDirectReservation?.botId;
    for(const original of bots){
      const old=Object.hasOwn(next.bots,original.id)?next.bots[original.id]:undefined;if(old){staged.push({...original,...Object.fromEntries(fields.map(k=>[k,old[k]]))});continue;}
      const b={...original};
      // A legacy opt-in is authority only when it is the exact boolean true.
      if(b.useMyChrome !== true)delete b.useMyChrome;
      if((b.browserMode!==undefined&&!['builtin','chrome-extension','chrome-direct'].includes(b.browserMode))||(b.useMyChrome!==undefined&&b.useMyChrome!==true)||(b.browserTransport!==undefined&&b.browserTransport!=='extension')||(b.browserTransport==='extension'&&b.browserExtensionProfileId!==undefined&&(typeof b.browserExtensionProfileId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(b.browserExtensionProfileId)))){console.warn(`[browser] unchanged ambiguous selection ${b.id}`);staged.push(b);continue;}
      let selection=browserSelection(b);
      if(selection.mode==='chrome-direct'&&direct&&direct!==b.id){console.warn(`[browser] extra legacy direct selection ${b.id} keeps its own browser`);selection={mode:'builtin',profile:b.browserProfile};}
      const mapped=derivedBrowserFields(selection);if(selection.mode!=='chrome-extension'){delete mapped.browserExtensionProfileId;delete mapped.browserExtensionBrowser;}
      Object.assign(b,mapped,{selectionRevision:b.selectionRevision??0,browserSelectionRevision:b.selectionRevision??0});
      if(selection.mode==='chrome-direct'){direct=b.id;next.chromeDirectReservation={botId:b.id,revision:b.selectionRevision!,state:'held'};}
      next.bots[b.id]=pick(b);staged.push(b);
    }
    if(!next.chromeDirectReservation){
      const releasing=staged.find(b=>b.browserRelease?.mode==='chrome-direct');
      const holder=releasing??staged.find(b=>b.browserMode==='chrome-direct');
      if(holder)next.chromeDirectReservation={botId:holder.id,revision:releasing?.browserRelease?.revision??holder.selectionRevision??0,state:releasing?'releasing':'held'};
    }
    // Publish neither the migration nor its done marker if the write fails.
    if(saved===undefined||JSON.stringify(next)!==JSON.stringify(this.root))this.write(this.file,JSON.stringify(next));
    this.root=next;for(let i=0;i<bots.length;i++){Object.assign(bots[i]!,staged[i]);if(bots[i]!.useMyChrome !== true)delete bots[i]!.useMyChrome;}
    return before!==JSON.stringify(bots);
  }
  remove(id:string){
    const next:Root={...this.root,bots:{...this.root.bots}};delete next.bots[id];
    if(next.chromeDirectReservation?.botId===id)next.chromeDirectReservation=undefined;
    this.write(this.file,JSON.stringify(next));this.root=next;
  }
  commit(bot:BrowserChoiceBot,patch:Partial<BrowserChoiceBot>,reservation:DirectReservation|undefined){
    const staged={...bot,...patch},next:Root={...this.root,bots:{...this.root.bots,[bot.id]:pick(staged)},chromeDirectReservation:reservation};
    this.write(this.file,JSON.stringify(next));this.root=next;Object.assign(bot,patch);
  }
}
