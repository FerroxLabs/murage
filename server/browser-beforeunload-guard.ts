/** Where the engine's own auto-answer is off, a beforeunload prompt would block the navigating call
 * (the engine serves one command at a time, so nothing can answer it while that call is in flight).
 * The first tab loads it through AGENT_BROWSER_INIT_SCRIPTS, which the engine registers with
 * Page.addScriptToEvaluateOnNewDocument: it runs at document start, before any page script, in every
 * frame. The page can then never register a beforeunload handler, so the prompt is never raised.
 * Tabs opened later get it from the target guard (headless-target-guard.ts). A capture listener added first (through the original addEventListener) stops any handler a
 * `<body onbeforeunload>` attribute adds later. */
export const BEFOREUNLOAD_GUARD_SCRIPT = `(()=>{try{
const mark=Symbol.for("murage.beforeunload-guard");if(window[mark])return;Object.defineProperty(window,mark,{value:true});
const original=EventTarget.prototype.addEventListener;
const isUnload=(t)=>{try{return String(t)==="beforeunload";}catch{return false;}};
Object.defineProperty(EventTarget.prototype,"addEventListener",{configurable:true,writable:true,value:function addEventListener(type,...rest){if(isUnload(type))return undefined;return original.call(this,type,...rest);}});
Object.defineProperty(window,"onbeforeunload",{configurable:true,get(){return null;},set(){}});
original.call(window,"beforeunload",(e)=>{e.stopImmediatePropagation();},true);
}catch{}})();`;
