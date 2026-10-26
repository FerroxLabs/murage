// Protected-document state lives in a CDP isolated world: page scripts cannot
// reset it. Capture listeners run before page handlers on future documents.
// A guard is installed before every mediated action, including new tabs.
import { NATIVE_DOM_SOURCE } from "./browser-native-dom.ts";
import WebSocket from "ws";
import type { Duplex } from "node:stream";

import { closeSocketQuietly } from "./browser-socket-teardown.ts";
import { protectedDocumentTargeted } from "./browser-floor-builtin.ts";
import { SECRET_CLASSIFIER_SOURCE } from "../shared/browser-secret-classifier.ts";
const WORLD = "murage-protected-document-v1";
export const BROWSER_DOCUMENT_GUARD_SOURCE = String.raw`(() => {
  if(globalThis.__murageGuard) return;
  const dom=(${NATIVE_DOM_SOURCE})();
  // A field is private by what it says it is: its type, name, id and autocomplete, its placeholder and title,
  // every label that names it (<label for>, an ancestor <label>, aria-labelledby, aria-label) and, for a
  // revealed password, the fact that it was one. Kept in step with SENSITIVE in browser-extension-engine-read.ts.
  const re=/password|passwd|passcode|secret|api.?key|private.?key|access.?token|auth.?token|refresh.?token|one.?time|otp|verification.?code|recovery|seed.?phrase|mnemonic|cc-|card.?number|card.?no\b|credit.?card|debit.?card|security.?code|cvv|cvc|bank.?account|account.?number|routing|sort.?code|iban|social.?security|ssn/i;
  // Round 8: the shared classifier decides what a secret name is, in the common languages, besides the list above.
  const SC=${SECRET_CLASSIFIER_SOURCE};
  let tainted=false, armed=false, dirty=true, cached=false, hasShadow=false, observing=false, listening=false, observer=null, lease=null;
  // A guard is held only while it is leased. Disabled, expired or disposed it keeps no listener and no observer; the verdict is
  // then read from the document each time. The lease is renewed by every enable(true) (each mediated action calls it).
  const LEASE_MS=120000;
  const wasPassword=new WeakSet();
  const clip=n=>String((n&&dom.text(n))||'').slice(0,300);
  const nameOf=e=>{
    const parts=[dom.controlType(e),dom.attr(e,'name'),dom.attr(e,'id'),dom.attr(e,'autocomplete'),dom.attr(e,'aria-label'),dom.attr(e,'placeholder'),dom.attr(e,'title')];
    try{for(const l of dom.labels(e))parts.push(clip(l));}catch{}
    try{const by=dom.attr(e,'aria-labelledby');if(by){const root=dom.root(e);for(const id of by.split(/\s+/)){const n=dom.byId(root&&dom.kind(root)===11?root:document,id);if(n)parts.push(clip(n));}}}catch{}
    try{const l=dom.closest(e,'label');if(l)parts.push(clip(l));}catch{}
    return parts.join(' ');
  };
  const masked=e=>{try{const v=getComputedStyle(e).webkitTextSecurity;return !!v&&v!=='none';}catch{return false;}};
  const editable=e=>dom.tag(e).toUpperCase()==='INPUT'||dom.tag(e).toUpperCase()==='TEXTAREA'||dom.attr(e,'contenteditable')!==null||dom.attr(e,'role')==='textbox';
  // A composed event path ends with Window, which is not a Node receiver.
  const sensitive=e=>!!e&&e!==globalThis&&dom.kind(e)===1&&editable(e)&&(dom.controlType(e)==='password'||wasPassword.has(e)||(re.test(nameOf(e))||SC.secretName(nameOf(e)))||masked(e));
  // Targeted queries in this isolated world: the fields, then open shadow roots and same-origin frames.
  // Nothing about the page crosses to the extension; only the verdict does.
  const scan=(root,depth)=>{
    // A traversal that cannot finish is not a clean page: too deep is a stop.
    if(depth>8)return true;
    for(const e of dom.query(root,'input,textarea,[contenteditable],[role="textbox"]')){if(dom.controlType(e)==='password')wasPassword.add(e);if(sensitive(e))return true;}
    for(const e of dom.query(root,'*')){
      if(dom.shadow(e)){hasShadow=true;if(scan(dom.shadow(e),depth+1))return true;}
      if(dom.tag(e).toUpperCase()==='IFRAME'||dom.tag(e).toUpperCase()==='FRAME'){hasShadow=true;try{const d=e.contentDocument;if(d&&scan(d,depth+1))return true;}catch{}}
    }
    return false;
  };
  // The observer sees the document only: open shadow roots and frames change unseen, so a page that has them is looked at every time.
  // Custom elements whose shadow root this world cannot read (a closed root looks exactly like none). collect returns the elements (up to 257),
  // otherwise only a count. The executor asks the browser's own tree about each one; nothing about the page crosses to the extension here.
  const suspects=collect=>{const out=[];let n=0;const walk=(root,depth)=>{if(depth>8){n+=1000000;return;}
    for(const e of dom.query(root,'*')){
      if(dom.shadow(e))walk(dom.shadow(e),depth+1);else if(dom.tag(e).indexOf('-')>0){n++;if(out.length<257)out.push(e);}
      if(dom.tag(e).toUpperCase()==='IFRAME'||dom.tag(e).toUpperCase()==='FRAME'){try{const d=e.contentDocument;if(d)walk(d,depth+1);}catch{}}
    }};walk(document,0);dom.assertComplete();return collect?out:n;};
  const state=()=>{if(tainted)return true;if(dirty||!observing||hasShadow){try{cached=scan(document,0);dom.assertComplete();}catch{cached=true;}dirty=false;}return cached;};
  const TYPES=['beforeinput','input','change','keydown','click','pointerdown','mousedown','submit'];
  const onEvent=e=>{
    if(hasShadow)dirty=true;
    let blocks=true;try{blocks=state()||e.composedPath().some(sensitive);dom.assertComplete();}catch{blocks=true;}
    if(blocks) { tainted=true; if(armed){e.preventDefault(); e.stopImmediatePropagation();} }
  };
  const watch=()=>{
    if(!observer){
      try{
        observer=new MutationObserver(records=>{dirty=true;for(const r of records)if(r.type==='attributes'&&r.attributeName==='type'&&r.oldValue==='password'&&r.target)wasPassword.add(r.target);});
        observer.observe(document,{subtree:true,childList:true,attributes:true,attributeOldValue:true,characterData:true});
        observing=true;
      }catch{observer=null;observing=false;}
    }
    if(!listening){for(const type of TYPES)document.addEventListener(type,onEvent,true);listening=true;}
    dirty=true;
  };
  // Dispose: remember which fields were passwords (the observer that tracked that is going away), then drop every listener and observer.
  const dispose=()=>{
    if(lease!==null){clearTimeout(lease);lease=null;}
    armed=false;
    if(listening||observer){try{scan(document,0);}catch{}}
    if(listening){for(const type of TYPES)document.removeEventListener(type,onEvent,true);listening=false;}
    if(observer){try{observer.disconnect();}catch{}observer=null;}
    observing=false;dirty=true;
  };
  const arm=ms=>{
    armed=true;watch();
    if(lease!==null)clearTimeout(lease);
    lease=setTimeout(dispose,Number.isFinite(ms)&&ms>0?ms:LEASE_MS);
  };
  state.enable=(value,ms)=>{if(value)arm(ms);else dispose();};
  state.arm=arm;state.dispose=dispose;
  state.suspects=()=>suspects(false);state.suspectList=()=>suspects(true); Object.defineProperty(globalThis,'__murageGuard',{value:state});
})()`;

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };
export class BrowserDocumentGuard {
  private socket?: WebSocket;
  private sequence = 0;
  private pending = new Map<number, Pending>();
  private sessions = new Map<string, string>();
  private opening?: Promise<void>;
  private command: (args: string[]) => Promise<unknown>;
  private connectTimeoutMs: number;
  /** Cloud home only: opens the socket over the launcher relay instead of a TCP dial. */
  private connection?: () => Duplex;
  /** `connectTimeoutMs`: an attached owner's Chrome asks them to Allow this
   * connection, which takes a person, not 5 seconds (0.1.60 Linux D12). */
  private endpoint?: string;
  /** `endpoint`: a fixed loopback CDP address to use instead of asking the engine (the owner's Chrome, through Murage's one connection). */
  /** `scope`: the only pages to check ("Use my Chrome": the bot's own tabs, the only ones its engine can see). Without it, every page. */
  private scope?: () => { targets: ReadonlySet<string>; closed: number };
  /** How many bot tabs had closed when this check last looked. */
  private closedSeen = 0;
  constructor(command: (args: string[]) => Promise<unknown>, options: { connectTimeoutMs?: number; connection?: () => Duplex; endpoint?: string; scope?: () => { targets: ReadonlySet<string>; closed: number } } = {}) { this.scope = options.scope; this.command = command; this.connection = options.connection; this.connectTimeoutMs = options.connectTimeoutMs ?? 5000; this.endpoint = options.endpoint; }
  private fail() {
    for(const p of this.pending.values()) {clearTimeout(p.timer);p.reject(new Error("Browser document guard disconnected"));}
    this.pending.clear();this.sessions.clear();this.socket=undefined;this.opening=undefined;
  }
  private async open() {
    if(this.socket?.readyState===WebSocket.OPEN)return;
    if(this.opening)return this.opening;
    this.opening=(async()=>{
      const value=this.endpoint??await this.command(["get","cdp-url"]) as any;
      const endpoint=typeof value==="string"?value:value?.cdpUrl??value?.cdp_url??value?.url;
      const url=new URL(endpoint);
      if(url.protocol!=="ws:"||!["127.0.0.1","localhost","[::1]"].includes(url.hostname))throw new Error("Browser guard requires a local CDP endpoint");
      const socket=new WebSocket(url,{maxPayload:2*1024*1024,handshakeTimeout:this.connectTimeoutMs,...(this.connection?{createConnection:this.connection as never}:{})});this.socket=socket;
      socket.on("message",raw=>{
        try {const message=JSON.parse(raw.toString());
          if(message.id===undefined&&message.method==="Page.javascriptDialogOpening"&&typeof message.sessionId==="string"){this.answerDialog(message.params?.type,message.sessionId);return;}
          const p=this.pending.get(message.id);if(!p)return;this.pending.delete(message.id);clearTimeout(p.timer);if(message.error)p.reject(new Error("Browser document guard command refused"));else p.resolve(message.result);}
        catch{socket.terminate();}
      });
      socket.on("close",()=>this.fail());
      socket.on("error",()=>this.fail());
      await new Promise<void>((resolve,reject)=>{socket.once("open",resolve);socket.once("error",()=>reject(new Error("Browser guard unavailable")));});
    })();
    try {await this.opening;} catch(error){this.opening=undefined;throw error;}
  }
  /** While a bot's tool call is in flight, a JavaScript dialog the page opens is answered here: the call (a click that opened an alert)
   * cannot finish until it is, and the engine serves one command at a time. An alert or a beforeunload is accepted; a confirm or a prompt
   * is dismissed, so the bot never agrees to something on the owner's behalf. Off between calls, so a dialog the owner meets while
   * driving the page is theirs. */
  private answeringDialogs=false;
  answerDialogs(active:boolean){this.answeringDialogs=active;}
  private answerDialog(type:unknown,sessionId:string){
    if(!this.answeringDialogs)return;
    const accept=type==="alert"||type==="beforeunload";
    // A second answerer (the engine's own, on systems where it works) makes this fail with "no dialog showing": nothing to report.
    void this.send("Page.handleJavaScriptDialog",{accept},sessionId).catch(()=>{});
  }
  private send(method:string,params:Record<string,unknown>={},sessionId?:string):Promise<any>{
    if(this.socket?.readyState!==WebSocket.OPEN)return Promise.reject(new Error("Browser guard disconnected"));
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error("Browser guard timed out"));},5000);
      this.pending.set(id,{resolve,reject,timer});this.socket!.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));
    });
  }
  async protected(armed=true):Promise<boolean>{
    await this.open();
    const targets=await this.send("Target.getTargets");
    let pages=(targets.targetInfos as any[]).filter(t=>t.type==="page");
    if(this.scope){
      // The owner's own tabs are out of the engine's sight (user-chrome-proxy.ts), so only the bot's tabs are checked.
      const {targets:mine,closed}=this.scope();
      // A bot tab closed since the last look, or one Chrome no longer lists, may hold what this step read: refuse once.
      const listed=new Set(pages.map(t=>t.targetId));
      if(closed!==this.closedSeen){this.closedSeen=closed;throw new Error("Browser document inventory unavailable");}
      if([...mine].some(id=>!listed.has(id)))throw new Error("Browser document inventory unavailable");
      pages=pages.filter(t=>mine.has(t.targetId));
      // No bot tab yet, and none closed: no page has been opened or read, so nothing is protected.
      if(!pages.length)return false;
    }
    if(!pages.length||pages.length>20)throw new Error("Browser document inventory unavailable");
    let protectedDocument=false;
    for(const page of pages){
      let session=this.sessions.get(page.targetId);
      if(!session){
        const attached=await this.send("Target.attachToTarget",{targetId:page.targetId,flatten:true});session=attached.sessionId;
        await this.send("Page.enable",{},session);
        await this.send("Page.addScriptToEvaluateOnNewDocument",{source:BROWSER_DOCUMENT_GUARD_SOURCE,worldName:WORLD,runImmediately:true},session);
        this.sessions.set(page.targetId,session!);
      }
      await this.send("DOM.enable",{},session);
      // L11a: a targeted question in the isolated world (closed shadow roots included), never a dump of the DOM.
      if(await protectedDocumentTargeted((method,params={})=>this.send(method,params,session),BROWSER_DOCUMENT_GUARD_SOURCE,WORLD,armed))protectedDocument=true;
    }
    return protectedDocument;
  }
  // Same defect as the relay's `resetStream`, and the same fix. This guard
  // opens with a 5s handshakeTimeout, so "closed before connected" is a state
  // it reaches by design rather than by accident.
  /** Open the guard's own connection now (the owner's Chrome asks to Allow it). */
  warm():Promise<void>{return this.open();}
  close(){closeSocketQuietly(this.socket);this.fail();}
  /** Release the connection and every session this guard holds; the next protected() call opens afresh (re-arm). */
  dispose(){this.close();}
}
