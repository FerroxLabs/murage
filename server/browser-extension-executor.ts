// SPDX-License-Identifier: AGPL-3.0-or-later
// Trusted semantic executor. Model parameters are data, never JavaScript/CDP.
import { createHash, createHmac, randomBytes } from "node:crypto";
import { inspectClosedRoots } from "./browser-extension-dom-inspection.ts";
import { BROWSER_DOCUMENT_GUARD_SOURCE } from "./browser-document-guard.ts";
import { isClipboardInput, isClipboardKeyName } from "../shared/browser-clipboard.ts";
import { COMPOSED_ACTIVE_SOURCE, COMPOSED_HIT_TEST_SOURCE, DESCRIBE_TARGET_SOURCE, HTML_LENGTH_EXPRESSION, htmlSliceExpression, presentedLinkExpression } from "./browser-extension-page-scripts.ts";
import { collectFloorFacts, type FloorFactsExtra, type FloorFactsIo, type FloorTarget } from "./browser-floor-facts.ts";
import { classifyFloor, type FloorFacts, type FloorResult } from "./browser-floor.ts";
import { ACCOUNT_OWNER_PHRASE, FLOOR_OWNER_PHRASE } from "../shared/browser-floor-signatures.ts";
import { withoutSecretValues } from "./browser-recipient-safety.ts";
import { ReadLayerError, type ReadLayer } from "./browser-extension-snapshot.ts";
import { validateHeadlessBrowserCall } from "./browser-engine-policy.ts";
import { redactSecretUrl } from "../shared/browser-secret-classifier.ts";

import { extensionEngineTools, type BrowserExtensionEngineBackend, type EngineObject } from "./browser-extension-engine.ts";
import { readWithBrowserAuthority, type EngineReadOptions } from "./browser-extension-engine-read.ts";
type Json = Record<string, unknown>;
export type ExtensionDocument = { profileId: string; tabId: number; frameId: string; navigationEpoch: number; origin: string; url: string };
export interface ExtensionCdpTransport {
  document(tabId?: number): Promise<ExtensionDocument>;
  send(method: string, params: Json, document: ExtensionDocument): Promise<any>;
}
export type ExtensionAction = { name: string; arguments: Json; document: ExtensionDocument; digest: string; summary: string; mutation: boolean; presentedLink?: boolean;
  /** What a push notification may say: the operation, the site and field names with a count. Never typed text or values. */
  pushSummary?: string;
  /** The facts the floor and the level were judged on, with the target's visibility block (T23W). Absent for actions with no target. */
  facts?: FloorFacts & { visibility?: unknown };
  /** The activity log's target label and whether the page wrote it, and the length (never the text) of what is typed. */
  target?: string; fromPage?: boolean; textLength?: number;
  /** The actual element this step acts on (round 6): the engine's node id and the frame it lives in. Absent for a step with no target. */
  node?: { backendNodeId: number; frameId: string };
  /** Set by the service when the card is one of the always-ask kinds (D1): the card says Murage asks every time. */
  cardKind?: "delete" | "newRecipient" };
/** The hard floor asked for the owner (spec 2.5.1). `text` is the plain sentence the bot reads. */
export type ExtensionFloorHandoff = { result: FloorResult; operation: string; document: ExtensionDocument; text: string };
/** What the executor reports to the activity log itself: the decisions the service cannot see. */
export type ExtensionActivityEvent = { operation: string; document: ExtensionDocument; decision: "your turn" | "not done"; outcome: "handed over" | "failed"; level: 1 | 2 | 3; target?: string; fromPage?: boolean; textLength?: number };
export interface ExtensionExecutorOptions {
  transport: ExtensionCdpTransport;
  authorize: () => boolean;
  authorizationError?: () => Error;
  // Access precedes all page observations. Action approval follows protected target inspection.
  access: (document: ExtensionDocument, destination?: string) => Promise<boolean>;
  admit: (action: ExtensionAction) => Promise<boolean>;
  settled?: () => void;
  /** Test seam for the facts collector. Production uses collectFloorFacts. A collector that throws is floor. */
  collectFacts?: (io: FloorFactsIo, target: FloorTarget | undefined, operation: string, extra?: FloorFactsExtra) => Promise<FloorFacts>;
  /** Called before the refusal when the floor asks for the owner: the service pauses the binding and tells the owner. */
  onFloor?: (info: ExtensionFloorHandoff) => Promise<void> | void;
  activity?: (event: ExtensionActivityEvent) => void;
  /** T52: phase timestamps of a turn (admitted, first visible content, first input dispatch), in milliseconds on a monotonic clock. */
  phase?: (event: { phase: "admitted" | "first_content" | "first_input"; at: number; sinceAdmitted: number; operation: string }) => void;
  createEngine?: (hooks: { beforeCommand: (document:ExtensionDocument,method:string,params:Json)=>Promise<void>; beforeDestination: (url:string,document:ExtensionDocument)=>Promise<void> }) => BrowserExtensionEngineBackend;
}
// Looking around changes nothing, so it needs no card: scrolling joins the reads.
const reads = new Set(["read","snapshot","screenshot","get_text","get_url","get_title","tab_list","wait_ms","wait_for_selector","wait_for_text","wait_for_load","scroll"]);
const navigation = new Set(["open","back","forward","reload","tab_new","tab_switch"]);
const administrative = new Set(["close","tab_close","tab_new","tab_list","tab_switch"]);
/** Items Murage's own read layer already fenced (T24), so the service does not fence them a second time. */
const markFenced = (output: unknown): unknown => {
  const content = (output as { content?: unknown } | undefined)?.content;
  if (!output || typeof output !== "object" || !Array.isArray(content)) return output;
  return { ...(output as object), content: content.map(item => item && typeof item === "object" ? { ...(item as object), murage: true } : item) };
};
const refuse = (message: string): never => { throw Object.assign(new Error(message), { code: "browser_extension_refused", status: 409 }); };
// These refusals already explain a control change. An inspection fallback must not replace them with a page handoff.
const isAuthorityRefusal = (error: unknown) => ["browser_extension_refused", "uncertain", "stale_binding", "stale_generation", "binding_inactive", "binding_unauthorized", "host_offline", "stale_document"].includes(String((error as { code?: unknown })?.code));
const sameDocument = (a: ExtensionDocument, b: ExtensionDocument) => a.profileId === b.profileId && a.tabId === b.tabId && a.frameId === b.frameId && a.navigationEpoch === b.navigationEpoch && a.origin === b.origin;
// Reviewing a long email body is normal; the card shows it collapsed. Beyond this the action is not reviewable.
const MAX_REVIEW_CHARS = 12000;
// Operations that leave a page (or only look at tabs): they stay possible on a page that needs the owner.
const escapes = new Set(["open","tab_new","tab_list","tab_switch","tab_close","close"]);
// Commands that only prepare or move, never read the page: allowed while the document is protected, for an escape.
const ESCAPE_SETUP = new Set(["Page.enable","Page.disable","Runtime.enable","Runtime.disable","DOM.enable","DOM.disable","Accessibility.enable","Accessibility.disable","Network.enable","Network.disable","Page.setLifecycleEventsEnabled","Page.bringToFront","Page.getNavigationHistory","Page.getFrameTree","Runtime.runIfWaitingForDebugger"]);
// Looking around: keys that only move focus or the viewport are free (never Enter, Space or the arrows, which can act).
const FREE_KEYS = new Set(["tab","shift+tab","pageup","pagedown","home","end"]);
const freeKey = (key: unknown) => typeof key === "string" && FREE_KEYS.has(key.trim().toLowerCase().replace(/\s+/g, ""));
type Detail = { display: { tag?: string; role?: string | null; label?: string; text?: string; href?: string | null; form?: { action?: string; method?: string } | null; submit?: { action?: string; method?: string } | null; fieldCount?: number; fieldNames?: string[] } & Record<string, unknown>; bound: unknown };
// One card line per fact: page text (and model text) never starts a line of its own on the card, which is a <pre>.
const flat = (value: unknown) => String(value ?? "").replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]+/g, " ");
const jsonLine = (value: unknown) => JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
const docKey = (d: ExtensionDocument) => JSON.stringify([d.profileId, d.tabId, d.frameId, d.navigationEpoch, d.origin]);

/** Round 8 (SEC-10): a field's live value is bound into the action digest only through a keyed digest whose key lives in this process's memory
 * and is never written anywhere. The value itself is never shown, hashed bare (a six-digit code would fall to a dictionary) or stored. */
const VALUE_KEY = randomBytes(32);
/** Enter and Space activate what has focus (a submit, a button); the rest of the keyboard only types or moves. */
const activationKeyEvent = (params: Json) => {
  const key = String(params.key ?? params.code ?? ""), text = String(params.text ?? "");
  return ["Enter", "NumpadEnter", " ", "Space", "Spacebar"].includes(key) || /[\r\n]/.test(text);
};

/** The pinned engine moves the page with exactly this evaluate (agent-browser interaction.rs, scroll without a selector). It acts only inside a scroll operation, by a bounded amount. */
const SCROLL_BY = /^window\.scrollBy\(\s*(-?[\d.]+(?:e[+-]?\d+)?)\s*,\s*(-?[\d.]+(?:e[+-]?\d+)?)\s*\)$/i;
const MAX_SCROLL = 20000;
/** MEM-02: per-tab caches (read layers, isolated worlds, guard registrations) keep the most recent tabs only; an evicted tab simply sets up again. */
const MAX_TAB_CACHE = 32;
/** Looks at the browser's own tree before a page counts as one the owner must use: one settled second look absorbs a page mid-change. */
const CLOSED_ROOT_LOOKS = 2;
const CLOSED_ROOT_SETTLE_MS = 150;

/** Murage's own overlay: a custom element the extension mounts with a closed root. It is the one closed root Murage lets through, and only if it holds nothing editable. */
const PRESENCE_WORLD = "murage-presence-v1";
/** The recipients the owner is shown on the card: read from the page, secrets dropped, capped. An unreadable scan says so. */
const recipientLine = (facts: { recipients?: unknown; recipientScanFailed?: unknown; recipientNoField?: unknown } | undefined) => {
  const list = withoutSecretValues(facts?.recipients as string[] | undefined).slice(0, 20).map(item => flat(item).slice(0, 254));
  if (list.length) return `Goes to (read from the page): ${list.join(", ")}${facts?.recipientScanFailed ? ". Murage could not read every recipient on this page." : ""}`;
  return facts?.recipientScanFailed === true && facts?.recipientNoField !== true ? "Goes to: Murage could not read who this goes to on this page." : "";
};
const recipientKey = (facts: { recipients?: unknown; recipientScanFailed?: unknown } | undefined) => JSON.stringify([facts?.recipients ?? null, facts?.recipientScanFailed ?? null]);

export class BrowserExtensionExecutor {
  /** The approved target as it was described at admission (SEC-02): checked again right before every activating input. */
  private approvedShape?:{observed:string;structure:string;bound:string;editable:boolean;recipients:string;macs:string[]|null;skip:number[]};
  private currentOperation="";
  private currentKey:Json={};
  private closedChecked=new Set<string>();
  private engine?:BrowserExtensionEngineBackend;
  private executing=false;
  private mutation=false;
  private approvedTarget?:EngineObject;
  private loaderBase?:string;
  private layers=new Map<number,{key:string;layer:ReadLayer}>();
  /** The Murage read layer (T40) for a tab: one per tab and document, so refs live while the node lives. */
  private layerFor(document:ExtensionDocument):ReadLayer|undefined{
    const backend=this.engine as (BrowserExtensionEngineBackend&{readLayer?:(document:ExtensionDocument,origin:()=>string)=>ReadLayer})|undefined;
    if(!backend||typeof backend.readLayer!=="function")return undefined;
    const key=docKey(document),held=this.layers.get(document.tabId);
    if(held?.key===key)return held.layer;
    const layer=backend.readLayer({...document},()=>document.origin);this.layers.delete(document.tabId);this.layers.set(document.tabId,{key,layer});while(this.layers.size>MAX_TAB_CACHE)this.layers.delete(this.layers.keys().next().value as number);return layer;
  }
  /** The engine takes the layer's refs only when it can act on a node by id (selector `node:<id>`). Until then the engine keeps its own refs. */
  private layerOwnsRefs(){return (this.engine as {actsOnNodes?:boolean}|undefined)?.actsOnNodes===true;}
  private marks:Partial<Record<"admitted"|"first_content"|"first_input",number>>={};
  /** Turn phases, logged once each until the turn's first input has gone out: admitted, first visible content, first input dispatch. */
  private mark(phase:"admitted"|"first_content"|"first_input",operation:string){
    if(this.marks[phase]!==undefined||(phase!=="admitted"&&this.marks.admitted===undefined))return;
    const at=performance.now();this.marks[phase]=at;
    const event={phase,at,sinceAdmitted:at-(this.marks.admitted??at),operation};
    try{this.options.phase?.(event);}catch{/* a logging sink never changes what the browser does */}
    if(phase==="first_input")this.marks={};
  }
  timings(){return {...this.marks};}
  private currentAction?:ExtensionAction;
  private currentRole="element";
  private refsDocument = "";
  private busy = false;
  private options: ExtensionExecutorOptions;
  constructor(options: ExtensionExecutorOptions) {
    this.options=options;
    this.engine=options.createEngine?.({beforeCommand:(document,method,params)=>this.beforeEngineCommand(document,method,params),beforeDestination:(url,document)=>this.destination(url,document)});
  }
  tools() { return extensionEngineTools(); }
  private authorized() { if (!this.options.authorize()) { if (this.options.authorizationError) throw this.options.authorizationError(); refuse("Browser control is no longer authorised."); } }
  private async stable(document: ExtensionDocument) {
    this.authorized();
    if (!sameDocument(document, await this.options.transport.document(document.tabId))) refuse("The page changed. Inspect it again before continuing.");
    this.authorized();
  }
  private async send(document: ExtensionDocument, method: string, params: Json = {}) {
    await this.stable(document);
    const value = await this.options.transport.send(method, params, document);
    this.authorized();
    return value;
  }
  /** SPD-001: setup the page cannot change is done once. The guard script is registered once per tab attachment (MEM-002), and the isolated world is
   * reused for as long as the document is the same; both are forgotten when the engine closes or a call finds the world gone. */
  private guardRegistered = new Set<string>();
  private worlds = new Map<number, { key: string; id: number }>();
  /** One authorisation-bracketed command without its own document look: the guard checks the document before and after its whole sequence. */
  private async sendWithin(document: ExtensionDocument, method: string, params: Json = {}) {
    this.authorized();
    const value = await this.options.transport.send(method, params, document);
    this.authorized();
    return value;
  }
  private async world(document: ExtensionDocument, fresh = false, within = false) {
    const key = docKey(document), held = this.worlds.get(document.tabId);
    if (!fresh && held?.key === key) return held.id;
    // An embedded frame is opaque, not a reason to refuse the page: only a target or focus inside one is refused.
    const send = within ? this.sendWithin.bind(this) : this.send.bind(this);
    const tree = await send(document, "Page.getFrameTree");
    const world = await send(document, "Page.createIsolatedWorld", { frameId: tree.frameTree.frame.id, worldName: "murage-protected-document-v1" });
    this.worlds.delete(document.tabId); this.worlds.set(document.tabId, { key, id: world.executionContextId as number });
    // A tab can go away without the bot closing it: the per-tab caches never hold more than the most recent tabs.
    while (this.worlds.size > MAX_TAB_CACHE) this.worlds.delete(this.worlds.keys().next().value as number);
    return world.executionContextId as number;
  }
  private async evaluate(document: ExtensionDocument, expression: string, within = false) {
    const send = within ? this.sendWithin.bind(this) : this.send.bind(this);
    for (let attempt = 0; ; attempt++) {
      let response: any;
      try { response = await send(document, "Runtime.evaluate", { expression, contextId: await this.world(document, attempt > 0, within), returnByValue: true }); }
      catch (error) {
        // A reused world that the browser has since dropped: make a new one once. A refusal is never retried.
        if (attempt === 0 && !isAuthorityRefusal(error)) { this.worlds.delete(document.tabId); continue; }
        throw error;
      }
      if (response.exceptionDetails) refuse("The page could not be inspected.");
      return response.result?.value;
    }
  }
  /** Is this document one the owner must use directly? A targeted query in the isolated world, never a dump of the DOM. */
  async protectedDocument(document: ExtensionDocument, fresh = false) {
    await this.stable(document);
    const attachment = `${document.profileId}:${document.tabId}`;
    if (!this.guardRegistered.has(attachment)) {
      await this.sendWithin(document, "Page.enable");
      await this.sendWithin(document, "Page.addScriptToEvaluateOnNewDocument", { source: BROWSER_DOCUMENT_GUARD_SOURCE, worldName: "murage-protected-document-v1", runImmediately: true });
      this.guardRegistered.add(attachment);
      while (this.guardRegistered.size > MAX_TAB_CACHE) this.guardRegistered.delete(this.guardRegistered.values().next().value as string);
    }
    const state = await this.evaluate(document, `${BROWSER_DOCUMENT_GUARD_SOURCE};globalThis.__murageGuard.enable(true);globalThis.__murageGuard()`, true);
    await this.stable(document);
    if (typeof state !== "boolean") refuse("The page protection check is unavailable.");
    this.protectedUnsure = false;
    if (state) return true;
    // SEC-05: a closed shadow root cannot be read by any page function, so a secret inside one is invisible to the guard. When the page has
    // roots the page cannot read, the browser's own tree decides; an inspection failure is a stop.
    // Round 9 (R8-01): any element can host a closed root, so the browser's own tree is read for every page, and again before every input.
    if (fresh) this.closedChecked.delete(docKey(document));
    const closed = await this.closedRoot(document);
    if (closed) this.protectedUnsure = true;
    return closed;
  }
  /** Inspect shallow pieces, paging wide branches. Only the extension's own non-editable overlay may have a closed root. */
  private async closedRoot(document: ExtensionDocument) {
    const key = docKey(document);
    if (this.closedChecked.has(key)) return false;
    // A page still settling (a navigation landing, the last task's overlay coming down) can fail one look or show a root that is
    // gone a moment later. One settled second look decides; a page that blocks or fails twice still goes to the owner.
    for (let attempt = 0; attempt < CLOSED_ROOT_LOOKS; attempt++) {
      if (attempt > 0) await new Promise(resolve => setTimeout(resolve, CLOSED_ROOT_SETTLE_MS));
      try {
        // The look at the browser's tree is one bracketed unit: the document is confirmed before it and again after it, so the answer is about this document.
        await this.stable(document);
        await this.sendWithin(document, "DOM.enable");
        const blocks = await inspectClosedRoots(
          (method, params = {}) => this.sendWithin(document, method, params),
          () => this.world(document, false, true),
          () => this.presenceHost(document),
        );
        // The verdict, blocking or not, is about this document only if it is still the one the look began on.
        await this.stable(document);
        if (blocks) continue;
      } catch (error) {
        if (isAuthorityRefusal(error)) throw error;
        continue;
      }
      this.closedChecked.add(key);
      return false;
    }
    return true;
  }
  /** The browser's node id of the overlay the extension itself mounted, or undefined when there is none (or it cannot be asked). */
  private async presenceHost(document: ExtensionDocument): Promise<number | undefined> {
    try {
      const tree = await this.sendWithin(document, "Page.getFrameTree");
      const world = await this.sendWithin(document, "Page.createIsolatedWorld", { frameId: tree.frameTree.frame.id, worldName: PRESENCE_WORLD });
      const response = await this.sendWithin(document, "Runtime.evaluate", { expression: "globalThis.__muragePresence?.hostElement?.()||null", contextId: world.executionContextId, returnByValue: false });
      const objectId = response?.result?.objectId;
      if (typeof objectId !== "string") return undefined;
      const described = await this.sendWithin(document, "DOM.describeNode", { objectId, depth: 0 });
      return Number.isSafeInteger(described?.node?.backendNodeId) ? described.node.backendNodeId : undefined;
    } catch (error) {
      if (isAuthorityRefusal(error)) throw error;
      return undefined;
    }
  }
  /** UX-005: a page the owner must use directly is a structured hand-back, the same state machine as a target on the floor: the owner is told once,
   * the service pauses the binding (which lets go of the tab) and only then is the bot told to end its turn. */
  private protectedUnsure = false;
  private handedText = "";
  private async guard(document: ExtensionDocument, fresh = false) {
    if (!await this.protectedDocument(document, fresh)) return;
    if (this.floorHandled) refuse(this.handedText || "YOUR TURN: this step needs the owner. Murage has asked them. End your turn now and wait. Do not try another way to do this step.");
    const unsure = this.protectedUnsure;
    await this.handOff(document, { floor: "credentials", rule: unsure ? "protected-page-unreadable" : "protected-page", reason: "This page needs the owner to take over.", unsure }, this.callOperation || "read");
  }
  private backend():BrowserExtensionEngineBackend{
    this.engine??=this.options.createEngine?.({beforeCommand:(document,method,params)=>this.beforeEngineCommand(document,method,params),beforeDestination:(url,document)=>this.destination(url,document)});
    return this.engine??refuse("The pinned browser engine adapter is not connected.");
  }
  private async resolveObject(target:EngineObject){
    await this.stable(target.document);
    let resolved:any;
    try{resolved=await this.send(target.document,"DOM.resolveNode",{backendNodeId:target.backendNodeId,executionContextId:await this.world(target.document)});}
    catch(error){if(isAuthorityRefusal(error))throw error;this.worlds.delete(target.document.tabId);refuse("The approved target is no longer available, or it is inside an embedded frame. Take over if you need it.");}
    if(!resolved.object?.objectId)refuse("The approved target is no longer available.");return resolved.object.objectId as string;
  }
  private async nodeCall(target:EngineObject,fn:string,args:unknown[]=[]){
    const response=await this.send(target.document,"Runtime.callFunctionOn",{objectId:await this.resolveObject(target),functionDeclaration:fn,arguments:args.map(value=>({value})),returnByValue:true});
    if(response.exceptionDetails){
      const said=String(response.exceptionDetails.exception?.description??response.exceptionDetails.text??"");
      if(said.includes("MURAGE_FRAME"))refuse("This target is inside an embedded frame, which Murage does not act in. Take over to continue.");
      if(said.includes("MURAGE_CLOSED_SHADOW"))refuse("This target is inside protected page content. Take over to continue.");
      refuse("The approved target could not be inspected.");
    }
    return response.result?.value;
  }
  private async activeTarget(document:ExtensionDocument):Promise<EngineObject>{
    const response=await this.send(document,"Runtime.evaluate",{expression:"document.activeElement||document.body",contextId:await this.world(document),returnByValue:false});
    let objectId=response.result?.objectId as string|undefined;if(!objectId)refuse("The focused browser target is unavailable.");
    // Through open shadow roots, to the element that really has focus.
    const inner=await this.send(document,"Runtime.callFunctionOn",{objectId,functionDeclaration:COMPOSED_ACTIVE_SOURCE,returnByValue:false});
    if(typeof inner.result?.objectId==="string")objectId=inner.result.objectId;
    const described=await this.send(document,"DOM.describeNode",{objectId,depth:1,pierce:true});
    if(!Number.isSafeInteger(described.node?.backendNodeId))refuse("The focused browser target is unavailable.");
    const name=String(described.node?.nodeName??"").toUpperCase();
    if(["IFRAME","FRAME","OBJECT","EMBED"].includes(name))refuse("Keyboard focus is inside an embedded frame, which Murage does not act in. Take over to continue.");
    if((described.node?.shadowRoots??[]).some((root:any)=>root?.shadowRootType==="closed"))refuse("Keyboard focus is inside protected page content. Take over to continue.");
    return{backendNodeId:described.node.backendNodeId,document:{...document}};
  }
  private async describe(target:EngineObject):Promise<{observed:string;structure:string;bound:string;editable:boolean;detail:Detail;priv:{href?:string|null};macs:string[]|null;skip:number[]}>{
    const text=String(await this.nodeCall(target,DESCRIBE_TARGET_SOURCE));
    // Anything that is not the structured shape is still bound into the digest, and shown as plain text.
    let parsed:any;try{parsed=JSON.parse(text);}catch{parsed=undefined;}
    let values:unknown=null,editable=false,priv:{href?:string|null}={},macs:string[]|null=null,skip:number[]=[];
    if(parsed&&typeof parsed==="object"&&parsed.display){
      // Live values leave the page only into this keyed digest: they never become part of the description or of anything shown or stored.
      values=Array.isArray(parsed.values)?parsed.values:null;editable=parsed.editable===true;
      if(parsed.priv&&typeof parsed.priv==="object"){priv={href:typeof parsed.priv.href==="string"?parsed.priv.href:null};if(Array.isArray(parsed.priv.skip))skip=parsed.priv.skip.filter((n:unknown)=>Number.isSafeInteger(n));}
      const {values:_values,editable:_editable,priv:_priv,...rest}=parsed;parsed=rest;
    }
    const detail:Detail=parsed&&typeof parsed==="object"&&parsed.display?parsed:{display:parsed&&typeof parsed==="object"?parsed:{text:text.slice(0,200)},bound:parsed&&typeof parsed==="object"?null:text};
    const mac=createHmac("sha256",VALUE_KEY).update(JSON.stringify(values)).digest("hex");
    // Round 10 (R9-04): the bound structure holds raw destinations, so it too is hashed only under the process key.
    const keyed=(v:unknown)=>createHmac("sha256",VALUE_KEY).update(JSON.stringify(v??null)).digest("hex");
    if(Array.isArray(values))macs=values.map(keyed);
    return{observed:JSON.stringify(detail.display),structure:keyed(detail.bound),bound:keyed([detail.bound??null,mac]),editable,detail,priv,macs,skip};
  }
  /** SEC-02: right before an activating input the target is described and classified again. A page can turn the approved button into something
   * else between mousedown and mouseup (or between keydown and keyup); the activation is cancelled, nothing more reaches the page. */
  private async revalidate(document:ExtensionDocument,target:EngineObject,mouse:boolean){
    const shape=this.approvedShape;if(!shape)return refuse("The browser action was not approved.");
    const now=await this.describe(target);
    // Round 10 (R9-10): a mouse activation is bound to the whole payload, always, even on a control that holds an editable region (a click does not type, and a
    // value that moves between mousedown and mouseup is a different payload). A key press in the edited field is typing: only that one field's own value may move.
    const typingOnly=!mouse&&shape.editable&&now.structure===shape.structure&&!!now.macs&&!!shape.macs&&now.macs.length===shape.macs.length&&now.macs.every((m,i)=>m===shape.macs![i]||shape.skip.includes(i));
    const same=now.observed===shape.observed&&(now.bound===shape.bound||typingOnly);
    if(!same)refuse("The target changed while the action was running. Inspect it again before continuing.");
    const late=await this.floorCheck(document,target,this.currentOperation,this.currentKey);
    if(late)await this.handOff(document,late,this.currentOperation,now.detail);
    // The recipients the page is about to send to are the ones the owner approved (changed or unreadable: back to the owner).
    if(recipientKey(this.lastFacts)!==shape.recipients)refuse("The recipients changed while the action was running. Inspect the page again before continuing.");
  }
  private async destination(url:string,document:ExtensionDocument){
    this.authorized();if(!await this.options.access(document,url))refuse("Site access was not approved.");
    // Original navigation already has an exact admission. New redirects, popup URLs and
    // reader fallbacks use their own destination-bound grant, never a site-only write grant.
    if(this.currentAction?.arguments.url!==url){
      let where="a page";try{where=`a page on ${new URL(url).origin}`;}catch{/* the policy refuses an invalid URL */}
      const action:ExtensionAction={name:"agent_browser_open",arguments:{url},document,mutation:false,digest:createHash("sha256").update(JSON.stringify([document,url])).digest("hex"),summary:`Open ${redactSecretUrl(url)}`,pushSummary:`Open ${where}`};
      if(!await this.options.admit(action))refuse("The browser destination was not approved.");
    }
    this.authorized();
  }
  private dialog?:{tabId:number;type:string;message:string};
  private async beforeEngineCommand(document:ExtensionDocument,method:string,params:Json){
    this.authorized();if(!await this.options.access(document))refuse("Site access was not approved.");
    // Clipboard editing is never the bot's to do: a paste carries whatever the owner last copied into a page.
    if(isClipboardInput(method,params))refuse("Pasting, copying and select-all are not available in the owner's browser. A paste could hand the page whatever the owner last copied.");
    if(method==="Page.handleJavaScriptDialog")return this.answerDialog(document,params);
    if(document.url==="about:blank")refuse("Navigate the bootstrap tab before observing it.");
    // Input belongs to an admitted action only: nothing the engine does before admit (resolving a target) may press or type.
    if(method.startsWith("Input.")&&!this.executing)refuse("The browser action was not approved.");
    // D2: the page moves only inside a scroll operation, by a bounded amount, and the document guard below has the last word. Anything else that
    // looks like a scroll is not the engine's to send.
    if(method==="Runtime.evaluate"&&typeof params.expression==="string"){
      const moved=SCROLL_BY.exec(params.expression.trim());
      if(moved){
        if(!this.executing||this.currentOperation!=="scroll")refuse("The browser action was not approved. Scrolling is only available through the scroll operation.");
        const dx=Number(moved[1]),dy=Number(moved[2]);
        if(!Number.isFinite(dx)||!Number.isFinite(dy)||Math.abs(dx)>MAX_SCROLL||Math.abs(dy)>MAX_SCROLL)refuse("That scroll is too large. Scroll in smaller steps.");
      }
    }
    // An escape (open, a new tab) only moves away: setup and navigation need no look at a page the owner must use directly.
    // The guard ends on a confirmed document; only an escape (which skips it) needs its own look.
    if(!(this.escaping&&ESCAPE_SETUP.has(method)))await this.guard(document,method.startsWith("Input."));else await this.stable(document);
    if(method.startsWith("Input.")&&this.executing)this.mark("first_input",this.currentOperation||this.callOperation);
    if(!this.executing||!this.mutation||!this.approvedTarget)return;
    const target=this.approvedTarget;
    // L1: input reaches only the document that was admitted. A navigation can commit between admit and dispatch.
    // Unsure is a stop: a frame tree without a loader id never matches, so no input reaches an unknown document.
    if(method.startsWith("Input.")){const now=await this.loaderId(document);if(!this.loaderBase||!now||now!==this.loaderBase)refuse("The page changed. Inspect it again before continuing.");}
    if((method.startsWith("Input.")||method==="Runtime.callFunctionOn")&&!sameDocument(target.document,document))refuse("The action moved to a different document.");
    if(method==="Runtime.callFunctionOn"&&typeof params.objectId==="string"){
      const described=await this.send(document,"DOM.describeNode",{objectId:params.objectId,depth:0});
      if(described.node?.backendNodeId!==target.backendNodeId)refuse("The engine resolved a different target than the approved element.");
    }
    if(method==="Input.dispatchMouseEvent"&&params.type!=="mouseWheel"){
      const clear=await this.nodeCall(target,COMPOSED_HIT_TEST_SOURCE,[params.x,params.y]);
      if(clear!==true){
        let said:string|null=null;try{said=await this.layerFor(document)?.explainCover(target.backendNodeId,this.currentRole)??null;}catch{/* the plain sentence below stands */}
        refuse(said??"Another element covers the approved target.");
      }
    }
    // Round 10 (R10-02): the key-up of an activation key (Space activates on it, and any page handler may run) reaches only the focus that was approved too.
    if(method==="Input.insertText"||(method==="Input.dispatchKeyEvent"&&(params.type!=="keyUp"||activationKeyEvent(params)))){
      const active=await this.activeTarget(document);if(active.backendNodeId!==target.backendNodeId)refuse("Keyboard focus changed from the approved target.");
    }
    // SEC-02: the semantics digest and the floor, again, right before every activating input (both halves of a click, Enter or Space).
    if((method==="Input.dispatchMouseEvent"&&(params.type==="mousePressed"||params.type==="mouseReleased"))||(method==="Input.dispatchKeyEvent"&&activationKeyEvent(params)))
      await this.revalidate(document,target,method==="Input.dispatchMouseEvent");
  }
  /** The main frame's loader id: it changes whenever the frame commits a new document. */
  private async loaderId(document:ExtensionDocument){
    const tree=await this.send(document,"Page.getFrameTree");
    return typeof tree?.frameTree?.frame?.loaderId==="string"?tree.frameTree.frame.loaderId as string:undefined;
  }
  /** The floor, classified on the facts of the moment. Unsure (a collector or classifier that fails) is floor. */
  private async floorCheck(_document:ExtensionDocument,target:EngineObject|undefined,operation:string,extra:FloorFactsExtra={}):Promise<FloorResult|null>{
    let facts:FloorFacts;
    try{
      const io:FloorFactsIo={send:(method,params,doc)=>this.send(doc as unknown as ExtensionDocument,method,params),world:doc=>this.world(doc as unknown as ExtensionDocument)};
      facts=await (this.options.collectFacts??collectFloorFacts)(io,target?{document:target.document as never,backendNodeId:target.backendNodeId}:undefined,operation,extra);
    }catch(error){if(isAuthorityRefusal(error))throw error;facts={operation,factsFailed:true};}
    this.lastFacts=facts as FloorFacts&{visibility?:unknown};
    // Losing authority while looking is a stop, not a hand-off.
    this.authorized();
    try{const result=classifyFloor(facts);if(!result.floor&&(facts as {recipientCapped?:boolean}).recipientCapped===true)return{floor:"consent",reason:"Murage could not read every recipient on this page, so the owner decides who this goes to.",rule:"recipient-scan-capped",unsure:true} as FloorResult;return result.floor?result:null;}
    catch{return classifyFloor({operation,factsFailed:true});}
  }
  private floorHandled=false;
  private callOperation="";
  /** The facts of the most recent floor check in this call, handed on to the decision (T23W). */
  private lastFacts:(FloorFacts&{visibility?:unknown})|undefined;
  /** Refuse with the plain YOUR TURN text; nothing reaches the page. */
  private async handOff(document:ExtensionDocument,result:FloorResult,operation:string,detail?:Detail):Promise<never>{
    this.floorHandled=true;
    const phrase=!result.unsure&&result.floor?` (${result.rule==="owner-account-change"?ACCOUNT_OWNER_PHRASE:FLOOR_OWNER_PHRASE[result.floor]})`:"";
    const text=`YOUR TURN: ${result.rule.startsWith("protected-page")?"this page needs the owner to take over":`this step needs the owner${phrase}`}. Murage has asked them. End your turn now and wait. Do not try another way to do this step.`;
    this.handedText=text;
    this.options.activity?.({operation,document,decision:"your turn",outcome:"handed over",level:2,...(detail?.display.label?{target:String(detail.display.label),fromPage:true}:{})});
    try{await this.options.onFloor?.({result,operation,document,text});}catch{/* the refusal stands whether or not the owner could be told */}
    return refuse(text);
  }
  /** Answering a page's JavaScript dialog. An alert only dismisses; a confirm or prompt decides something, so it needs the owner. */
  private async answerDialog(document:ExtensionDocument,params:Json){
    const open=this.dialog&&this.dialog.tabId===document.tabId?this.dialog:undefined;
    // Only while a tool call is running: an answer decided outside one has no owner action to belong to. A dialog the owner opened while the bot was
    // not acting is left alone, an alert included (T43).
    if(!this.executing)refuse("A dialog is open on the page. It needs the owner to answer it.");
    const accept=params.accept===true,kind=open?.type??"confirm";
    const dialogFloor=await this.floorCheck(document,undefined,accept?"dialog_accept":"dialog_dismiss",{dialog:{kind,text:String(open?.message??"")}});
    if(dialogFloor)await this.handOff(document,dialogFloor,accept?"dialog_accept":"dialog_dismiss");
    const arguments_:Json={accept,...(typeof params.promptText==="string"?{promptText:params.promptText.slice(0,500)}:{})};
    // Text the bot would type into a prompt is the bot's (it can carry conversation data to the page): the owner sees it.
    const typed=typeof arguments_.promptText==="string"&&accept?`\nText the bot will enter: ${jsonLine(arguments_.promptText)}`:"";
    const leaving=kind==="beforeunload";
    const summary=`${leaving?(accept?"Leave this page?":"Stay on this page?"):`Answer the page's ${flat(kind).slice(0,16)} dialog with ${accept?"OK":"Cancel"}`} on ${document.origin}${typed}\nFrom the page, written by the site and not by Murage: "${flat(String(open?.message??"").slice(0,300))}"`;
    // The level rules read the operation as dialog_accept or dialog_dismiss and the dialog's kind from the facts: alert and dismiss are L2,
    // confirm, prompt and a beforeunload that may discard typed data are L3.
    const action:ExtensionAction={name:`agent_browser_dialog_${accept?"accept":"dismiss"}`,arguments:arguments_,document,mutation:true,...(this.lastFacts?{facts:this.lastFacts}:{}),digest:createHash("sha256").update(JSON.stringify(["dialog",document,arguments_,open?.message??""])).digest("hex"),summary,pushSummary:`Answer a ${kind} dialog on ${document.origin}`};
    if(!await this.options.admit(action))refuse("The browser action was not approved.");
    this.authorized();
  }
  private escaping=false;
  /** The page's HTML in slices, so a large page crosses the wire in pieces. */
  private async activeHtml(document:ExtensionDocument){
    const total=Number(await this.evaluate(document,HTML_LENGTH_EXPRESSION));
    if(!Number.isSafeInteger(total)||total<0)refuse("The page could not be read.");
    const slice=120_000;let out="";
    for(let at=0;at<total&&at<2_400_000;at+=slice)out+=String(await this.evaluate(document,htmlSliceExpression(at,at+slice)));
    return out;
  }
  async call(name:unknown,args:unknown):Promise<unknown>{
    // Some engines call an element reference `ref`; this tool names it `selector` (a reference starts with @).
    if(args&&typeof args==='object'&&!Array.isArray(args)&&typeof (args as Json).ref==='string'&&(args as Json).selector===undefined){const {ref,...rest}=args as Json;args={...rest,selector:String(ref).startsWith('@')?ref:`@${ref}`};}
    const call=validateHeadlessBrowserCall(name,args);if(!this.tools().some(tool=>tool.name===call.name))refuse("This browser operation is unavailable through the extension.");
    if(this.busy)refuse("This browser has an action in progress.");this.busy=true;this.executing=false;this.mutation=false;this.approvedTarget=undefined;
    let document:ExtensionDocument|undefined,admitted=false,afterAdmit:ExtensionAction|undefined;this.floorHandled=false;this.lastFacts=undefined;this.loaderBase=undefined;this.approvedShape=undefined;this.closedChecked.clear();
    const operation=call.name.replace(/^agent_browser_/,"");this.callOperation=operation;this.handedText="";
    try{
      if(operation==="press"&&isClipboardKeyName(call.arguments.key))refuse("Pasting, copying and select-all are not available in the owner's browser. A paste could hand the page whatever the owner last copied.");
      this.authorized();document=await this.options.transport.document();
      if(["tab_switch","tab_close"].includes(operation)&&typeof call.arguments.tab==="string")document=await this.backend().resolveTab(call.arguments.tab);
      let destination=typeof call.arguments.url==="string"?call.arguments.url:undefined;
      if(!await this.options.access(document,destination))refuse("Site access was not approved.");
      // T43: a pending dialog is a modal state. Looking (snapshot, screenshot) and answering stay possible; nothing else moves until it is answered.
      const pending=this.dialog&&this.dialog.tabId===document.tabId?this.dialog:undefined;
      if(pending&&!["snapshot","screenshot","dialog","dialog_accept","dialog_dismiss","close"].includes(operation))refuse(`A dialog is open on the page: "${flat(pending.message).slice(0,300)}" (written by the site, not by Murage). Answer it first.`);
      admitted=true;this.mark("admitted",operation);
      const bootstrap=document.url==="about:blank"&&(operation==="open"||administrative.has(operation));
      this.escaping=escapes.has(operation);
      if(!bootstrap&&!this.escaping)await this.guard(document);
      if(typeof call.arguments.selector==="string"&&call.arguments.selector.startsWith("@")&&!this.layerOwnsRefs()&&this.refsDocument!==docKey(document))refuse("Element references expired. Take a new snapshot.");
      if(operation==="back"||operation==="forward"){
        const history=await this.send(document,"Page.getNavigationHistory");const item=history.entries?.[history.currentIndex+(operation==="back"?-1:1)];if(item?.url){destination=item.url;if(!await this.options.access(document,destination))refuse("Site access was not approved.");}
      }
      // Closing the session is not free when it would close a tab the owner shared.
      this.mutation=!reads.has(operation)&&!navigation.has(operation)&&(operation!=="close"||!bootstrap);
      // Moving focus or the viewport (Tab, PageDown, ...) only looks around, unless focus is on a select, where Home or End picks.
      if(operation==="press"&&freeKey(call.arguments.key)&&!bootstrap){
        const active=await this.activeTarget(document);const node=await this.send(document,"DOM.describeNode",{backendNodeId:active.backendNodeId,depth:0});
        if(String(node.node?.nodeName??"").toUpperCase()!=="SELECT")this.mutation=false;
      }
      let target:EngineObject|undefined,observed="",bound="",shapeStructure="",shapeEditable=false,shapeMacs:string[]|null=null,shapeSkip:number[]=[],detail:Detail|undefined,privHref:string|null|undefined;
      if(!bootstrap&&this.mutation&&operation!=="close"){
        const selector=call.arguments.selector,layer=typeof selector==="string"&&selector.startsWith("@")&&this.layerOwnsRefs()?this.layerFor(document):undefined;
        if(layer){
          // T40: the layer's refs live while the node lives. A dead one is a plain sentence for the bot, never a stack.
          try{target={backendNodeId:(await layer.resolve(selector as string)).backendNodeId,document:{...document}};}
          catch(error){if(error instanceof ReadLayerError)refuse(error.message);throw error;}
        }else target=typeof selector==="string"?await this.backend().resolveTarget(selector):await this.activeTarget(document);await this.stable(document);if(!sameDocument(target.document,document))refuse("The selected browser tab changed.");
        // The engine names the frame the node really lives in. Anything but the page's own frame is not Murage's to act in.
        if(target.frameId!==undefined&&target.frameId!==document.frameId)refuse("This target is inside an embedded frame, which Murage does not act in. Take over to continue.");
        {const first=await this.describe(target);({observed,bound,detail}=first);shapeStructure=first.structure;shapeEditable=first.editable;privHref=first.priv.href;shapeMacs=first.macs;shapeSkip=first.skip;}
        this.currentRole=String(detail.display.role||detail.display.tag||"element").toLowerCase();
        // The hard floor comes before any card, in every mode.
        const floor=await this.floorCheck(document,target,operation,typeof call.arguments.key==="string"?{key:call.arguments.key}:{});
        if(floor)await this.handOff(document,floor,operation,detail);
      }
      let shownUrl:string|undefined;
      if(operation==="click"&&detail?.display.href){destination=new URL(privHref??detail.display.href,document.url).href;try{shownUrl=new URL(detail.display.href,document.url).href;}catch{shownUrl=undefined;}if(!await this.options.access(document,destination))refuse("Site access was not approved.");}
      // A link the page itself presents is not data the bot chose: only the owner-visible rule needs to know.
      let presentedLink:boolean|undefined;
      if(destination&&(operation==="open"||operation==="read")&&!bootstrap){try{presentedLink=await this.evaluate(document,presentedLinkExpression(new URL(destination).href))===true;}catch{presentedLink=undefined;}}
      const reviewArgs={...call.arguments,...(destination?{url:destination}:{})};
      const summary=this.reviewText(operation,document.origin,shownUrl&&destination?{...reviewArgs,url:shownUrl}:reviewArgs,detail?.display,recipientLine(this.lastFacts));
      if(summary.length>MAX_REVIEW_CHARS)refuse("This action is too large to review. Split the text into smaller parts or take over to continue.");
      const names=(detail?.display.fieldNames??[]).join(", ");
      const pushSummary=`${operation} on ${document.origin}${detail?.display.fieldCount?`. Fields: ${names} (${detail.display.fieldCount})`:""}`;
      const action:ExtensionAction={...call,arguments:reviewArgs,document,mutation:this.mutation,...(this.lastFacts?{facts:this.lastFacts}:{}),...(detail?.display.label?{target:String(detail.display.label),fromPage:true}:{}),...(typeof call.arguments.text==="string"?{textLength:call.arguments.text.length}:{}),...(target?{node:{backendNodeId:target.backendNodeId,frameId:target.frameId!==undefined?target.frameId:document.frameId}}:{}),...(presentedLink?{presentedLink}:{}),digest:createHash("sha256").update(JSON.stringify([call,document,target?.backendNodeId,observed,bound,createHmac("sha256",VALUE_KEY).update(recipientKey(this.lastFacts)).digest("hex")])).digest("hex"),summary,pushSummary};
      // Round 10 (R9-01): the recipients the owner approved are the ones scanned at admission. Every later scan is compared with this set and none replaces it.
      const admittedRecipients=recipientKey(this.lastFacts);
      this.currentAction=action;if(!await this.options.admit(action))refuse("The browser action was not approved.");
      afterAdmit=this.mutation?action:undefined;
      await this.stable(document);this.closedChecked.clear();
      // L1: the document that was admitted is the one the input may reach.
      if(!bootstrap&&!this.escaping&&this.mutation)this.loaderBase=await this.loaderId(document);
      if(!bootstrap&&!this.escaping)await this.guard(document);
      if(target){
        const again=await this.describe(target);if(again.observed!==observed||again.bound!==bound)refuse("The target changed while waiting. Inspect it again before continuing.");
        // A page can change a button after the card: classify again, and drop the approval if it is now floor.
        const late=await this.floorCheck(document,target,operation,typeof call.arguments.key==="string"?{key:call.arguments.key}:{});
        if(late)await this.handOff(document,late,operation,again.detail);
        if(recipientKey(this.lastFacts)!==admittedRecipients)refuse("The recipients changed while waiting. Inspect the page again before continuing.");
      }
      this.approvedTarget=target;this.executing=true;this.currentOperation=operation;this.currentKey=typeof call.arguments.key==="string"?{key:call.arguments.key}:{};
      this.approvedShape=target?{observed,structure:shapeStructure,bound,editable:shapeEditable,recipients:admittedRecipients,macs:shapeMacs,skip:shapeSkip}:undefined;
      const layer=this.layerOwnsRefs()?this.layerFor(document):undefined;
      const engineArgs=layer&&target&&typeof call.arguments.selector==="string"&&call.arguments.selector.startsWith("@")?{...call.arguments,selector:`node:${target.backendNodeId}`}:call.arguments;
      let output=operation==="read"?await readWithBrowserAuthority(call.arguments as EngineReadOptions,{fenceOrigin:document.origin,currentUrl:document.url,activeHtml:()=>this.activeHtml(document!),authorize:()=>this.options.authorize(),admitUrl:url=>this.destination(url,document!)}):operation==="snapshot"&&layer?{content:[{type:"text",text:layer.fenced(await layer.snapshot()),murage:true}]}:await this.backend().call(call.name,engineArgs);
      if(operation==="read")output=markFenced(output);
      this.authorized();
      if(operation==="close"){await this.engine?.close();this.engine=undefined;this.layers.clear();this.guardRegistered.clear();this.worlds.clear();return output;}
      // After an L2 or L3 action: what changed on the page, fenced, appended to the result.
      if(this.mutation&&layer){
        let diff:string|null=null;try{diff=await layer.diffSince();}catch{/* the action happened; the diff is a courtesy */}
        const content=(output as {content?:unknown}|undefined)?.content;
        if(diff&&Array.isArray(content))output={...(output as object),content:[...content,{type:"text",text:diff,murage:true}]};
      }
      // Every resulting document must be admitted before its output reaches a model.
      const current=await this.options.transport.document();if(current.url!=="about:blank"){if(!await this.options.access(current))refuse("Site access was not approved.");await this.guard(current);}
      if(["read","snapshot","screenshot","get_text"].includes(operation))this.mark("first_content",operation);
      if(operation==="tab_close"){this.layers.delete(document.tabId);this.worlds.delete(document.tabId);this.guardRegistered.delete(`${document.profileId}:${document.tabId}`);}
      if(operation==="snapshot")this.refsDocument=docKey(current);else if(!sameDocument(document,current)||["open","back","forward","reload","tab_new","tab_switch","tab_close"].includes(operation))this.refsDocument="";
      return output;
    }catch(error){
      // An admitted action that did not happen is still a decision worth a line: not done.
      if(afterAdmit&&document&&!this.floorHandled)this.options.activity?.({operation,document,decision:"not done",outcome:"failed",level:2,...(afterAdmit.target?{target:afterAdmit.target,fromPage:true}:{}),...(afterAdmit.textLength!==undefined?{textLength:afterAdmit.textLength}:{})});
      throw error;
    }finally{
      this.loaderBase=undefined;
      if(document&&admitted){try{await this.evaluate(document,"globalThis.__murageGuard?.enable(false)");}catch{/* revoked or navigated: no further observation */}}
      this.approvedShape=undefined;this.options.settled?.();this.currentAction=undefined;this.executing=false;this.mutation=false;this.approvedTarget=undefined;this.escaping=false;this.busy=false;
    }
  }
  /** The card text. What the page wrote (element text, links, field names) is set apart and labelled as the page's. */
  private reviewText(operation:string,origin:string,args:Json,display?:Detail["display"],goesTo=""){
    // Round 10 (R10-04): a URL on the card is shown with its secret-looking components replaced.
    const shown=typeof args.url==="string"?{...args,url:redactSecretUrl(args.url)}:args;
    const lines=[`${operation} on ${origin}`,`Arguments: ${jsonLine(shown)}`];
    if(display){
      const bits:string[]=[];
      const what=[String(display.tag??"element").toLowerCase(),display.label?`"${display.label}"`:"",display.text?`text "${String(display.text).replace(/\s+/g," ").slice(0,200)}"`:""].filter(Boolean).join(" ");
      bits.push(what);
      if(display.href)bits.push(`link to ${display.href}`);
      if(display.form?.action)bits.push(`submits to ${display.form.action}${display.form.method?` (${display.form.method})`:""}`);
      if(display.submit)bits.push(`this button sends to ${display.submit.action||"the form address"}${display.submit.method?` (${display.submit.method})`:""} instead`);
      if(display.fieldCount)bits.push(`${display.fieldCount} field${display.fieldCount===1?"":"s"} in this form: ${(display.fieldNames??[]).join(", ")}`);
      lines.push(`From the page, written by the site and not by Murage: ${flat(bits.join("; "))}`);
    }
    if(goesTo)lines.push(goesTo);
    return lines.join("\n");
  }
  event(tabId:number,epoch:number,method:string,params:Json){
    if(method==="Page.javascriptDialogOpening")this.dialog={tabId,type:String(params.type??"confirm"),message:String(params.message??"")};
    else if(method==="Page.javascriptDialogClosed"&&this.dialog?.tabId===tabId)this.dialog=undefined;
    this.engine?.event(tabId,epoch,method,params);
  }
  async close(){await this.engine?.close();this.engine=undefined;this.refsDocument="";this.dialog=undefined;this.layers.clear();this.guardRegistered.clear();this.worlds.clear();}
}
