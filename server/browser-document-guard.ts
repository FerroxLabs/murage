// Protected-document state lives in a CDP isolated world: page scripts cannot
// reset it. Capture listeners run before page handlers on future documents.
// A guard is installed before every mediated action, including new tabs.
import WebSocket from "ws";
const WORLD = "murage-protected-document-v1";
const SOURCE = `(() => {
  if(globalThis.__murageGuard) return;
  const re=/password|passwd|passcode|secret|api.?key|private.?key|access.?token|auth.?token|refresh.?token|one.?time|otp|verification.?code|recovery|seed.?phrase|mnemonic|cc-|card.?number|cvv|cvc|bank.?account|routing|social.?security|ssn/i;
  let tainted=false, armed=false;
  const sensitive=e=>e&&e.nodeType===1&&e.matches('input,textarea,[contenteditable]')&&re.test([e.type,e.name,e.id,e.autocomplete,e.getAttribute('aria-label'),e.getAttribute('placeholder')].join(' '));
  const scan=root=>[...root.querySelectorAll('*')].some(e=>e.tagName==='IFRAME'||sensitive(e)||(e.shadowRoot&&scan(e.shadowRoot)));
  const state=()=>tainted||scan(document);
  state.enable=value=>{armed=value;}; Object.defineProperty(globalThis,'__murageGuard',{value:state});
  for(const type of ['beforeinput','input','change','keydown','click','pointerdown','mousedown','submit']) document.addEventListener(type,e=>{
    if(state()||e.composedPath().some(sensitive)) { tainted=true; if(armed){e.preventDefault(); e.stopImmediatePropagation();} }
  },true);
})()`;

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };
export class BrowserDocumentGuard {
  private socket?: WebSocket;
  private sequence = 0;
  private pending = new Map<number, Pending>();
  private sessions = new Map<string, string>();
  private opening?: Promise<void>;
  private command: (args: string[]) => Promise<unknown>;
  constructor(command: (args: string[]) => Promise<unknown>) { this.command = command; }
  private fail() {
    for(const p of this.pending.values()) {clearTimeout(p.timer);p.reject(new Error("Browser document guard disconnected"));}
    this.pending.clear();this.sessions.clear();this.socket=undefined;this.opening=undefined;
  }
  private async open() {
    if(this.socket?.readyState===WebSocket.OPEN)return;
    if(this.opening)return this.opening;
    this.opening=(async()=>{
      const value=await this.command(["get","cdp-url"]) as any;
      const endpoint=typeof value==="string"?value:value?.cdpUrl??value?.cdp_url??value?.url;
      const url=new URL(endpoint);
      if(url.protocol!=="ws:"||!["127.0.0.1","localhost","[::1]"].includes(url.hostname))throw new Error("Browser guard requires a local CDP endpoint");
      const socket=new WebSocket(url,{maxPayload:2*1024*1024,handshakeTimeout:5000});this.socket=socket;
      socket.on("message",raw=>{
        try {const message=JSON.parse(raw.toString());const p=this.pending.get(message.id);if(!p)return;this.pending.delete(message.id);clearTimeout(p.timer);if(message.error)p.reject(new Error("Browser document guard command refused"));else p.resolve(message.result);}
        catch{socket.terminate();}
      });
      socket.on("close",()=>this.fail());
      socket.on("error",()=>this.fail());
      await new Promise<void>((resolve,reject)=>{socket.once("open",resolve);socket.once("error",()=>reject(new Error("Browser guard unavailable")));});
    })();
    try {await this.opening;} catch(error){this.opening=undefined;throw error;}
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
    const pages=(targets.targetInfos as any[]).filter(t=>t.type==="page");
    if(!pages.length||pages.length>20)throw new Error("Browser document inventory unavailable");
    let protectedDocument=false;
    for(const page of pages){
      let session=this.sessions.get(page.targetId);
      if(!session){
        const attached=await this.send("Target.attachToTarget",{targetId:page.targetId,flatten:true});session=attached.sessionId;
        await this.send("Page.enable",{},session);
        await this.send("Page.addScriptToEvaluateOnNewDocument",{source:SOURCE,worldName:WORLD,runImmediately:true},session);
        this.sessions.set(page.targetId,session!);
      }
      const tree=await this.send("Page.getFrameTree",{},session);
      if(tree.frameTree.childFrames?.length)protectedDocument=true;
      const world=await this.send("Page.createIsolatedWorld",{frameId:tree.frameTree.frame.id,worldName:WORLD},session);
      // Existing documents may predate runImmediately. Idempotent installation.
      const result=await this.send("Runtime.evaluate",{expression:`${SOURCE}; globalThis.__murageGuard.enable(${armed}); globalThis.__murageGuard()`,contextId:world.executionContextId,returnByValue:true},session);
      if(result.exceptionDetails||result.result?.type!=="boolean")throw new Error("Browser document guard could not inspect the page");
      if(result.result.value)protectedDocument=true;
    }
    return protectedDocument;
  }
  close(){this.socket?.removeAllListeners();this.socket?.terminate();this.fail();}
}
