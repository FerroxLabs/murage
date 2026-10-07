// SPDX-License-Identifier: AGPL-3.0-or-later
// Scoped browser-level CDP facade for the pinned existing agent-browser engine.
// Discovery ordering follows the qualified three-command experiment. No browser-wide CDP passthrough.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import { createServer, type Server } from "node:http";
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { agentBrowserIntegration, browserEngineEncryptionKey, browserEngineStatus, verifyAgentBrowserBinary, type AgentBrowserSpec } from "./browser-engine.ts";
import { startHeadlessEngine, type EngineClient } from "./drivers/headless-browser-proxy.ts";
import { listHeadlessBrowserTools, validateHeadlessBrowserCall } from "./browser-engine-policy.ts";
import { ReadLayer } from "./browser-extension-snapshot.ts";
import { extensionRefusal } from "./browser-extension-refusals.ts";
import type { ExtensionDocument } from "./browser-extension-executor.ts";

type Json = Record<string, unknown>;
export const EXTENSION_ENGINE_TOOL_NAMES = ["open","read","snapshot","click","fill","type","press","check","uncheck","select","scroll","wait_ms","wait_for_selector","wait_for_text","wait_for_load","screenshot","get_text","get_url","get_title","close","back","forward","reload","tab_new","tab_list","tab_switch","tab_close"] as const;
const PINNED_TOOL_METADATA = [{"name":"agent_browser_open","description":"Launch the browser and optionally navigate to a URL."},{"name":"agent_browser_read","description":"Fetch a URL as agent-readable text, preferring text/markdown. Omit url to read the active tab."},{"name":"agent_browser_snapshot","description":"Return an accessibility-tree snapshot with stable element refs."},{"name":"agent_browser_click","description":"Click an element by @ref or CSS selector."},{"name":"agent_browser_fill","description":"Clear and fill an input by @ref or CSS selector."},{"name":"agent_browser_type","description":"Type text into an element by @ref or CSS selector."},{"name":"agent_browser_press","description":"Press a key at the current focus."},{"name":"agent_browser_check","description":"Check a checkbox or switch."},{"name":"agent_browser_uncheck","description":"Uncheck a checkbox or switch."},{"name":"agent_browser_select","description":"Select one or more options in a select element."},{"name":"agent_browser_scroll","description":"Scroll the page or an element."},{"name":"agent_browser_wait_ms","description":"Wait for a fixed time."},{"name":"agent_browser_wait_for_selector","description":"Wait for an element to appear."},{"name":"agent_browser_wait_for_text","description":"Wait for text to appear."},{"name":"agent_browser_wait_for_load","description":"Wait for a page load state."},{"name":"agent_browser_screenshot","description":"Capture a screenshot and return the saved path. Small PNG/JPEG screenshots are also returned as image content."},{"name":"agent_browser_get_text","description":"Get visible text from an element."},{"name":"agent_browser_get_url","description":"Get the current page URL."},{"name":"agent_browser_get_title","description":"Get the current page title."},{"name":"agent_browser_close","description":"Close the current browser session."},{"name":"agent_browser_back","description":"Navigate back."},{"name":"agent_browser_forward","description":"Navigate forward."},{"name":"agent_browser_reload","description":"Reload the page."},{"name":"agent_browser_tab_new","description":"Open a new tab."},{"name":"agent_browser_tab_list","description":"List tabs."},{"name":"agent_browser_tab_switch","description":"Switch to a tab by id (t1), label, or CDP target id. Switching also binds the session to that tab."},{"name":"agent_browser_tab_close","description":"Close a tab by id (t1), label, or CDP target id. Omit to close the current tab."}];
export const extensionEngineTools = () => listHeadlessBrowserTools(PINNED_TOOL_METADATA);
/** `frameId` is set only by an engine that knows the node's own frame; absent means the node was resolved in the top document. */
export type EngineObject = { backendNodeId: number; document: ExtensionDocument; frameId?: string };
export interface BrowserExtensionEngineTransport {
  documents(): Promise<ExtensionDocument[]>;
  selected(): Promise<ExtensionDocument>;
  send(method:string,params:Json,document:ExtensionDocument):Promise<any>;
  newTab(url:string):Promise<ExtensionDocument>;
  closeTab(tabId:number):Promise<void>;
  selectTab(tabId:number):Promise<ExtensionDocument>;
}
export interface BrowserExtensionEngineBackend {
  call(name:string,args:Json):Promise<unknown>;
  resolveTarget(selector:string):Promise<EngineObject>;
  resolveTab(tab?:string):Promise<ExtensionDocument>;
  event(tabId:number,navigationEpoch:number,method:string,params:Json):void;
  close():Promise<void>;
}
export interface BrowserExtensionEngineOptions {
  dataDir:string; realmId:string; bindingId:string;
  transport:BrowserExtensionEngineTransport;
  authorize:()=>boolean;
  authorizationError?:()=>Error;
  beforeCommand:(document:ExtensionDocument,method:string,params:Json)=>Promise<void>;
  beforeDestination:(url:string,document:ExtensionDocument)=>Promise<void>;
  engineFactory?: (spec:AgentBrowserSpec)=>EngineClient;
}
const BOOTSTRAP_SETUP = new Set(["Page.enable","Page.disable","Runtime.enable","Runtime.disable","DOM.enable","DOM.disable","Accessibility.enable","Accessibility.disable","Network.enable","Network.disable","Runtime.runIfWaitingForDebugger","Target.setAutoAttach"]);
const targetId=(tabId:number)=>tabId.toString(16).padStart(32,"0");
/** The dialogs the pinned engine accepts by itself. Murage answers these instead (see answerOwnDialog); a confirm or prompt stays the engine's and the owner's. */
const SELF_ANSWERED_DIALOGS=new Set(["alert","beforeunload"]);
export class BrowserExtensionEngine {
  private options:BrowserExtensionEngineOptions;
  private server?:Server;
  private sockets?:WebSocketServer;
  private socket?:WebSocket;
  private client?:EngineClient;
  private starting?:Promise<void>;
  private sessions=new Map<string,number>();
  private known=new Map<number,ExtensionDocument>();
  private capture?:EngineObject;
  private closed=false;
  private sequence=0;
  private targetFile?:string;
  private relaySecret="";
  private wireQueue=Promise.resolve();
  private wirePending=0;
  private callRefusal?: { first?: unknown };
  constructor(options:BrowserExtensionEngineOptions){this.options=options;}
  private authorized(){if(this.closed||!this.options.authorize())throw this.options.authorizationError?.() ?? Error("Browser control is no longer authorised.");}
  private emit(message:Json){if(this.socket?.readyState===WebSocket.OPEN)this.socket.send(JSON.stringify(message));}
  private target(document:ExtensionDocument){return{targetId:targetId(document.tabId),type:"page",title:"",url:document.url,attached:true,canAccessOpener:false,browserContextId:"murage-binding"};}
  private session(tabId:number){let id=[...this.sessions].find(([,tab])=>tab===tabId)?.[0];if(!id){id=`murage-tab-${++this.sequence}`;this.sessions.set(id,tabId);}return id;}
  private async inventory(){this.authorized();const docs=await this.options.transport.documents();this.authorized();for(const doc of docs)this.known.set(doc.tabId,doc);for(const id of this.known.keys())if(!docs.some(doc=>doc.tabId===id)){this.known.delete(id);const session=[...this.sessions].find(([,tab])=>tab===id);if(session){this.sessions.delete(session[0]);this.emit({method:"Target.detachedFromTarget",params:{sessionId:session[0],targetId:targetId(id)}});}this.emit({method:"Target.targetDestroyed",params:{targetId:targetId(id)}});}return docs;}
  private async document(sessionId:string){const tabId=this.sessions.get(sessionId);if(tabId===undefined)throw Error("Browser session does not belong to this binding.");const doc=(await this.inventory()).find(doc=>doc.tabId===tabId);if(!doc)throw Error("The shared tab was removed.");return doc;}
  /** Optional engine probes may recover from CDP errors. An authority or policy refusal cannot be recovered that way: it belongs to the tool call in flight. */
  private keepRefusal(error:unknown,refusal:{first?:unknown}|undefined){
    const code=(error as {code?:string})?.code;
    if(refusal&&refusal.first===undefined&&(extensionRefusal(error)||code==="browser_extension_refused"||this.closed||!this.options.authorize()))refusal.first=error;
  }
  /** An alert or a beforeunload, answered by Murage itself. The pinned engine would accept these from a background task that, on Windows,
   * never sends the answer: the task first writes to its daemon's stderr, a pipe from the short-lived CLI that started the daemon (only Unix
   * points it at /dev/null), and the failed write ends the task. The click that opened the dialog then waited out its input deadline and
   * was fenced. The answer takes the same path an engine answer took (admission and its card, then past the queue), and the engine never
   * sees the opening, so exactly one answer is ever sent. A refusal belongs to the call in flight, as an engine answer's did. */
  private answerOwnDialog(sessionId:string){
    const refusal=this.callRefusal;
    void this.command("Page.handleJavaScriptDialog",{accept:true},sessionId).catch(error=>this.keepRefusal(error,refusal));
  }
  /** One CDP command from the pinned engine. Commands run one at a time, in order. */
  private dispatchWire(raw:string,overflow:()=>void=()=>{}){
    if(++this.wirePending>64){overflow();return;}
    const refusal = this.callRefusal;
    const run=async()=>{let command:any;try{command=JSON.parse(raw);if(!Number.isSafeInteger(command.id)||typeof command.method!=="string"||(command.params!==undefined&&(!command.params||typeof command.params!=="object")))throw Error("Invalid CDP command");const result=await this.command(command.method,command.params,command.sessionId);this.emit({id:command.id,...(command.sessionId?{sessionId:command.sessionId}:{}),result});}catch(error){
      const code = (error as { code?: string })?.code;
      const known = extensionRefusal(error);
      this.keepRefusal(error, refusal);
      const reason = known?.error ?? (code === "browser_extension_refused" && error instanceof Error ? error.message : "Browser authority, document or operation refused.");
      if(command?.id!==undefined)this.emit({id:command.id,...(command.sessionId?{sessionId:command.sessionId}:{}),error:{code:-32000,message:this.relaySecret?reason.replaceAll(this.relaySecret,"private-browser-connection"):reason}});
    }};
    // The answer to a dialog is the one command that must not wait its turn: the command ahead of it (the click that opened the
    // dialog) cannot finish until the dialog is answered.
    let urgent=false;try{const peek=JSON.parse(raw);urgent=peek?.method==="Page.handleJavaScriptDialog"&&typeof peek.sessionId==="string";}catch{/* run() reports it */}
    if(urgent){void run().finally(()=>{this.wirePending--;});return;}
    this.wireQueue=this.wireQueue.then(run).finally(()=>{this.wirePending--;});
  }
  private async command(method:string,params:Json={},sessionId?:string):Promise<any>{
    // The close command probes this harmless constant before stopping its daemon.
    if(!sessionId&&method==="Browser.getVersion")return{protocolVersion:"1.3",product:"Chrome/Murage-Scoped-Extension",userAgent:"Murage Browser",jsVersion:"V8"};
    this.authorized();
    if(!sessionId){
      if(method==="Browser.setDownloadBehavior")return{};
      if(method==="Target.setDiscoverTargets"||method==="Target.setAutoAttach"){
        for(const doc of await this.inventory()){const id=this.session(doc.tabId);this.emit({method:"Target.targetCreated",params:{targetInfo:this.target(doc)}});if(method==="Target.setAutoAttach")this.emit({method:"Target.attachedToTarget",params:{sessionId:id,targetInfo:this.target(doc),waitingForDebugger:false}});}return{};
      }
      if(method==="Target.getTargets")return{targetInfos:(await this.inventory()).map(doc=>this.target(doc))};
      if(method==="Target.createTarget"){
        const url=typeof params.url==="string"?params.url:"about:blank";
        if(url!=="about:blank")await this.options.beforeDestination(url,await this.options.transport.selected());
        const doc=await this.options.transport.newTab(url);this.authorized();this.known.set(doc.tabId,doc);const id=this.session(doc.tabId);this.emit({method:"Target.targetCreated",params:{targetInfo:this.target(doc)}});this.emit({method:"Target.attachedToTarget",params:{sessionId:id,targetInfo:this.target(doc),waitingForDebugger:false}});return{targetId:targetId(doc.tabId)};
      }
      if(["Target.attachToTarget","Target.getTargetInfo","Target.closeTarget","Target.activateTarget"].includes(method)){
        const doc=(await this.inventory()).find(doc=>targetId(doc.tabId)===params.targetId);if(!doc)throw Error("Target is outside this browser binding.");
        if(method==="Target.attachToTarget"){if(params.flatten!==true)throw Error("Flattened target sessions required.");return{sessionId:this.session(doc.tabId)};}
        if(method==="Target.getTargetInfo")return{targetInfo:this.target(doc)};
        if(method==="Target.closeTarget"){await this.options.transport.closeTab(doc.tabId);await this.inventory();return{success:true};}
        await this.options.transport.selectTab(doc.tabId);return{};
      }
      if(method==="Target.detachFromTarget"){if(typeof params.sessionId!=="string"||!this.sessions.has(params.sessionId))throw Error("Unknown browser session.");this.sessions.delete(params.sessionId);return{};}
      throw Error("Browser-wide command is not permitted.");
    }
    if(method.startsWith("Storage.")||(method.startsWith("Network.")&&!['Network.enable','Network.disable'].includes(method)))throw Error("Browser storage and network payload access is not permitted.");
    const doc=await this.document(sessionId);
    if(method==="Target.getTargetInfo")return{targetInfo:this.target(doc)};
    if(method==="Target.setAutoAttach")return{}; // Child frames remain protected, never exposed as new authority.
    if(method==="Page.bringToFront"){await this.options.transport.selectTab(doc.tabId);return{};}
    if(doc.url==="about:blank"){
      if(BOOTSTRAP_SETUP.has(method))return this.options.transport.send(method,params,doc);
      if(method==="Runtime.evaluate"){
        const values:Record<string,unknown>={"1":1,"location.href":"about:blank","document.title":"","document.readyState":"complete","document.readyState === 'complete'":true,"document.readyState !== 'loading'":true};
        if(typeof params.expression!=="string"||!Object.hasOwn(values,params.expression))throw Error("Bootstrap tab cannot be inspected.");
        const value=values[params.expression];return{result:{type:typeof value,value}};
      }
      if(method!=="Page.navigate")throw Error("Navigate the bootstrap tab before using it.");
    }
    // Pinned agent-browser back/forward uses these exact evaluate calls. Convert
    // them to scoped history navigation so the runtime sees an acknowledged navigation.
    if(method==="Runtime.evaluate"&&(params.expression==="history.back()"||params.expression==="history.forward()")){
      if(Object.keys(params).sort().join(",")!=="awaitPromise,expression,returnByValue"||params.returnByValue!==true||params.awaitPromise!==true)throw Error("Unsupported history command shape.");
      const original={...doc};
      await this.options.beforeCommand(original,method,params);this.authorized();
      const history=await this.options.transport.send("Page.getNavigationHistory",{},original);
      if(!Number.isSafeInteger(history.currentIndex)||!Array.isArray(history.entries))throw Error("Browser history is unavailable.");
      const offset=params.expression==="history.back()"?-1:1;
      const index=history.currentIndex+offset;
      if(index<0||index>=history.entries.length)return{result:{type:"undefined"}};
      const entry=history.entries[index];
      if(!Number.isSafeInteger(entry?.id)||typeof entry?.url!=="string")throw Error("Browser history destination is unavailable.");
      const entryId=entry.id,entryUrl=entry.url;
      await this.options.beforeDestination(entryUrl,original);this.authorized();
      const current=await this.document(sessionId);
      if(current.profileId!==original.profileId||current.tabId!==original.tabId||current.frameId!==original.frameId||current.navigationEpoch!==original.navigationEpoch||current.origin!==original.origin||current.url!==original.url)throw Error("The document changed during history approval.");
      await this.options.beforeCommand(original,method,params);this.authorized();
      const refreshed=await this.options.transport.send("Page.getNavigationHistory",{},original);
      const adjacent=Array.isArray(refreshed.entries)&&Number.isSafeInteger(refreshed.currentIndex)?refreshed.entries[refreshed.currentIndex+offset]:undefined;
      if(!adjacent||adjacent.id!==entryId||adjacent.url!==entryUrl)throw Error("The history destination changed during approval.");
      this.authorized();await this.options.transport.send("Page.navigateToHistoryEntry",{entryId},original);this.authorized();
      return{result:{type:"undefined"}};
    }
    if(method==="Page.navigate"){
      if(typeof params.url!=="string")throw Error("Navigation URL required.");await this.options.beforeDestination(params.url,doc);
    }else if(doc.url!=="about:blank")await this.options.beforeCommand(doc,method,params);
    this.authorized();const response=await this.options.transport.send(method,params,doc);this.authorized();
    const object=response?.object??response?.result;
    if(object?.subtype==="node"&&typeof object.objectId==="string"){
      const described=await this.options.transport.send("DOM.describeNode",{objectId:object.objectId,depth:0},doc);
      if(Number.isSafeInteger(described.node?.backendNodeId))this.capture={backendNodeId:described.node.backendNodeId,document:{...doc},frameId:await this.frameOf(doc,described.node.backendNodeId)};
    }
    return response;
  }
  /** The frame a node really lives in, asked of the browser in Murage's own isolated world (the page cannot answer for itself): the page's own frame id when the
   * node belongs to the page's document, and `<frame>:embedded` for a node in an embedded frame, or one the page's world cannot even resolve (another process). */
  private async frameOf(doc:ExtensionDocument,backendNodeId:number):Promise<string>{
    try{
      const tree=await this.options.transport.send("Page.getFrameTree",{},doc);
      const world=await this.options.transport.send("Page.createIsolatedWorld",{frameId:tree.frameTree.frame.id,worldName:"murage-engine-frame-v1"},doc);
      const resolved=await this.options.transport.send("DOM.resolveNode",{backendNodeId,executionContextId:world.executionContextId},doc);
      const objectId=resolved?.object?.objectId;if(typeof objectId!=="string")return `${doc.frameId}:embedded`;
      const owner=await this.options.transport.send("Runtime.callFunctionOn",{objectId,functionDeclaration:"function(){return this===document||this.ownerDocument===document;}",returnByValue:true},doc);
      return owner?.result?.value===true?doc.frameId:`${doc.frameId}:embedded`;
    }catch{return `${doc.frameId}:embedded`;}
  }
  private async start(){
    this.authorized();if(this.client)return;if(this.starting)return this.starting;
    this.starting=(async()=>{
      const secret=randomBytes(32).toString("hex");this.relaySecret=secret;const route=`/devtools/browser/${secret}`;
      const server=createServer((_req,res)=>{res.writeHead(404);res.end();});this.server=server;
      const sockets=new WebSocketServer({noServer:true,maxPayload:1024*1024});this.sockets=sockets;
      await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve)});
      const address=server.address();if(!address||typeof address==="string")throw Error("Browser relay unavailable.");
      server.on("upgrade",(req,socket,head)=>{
        const valid= !req.headers.origin&&req.headers.host===`127.0.0.1:${address.port}`&&typeof req.url==="string"&&Buffer.byteLength(req.url)===Buffer.byteLength(route)&&timingSafeEqual(Buffer.from(req.url),Buffer.from(route))&&!this.socket;
        if(!valid){socket.destroy();return;}sockets.handleUpgrade(req,socket,head,ws=>{this.socket=ws;ws.on("message",raw=>{this.dispatchWire(raw.toString(),()=>ws.close(1013));});ws.on("error",()=>{});ws.on("close",()=>{if(this.socket===ws)this.socket=undefined;});});
      });
      const status=browserEngineStatus({dataDir:this.options.dataDir});if(status.kind!=="ready")throw Error(status.reason);
      const spec=agentBrowserIntegration({binaryPath:status.binaryPath,session:`mbe-${createHash("sha256").update(this.options.bindingId).digest("hex").slice(0,28)}`,encryptionKey:browserEngineEncryptionKey(this.options.dataDir),dataDir:this.options.dataDir,realmId:this.options.realmId,attachCdpUrl:`ws://127.0.0.1:${address.port}${route}`,persistent:false});
      await verifyAgentBrowserBinary(spec.command,spec.env);
      // Supported pinned engine target record: avoid creating an unrelated blank tab
      // when the owner explicitly selected an already-shared tab.
      const selected=await this.options.transport.selected();
      this.targetFile=join(spec.env.AGENT_BROWSER_SOCKET_DIR!,`${spec.env.AGENT_BROWSER_SESSION}.target`);
      writeFileAtomic(this.targetFile,JSON.stringify({targetId:targetId(selected.tabId),url:selected.url,pinned:true}),{mode:0o600});
      this.client=(this.options.engineFactory??startHeadlessEngine)(spec);
      await this.client.request("initialize",{protocolVersion:"2024-11-05",capabilities:{},clientInfo:{name:"murage-browser",version:"1"}});
      const listed=await this.client.request("tools/list") as {tools?:unknown};const actual=listHeadlessBrowserTools(listed.tools).map(tool=>tool.name).sort();const expected=extensionEngineTools().map(tool=>tool.name).sort();if(JSON.stringify(actual)!==JSON.stringify(expected))throw Error("Pinned browser tool contract changed.");
    })();
    try{await this.starting;}catch(error){await this.dispose();throw error;}
  }
  async call(name:string,args:Json){
    validateHeadlessBrowserCall(name,args);
    if(name==="agent_browser_read")throw Error("Network read must use the mediated reader.");
    const refusal: { first?: unknown } = {};
    this.callRefusal = refusal;
    try {
      await this.start();this.authorized();
      if(name!=="agent_browser_close"&&name!=="agent_browser_tab_switch"){
        const selected=await this.options.transport.selected();let pin:{targetId?:string}={};try{pin=JSON.parse(readFileSync(this.targetFile!,"utf8"));}catch{}
        if(pin.targetId!==targetId(selected.tabId)){const switched=await this.client!.request("tools/call",{name:"agent_browser_tab_switch",arguments:{tab:targetId(selected.tabId)}}) as {isError?:boolean};if(switched.isError)throw Error("The selected shared tab could not be bound.");}
      }
      const value=await this.client!.request("tools/call",{name,arguments:args});
      if (refusal.first !== undefined) throw refusal.first;
      this.authorized();
      return this.relaySecret?JSON.parse(JSON.stringify(value).replaceAll(this.relaySecret,"private-browser-connection")):value;
    } catch (error) { throw refusal.first ?? error; }
    finally { if (this.callRefusal === refusal) this.callRefusal = undefined; }
  }
  async resolveTarget(selector:string):Promise<EngineObject>{this.capture=undefined;const value=await this.call("agent_browser_get_text",{selector}) as {isError?:boolean};if(value?.isError||!this.capture)throw Error("The browser target could not be resolved.");return structuredClone(this.capture);}
  async resolveTab(tab?:string):Promise<ExtensionDocument>{
    if(tab===undefined)return this.options.transport.selected();
    const response=await this.call("agent_browser_tab_list",{}) as {isError?:boolean;structuredContent?:{response?:{data?:{tabs?:{tabId:string;targetId:string;label?:string}[]}}}};
    const matches=response.structuredContent?.response?.data?.tabs?.filter(item=>item.tabId===tab||item.targetId===tab||item.label===tab)??[];
    if(response.isError||matches.length!==1)throw Error("The browser tab is not available in this binding.");
    const document=(await this.inventory()).find(doc=>targetId(doc.tabId)===matches[0].targetId);if(!document)throw Error("The browser tab is no longer shared.");return structuredClone(document);
  }
  event(tabId:number,navigationEpoch:number,method:string,params:Json){if(this.closed||!this.options.authorize())return;const session=[...this.sessions].find(([,id])=>id===tabId)?.[0];if(!session)return;const known=this.known.get(tabId);if(!known||navigationEpoch<known.navigationEpoch)return;if(method==="Page.javascriptDialogOpening"&&SELF_ANSWERED_DIALOGS.has(String(params.type))){this.answerOwnDialog(session);return;}this.emit({sessionId:session,method,params});}
  async dispose(){
    if(this.client){const client=this.client;this.client=undefined;try{if(this.socket?.readyState===WebSocket.OPEN)await client.request("tools/call",{name:"agent_browser_close",arguments:{}});}catch{}await client.close();}
    this.socket?.terminate();this.socket=undefined;this.sockets?.close();this.sockets=undefined;
    const server=this.server;this.server=undefined;if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));this.sessions.clear();this.known.clear();this.starting=undefined;
  }
  /** Murage-owned snapshot, refs and diff for one document (spec 6.1). The core lane keeps one per tab and calls it from the executor. */
  readLayer(document:ExtensionDocument,origin:()=>string):ReadLayer{return new ReadLayer((method,params)=>this.options.transport.send(method,(params??{}) as Json,document),{origin,url:()=>document.url});}
  async close(){this.closed=true;await this.dispose();}
}
