// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The trusted floor facts collector for Murage for Chrome (spec 2.5.5, 2.5.6).
//
// `collectFloorFacts` takes the resolved target of a step and the operation and
// returns the `FloorFacts` that `classifyFloor` (server/browser-floor.ts) reads,
// plus a separate `visibility` block for the intent check. It never returns a
// field value: it reads names, labels, types and nearby text, and a button's own
// value attribute, nothing a person typed. Anything it cannot read becomes
// `factsFailed: true` with whatever was gathered; it never throws past the caller.
//
// It runs in the extension's isolated world through the executor's own `send`
// and `world` (server/browser-extension-executor.ts), so the page cannot reach
// the functions or change their answers. The page functions are plain source
// strings: the operation, the key and the signature selectors cross as data
// arguments, never as source.

import { NATIVE_DOM_SOURCE } from "./browser-native-dom.ts";
import type { EngineObject } from "./browser-extension-engine.ts";
import type { FloorFacts } from "./browser-floor.ts";
import { cleanRecipients } from "./browser-recipient-safety.ts";
import { SECRET_CLASSIFIER_SOURCE, looksLikeSecretName } from "../shared/browser-secret-classifier.ts";
import { CARD_AUTOCOMPLETE_PREFIX, CREDENTIAL_AUTOCOMPLETE_TOKENS, CREDENTIAL_FIELD, CREDENTIAL_IDENTIFIER_TOKENS, compilePhrases, foldText } from "./browser-floor-lexicon.ts";
import {
  ALL_FRAME_SIGNATURES,
  CHALLENGE_PATH_PATTERNS,
  CHALLENGE_TITLE_PHRASES,
  CHALLENGE_TITLE_PREFIXES,
  matchFrame,
  matchFrameName,
  signatureSelectors,
} from "../shared/browser-floor-signatures.ts";
import type { FrameRef } from "../shared/browser-floor-signatures.ts";

type Json = Record<string, unknown>;
type Document = EngineObject["document"];

/** A resolved target, or just the document for a step with no element (a dialog answer): page facts only. */
export interface FloorTarget {
  document: Document;
  backendNodeId?: number;
}

/**
 * The currency pattern `classifyFloor` uses (server/browser-floor.ts), with the digit run bounded so it runs in
 * linear time on long digit strings (an unanchored test still finds the amount next to the currency word).
 * Passed to the page as data.
 */
const CURRENCY = /(?:[$€£¥₹₩₽₺₪]\s?\d|\d[\d.,]{0,24}\s?(?:[$€£¥₹₩]|usd|eur|gbp|cad|aud|inr|jpy|cny|brl|mxn|chf|dollars?|euros?|pounds?|円|元|रुपये)(?![a-z]))/iu;
export const CURRENCY_SOURCE = { source: CURRENCY.source, flags: CURRENCY.flags };

/** The narrow interface the executor already has (send and world), so the executor can pass its own. */
export interface FloorFactsIo {
  send(method: string, params: Json, document: Document): Promise<any>;
  /** The execution context id of the extension's isolated world in the top frame. */
  world(document: Document): Promise<number>;
}

export interface FloorVisibility {
  box: { x: number; y: number; width: number; height: number } | null;
  inViewport: boolean | null;
  /** Product of the target's and its ancestors' computed opacity. */
  opacity: number | null;
  visibility: string | null;
  ariaHidden: boolean | null;
  /** The element on top at the target's centre when it is not the target: tag, id and a short text. */
  coveredBy: string | null;
}

export type FloorFactsResult = FloorFacts & { visibility: FloorVisibility };

export interface FloorFactsExtra {
  /** For press and keyboard_press: the DOM key name. */
  key?: string;
  /** For dialog operations: the JavaScript dialog being answered. */
  dialog?: { kind: string; text: string };
  /** The whole collection is cut off after this long. Default 15 seconds. */
  timeoutMs?: number;
}

const SNIPPET_CAP = 1000;
const NEAR_CAP = 300;
const NAME_CAP = 500;
const URL_CAP = 200;
const FIELD_CAP = 60;
const FRAME_CAP = 50;
/** How much of the AX name and description goes to the page for the value test (more than NAME_CAP, so a value cut by the cap is still seen). */
const AX_TEST_CAP = 5000;
const DEFAULT_TIMEOUT_MS = 15_000;

const emptyVisibility = (): FloorVisibility => ({ box: null, inViewport: null, opacity: null, visibility: null, ariaHidden: null, coveredBy: null });

// ---------------------------------------------------------------------------
// Page functions (callFunctionOn, this = a DOM node in the isolated world)
// ---------------------------------------------------------------------------

/**
 * A key as a model may spell it, read the way the floor reads it (server/browser-floor.ts splitKey): the base is the
 * part after the last "+", any modifiers before it. enter: Enter, Return, NumpadEnter or a raw line break, with any
 * modifiers; a missing key or an unknown non-character key also counts as Enter, since it may submit. space: a space
 * key. mod: a modifier other than Shift. Plain source, used inside both page functions and tested on its own.
 */
export const KEY_INFO_SOURCE = String.raw`function(k){
    const ENTER=['enter','return','numpadenter','\n','\r','\r\n'];
    const SPACE=[' ','space','spacebar'];
    const INERT=['tab','escape','esc','backspace','delete','arrowup','arrowdown','arrowleft','arrowright','up','down','left','right','home','end','pageup','pagedown','shift','control','ctrl','alt','meta','capslock','insert'];
    if(k==null||k==='')return{enter:true,space:false,mod:false};
    k=String(k);
    let base=k,mods=[];
    if(k!=='+'&&k.includes('+')){
      if(k.endsWith('++')){base='+';mods=k.slice(0,-2).split('+').filter(Boolean);}
      else{const p=k.split('+');base=p.pop()||'+';mods=p.filter(Boolean);}
    }
    const b=base.toLowerCase();
    const mod=mods.some(m=>m.toLowerCase()!=='shift');
    if(ENTER.includes(b))return{enter:true,space:false,mod:mod};
    if(SPACE.includes(b))return{enter:false,space:true,mod:mod};
    if(Array.from(base).length===1||INERT.includes(b)||/^f\d{1,2}$/.test(b))return{enter:false,space:false,mod:mod};
    return{enter:true,space:false,mod:mod};
  }`;

/** Only activation which can send calls for recipient certainty. All reads are native. */
export const SEND_CAPABLE_SOURCE = String.raw`function(el,op,key,dom){
    op=String(op||'click').toLowerCase();
    if(op==='submit')return true;
    const press=['press','keyboard_press','key'].includes(op);
    if(!press&&!['click','dblclick','double_click','tap','activate','keyboard_activate'].includes(op))return false;
    const tag=dom.tag(el),type=dom.controlType(el),role=(dom.attr(el,'role')||'').toLowerCase();
    const info=(${KEY_INFO_SOURCE})(key);
    if(press&&!info.enter&&!info.space)return false;
    if(tag==='a'||tag==='area'){
      const href=dom.attr(el,'href');
      if(href!==null){try{if(/^https?:$/.test(new URL(href,dom.baseURI(el)).protocol))return false;}catch{}}
      return true;
    }
    if(tag==='button'||tag==='input'&&['submit','button','image'].includes(type)||['button','menuitem','link'].includes(role))return true;
    const ce=dom.attr(el,'contenteditable');
    return press&&info.enter&&(tag==='textarea'||tag==='input'&&!['hidden','checkbox','radio','file','range','color','reset'].includes(type)||ce!==null&&ce.toLowerCase()!=='false'||['textbox','combobox','searchbox','spinbutton'].includes(role));
  }`;

/** One native document inventory. Every control is positively classified or unknown. */
export const COLLECT_RECIPIENTS_SOURCE = String.raw`function(operation='click',key=null){
    const dom=(${NATIVE_DOM_SOURCE})();
    if(!(${SEND_CAPABLE_SOURCE})(this,operation,key,dom))return{sendCapable:false,recipients:[],fields:[],incomplete:false};
    const D=this.ownerDocument||document;
    const SC=${SECRET_CLASSIFIER_SOURCE};
    const WORD=/(^|[^a-z])(to|cc|bcc|recipients?|invit(?:e|ee|ees)|attendees?|share|collaborators?|send.?to|e-?mail|phone|mobile|handle)([^a-z]|$)/i;
    const SECRET=/(^|\s)(one-time-code|current-password|new-password|cc-[a-z-]+)(\s|$)|pass|pwd|card|cvv|cvc|csc|ccnum|ccexp|expir|otp|one.?time|token|secret|iban|ssn|social.?sec|national.?id|tax.?id|security.?code|\bpin\b/i;
    const CHIP=['email','data-email','data-hovercard-id','data-recipient','data-recipient-email','data-address','data-identifier'];
    let incomplete=false,capped=false,sawComposer=false,sawRecipient=false;
    const out=[],fields=[],names=new WeakMap(),unresolved=new WeakSet();
    const attr=(e,k)=>dom.attr(e,k)||'';
    const nameOf=e=>{
      if(names.has(e))return names.get(e);
      const parts=['id','name','aria-label','placeholder','title','data-testid','data-name'].map(k=>attr(e,k));
      for(const label of dom.labels(e))parts.push(dom.text(label));
      for(let p=dom.parent(e),i=0;p&&i<200;p=dom.parent(p),i++)if(dom.tag(p)==='label'){parts.push(dom.text(p));break;}
      const root=dom.root(e);
      for(const id of attr(e,'aria-labelledby').split(/\s+/).filter(Boolean)){
        const label=dom.byId(root&&dom.kind(root)===11?root:D,id);
        if(!label){incomplete=true;unresolved.add(e);}else parts.push(dom.text(label));
      }
      const name=parts.filter(Boolean).join(' ').trim();
      if(name.length>2000){incomplete=true;unresolved.add(e);}
      names.set(e,name.slice(0,2000));return names.get(e);
    };
    const privateOwn=e=>dom.controlType(e)==='password'||SECRET.test(nameOf(e)+' '+attr(e,'autocomplete'))||SC.secretName(nameOf(e)+' '+attr(e,'autocomplete'));
    // Identity belongs to the field, as in the document guard. Computed text
    // masking already includes inherited styling; ancestor names do not.
    const privateChain=e=>{
      const mask=getComputedStyle(e).webkitTextSecurity;
      return privateOwn(e)||!!mask&&mask!=='none';
    };
    const descriptor=e=>({type:dom.controlType(e),autocomplete:attr(e,'autocomplete'),names:nameOf(e),idName:(attr(e,'id')+' '+attr(e,'name')).slice(0,120),masked:false});
    // Each selected value is resolved independently; a parsed neighbour cannot cover it.
    const emit=(e,value,required=false)=>{
      value=String(value||'').trim();if(!value){if(required)incomplete=true;return;}
      if(value.length>2000||privateChain(e)||unresolved.has(e)||SC.looksLikeSecretValue(value)){incomplete=true;return;}
      const tokens=/^[+\d\s().-]+$/.test(value)?[value]:value.split(/[,;\n\r\t ]+/);
      for(const token of tokens){
        const t=token.replace(/^[<"']+|[>"']+$/g,'');if(!t)continue;
        if(t.length>254||SC.looksLikeSecretValue(t)||SC.looksLikeSecretValue(t.replace(/^@/,''))||!(t.includes('@')||/^[+\d\s().-]+$/.test(t)&&t.replace(/\D/g,'').length>=7)){incomplete=true;continue;}
        if(out.includes(t))continue;if(out.length>=20){incomplete=true;capped=true;continue;}
        out.push(t);fields.push(descriptor(e));
      }
    };
    let inventory;
    try{
      inventory=dom.fieldPresence(D);
      incomplete=inventory.incomplete;
      if(inventory.count===0&&!incomplete){dom.assertComplete();return{sendCapable:true,recipients:[],fields:[],incomplete:false,capped:false,noRecipientField:true,composerOnly:false};}
      const controls=new Set(inventory.fields),knownNon=new Set();
      for(const e of inventory.fields){
        const tag=dom.tag(e),type=dom.controlType(e),role=attr(e,'role').toLowerCase(),own=nameOf(e);
        if(unresolved.has(e)){incomplete=true;continue;}
        if(privateChain(e)){knownNon.add(e);continue;}
        // Named surrounding recipient regions also name native selectors and chips.
        let context='',p=dom.parent(e),depth=0;
        for(;p&&depth<200;p=dom.parent(p),depth++)if(dom.kind(p)===1){const n=nameOf(p);if(unresolved.has(p))incomplete=true;if(WORD.test(n))context+=' '+n;}
        if(p)throw Error('Incomplete native name context');
        const recipient=type==='email'||type==='tel'||/^(email|tel)$/.test(attr(e,'autocomplete'))||WORD.test(own+context);
        const composerName=/^(?:(?:type|write|enter) (?:a |your )?)?(message|subject|compose|reply|comment|notes)(\b|$)/i.test(own);
        const ce=dom.attr(e,'contenteditable');
        const composer=composerName&&(tag==='textarea'||role==='textbox'||ce!==null&&ce.toLowerCase()!=='false')||role==='textbox'&&!!own&&attr(e,'aria-multiline')==='true';
        const searchName=/(^|[^a-z])(search|find)([^a-z]|$)/i.test(own);
        const form=!recipient&&searchName?(dom.form(e)||dom.closest(e,'form')):null;
        const search=searchName&&(tag==='input'&&type==='search'||['searchbox','combobox'].includes(role)||form&&attr(form,'role')==='search'&&(tag==='input'||tag==='textarea'||role==='textbox'));
        if(!recipient){
          if(composer||search){knownNon.add(e);if(composer)sawComposer=true;}else incomplete=true;
          continue;
        }
        sawRecipient=true;
        if(tag==='input'&&['checkbox','radio'].includes(type)){if(dom.checked(e))emit(e,dom.value(e),true);continue;}
        if(['checkbox','radio','switch','menuitemcheckbox','menuitemradio'].includes(role)&&!['true','false','mixed'].includes(attr(e,'aria-checked')))incomplete=true;
        if(['checkbox','radio','switch','menuitemcheckbox','menuitemradio'].includes(role)&&attr(e,'aria-checked')==='false'||['option','treeitem','gridcell'].includes(role)&&attr(e,'aria-selected')==='false')continue;
        if(tag==='select'){for(const value of dom.selected(e)){if(!String(value).trim())incomplete=true;else emit(e,value);}continue;}
        if(tag==='input'||tag==='textarea'){emit(e,dom.value(e));continue;}
        if(tag==='button'){emit(e,attr(e,'value'));continue;}
        const value=attr(e,'aria-valuetext'),active=attr(e,'aria-activedescendant');
        const numeric=attr(e,'aria-valuenow');if(numeric)emit(e,numeric,true);
        if(value)emit(e,value);
        if(active){const root=dom.root(e),option=dom.byId(root&&dom.kind(root)===11?root:D,active);if(!option)incomplete=true;else emit(option,dom.text(option));}
        // Read each chosen ARIA option, never aggregate all options into a single success.
        if(role==='listbox'){
          const selected=inventory.fields.filter(option=>attr(option,'role')==='option'&&dom.contains(e,option)&&attr(option,'aria-selected')==='true');
          for(const option of selected)emit(option,dom.text(option),true);
          if(!selected.length&&dom.text(e).trim())incomplete=true;
        }
        // Container text and chips remain values even with an empty nested input
        // or another resolved value source. Each source must resolve on its own.
        const text=dom.text(e);
        if(text.trim()||!value&&!active&&!numeric)emit(e,text,['option','checkbox','radio','switch','slider','spinbutton','menuitemcheckbox','menuitemradio','treeitem','gridcell'].includes(role));
      }
      // Recipient chips are read from the same inventory, without a second walk.
      for(const e of inventory.all){
        if(['iframe','frame','object','embed'].includes(dom.tag(e)))incomplete=true;
        for(const key of CHIP){const v=attr(e,key);if(v){sawRecipient=true;emit(e,v);}}
        if(!controls.has(e)&&WORD.test(nameOf(e))&&!['a','button','label','form'].includes(dom.tag(e))&&!['button','link','menuitem'].includes(attr(e,'role'))){
          const descendants=inventory.all.filter(n=>n!==e&&dom.contains(e,n));
          const hasControls=descendants.some(n=>controls.has(n));
          let chip=false;
          for(const n of descendants){
            if(CHIP.some(k=>attr(n,k))){chip=true;continue;}
            if(!controls.has(n)&&attr(n,'aria-label').includes('@')){chip=true;sawRecipient=true;emit(n,attr(n,'aria-label'));}
          }
          if(!hasControls&&!chip&&dom.text(e).trim())incomplete=true;
        }
      }
      dom.assertComplete();
      const composerOnly=!incomplete&&sawComposer&&!sawRecipient&&inventory.fields.every(e=>knownNon.has(e));
      return{sendCapable:true,recipients:out,fields,incomplete:incomplete||composerOnly,capped,scoped:false,noRecipientField:inventory.count===0&&!incomplete&&!sawRecipient,composerOnly};
    }catch{ return{sendCapable:true,recipients:out,fields,incomplete:true,capped,noRecipientField:false,composerOnly:false}; }
  }`;

/**
 * callFunctionOn(this = the effect target), returnByValue false. Returns an array of the elements whose content can
 * reach the target's accessible name or description: its labels, the targets of its aria-labelledby, aria-describedby
 * and aria-owns (attribute or reflected), and the targets of those attributes on its and its labels' descendants.
 * The server describes each with pierce to find closed shadow roots, which no page function can read (N5).
 */
export const RELATED_ELEMENTS_SOURCE = String.raw`function(){
    const el=this;const D=el.ownerDocument||document;const dom=(${NATIVE_DOM_SOURCE})();const out=[];
    const add=e=>{if(e&&dom.kind(e)===1&&e!==el&&out.indexOf(e)<0){if(out.length>=20)throw Error('Too many related elements');out.push(e);}};
    const refs=e=>{
      const res=[];let r=null;try{r=dom.root(e);}catch(x){}
      for(const a of ['aria-labelledby','aria-describedby','aria-owns']){
        const ids=dom.attr(e,a);
        if(ids)for(const id of ids.split(/\s+/).filter(Boolean).slice(0,10)){let t=null;try{t=dom.byId(r&&dom.kind(r)===11?r:D,id);}catch(x){}if(t)res.push(t);}
      }
      for(const p of ['ariaLabelledByElements','ariaDescribedByElements','ariaOwnsElements']){try{for(const t of dom.references(e,p,10))res.push(t);}catch(x){}}
      return res;
    };
    try{for(const l of dom.labels(el))add(l);}catch(e){}
    for(const t of refs(el))add(t);
    for(const root of [el].concat(out.slice())){
      const all=dom.query(root,'[aria-labelledby],[aria-describedby]',50);
      for(const d of Array.prototype.slice.call(all,0,50))for(const t of refs(d))add(t);
    }
    dom.assertComplete();
    return out;
  }`;

/**
 * callFunctionOn(this = the approved target, operation, key). Returns the ELEMENT the step takes effect on:
 *   a press acts on the focused element (deep through open shadow roots and same-origin frames), and Enter (any
 *   spelling, or a missing or unknown key) on a text field in a form gives the form's default submit button, else
 *   the first submit-like control in it (a shadow-DOM button or a role=button); a click on a label gives its control,
 *   a click inside a button gives the button; anything else the target itself.
 */
export const EFFECT_TARGET_SOURCE = String.raw`function(op,key){
    const dom=(${NATIVE_DOM_SOURCE})();
    try{
    const lower=v=>String(v==null?'':v).toLowerCase();
    const keyInfo=${KEY_INFO_SOURCE};
    const composedParent=n=>{const slot=dom.slot(n);if(slot)return slot;const p=dom.parent(n);return p&&dom.kind(p)===11?dom.parent(p):p;};
    const closestForm=start=>{for(let n=start,s=0;n&&s<400;n=composedParent(n),s++){if(dom.kind(n)===1&&dom.tag(n).toUpperCase()==='FORM')return n;}return null;};
    const noSubmit=e=>(dom.tag(e).toUpperCase()==='BUTTON'||dom.tag(e).toUpperCase()==='INPUT')&&['button','reset'].includes(lower(dom.controlType(e)));
    // The first submit-like control under a form, open shadow roots included.
    const deepSubmit=form=>{
      const roots=[form];let scanned=0;
      for(let i=0;i<roots.length&&i<100;i++){
        const all=dom.query(roots[i],'*');
        for(const e of all){
          if(++scanned>20000)throw Error('Incomplete submit traversal');
          let m=false;try{m=dom.matches(e,'button,input[type="submit" i],input[type="image" i],[role="button" i]');}catch(err){}
          if(m&&!noSubmit(e))return e;
          if(dom.shadow(e))roots.push(dom.shadow(e));
        }
      }
      if(roots.length>100)throw Error('Incomplete submit roots');
      return null;
    };
    const INTERACTIVE='button,a[href],area[href],input,select,textarea,summary,label,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="tab"],[role="option"]';
    const SUBMIT_INPUTS=['submit','image'];
    const isSubmit=e=>(dom.tag(e).toUpperCase()==='BUTTON'&&lower(dom.controlType(e))==='submit')||(dom.tag(e).toUpperCase()==='INPUT'&&SUBMIT_INPUTS.includes(lower(dom.controlType(e))));
    const el=this;
    if(['press','keyboard_press','key'].includes(lower(op))){
      // A key goes to whatever has focus, not to the element the step named.
      let base=el;
      try{
        const D=el.ownerDocument||document;
        let a=D.activeElement,hops=0;
        while(a&&hops++<20){
          if(dom.shadow(a)&&dom.shadow(a).activeElement){a=dom.shadow(a).activeElement;continue;}
          const t=a.tagName;
          if((t==='IFRAME'||t==='FRAME')){let inner=null;try{inner=a.contentDocument&&a.contentDocument.activeElement;}catch(e){}if(inner&&inner!==a.contentDocument.body){a=inner;continue;}}
          break;
        }
        if(a&&a!==D.body&&a!==D.documentElement)base=a;
      }catch(e){}
      if(keyInfo(key).enter){
        const tag=lower(dom.tag(base).toUpperCase());
        if(tag==='input'&&!SUBMIT_INPUTS.includes(lower(dom.controlType(base)))&&!['button','reset'].includes(lower(dom.controlType(base)))){
          const form=dom.form(base)||closestForm(base);
          if(form){
            let def=null;
            if(dom.form(base))def=dom.elements(dom.form(base)).find(isSubmit)||null;
            if(!def)def=deepSubmit(form);
            if(def)return def;
          }
        }
      }
      return base;
    }
    const hit=dom.closest(el,INTERACTIVE);
    if(!hit)return el;
    if(lower(dom.tag(hit).toUpperCase())==='label'){const control=hit.control;return control||hit;}
    return hit;
    }finally{dom.assertComplete();}
  }`;

/**
 * callFunctionOn(this = the effect target, options). Returns one plain object of facts about it and its page:
 * names, types, attributes, form field descriptors, text snippets, signature booleans, visibility.
 * No field value leaves this function. Live values are read in one place (liveValues) and used only inside the page:
 * to answer whether the AX name or description the server passed in contains one (nameHasValue, descriptionHasValue),
 * to drop any fallback name that contains one, and to mask one wherever it shows in visible text.
 * options: { operation, key, name, description, selectors: {consent, captcha, payment, paymentRequest, challenge}, currency }
 */
export const COLLECT_FLOOR_FACTS_SOURCE = String.raw`function(opts){
    const dom=(${NATIVE_DOM_SOURCE})();
    let traversalFailed=false;
    const el=this;
    const D=el.ownerDocument||document;
    const lower=v=>String(v==null?'':v).toLowerCase();
    const clipS=(v,n)=>String(v==null?'':v).replace(/\s+/g,' ').trim().slice(0,n);
    const upper=v=>String(v==null?'':v).toUpperCase();
    const norm=t=>String(t==null?'':t).replace(/\s+/g,' ').trim().toLowerCase();
    const tag=lower(dom.tag(el).toUpperCase());
    const attr=n=>dom.attr(el,n);
    const opL=lower(opts.operation);
    const key=opts.key==null?undefined:String(opts.key);
    const PRESS=['press','keyboard_press','key'];
    const keyInfo=${KEY_INFO_SOURCE};

    // ---- the composed tree: open shadow roots are crossed, slotted nodes sit under their slot ----
    const composedParent=n=>{
      try{
        const slot=dom.slot(n);if(slot)return slot;
        const p=dom.parent(n);return p&&dom.kind(p)===11?dom.parent(p):p;
      }catch(e){traversalFailed=true;return null;}
    };
    const cclosest=(start,sel)=>{
      for(let n=start,steps=0;n&&steps<400;n=composedParent(n),steps++){
        if(dom.kind(n)!==1)continue;
        try{if(dom.matches(n,sel))return n;}catch(e){return null;}
      }
      return null;
    };
    // Every element matching sel under root, including inside open shadow roots, up to cap.
    const deepAll=(root,sel,cap)=>{
      const out=[],roots=[root];let scanned=0,capped=false;
      try{if(root&&dom.shadow(root))roots.push(dom.shadow(root));}catch(e){traversalFailed=true;}
      for(let i=0;i<roots.length&&i<300;i++){
        let all;try{all=dom.query(roots[i],'*');}catch(e){traversalFailed=true;capped=true;break;}
        for(const e of all){
          if(++scanned>80000){capped=true;break;}
          let m=false;try{m=dom.matches(e,sel);}catch(err){}
          if(m){if(out.length>=cap){capped=true;break;}out.push(e);}
          if(dom.shadow(e))roots.push(dom.shadow(e));
        }
        if(capped)break;
      }
      if(roots.length>300)capped=true;
      if(capped)traversalFailed=true;
      return{list:out,capped:capped};
    };

    // ---- live values: the ONLY place a field value is read. Nothing read here is returned. ----
    const liveValues=(()=>{
      const SKIPTYPES=['hidden','submit','button','reset','image','checkbox','radio','file'];
      const valueOf=e=>{
        const out=[];
        try{
          const t=upper(dom.tag(e).toUpperCase());
          if(t==='INPUT'){if(!SKIPTYPES.includes(lower(dom.controlType(e))))out.push(e.value);}
          else if(t==='TEXTAREA')out.push(e.value);
          else if(t==='SELECT'){for(const o of dom.options(e)){out.push(dom.text(o));out.push(dom.value(o));}}
          else if(e.isContentEditable){const p=composedParent(e);if(!(p&&p.isContentEditable))out.push(e.textContent);}
        }catch(err){}
        return out;
      };
      const add=(list,v,min)=>{const n=norm(v).slice(0,4000);if(n.length>=min&&list.indexOf(n)<0)list.push(n);};
      // Values that can reach this element's accessible name or description: its own, its descendants', its labels',
      // and those of everything aria-labelledby, aria-describedby and aria-owns point at (attribute or reflected).
      const related=[];
      const relEls=[];
      const push=e=>{if(e&&dom.kind(e)===1&&relEls.length<400&&relEls.indexOf(e)<0)relEls.push(e);};
      // A subtree: the element, its fields and editors, and (two levels deep) whatever its descendants' aria-labelledby
      // and aria-describedby point at, since a descendant's reference also reaches the name (N6).
      const pushTree=(e,depth)=>{
        if(!e||dom.kind(e)!==1)return;
        push(e);
        for(const d of deepAll(e,'input,textarea,select,[contenteditable]',100).list)push(d);
        const level=depth||0;
        if(level>=2)return;
        for(const d of deepAll(e,'[aria-labelledby],[aria-describedby]',50).list){
          let r=null;try{r=dom.root(d);}catch(err){}
          for(const a of ['aria-labelledby','aria-describedby']){
            const ids=dom.attr(d,a);
            if(ids)for(const id of ids.split(/\s+/).filter(Boolean).slice(0,10)){
              let t=null;try{t=dom.byId(r&&dom.kind(r)===11?r:D,id);}catch(err){}
              if(t&&relEls.indexOf(t)<0)pushTree(t,level+1);
            }
          }
        }
      };
      try{
        pushTree(el);
        for(const l of dom.labels(el))pushTree(l);
        let r=null;try{r=dom.root(el);}catch(e){}
        const byId=id=>{try{return dom.byId(r&&dom.kind(r)===11?r:D,id);}catch(e){return null;}};
        for(const a of ['aria-labelledby','aria-describedby','aria-owns']){
          const ids=attr(a);
          if(ids)for(const id of ids.split(/\s+/).filter(Boolean).slice(0,20))pushTree(byId(id));
        }
        for(const p of ['ariaLabelledByElements','ariaDescribedByElements','ariaOwnsElements']){
          try{for(const e of dom.references(el,p,20))pushTree(e);}catch(e){}
        }
      }catch(e){}
      for(const e of relEls)for(const v of valueOf(e))add(related,v,3);
      // Every other field and editor in the document (open shadow roots included), for longer values.
      const all=[];
      const found=deepAll(D,'input,textarea,select,[contenteditable]',600);
      for(const e of found.list){for(const v of valueOf(e))add(all,v,8);if(all.length>=400)break;}
      return{related:related,all:all,capped:found.capped||all.length>=400};
    })();
    /*liveValues-end*/

    // A value longer than 32 characters is matched by its first or last 32, so a truncated copy is still caught.
    const probes=[];
    for(const v of liveValues.related.concat(liveValues.all)){
      if(v.length>32){probes.push({p:v.slice(0,32),len:v.length,head:true});probes.push({p:v.slice(-32),len:v.length,head:false});}
      else probes.push({p:v,len:v.length,head:true});
    }
    // Round 9 (R8-05): a name that is itself shaped like a code, PIN, SSN or card is a value whoever put it there (an input handler can copy one into a label).
    const SC2=${SECRET_CLASSIFIER_SOURCE};
    const hasValue=s=>{const n=norm(s);if(!n)return false;if(SC2.looksLikeSecretValue(String(s)))return true;for(const x of probes)if(n.includes(x.p))return true;return false;};
    const scrub=s=>hasValue(s)?'':s;
    // Masks every value occurrence in a piece of visible text (same length, so the rest of the text stays put).
    // minLen (optional): only values at least that long (the page path, where a short value is too common to mask).
    const mask=(s,minLen)=>{
      let base=String(s==null?'':s);
      if(!base||!probes.length)return base;
      let low=base.toLowerCase();
      if(low.length!==base.length)base=low;
      const star=n=>'*'.repeat(Math.max(0,n));
      for(const x of probes){
        if(minLen&&x.len<minLen)continue;
        let i=low.indexOf(x.p),guard=0;
        while(i>=0&&guard++<50){
          const from=x.head?i:Math.max(0,i+x.p.length-x.len);
          const to=x.head?Math.min(base.length,i+x.len):i+x.p.length;
          base=base.slice(0,from)+star(to-from)+base.slice(to);
          low=low.slice(0,from)+star(to-from)+low.slice(to);
          i=low.indexOf(x.p,to);
        }
      }
      return base;
    };
    // Whitespace folded, then masked, then cut: a value is never cut before it is masked (L1).
    const clipM=(v,n)=>mask(String(v==null?'':v).replace(/\s+/g,' ').trim()).slice(0,n);
    const nameHasValue=liveValues.capped&&!!opts.name?true:hasValue(opts.name);
    const descriptionHasValue=liveValues.capped&&!!opts.description?true:hasValue(opts.description);

    // ---- a target inside a frame (or a press whose focus sits in a frame): the frame, and whether the AX strings are clean ----
    const frameElement=PRESS.includes(opL)&&(tag==='iframe'||tag==='frame');
    if(D!==document||frameElement){
      let host='',path='';
      try{
        const u=frameElement?new URL(String(el.src||''),document.baseURI):D.location;
        host=String(u.hostname||'');path=String(u.pathname||'').slice(0,120);
      }catch(e){}
      dom.assertComplete();
      return{inFrame:true,frameElement:frameElement,frame:{host:host,path:path},nameHasValue:nameHasValue,descriptionHasValue:descriptionHasValue};
    }

    const type=(tag==='input'||tag==='button')?lower(dom.controlType(el)):(lower(attr('type'))||undefined);
    const BUTTON_INPUT=['button','submit','reset','image'];
    const isButtonInput=tag==='input'&&BUTTON_INPUT.includes(type);
    const textRoles=['textbox','searchbox','combobox'];
    const isField=(tag==='input'&&!isButtonInput&&type!=='checkbox'&&type!=='radio')||tag==='textarea'||tag==='select'||!!el.isContentEditable||textRoles.includes(lower(attr('role')));

    // ---- visible text: never from a field or an editor; visibility from computed style only ----
    const SKIP={SCRIPT:1,STYLE:1,NOSCRIPT:1,TEMPLATE:1,TEXTAREA:1,SELECT:1,OPTION:1,OPTGROUP:1,DATALIST:1,IFRAME:1,CANVAS:1,SVG:1,INPUT:1};
    const styleCache=new Map();
    const style=e=>{
      let v=styleCache.get(e);
      if(v===undefined){
        v={display:'',visibility:'visible'};
        try{const cs=getComputedStyle(e);v={display:cs.display,visibility:cs.visibility};}catch(err){}
        styleCache.set(e,v);
      }
      return v;
    };
    const acceptEl=node=>{
      if(SKIP[upper(node.tagName)])return false;
      if(node.isContentEditable)return false;
      if(style(node).display==='none')return false;
      return true;
    };
    const acceptText=node=>{
      if(!/\S/.test(node.nodeValue||''))return false;
      let p=dom.parent(node);if(p&&dom.kind(p)===11)p=dom.parent(p);
      if(!p)return true;
      if(p.isContentEditable)return false;
      try{if(dom.closest(p,'textarea'))return false;}catch(e){}
      const vis=style(p).visibility;
      return vis!=='hidden'&&vis!=='collapse';
    };
    const kids=n=>{
      try{
        if(dom.kind(n)===1){
          const sr=dom.shadow(n);if(sr)return dom.nodes(sr);
          if(dom.tag(n)==='slot'){const a=dom.assigned(n);if(a.length)return a;}
        }
        return dom.nodes(n);
      }catch(e){traversalFailed=true;return [];}
    };
    const STOP={};
    // Walks the flat tree under root in reading order. anchor (optional) is reported by onAnchor('enter'|'exit') and its
    // own subtree is not read; its ancestors are always entered. Returns false when the budget ran out.
    const walkFlat=(root,budget,onText,anchor,onAnchor,forced)=>{
      const stack=[root];let steps=0;
      while(stack.length){
        const node=stack.pop();
        if(node&&node.__exitAnchor){if(onAnchor('exit')===STOP)return true;continue;}
        if(++steps>budget)return false;
        if(anchor&&node===anchor){onAnchor('enter');stack.push({__exitAnchor:true});continue;}
        const nt=dom.kind(node);
        if(nt===3){if(acceptText(node)&&onText(node)===STOP)return true;continue;}
        if(nt===1){if(!acceptEl(node)&&!(forced&&forced.has(node)))continue;}
        else if(nt!==9&&nt!==11)continue;
        const c=kids(node);
        for(let i=c.length-1;i>=0;i--)stack.push(c[i]);
      }
      return true;
    };
    // Round 9 (R8-11): any traversal that ran out of budget makes the facts incomplete (the owner takes the step).
    let exhausted=false;
    // Round 10 (R10-07): strict collects read a control's own name; text cut at the character limit there is incomplete too (the sentence may lie beyond it).
    const collect=(root,cap,strict)=>{
      if(!root)return '';
      let out='',cut=false;
      if(!walkFlat(root,12000,t=>{out+=t.nodeValue+' ';if(out.length>=cap*2){cut=true;return STOP;}},null,null,null))exhausted=true;
      if(strict&&cut)exhausted=true;
      return clipM(out,cap);
    };
    // Up to 300 characters before and after the target in reading order. The anchor is the target, or the outermost
    // editor around it, so nothing typed into an editor is read. Starts from a near ancestor and widens.
    const near=(()=>{
      let anchor=el;
      for(let p=composedParent(anchor),s=0;p&&dom.kind(p)===1&&p.isContentEditable&&s<400;p=composedParent(p),s++)anchor=p;
      const forced=new Set();
      for(let p=composedParent(anchor),s=0;p&&s<400;p=composedParent(p),s++)forced.add(p);
      let best=null;
      for(const levels of [4,8,16,32,100000]){
        let root=anchor;
        for(let i=0;i<levels;i++){const p=composedParent(root);if(!p)break;root=p;}
        const top=!composedParent(root);
        let before='',after='',phase=0;
        // Whole text nodes, never cut here: the window is masked before it is cut to 300 (L1). The before window
        // keeps 800, so a value cut at its far edge is either caught by its 32-character head or tail or dropped by the cut.
        const done=walkFlat(root,60000,t=>{
          const s=String(t.nodeValue==null?'':t.nodeValue).replace(/\s+/g,' ').trim();if(!s)return;
          if(phase===0)before=(before+' '+s).slice(-800);
          else if(phase===2){after+=' '+s;if(after.length>=400)return STOP;}
        },anchor,k=>{phase=k==='enter'?1:2;},forced);
        if(phase===0){if(done&&!top)continue;break;}
        best={before:before,after:after};
        if(!done)exhausted=true;
        if(!done||top||(before.length>=300&&after.length>=300))break;
      }
      if(!best)return{failed:true,before:'',after:''};
      return{failed:exhausted,before:mask(clipS(best.before,4000)).slice(-300),after:mask(String(best.after).replace(/\s+/g,' ').trim()).slice(0,300)};
    })();

    // ---- names ----
    const rootOf=()=>{try{return dom.root(el);}catch(e){return D;}};
    const byId=id=>{const r=rootOf();return dom.byId(r&&dom.kind(r)===11?r:D,id);};
    const labelledBy=()=>{
      const by=attr('aria-labelledby');if(!by)return '';
      return by.split(/\s+/).filter(Boolean).slice(0,20).map(id=>{const n=byId(id);return n?collect(n,200,true):'';}).filter(Boolean).join(' ');
    };
    const labels=()=>{const out=[];try{for(const l of dom.labels(el))out.push(collect(l,200,true));}catch(e){}return out.filter(Boolean).join(' ');};
    const buttonValue=isButtonInput?clipS(scrub(el.value),200):'';
    const ownText=isField?'':scrub(collect(el,500,true));
    const fallbackName=clipS(scrub(labelledBy())||scrub(attr('aria-label'))||scrub(labels())||ownText||buttonValue||scrub(attr('alt'))||scrub(attr('title'))||scrub(attr('placeholder'))||'',500);
    // ---- wasPassword: the guard's own flag when it exposes one, else what is visible now ----
    let wasPassword;
    try{const g=globalThis.__murageGuard;if(g&&typeof g.wasPassword==='function')wasPassword=!!g.wasPassword(el);}catch(e){}
    if(wasPassword!==true){
      let masked=false;
      try{const v=getComputedStyle(el).webkitTextSecurity;masked=!!v&&v!=='none';}catch(e){}
      if(isField&&masked&&type!=='password')wasPassword=true;
    }

    // ---- containers, across open shadow roots ----
    const form=dom.form(el)||cclosest(el,'form');
    const dialog=cclosest(el,'dialog[open],[role="dialog"],[role="alertdialog"],[aria-modal="true"]');
    const LANDMARK='main,aside,nav,header,footer,form,section[aria-label],section[aria-labelledby],[role="main"],[role="banner"],[role="contentinfo"],[role="complementary"],[role="navigation"],[role="region"],[role="search"],[role="form"]';
    const landmark=cclosest(composedParent(el)||el,LANDMARK);

    // ---- submit ----
    const isSubmitBtn=(tag==='button'&&type==='submit')||(tag==='input'&&(type==='submit'||type==='image'));
    const buttonLike=tag==='button'||isButtonInput||lower(attr('role'))==='button';
    const ACTIVATE=['click','dblclick','double_click','tap','keyboard_activate','activate','submit','check','uncheck','toggle'];
    const ki=PRESS.includes(opL)?keyInfo(key):null;
    const viaEnter=!!ki&&ki.enter;
    const viaClick=ACTIVATE.includes(opL)||(!!ki&&ki.space);
    const activation=viaClick||viaEnter||(!!ki&&ki.mod);
    // Fields whose Enter takes part in implicit submission (HTML 4.10.21.2).
    const IMPLICIT=['text','search','url','tel','email','password','date','month','week','time','datetime-local','number'];
    const nativeNoSubmit=(tag==='button'||tag==='input')&&(type==='reset'||type==='button');
    // undefined = unsure. false only when proved: a type=button or reset control in a form, or Enter in a form's text
    // field when the form has no submit control and more than one implicit-submission field.
    let submits;
    if(activation){
      if(opL==='submit'){if(form)submits=true;}
      else if(buttonLike&&(viaClick||viaEnter)){
        // A submit button, a shadow-DOM button or a role=button inside a form (found across shadow roots) submits;
        // form-less, a script submits whatever sits around it (M4).
        submits=nativeNoSubmit&&form?false:true;
      }else if(viaEnter&&tag==='input'&&IMPLICIT.includes(type)){
        if(!form)submits=true;
        else if(dom.form(el)===form){
          const deepButton=deepAll(form,'button,input[type="submit" i],input[type="image" i],[role="button" i]',20).list.some(b=>!((upper(dom.tag(b).toUpperCase())==='BUTTON'||upper(dom.tag(b).toUpperCase())==='INPUT')&&['reset','button'].includes(lower(dom.controlType(b)))));
          let blocking=0;
          try{for(const e of dom.elements(form,2000))if(upper(dom.tag(e).toUpperCase())==='INPUT'&&IMPLICIT.includes(lower(dom.controlType(e))))blocking++;}catch(err){blocking=-1;traversalFailed=true;}
          if(deepButton||blocking===1)submits=true;
          else if(blocking>1)submits=false;
        }
      }
    }

    // ---- form fields: the form's own elements (form= included), else the dialog, landmark or document ----
    const cleanUrl=u=>{try{const x=new URL(String(u),D.baseURI);return (x.origin==='null'?x.protocol:x.origin)+x.pathname;}catch(e){return clipS(u,200).split(/[?#]/)[0];}};
    const FIELD_SEL='input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]),textarea,select,[contenteditable]:not([contenteditable="false"])';
    const fieldNode=e=>{
      const names=[];
      try{for(const l of dom.labels(e))names.push(collect(l,100));}catch(err){}
      const by=dom.attr(e,'aria-labelledby');
      if(by){let r=null;try{r=dom.root(e);}catch(err){}for(const id of by.split(/\s+/).filter(Boolean).slice(0,3)){let n=null;try{n=dom.byId(r&&dom.kind(r)===11?r:D,id);}catch(err){}if(n)names.push(collect(n,100));}}
      names.push(clipM(dom.attr(e,'aria-label'),100),clipM(dom.attr(e,'placeholder'),100),clipM(dom.attr(e,'title'),100));
      let masked=false;
      try{const v=getComputedStyle(e).webkitTextSecurity;masked=!!v&&v!=='none';}catch(err){}
      return{type:lower(dom.controlType(e)||dom.attr(e,'type')||''),autocomplete:lower(dom.attr(e,'autocomplete')),names:clipM(names.filter(Boolean).join(' '),200),idName:clipM((dom.attr(e,'id')||'')+' '+(dom.attr(e,'name')||''),120),masked:masked};
    };
    // Password, one-time-code and card fields first, so a long form cannot push them past the cap.
    const PRIORITY_WORD=/pass|pwd|card|cvv|cvc|csc|ccnum|ccexp|expir|otp|one.?time|code|pin|iban|secur|token|totp|2fa/i;
    const priority=e=>{
      try{
        const t=lower(dom.controlType(e));const ac=lower(dom.attr(e,'autocomplete'));
        if(t==='password')return true;
        if(/(^|\s)(one-time-code|current-password|new-password|cc-[a-z-]+)(\s|$)/.test(ac))return true;
        const v=getComputedStyle(e).webkitTextSecurity;if(v&&v!=='none')return true;
        return PRIORITY_WORD.test((dom.attr(e,'id')||'')+' '+(dom.attr(e,'name')||'')+' '+(dom.attr(e,'aria-label')||'')+' '+(dom.attr(e,'placeholder')||''));
      }catch(err){return true;}
    };
    let fieldsCapped=false;
    let fieldEls=[];
    if(form){
      try{for(const e of dom.elements(form,2000)){let m=false;try{m=dom.matches(e,FIELD_SEL);}catch(err){}if(m)fieldEls.push(e);}}catch(e){traversalFailed=true;}
      for(const e of deepAll(form,FIELD_SEL,2000).list)if(fieldEls.indexOf(e)<0)fieldEls.push(e);
    }else{
      fieldEls=deepAll(dialog||landmark||D,FIELD_SEL,2000).list;
    }
    const first=fieldEls.filter(priority),rest=fieldEls.filter(e=>!priority(e));
    if(first.length>${FIELD_CAP})fieldsCapped=true;
    const nodes=first.concat(rest).slice(0,${FIELD_CAP});
    const formOut={fields:nodes.map(fieldNode),hasCurrencyAmount:false};
    const scope=form||dialog;
    if(scope){
      try{formOut.hasCurrencyAmount=new RegExp(opts.currency.source,opts.currency.flags).test(collect(scope,5000));}catch(e){}
    }
    if(form){
      let action=dom.formProperty(form,'action'),method=dom.formProperty(form,'method');
      if(isSubmitBtn&&dom.attr(el,'formaction')!==null)action=el.formAction;
      if(isSubmitBtn&&dom.attr(el,'formmethod')!==null)method=el.formMethod;
      formOut.action=cleanUrl(action).slice(0,200);
      formOut.method=lower(method||'get').slice(0,10);
    }

    // ---- page ----
    const q=sels=>{for(const s of sels){try{if(dom.query(D,s).length)return true;}catch(e){traversalFailed=true;}}return false;};
    const insideAny=sels=>{
      for(let n=el,steps=0;n&&steps<400;n=composedParent(n),steps++){
        if(dom.kind(n)!==1)continue;
        for(const s of sels){try{if(dom.matches(n,s))return true;}catch(e){}}
      }
      return false;
    };
    const sel=opts.selectors;
    // The generic consent rule: a fixed or sticky container whose text says cookie plus accept or agree.
    const genericConsent=[];
    try{
      const candidates=dom.query(D,'[class*="cookie" i],[id*="cookie" i],[class*="consent" i],[id*="consent" i],[class*="gdpr" i],[id*="gdpr" i],[role="dialog"],[aria-modal="true"],dialog',80);
      for(const c of Array.prototype.slice.call(candidates,0,80)){
        let pos='';try{pos=getComputedStyle(c).position;}catch(e){}
        if(pos!=='fixed'&&pos!=='sticky')continue;
        const text=lower(collect(c,600));
        if(text.includes('cookie')&&/accept|agree|allow|consent/.test(text))genericConsent.push(c);
      }
    }catch(e){traversalFailed=true;}
    const isAncestor=c=>{for(let n=el,steps=0;n&&steps<400;n=composedParent(n),steps++)if(n===c)return true;return false;};
    const inGeneric=genericConsent.find(isAncestor);
    const namedConsent=(()=>{
      for(let n=el,steps=0;n&&steps<400;n=composedParent(n),steps++){
        if(dom.kind(n)!==1)continue;
        for(const s of sel.consent){try{if(dom.matches(n,s))return n;}catch(e){}}
      }
      return null;
    })();
    const consentBox=namedConsent||inGeneric||null;
    // Is any optional category switched on? A toggle counts as necessary only when it is disabled; every other
    // toggle counts, whatever its label says. Unknown (undefined) when the banner has no enabled switches.
    let consentOptionalOn;
    if(consentBox){
      const toggles=deepAll(consentBox,'input[type="checkbox"],[role="switch"],[role="checkbox"]',200).list.filter(t=>!(t.disabled||dom.attr(t,'aria-disabled')==='true'));
      if(toggles.length>0)consentOptionalOn=toggles.some(t=>t.checked===true||dom.attr(t,'aria-checked')==='true');
    }
    const pageOut={
      urlPath:mask(location.pathname,8).slice(0,${URL_CAP}),
      title:clipM(D.title,200),
      hasPaymentRequestButton:q(sel.paymentRequest),
      hasCurrencyAmount:false,
      domConsent:q(sel.consent)||genericConsent.length>0,
      domCaptcha:q(sel.captcha),
      domPayment:q(sel.payment),
      domChallenge:q(sel.challenge),
    };
    try{pageOut.hasCurrencyAmount=new RegExp(opts.currency.source,opts.currency.flags).test(collect(D.body,8000));}catch(e){}

    // ---- visibility ----
    const visibility=(()=>{
      const r=el.getBoundingClientRect();
      const box={x:Math.round(r.left),y:Math.round(r.top),width:Math.round(r.width),height:Math.round(r.height)};
      const vw=window.innerWidth,vh=window.innerHeight;
      const inViewport=r.width>0&&r.height>0&&r.right>0&&r.bottom>0&&r.left<vw&&r.top<vh;
      let opacity=1,ariaHidden=false,steps=0;
      for(let n=el;n&&dom.kind(n)===1&&steps++<60;n=composedParent(n)){
        try{opacity*=parseFloat(getComputedStyle(n).opacity);}catch(e){}
        if(dom.attr(n,'aria-hidden')==='true')ariaHidden=true;
      }
      let visible='visible';try{visible=getComputedStyle(el).visibility;}catch(e){}
      let coveredBy=null;
      if(inViewport){
        const x=Math.min(Math.max(r.left+r.width/2,0),vw-1),y=Math.min(Math.max(r.top+r.height/2,0),vh-1);
        let hit=D.elementFromPoint(x,y);
        while(hit&&dom.shadow(hit)){const inner=dom.shadow(hit).elementFromPoint(x,y);if(!inner||inner===hit)break;hit=inner;}
        if(hit&&hit!==el&&!dom.contains(el,hit)&&!dom.contains(hit,el)){
          let viaLabel=false;
          try{for(const l of dom.labels(el))if(dom.contains(l,hit))viaLabel=true;}catch(e){}
          if(!viaLabel){
            const text=collect(hit,60);
            coveredBy=lower(dom.tag(hit).toUpperCase())+(dom.attr(hit,'id')?'#'+mask(String(dom.attr(hit,'id'))).slice(0,40):'')+(text?' "'+text+'"':'');
          }
        }
      }
      return{box:box,inViewport:inViewport,opacity:isNaN(opacity)?null:Math.round(opacity*100)/100,visibility:visible,ariaHidden:ariaHidden,coveredBy:coveredBy};
    })();

    const result={
      sendCapable:(${SEND_CAPABLE_SOURCE})(el,opts.operation,opts.key,dom),
      tag:tag,type:type,roleAttr:lower(attr('role'))||undefined,
      text:ownText||undefined,
      buttonValue:buttonValue||undefined,
      title:clipS(scrub(attr('title')),200)||undefined,
      ariaLabel:clipS(scrub(attr('aria-label')),200)||undefined,
      alt:clipS(scrub(attr('alt')),200)||undefined,
      placeholder:isField?clipS(scrub(attr('placeholder')),200)||undefined:undefined,
      fieldName:clipM((dom.attr(el,'id')||'')+' '+(dom.attr(el,'name')||''),160)||undefined,
      autocomplete:lower(attr('autocomplete'))||undefined,
      checked:typeof el.checked==='boolean'&&(type==='checkbox'||type==='radio')?el.checked:undefined,
      required:el.required===true?true:undefined,
      submits:submits,
      wasPassword:wasPassword,
      fallbackName:fallbackName,
      nameHasValue:nameHasValue,
      descriptionHasValue:descriptionHasValue,
      valuesCapped:liveValues.capped,
      fieldsCapped:fieldsCapped,
      nearFailed:near.failed,
      form:formOut,
      snippets:{form:form?collect(form,${SNIPPET_CAP}):'',dialog:dialog?collect(dialog,${SNIPPET_CAP}):'',landmark:landmark?collect(landmark,${SNIPPET_CAP}):'',before:near.before,after:near.after},
      page:pageOut,
      signatures:{consentManager:!!consentBox,captcha:insideAny(sel.captcha),payment:insideAny(sel.payment)},
      consentOptionalOn:consentOptionalOn,
      visibility:visibility
    };
    // Round 10 (R9-07): one final exhaustion flag. Every collect() above has run by now, so a budget that ran out in any of them (names, labels, snippets) counts.
    result.nearFailed=near.failed===true||exhausted||traversalFailed;
    dom.assertComplete();
    if(traversalFailed)throw Error('Incomplete native facts traversal');
    return result;
  }`;


// ---------------------------------------------------------------------------
// Assembly (pure, defensive: only declared fields are copied)
// ---------------------------------------------------------------------------

const asString = (value: unknown, cap: number): string | undefined => (typeof value === "string" && value.length > 0 ? value.slice(0, cap) : undefined);
const asBool = (value: unknown): boolean | undefined => (typeof value === "boolean" ? value : undefined);
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function stripQuery(url: string, cap: number): string {
  return url.split(/[?#]/)[0].slice(0, cap);
}

const OTHER_ROLES = new Set(["none", "generic", "statictext", "inlinetextbox", "rootwebarea", "webarea"]);

interface AxRead {
  name?: string;
  description?: string;
  /** Up to AX_TEST_CAP characters, only for the page's value test; never copied into the facts. */
  nameFull?: string;
  descriptionFull?: string;
  role?: string;
  checked?: boolean;
  required?: boolean;
}

function readAx(response: any, backendNodeId: number): AxRead {
  const nodes: any[] = Array.isArray(response?.nodes) ? response.nodes : [];
  const node = nodes.find(item => item?.backendDOMNodeId === backendNodeId) ?? nodes[0];
  if (!node) return {};
  const out: AxRead = {};
  out.name = asString(node.name?.value, NAME_CAP);
  out.description = asString(node.description?.value, NAME_CAP);
  out.nameFull = asString(node.name?.value, AX_TEST_CAP);
  out.descriptionFull = asString(node.description?.value, AX_TEST_CAP);
  const role = asString(node.role?.value, 40);
  if (role && !OTHER_ROLES.has(role.toLowerCase())) out.role = role.toLowerCase();
  for (const property of Array.isArray(node.properties) ? node.properties : []) {
    const value = property?.value?.value;
    if (property?.name === "checked") out.checked = value === true || value === "true" || value === "mixed";
    if (property?.name === "required") out.required = value === true || value === "true";
  }
  return out;
}

const CREDENTIAL_FIELD_MATCHER = compilePhrases(CREDENTIAL_FIELD);
const CARD_WORD = /card|cvv|cvc|csc|iban|ccnum|ccexp|expir|カード|卡|कार्ड|tarjeta|carte|karte|cartão|cartao/iu;
const OTP_WORD = /otp|one.?time|verification|authenticat|2fa|totp|mfa|sms|recovery|backup|confirmation|code|ワンタイム|認証|验证|驗證|ओटीपी/iu;

interface FieldDescriptor {
  type: string;
  autocomplete: string;
  names: string;
  idName: string;
  masked: boolean;
}

function readFields(value: unknown): FieldDescriptor[] {
  if (!Array.isArray(value)) return [];
  const out: FieldDescriptor[] = [];
  for (const item of value.slice(0, FIELD_CAP)) {
    if (!isObject(item)) continue;
    out.push({
      type: typeof item.type === "string" ? item.type.toLowerCase().slice(0, 30) : "",
      autocomplete: typeof item.autocomplete === "string" ? item.autocomplete.toLowerCase().slice(0, 80) : "",
      names: typeof item.names === "string" ? item.names.slice(0, 200) : "",
      idName: typeof item.idName === "string" ? item.idName.slice(0, 120) : "",
      masked: item.masked === true,
    });
  }
  return out;
}

function identifierTokens(identifier: string): string[] {
  const split = identifier.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return [...split, identifier.toLowerCase().replace(/[^a-z0-9]+/g, "")];
}

function formFlags(fields: FieldDescriptor[]): { hasPasswordField: boolean; hasOneTimeCodeField: boolean; hasCardFields: boolean } {
  let hasPasswordField = false;
  let hasOneTimeCodeField = false;
  let hasCardFields = false;
  for (const field of fields) {
    const tokens = field.autocomplete.split(/\s+/).filter(Boolean);
    const named = foldText(field.names);
    const credentialName = !!named && CREDENTIAL_FIELD_MATCHER.test(named);
    const identifier = identifierTokens(field.idName).some(token => CREDENTIAL_IDENTIFIER_TOKENS.includes(token));
    const password = field.type === "password" || field.masked || tokens.includes("current-password") || tokens.includes("new-password");
    const card = tokens.some(token => token.startsWith(CARD_AUTOCOMPLETE_PREFIX)) || ((credentialName || identifier) && (CARD_WORD.test(field.names) || CARD_WORD.test(field.idName)));
    const oneTime = tokens.includes("one-time-code") || ((credentialName || identifier) && !card && !password && (OTP_WORD.test(field.names) || OTP_WORD.test(field.idName)));
    if (password) hasPasswordField = true;
    if (card) hasCardFields = true;
    if (oneTime) hasOneTimeCodeField = true;
    if (!password && !card && !oneTime && CREDENTIAL_AUTOCOMPLETE_TOKENS.some(token => tokens.includes(token))) hasPasswordField = true;
  }
  return { hasPasswordField, hasOneTimeCodeField, hasCardFields };
}

/** Round 7: the floor's own classifier (formFlags, with its card and one-time-code words) applied to one recipient-scan field. */
export function isSecretDescriptor(field: FieldDescriptor): boolean {
  const flags = formFlags([field]);
  if (flags.hasPasswordField || flags.hasCardFields || flags.hasOneTimeCodeField) return true;
  return CARD_WORD.test(field.names) || CARD_WORD.test(field.idName) || looksLikeSecretName(`${field.names} ${field.idName} ${field.autocomplete} ${field.type}`);
}

/** What the recipient scan found, minus anything that came from a secret field, has no descriptor (unclassified provenance is not trusted),
 * or is not an address, handle or phone number. `dropped` says something secret-shaped or unclassified was removed: the recipients are then unknown. */
function cleanScanned(list: unknown[], fields: unknown): { list: unknown[]; dropped: boolean } {
  if (!list.every(item => typeof item === "string")) return { list, dropped: false };
  let dropped = false;
  const kept = (list as string[]).filter((_, i) => {
    const raw = Array.isArray(fields) ? fields[i] : null;
    if (raw === null || raw === undefined) { dropped = true; return false; }
    const [field] = readFields([raw]);
    if (!field || isSecretDescriptor(field)) { dropped = true; return false; }
    return true;
  });
  const clean = cleanRecipients(kept);
  if (clean.length !== kept.length) dropped = true;
  return { list: clean, dropped };
}

function frameRef(url: string): FrameRef | null {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname) return null;
    return { host: parsed.hostname.toLowerCase(), path: parsed.pathname.slice(0, 120) };
  } catch {
    return null;
  }
}

interface FrameScan {
  frames: FrameRef[];
  consent: boolean;
  captcha: boolean;
  payment: boolean;
  urlPath?: string;
}

function scanFrameTree(response: any): FrameScan {
  const scan: FrameScan = { frames: [], consent: false, captcha: false, payment: false };
  const main = response?.frameTree?.frame;
  if (typeof main?.url === "string") {
    try {
      scan.urlPath = new URL(main.url).pathname.slice(0, URL_CAP);
    } catch {
      scan.urlPath = undefined;
    }
  }
  let visited = 0;
  const visit = (node: any, depth: number) => {
    if (!node || depth > 8) return;
    for (const child of Array.isArray(node.childFrames) ? node.childFrames : []) {
      const url = typeof child?.frame?.url === "string" ? child.frame.url : "";
      const name = typeof child?.frame?.name === "string" ? child.frame.name : "";
      if (++visited > 500) return;
      const ref = frameRef(url);
      if (ref && scan.frames.length < FRAME_CAP) scan.frames.push(ref);
      const sig = (ref ? matchFrame(ref) : null) ?? (name ? matchFrameName(name) : null);
      if (sig) scan[sig.kind] = true;
      visit(child, depth + 1);
    }
  };
  visit(response?.frameTree, 0);
  return scan;
}

function isChallenge(urlPath: string | undefined, title: string | undefined, domChallenge: boolean): boolean {
  if (domChallenge) return true;
  if (urlPath && CHALLENGE_PATH_PATTERNS.some(pattern => pattern.test(urlPath))) return true;
  const folded = foldText(title ?? "");
  if (!folded) return false;
  if (CHALLENGE_TITLE_PREFIXES.some(prefix => folded.startsWith(foldText(prefix)))) return true;
  return CHALLENGE_TITLE_PHRASES.some(phrase => folded.includes(foldText(phrase)));
}

function readVisibility(value: unknown): FloorVisibility {
  const out = emptyVisibility();
  if (!isObject(value)) return out;
  const box = value.box;
  if (isObject(box) && ["x", "y", "width", "height"].every(key => typeof box[key] === "number" && Number.isFinite(box[key] as number))) {
    out.box = { x: box.x as number, y: box.y as number, width: box.width as number, height: box.height as number };
  }
  out.inViewport = asBool(value.inViewport) ?? null;
  out.opacity = typeof value.opacity === "number" && Number.isFinite(value.opacity) ? value.opacity : null;
  out.visibility = asString(value.visibility, 20) ?? null;
  out.ariaHidden = asBool(value.ariaHidden) ?? null;
  out.coveredBy = asString(value.coveredBy, 120) ?? null;
  return out;
}

/** Whether a DOM.describeNode tree (depth -1, pierce) holds a closed shadow root anywhere. Bounded. */
function hasClosedShadowRoot(root: any): boolean {
  const stack: any[] = [root];
  let seen = 0;
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (++seen > 50_000) return true; // too big to check: treat as unreadable
    if (node.shadowRootType === "closed") return true;
    for (const key of ["children", "shadowRoots"]) if (Array.isArray(node[key])) stack.push(...node[key]);
    if (node.contentDocument) stack.push(node.contentDocument);
    if (node.templateContent) stack.push(node.templateContent);
  }
  return false;
}

function selectorsForPage() {
  const unique = (list: string[]) => [...new Set(list)];
  const paymentRequestIds = new Set(["payment-request", "apple-pay", "google-pay"]);
  return {
    consent: unique(signatureSelectors("consent")),
    captcha: unique(signatureSelectors("captcha")),
    payment: unique(signatureSelectors("payment")),
    paymentRequest: unique(ALL_FRAME_SIGNATURES.filter(sig => paymentRequestIds.has(sig.id)).flatMap(sig => [...sig.selectors])),
    challenge: ["#challenge-form", "#cf-challenge-running", "#challenge-stage"],
  };
}

// ---------------------------------------------------------------------------
// The collector
// ---------------------------------------------------------------------------

/**
 * Facts for `classifyFloor` and `visibility` for the intent check, for one step. `target` is the resolved
 * target (omit it for a dialog answer). Never throws; a failure sets `factsFailed` and keeps what was gathered.
 */
/** The operations that can send, share or invite: a click or an activating key. A read, a scroll or typing is never scanned. */
const RECIPIENT_OPERATIONS = new Set(["click", "dblclick", "double_click", "tap", "activate", "keyboard_activate", "press", "keyboard_press", "key", "submit"]);

export async function collectFloorFacts(io: FloorFactsIo, target: FloorTarget | undefined, operation: string, extra: FloorFactsExtra = {}): Promise<FloorFactsResult> {
  const facts: FloorFactsResult = { operation, visibility: emptyVisibility() };
  if (extra.key !== undefined) facts.key = extra.key;
  if (extra.dialog) facts.dialog = { kind: String(extra.dialog.kind ?? "").slice(0, 40), text: String(extra.dialog.text ?? "").slice(0, SNIPPET_CAP) };

  const document = target?.document;
  const gather = async () => {
    const fail = () => {
      facts.factsFailed = true;
    };
    // Page facts first: they survive a target that cannot be read.
    let scan: FrameScan = { frames: [], consent: false, captcha: false, payment: false };
    if (document) {
      try {
        scan = scanFrameTree(await io.send("Page.getFrameTree", {}, document));
        // The frame tree's path is never sent: it cannot be checked against field values. Only the page
        // function's masked path goes out (below).
        facts.page = { frames: scan.frames };
        if (scan.consent) facts.page.hasConsentManager = true;
        if (scan.captcha) facts.page.hasCaptcha = true;
        if (scan.payment) facts.page.hasPaymentFrame = true;
      } catch {
        fail();
      }
    }
    if (!target || !document || target.backendNodeId === undefined) return;
    const backendNodeId = target.backendNodeId;

    let contextId: number;
    let objectId: string;
    try {
      contextId = await io.world(document);
      const resolved = await io.send("DOM.resolveNode", { backendNodeId, executionContextId: contextId }, document);
      if (typeof resolved?.object?.objectId !== "string") throw new Error("unresolved");
      objectId = resolved.object.objectId;
    } catch {
      fail();
      return;
    }

    // The element the step takes effect on (spec 2.1), then its backend node id for the AX call.
    let effectObjectId = objectId;
    let effectNodeId = backendNodeId;
    try {
      const effect = await io.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: EFFECT_TARGET_SOURCE,
        arguments: [{ value: operation }, { value: extra.key ?? null }],
        returnByValue: false,
      }, document);
      if (effect?.exceptionDetails || typeof effect?.result?.objectId !== "string") throw new Error("no effect target");
      effectObjectId = effect.result.objectId;
      const described = await io.send("DOM.describeNode", { objectId: effectObjectId }, document);
      if (Number.isSafeInteger(described?.node?.backendNodeId)) effectNodeId = described.node.backendNodeId;
    } catch {
      fail();
    }

    // N5: no page function can read a closed shadow root, so a value inside one could reach the AX name unseen. The
    // effect target and every element whose content feeds its name are described with pierce; any closed root (or a
    // check that cannot run) makes the facts partial and the AX name and description unusable.
    let closedRoot = false;
    try {
      const objectIds = [effectObjectId];
      const related = await io.send("Runtime.callFunctionOn", { objectId: effectObjectId, functionDeclaration: RELATED_ELEMENTS_SOURCE, returnByValue: false }, document);
      if (related?.exceptionDetails || typeof related?.result?.objectId !== "string") throw new Error("no related elements");
      const props = await io.send("Runtime.getProperties", { objectId: related.result.objectId, ownProperties: true }, document);
      if (!Array.isArray(props?.result)) throw new Error("no related elements");
      for (const prop of props.result) {
        if (typeof prop?.name === "string" && /^\d+$/.test(prop.name) && typeof prop?.value?.objectId === "string") objectIds.push(prop.value.objectId);
      }
      for (const id of objectIds.slice(0, 21)) {
        const described = await io.send("DOM.describeNode", { objectId: id, depth: -1, pierce: true }, document);
        if (!isObject(described?.node)) throw new Error("not described");
        if (hasClosedShadowRoot(described.node)) {
          closedRoot = true;
          break;
        }
      }
    } catch {
      closedRoot = true;
    }
    if (closedRoot) fail();

    let ax: AxRead = {};
    try {
      ax = readAx(await io.send("Accessibility.getPartialAXTree", { backendNodeId: effectNodeId, fetchRelatives: false }, document), effectNodeId);
    } catch {
      fail();
    }

    let raw: Record<string, unknown> | undefined;
    try {
      const response = await io.send("Runtime.callFunctionOn", {
        objectId: effectObjectId,
        functionDeclaration: COLLECT_FLOOR_FACTS_SOURCE,
        arguments: [{ value: { operation, key: extra.key ?? null, name: ax.nameFull ?? "", description: ax.descriptionFull ?? "", selectors: selectorsForPage(), currency: CURRENCY_SOURCE } }],
        returnByValue: true,
      }, document);
      if (response?.exceptionDetails || !isObject(response?.result?.value)) throw new Error("page facts failed");
      raw = response.result.value;
    } catch {
      fail();
    }
    // The AX name or description is used only when the page tested it against every live field value and found
    // none in it (H1). Without that answer (page function failed, garbage, an older page side) it is not used.
    const axName = !closedRoot && raw?.nameHasValue === false ? ax.name : undefined;
    const axDescription = !closedRoot && raw?.descriptionHasValue === false ? ax.description : undefined;
    if (!raw) {
      if (ax.role) facts.role = ax.role;
      return;
    }

    if (raw.inFrame === true && isObject(raw.frame)) {
      // The collector cannot read inside the frame, so this is never a complete answer (M5). The AX name and
      // role stay, so a "Place order" inside an unknown frame still reads as payment.
      facts.factsFailed = true;
      const host = asString(raw.frame.host, 200) ?? "";
      const path = asString(raw.frame.path, 120);
      facts.frame = { host, ...(path ? { path } : {}), readable: false };
      // A press whose focus sits in a frame acts on an element inside it: the frame element's own name is not that element's.
      if (raw.frameElement !== true) {
        if (axName) facts.name = axName;
        if (axDescription) facts.description = axDescription;
        if (ax.role) facts.role = ax.role;
      }
      const sig = host ? matchFrame({ host, ...(path ? { path } : {}) }) : null;
      facts.signatures = { consentManager: sig?.kind === "consent", captcha: sig?.kind === "captcha", payment: sig?.kind === "payment" };
      return;
    }

    // Partial reads are floor-unsure: values not all checked, priority fields past the cap, or the target missing
    // from reading order. Open roots are traversed; the pierced DOM check above refuses closed roots.
    if (raw.valuesCapped === true || raw.fieldsCapped === true || raw.nearFailed === true) facts.factsFailed = true;

    // With a closed root in play there is no name at all (the fallback cannot be shown free of that subtree either).
    const name = closedRoot ? undefined : axName ?? asString(raw.fallbackName, NAME_CAP);
    const description = axDescription;
    const role = ax.role ?? asString(raw.roleAttr, 40);
    const set = <K extends keyof FloorFacts>(key: K, value: FloorFacts[K] | undefined) => {
      if (value !== undefined) (facts as FloorFacts)[key] = value;
    };
    set("tag", asString(raw.tag, 30));
    set("type", asString(raw.type, 30));
    set("role", role);
    set("name", name);
    set("description", description);
    set("text", asString(raw.text, 500));
    set("buttonValue", asString(raw.buttonValue, 200));
    set("title", asString(raw.title, 200));
    set("ariaLabel", asString(raw.ariaLabel, 200));
    set("alt", asString(raw.alt, 200));
    set("placeholder", asString(raw.placeholder, 200));
    set("fieldName", asString(raw.fieldName, 160));
    set("autocomplete", asString(raw.autocomplete, 80));
    set("wasPassword", asBool(raw.wasPassword));
    set("checked", ax.checked ?? asBool(raw.checked));
    set("required", ax.required ?? asBool(raw.required));
    set("submits", asBool(raw.submits));
    set("consentOptionalOn", asBool(raw.consentOptionalOn));

    if (isObject(raw.form)) {
      const flags = formFlags(readFields(raw.form.fields));
      const action = asString(raw.form.action, URL_CAP);
      const method = asString(raw.form.method, 10);
      facts.form = {
        ...(action ? { action: stripQuery(action, URL_CAP) } : {}),
        ...(method ? { method: method.toLowerCase() } : {}),
        ...flags,
        hasCurrencyAmount: raw.form.hasCurrencyAmount === true,
      };
    }

    if (isObject(raw.snippets)) {
      const snippets: NonNullable<FloorFacts["snippets"]> = {};
      const cap = (key: "form" | "dialog" | "landmark") => {
        const value = asString((raw.snippets as Json)[key], SNIPPET_CAP);
        if (value) snippets[key] = value;
      };
      cap("form");
      cap("dialog");
      cap("landmark");
      const before = asString((raw.snippets as Json).before, SNIPPET_CAP);
      const after = asString((raw.snippets as Json).after, SNIPPET_CAP);
      if (before) snippets.before = before.slice(-NEAR_CAP);
      if (after) snippets.after = after.slice(0, NEAR_CAP);
      facts.snippets = snippets;
    }

    // T21 (intent rule I2): who a send, share or invite goes to. A separate page function, so the floor's collector still lets
    // no field value out. It can only add a card (decide passes the list to I2); a scan that fails leaves the list absent.
    facts.sendCapable = typeof raw.sendCapable === "boolean" ? raw.sendCapable : undefined;
    if (RECIPIENT_OPERATIONS.has(operation) && raw.sendCapable !== false) {
      // T22: a scan that cannot run is not "no recipients". The flag lets I2 ask (attended) or refuse (unattended).
      let usable = false, noField = false, composer = false, capped = false;
      try {
        const found = await io.send("Runtime.callFunctionOn", { objectId: effectObjectId, functionDeclaration: COLLECT_RECIPIENTS_SOURCE, arguments: [{ value: operation }, { value: extra.key ?? null }], returnByValue: true }, document);
        const value = isObject(found?.result?.value) ? (found.result.value as Json) : undefined;
        if (typeof value?.sendCapable === "boolean") facts.sendCapable = value.sendCapable;
        const cleaned = isObject(found?.result?.value) && Array.isArray(value?.recipients) ? cleanScanned(value.recipients as unknown[], value.fields) : undefined;
        const list = cleaned ? cleaned.list : value?.recipients;
        capped = value?.capped === true;
        noField = value?.noRecipientField === true && Array.isArray(list) && list.length === 0;
        composer = value?.composerOnly === true && Array.isArray(list) && list.length === 0;
        // H3: only an explicit "complete" counts. A scan that hit a cap or could not read something is unknown recipients, not none.
        if (!found?.exceptionDetails && Array.isArray(list) && list.every(item => typeof item === "string") && value?.incomplete === false && cleaned?.dropped !== true && list.length <= 20 && list.every(item => item.length <= 254)) {
          usable = true;
          const recipients = list.filter((item): item is string => item.length > 0);
          if (recipients.length) facts.recipients = recipients;
        } else if (Array.isArray(list) && list.every(item => typeof item === "string")) {
          // Still hand over what was found, so the card names it, but the flag below makes the list count as unknown.
          const recipients = list.filter((item): item is string => item.length > 0 && item.length <= 254).slice(0, 20);
          if (recipients.length) facts.recipients = recipients;
        }
      } catch { /* the list stays absent and the flag below is set */ }
      if (!usable) facts.recipientScanFailed = true;
      if (capped) facts.recipientCapped = true;
      if (composer && !usable) facts.recipientComposer = true;
      if (noField && !usable) facts.recipientNoField = true;
    }

    const pageRaw = isObject(raw.page) ? raw.page : {};
    const urlPath = asString(pageRaw.urlPath, URL_CAP);
    const title = asString(pageRaw.title, 200);
    facts.page = {
      ...(urlPath ? { urlPath: stripQuery(urlPath, URL_CAP) } : {}),
      ...(title ? { title } : {}),
      hasPaymentRequestButton: pageRaw.hasPaymentRequestButton === true,
      hasCurrencyAmount: pageRaw.hasCurrencyAmount === true,
      hasConsentManager: scan.consent || pageRaw.domConsent === true,
      hasCaptcha: scan.captcha || pageRaw.domCaptcha === true,
      hasPaymentFrame: scan.payment || pageRaw.domPayment === true,
      frames: scan.frames,
    };

    const sigRaw = isObject(raw.signatures) ? raw.signatures : {};
    facts.signatures = {
      consentManager: sigRaw.consentManager === true,
      captcha: sigRaw.captcha === true,
      payment: sigRaw.payment === true,
      // The unmasked frame-tree path only feeds this boolean; it never leaves the server as text.
      challengePage: isChallenge(urlPath ?? scan.urlPath, title, pageRaw.domChallenge === true),
    };
    facts.visibility = readVisibility(raw.visibility);
  };

  const timeoutMs = Number.isFinite(extra.timeoutMs) && (extra.timeoutMs as number) > 0 ? (extra.timeoutMs as number) : DEFAULT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    await Promise.race([
      gather(),
      new Promise<void>(resolve => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve();
        }, timeoutMs);
      }),
    ]);
  } catch {
    facts.factsFailed = true;
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (timedOut) {
    // A late answer must not change what the caller already holds.
    const frozen = structuredClone(facts);
    frozen.factsFailed = true;
    return frozen;
  }
  return facts;
}
