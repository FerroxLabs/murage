// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The in-page press guard and the navigation hold of the Full-access pay card (designs/PAYFULL-DESIGN-1024.md "The press itself"
// a-e, J16). Owners: this module and its executor wiring = q1024-payguard-fable; the card flow = q1024-paybuild; the extension's
// side of the hold (extensions/murage-browser/runtime.mjs PAY_HOLD) = q1024-payguard-fable; rulings = MAIN.
//
// A check made on the server cannot see a page that changes one millisecond later, so the last comparison is made inside the
// page, in the task of the click itself. The guard runs in Murage's isolated world (the page cannot reach or remove it):
//   - from the moment it is installed it cancels EVERY activation event in the document, in the capture phase on the window;
//   - everything outside the approved control's own ancestor chain is inert, and so is anything added meanwhile;
//   - armed, it lets through exactly one real click (trusted, primary button, on the approved node), and only while the page
//     read and the control's description are byte for byte what they were when the guard was installed (= what the server's
//     final check compared with the owner's card); anything else is cancelled and reported `changed`;
//   - it carries its own deadline on the page's clock; after it nothing gets through.

import { DESCRIBE_TARGET_SOURCE } from './browser-extension-page-scripts.ts';
import { PAY_PAGE_EXPRESSION } from './pay-card.ts';

/** The capability an extension declares once it can hold main-frame navigations for the press (and releases them itself after 3 s). */
export const PAY_HOLD_CAPABILITY = 'pay_hold_v2'; // v2 = the hold and the report binding (PAY_REPORT_BINDING); an extension that only declares v1 gets no pay card
/** The one Fetch.enable shape the extension accepts: Document requests only, held until Fetch.disable. */
export const PAY_HOLD_PATTERNS = [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] as const;
/** A `go` older than this sends nothing; the guard's own deadline is what is left of it. */
export const PAY_PRESS_WINDOW_MS = 2_000;
/** The hold is released at the latest after this long (the executor's `finally`; the extension's own timer). */
export const PAY_HOLD_MAX_MS = 3_000;
/** A page read made under the hold that has not answered after this long is taken as a held navigation (Chromium answers no page-side command
 *  while a main-frame navigation is paused); the step ends without waiting for the release. */
export const PAY_HOLD_READ_MS = 700;

/** The guard's report leaves the page by a push, at the event: a CDP binding that exists only in Murage's isolated world (the page's own
 *  world has no such function). While a main-frame navigation is held Chromium answers no page read, and the pay button's own form post is
 *  such a navigation, so a report that had to be read back would be lost for most checkouts. The extension accepts this one binding shape and
 *  forwards its calls only while the hold is on. */
export const PAY_REPORT_BINDING = '__muragePayReport';
export const PAY_REPORT_WORLD = 'murage-protected-document-v1';

export type PayPressReport = { state: 'standing' | 'armed' | 'pressed' | 'changed' | 'expired'; passed: number; why?: string };

/** Called on the approved node in the isolated world. Returns JSON: {ok:true,page,shape} or {ok:false,why}. */
export const PAY_PRESS_GUARD_SOURCE = `function(){/*murage-pay-press-guard*/
const node=this,win=window;
if(globalThis.__muragePress)globalThis.__muragePress.remove();
const read=()=>{try{return String(${PAY_PAGE_EXPRESSION});}catch(e){return '';}};
const describe=${DESCRIBE_TARGET_SOURCE};
const shape=()=>{try{return String(describe.call(node));}catch(e){return '';}};
if(node.ownerDocument!==document||!node.isConnected)return JSON.stringify({ok:false,why:'node'});
const box=node.getBoundingClientRect();const top=document.elementFromPoint(box.left+box.width/2,box.top+box.height/2);
if(!top||!(top===node||node.contains(top)))return JSON.stringify({ok:false,why:'covered'});
const marked=[];
const mark=e=>{if(e&&e.nodeType===1&&e!==node&&!e.contains(node)&&!node.contains(e)&&!e.inert){e.inert=true;marked.push(e);}};
const sweep=()=>{for(let at=node;at&&at.parentNode;at=at.parentNode.nodeType===11?at.parentNode.host:at.parentNode){for(const s of at.parentNode.children||[])mark(s);}};
sweep();
const watch=new MutationObserver(list=>{for(const m of list)for(const added of m.addedNodes)mark(added);});
watch.observe(document,{childList:true,subtree:true});
const held={page:read(),shape:shape()};
let state='standing',deadline=0,passed=0,why='';const seen={};
const ORDER=['pointerdown','mousedown','pointerup','mouseup','click'];
const TYPES=[...ORDER,'auxclick','dblclick','contextmenu','keydown','keypress','keyup','touchstart','touchend','pointercancel'];
const cancel=e=>{e.preventDefault();e.stopImmediatePropagation();};
const say=typeof globalThis.${PAY_REPORT_BINDING}==='function'?globalThis.${PAY_REPORT_BINDING}:undefined;let nonce='';
// Every final state is pushed once, at the event that made it final (nothing changes after it).
const push=()=>{try{if(say&&nonce)say(JSON.stringify({nonce,state,passed,why}));}catch(e){}};
const fail=(e,reason)=>{cancel(e);if(state==='armed'){state='changed';why=reason;push();}};
let timer=0;
const lift=()=>{watch.disconnect();for(const type of TYPES)win.removeEventListener(type,on,true);for(const e of marked)e.inert=false;marked.length=0;clearTimeout(timer);};
const on=e=>{
  if(state==='pressed')return;
  if(state!=='armed'){cancel(e);return;}
  if(performance.now()>deadline){state='expired';cancel(e);push();return;}
  const i=ORDER.indexOf(e.type);
  if(i<0)return fail(e,'other-event');
  if(!e.isTrusted)return fail(e,'untrusted');
  if(e.button!==0||e.detail>1)return fail(e,'button');
  if(seen[e.type]||(e.type==='click'&&!seen.mousedown))return fail(e,'order');
  if(!(e.target===node||(e.target&&e.target.nodeType===1&&node.contains(e.target))))return fail(e,'target');
  if(read()!==held.page)return fail(e,'page');
  if(shape()!==held.shape)return fail(e,'control');
  seen[e.type]=1;passed++;
  if(e.type==='click'){state='pressed';push();lift();}
};
for(const type of TYPES)win.addEventListener(type,on,true);
// Never left standing on a page: whatever the host does, the guard and its inert marks go after ten seconds.
timer=setTimeout(()=>{if(state!=='pressed')lift();if(globalThis.__muragePress===api)delete globalThis.__muragePress;},10000);
const api={
  arm(ms,key){if(state!=='standing'||!(ms>0)||!node.isConnected)return false;nonce=typeof key==='string'?key:'';deadline=performance.now()+Math.min(ms,${PAY_PRESS_WINDOW_MS});state='armed';
    setTimeout(()=>{if(state==='armed'){state='expired';push();}},Math.min(ms,${PAY_PRESS_WINDOW_MS}));return true;},
  report(){return JSON.stringify({state,passed,why});},
  remove(){if(state!=='pressed')lift();if(globalThis.__muragePress===api)delete globalThis.__muragePress;return true;},
};
globalThis.__muragePress=api;
if(!held.page||!held.shape){api.remove();return JSON.stringify({ok:false,why:'read'});}
return JSON.stringify({ok:true,page:held.page,shape:held.shape});
}`;
export const PAY_PRESS_ARM = (ms: number, nonce = '') => `(()=>{/*murage-pay-press-arm*/const g=globalThis.__muragePress;return g?g.arm(${Math.floor(ms)},${JSON.stringify(nonce)}):false;})()`;
export const PAY_PRESS_REPORT = `(()=>{/*murage-pay-press-report*/const g=globalThis.__muragePress;return g?g.report():'';})()`;
export const PAY_PRESS_REMOVE = `(()=>{/*murage-pay-press-remove*/const g=globalThis.__muragePress;return g?g.remove():false;})()`;

export function readPressInstall(value: unknown): { page: string; shape: string } | undefined {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) as Record<string, unknown> : undefined;
    return parsed && parsed.ok === true && typeof parsed.page === 'string' && parsed.page && typeof parsed.shape === 'string' && parsed.shape ? { page: parsed.page, shape: parsed.shape } : undefined;
  } catch { return undefined; }
}
export function readPressReport(value: unknown): PayPressReport | undefined {
  try {
    const parsed = typeof value === 'string' && value ? JSON.parse(value) as Record<string, unknown> : undefined;
    if (!parsed || !['standing', 'armed', 'pressed', 'changed', 'expired'].includes(String(parsed.state)) || !Number.isSafeInteger(parsed.passed)) return undefined;
    return { state: parsed.state as PayPressReport['state'], passed: parsed.passed as number, ...(typeof parsed.why === 'string' && parsed.why ? { why: parsed.why } : {}) };
  } catch { return undefined; }
}
/** A pushed report (Runtime.bindingCalled). Taken only from the pay tab's own isolated world and only with this press's nonce. */
export function readPressPush(params: Record<string, unknown>, world: number, nonce: string): PayPressReport | undefined {
  if (params.name !== PAY_REPORT_BINDING || params.executionContextId !== world || typeof params.payload !== 'string' || !nonce) return undefined;
  try { if ((JSON.parse(params.payload) as { nonce?: unknown }).nonce !== nonce) return undefined; } catch { return undefined; }
  const report = readPressReport(params.payload);
  return report && report.state !== 'standing' && report.state !== 'armed' ? report : undefined;
}
