// SPDX-License-Identifier: AGPL-3.0-or-later
import { NATIVE_DOM_SOURCE } from "./browser-native-dom.ts";
import { SECRET_CLASSIFIER_SOURCE } from "../shared/browser-secret-classifier-source.ts";
// Functions the trusted executor runs inside the owner's page, in the extension's isolated world.
// They are plain source strings (never serialized from compiled code, which a bundler may rewrite).
// The page cannot reach this world; model input never becomes source here, only data arguments.

/** callFunctionOn(this = the approved target). Returns JSON {display, bound}.
 * display is what the owner reads on the card: the target and its own form only, fields by name and count.
 * bound is everything that decides what a submit does (the submitter's formaction/formmethod/name/value,
 * the form's action and method, hidden fields, every field's value); the executor hashes it into the digest
 * and never shows it. Throws MURAGE_FRAME or MURAGE_CLOSED_SHADOW when the target is not in the page itself. */
export const DESCRIBE_TARGET_SOURCE = String.raw`function(){
    const dom=(${NATIVE_DOM_SOURCE})();
    if(this.ownerDocument!==document)throw new Error('MURAGE_FRAME');
    const root=dom.root(this);
    if(typeof ShadowRoot!=='undefined'&&root instanceof ShadowRoot&&root.mode==='closed')throw new Error('MURAGE_CLOSED_SHADOW');
    const clip=(v,n)=>String(v==null?'':v).slice(0,n);
    const fnv=v=>{let a=0x811c9dc5,b=7;for(let i=0;i<v.length;i++){a^=v.charCodeAt(i);a=Math.imul(a,16777619)>>>0;b=(Math.imul(b,31)+v.charCodeAt(i))>>>0;}return a.toString(16)+'.'+b.toString(16)+'.'+v.length;};
    const val=v=>{v=String(v==null?'':v);return v.length>256?'h:'+fnv(v):v;};
    const visible=e=>{const b=e.getBoundingClientRect();return b.width>0&&b.height>0&&getComputedStyle(e).visibility!=='hidden'};
    const form=dom.form(this)||dom.closest(this,'form');
    const fieldSelector='input:not([type="hidden"]),textarea,select,[contenteditable]:not([contenteditable="false"])';
    let scope=form||dom.closest(this,'[role="dialog"]');
    // A div composer has no form or dialog: the message beside the Send button is still part of what the click sends. The nearest few ancestors
    // that hold a field are the payload; a page-wide ancestor (body) is never taken.
    if(!scope){let up=dom.parent(this);for(let i=0;up&&i<8&&up!==document.body&&up!==document.documentElement;i++,up=dom.parent(up)){if(dom.query(up,fieldSelector).length){scope=up;break;}}}
    const found=scope?dom.query(scope,fieldSelector,200):[];
    // Round 10 (R10-01): controls tied to this form by its id (form="f") may sit anywhere in the page; they are part of the payload too.
    if(form){for(const e of dom.elements(form,500))if(!found.includes(e)&&dom.matches(e,fieldSelector))found.push(e);}
    if(!found.includes(this)&&dom.matches(this,fieldSelector))found.push(this);
    const fields=found.filter(visible).slice(0,200);
    // Round 9 (R8-05): a page script can copy a live value into an attribute. Every attribute that is exported or hashed is scrubbed against the
    // live values and the shared classifier first.
    const SC=${SECRET_CLASSIFIER_SOURCE};
    const live=[];for(const e of fields){try{const v=String(e.isContentEditable?e.innerText:e.value);if(v)live.push(v);}catch(x){}}
    try{if(this.isContentEditable||(dom.matches(this,'input,textarea,select')))live.push(String(this.isContentEditable?this.innerText:this.value));}catch(x){}
    // Round 10 (R9-04): a URL is scrubbed piece by piece (live values, encoded or not, and anything number-shaped like a secret). The raw destination
    // leaves this function only in \`priv\`, which the executor hashes and uses for access decisions and never shows.
    // Round 10 (R10-05): every component is decoded first, and a live value is looked for in the decoded, normalised text (so %34%38... and invisible marks do not hide it).
    const squash=t=>SC.normalize(t).toLowerCase().replace(/[\s._\-,']/g,'');
    const liveSq=live.map(l=>squash(l.trim())).filter(l=>l.length>=3);
    // Opus gate (round 10, the R10-06 class): a copied value is looked for after the classifier's normalisation here too, so an invisible mark or a
    // separator inside a label or the element's text does not carry a live value onto the card.
    const scrub=t=>{const v=String(t==null?'':t);if(!v)return v;if(SC.looksLikeSecretValue(v))return '';for(const l of live){const w=l.trim();if(w.length>=3&&v.includes(w))return '';}const sv=squash(v);if(liveSq.some(l=>sv.includes(l)))return '';return v;};
    const scrubUrl=t=>{const v=String(t==null?'':t);
      return clip(v.replace(/[^?&=\/#;:@]+/g,p=>{let d=p;for(let i=0;i<3;i++){try{const n=decodeURIComponent(d);if(n===d)break;d=n;}catch(x){break;}}
        const sq=squash(d);return SC.looksLikeSecretValue(d)||/\d{6,}/.test(sq)||liveSq.some(l=>sq.includes(l))?'~':p;}),300);};
    const nameOf=e=>clip(scrub(dom.attr(e,'aria-label')||dom.attr(e,'name')||dom.attr(e,'id')||String(dom.tag(e).toUpperCase()).toLowerCase()),40);
    // Round 8 (SEC-10): what a person typed or an autofill put in a field is never text the executor shows or hashes. A field's own text, and the
    // text of anything that holds an editable region, stays out of the description; the values leave this function in a separate list that the
    // executor turns into an opaque keyed digest (see describe() in browser-extension-executor.ts) and never prints.
    const editableSel='[contenteditable]:not([contenteditable="false"]),textarea,input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]),select,[role="textbox"],[role="searchbox"],[role="combobox"]';
    let holdsEditable=false;try{holdsEditable=!!(this.isContentEditable||dom.matches(this,editableSel)||dom.query(this,editableSel).length);}catch(e){holdsEditable=true;}
    const submitter=dom.tag(this).toUpperCase()==='BUTTON'||(dom.tag(this).toUpperCase()==='INPUT'&&['submit','image'].includes(dom.controlType(this)));
    const display={tag:dom.tag(this).toUpperCase(),role:scrub(dom.attr(this,'role')),label:clip(scrub(dom.attr(this,'aria-label')),80),text:holdsEditable?'':clip(scrub(this.innerText||this.textContent),200),href:dom.attr(this,'href')==null?null:scrubUrl(dom.attr(this,'href')),
      form:form?{action:scrubUrl(dom.formProperty(form,'action')),method:clip(scrub(String(dom.formProperty(form,'method')||'get').toLowerCase()),10)}:null,
      submit:submitter&&(dom.attr(this,'formaction')!==null||dom.attr(this,'formmethod')!==null)?{action:scrubUrl(this.formAction),method:clip(scrub(this.formMethod),10)}:null,
      fieldCount:fields.length,fieldNames:[...new Set(fields.map(nameOf))].slice(0,12)};
    const hidden=form?dom.elements(form,500).filter(e=>dom.controlType(e)==='hidden').slice(0,200).map(e=>[dom.attr(e,'name'),val(e.value)]):[];
    const bound={tag:dom.tag(this).toUpperCase(),href:this.href||null,
      form:form?{action:dom.formProperty(form,'action'),method:dom.formProperty(form,'method'),enctype:dom.formProperty(form,'enctype'),target:dom.formProperty(form,'target'),id:dom.attr(form,'id'),name:dom.attr(form,'name')}:null,
      submitter:submitter?{type:dom.controlType(this),name:dom.attr(this,'name'),value:val(this.value),action:this.formAction,method:this.formMethod,enctype:this.formEnctype,target:this.formTarget,novalidate:this.formNoValidate,text:holdsEditable?'':clip(this.innerText||(dom.tag(this).toUpperCase()==='INPUT'?this.value:''),100)}:null,
      hidden,fields:fields.map(e=>[nameOf(e),typeof e.checked==='boolean'?e.checked:null])};
    const values=fields.map(e=>val(e.isContentEditable?e.innerText:e.value));
    const selfPushed=!!(this.isContentEditable||dom.matches(this,editableSel));
    if(selfPushed)values.push(val(this.isContentEditable?this.innerText:this.value));
    const value=JSON.stringify({display,bound,values,editable:holdsEditable,priv:{href:dom.attr(this,'href'),skip:[fields.indexOf(this),selfPushed?values.length-1:-1]}});
    dom.assertComplete();
    return value;
  }`;

/** callFunctionOn(this = the approved target, x, y): is the point over the target, through open shadow roots too. */
export const COMPOSED_HIT_TEST_SOURCE = String.raw`function(x,y){
    const dom=(${NATIVE_DOM_SOURCE})();
    const point=Document.prototype.elementFromPoint,shadowPoint=ShadowRoot.prototype.elementFromPoint;
    let hit=point.call(document,x,y);
    while(hit&&dom.shadow(hit)){const inner=shadowPoint.call(dom.shadow(hit),x,y);if(!inner||inner===hit)break;hit=inner;}
    for(let node=hit;node;node=dom.parent(node))if(node===this)return true;
    return false;
  }`;

/** callFunctionOn(this = document.activeElement): the focused element through open shadow roots. */
export const COMPOSED_ACTIVE_SOURCE = String.raw`function(){const dom=(${NATIVE_DOM_SOURCE})();const active=Object.getOwnPropertyDescriptor(ShadowRoot.prototype,'activeElement').get;let a=this;while(a&&dom.shadow(a)){const next=active.call(dom.shadow(a));if(!next)break;a=next;}return a;}`;

/** An expression: is `url` the destination of a link the current page presents? */
export const presentedLinkExpression = (url: string) => `(() => {const dom=(${NATIVE_DOM_SOURCE})();return dom.query(document,'a[href],area[href]').some(a=>a.href===${JSON.stringify(url)});})()`;
/** An expression returning one slice of the page's HTML, so a large page crosses the wire in pieces. */
export const htmlSliceExpression = (from: number, to: number) => `document.documentElement.outerHTML.slice(${from},${to})`;
export const HTML_LENGTH_EXPRESSION = "document.documentElement.outerHTML.length";
