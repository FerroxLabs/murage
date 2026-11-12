// SPDX-License-Identifier: AGPL-3.0-or-later
// Service -> executor -> real extension runtime; only chrome.* and the engine are fixture transports.
import {afterEach, expect, it, vi} from 'vitest';
import path from 'node:path';
import {fixture as chromeFixture} from './browser-extension-test-fixture.mjs';
import {fixture as decisionFixture,d} from '../server/decision/fixture.ts';
import {BrowserExtensionEngine} from '../server/browser-extension-engine.ts';
import {redactPageOutput} from '../server/browser-output-redaction.ts';
import {createBrowserExtensionService} from '../server/browser-extension-service.ts';
import {privateTestDirectory} from '../server/testing/private-test-dir.ts';
import {removeTempDir} from '../server/testing/cleanup.ts';

const cleanups=[];
afterEach(async()=>{vi.unstubAllGlobals();for(const cleanup of cleanups.splice(0).reverse())await cleanup();});
async function fixture(level='unlimited', initiator={k:'owner-typed'}, extra={}) {
 const decision=decisionFixture(level,initiator);cleanups.push(async()=>decision.dispose());
 if(initiator.k==='routine-run')d.installProvenanceReader({turnGenerationFor:()=> 'g',provenance:()=>({generation:'g',botId:'b',threadId:'t',principal:'owner',roomOwnerOnly:true,at:1,initiator}),live:()=>({botId:'b',turnId:'turn',providerInstanceId:'p',principal:'owner',owner:true,level,routine:{owner:true,sourceRunId:initiator.sourceRunId,sourceBotId:initiator.sourceBotId,recipientGeneration:'g'}})});
 const authority={claim:decision.claim,proof:'trusted',identity:{threadId:'t',generation:'g'}};
 const {root,directory}=await privateTestDirectory(path.resolve('.gnl-browser-'));cleanups.push(()=>removeTempDir(root));
 const chrome=chromeFixture();await chrome.runtime.initialize();const hello=await chrome.runtime.connection(true);
 const calls=[];let at=1000, protectedPage=false, targetFrame, beforeInput, beforeNavigate, duringArm, pay=false, floorFacts, text='fixture page';
 chrome.api.webNavigation.getAllFrames=vi.fn(async()=>[{frameId:0,parentFrameId:-1,url:chrome.tabs.get(1).url}]);
 chrome.api.debugger.sendCommand.mockImplementation(async(source,method,params={})=>{
  if(method==='Page.getFrameTree')return{frameTree:{frame:{id:'main-frame',loaderId:'L1'}}};
  if(method==='Page.createIsolatedWorld')return{executionContextId:params.worldName==='murage-presence-v1'?8:7};
  if(method==='Accessibility.getFullAXTree')return{nodes:[{backendDOMNodeId:12,role:{value:'textbox'},name:{value:'Password'},value:{value:'fixture-secret'}},{backendDOMNodeId:13,role:{value:'StaticText'},name:{value:'card: 4111 1111 1111 1111 SSN: 123-45-6789'}}]};
  if(method==='DOM.getDocument')return{root:{nodeType:9,children:[]}};
  if(method==='DOM.resolveNode')return{object:{objectId:'target'}};
  if(method==='DOM.describeNode')return{node:{backendNodeId:12,nodeName:'BUTTON'}};
  if(method==='Runtime.evaluate'){
   if(params.expression?.includes('__murageGuard()'))return{result:{value:protectedPage}};
   if(params.expression?.includes('return globalThis.__murageSavedReadHtml.length'))return{result:{value:text.length}};
   const slice=/^globalThis.__murageSavedReadHtml.slice\((\d+),(\d+)\)/.exec(params.expression??'');if(slice)return{result:{value:text.slice(Number(slice[1]),Number(slice[2]))}};
   if(params.expression==='document.documentElement.outerHTML')return{result:{value:text}};
   if(params.contextId===8)return{result:{value:true}};
   if(params.expression?.startsWith('globalThis.__murageTakeover?.')){if(params.expression.includes('.arm('))await duringArm?.();return chrome.sendCommand(source,method,params);}
   return{result:{value:'fixture',objectId:'target'}};
  }
  if(method==='Runtime.callFunctionOn')return{result:{value:params.functionDeclaration?.includes('elementFromPoint')?true:JSON.stringify({display:{tag:'BUTTON',label:'Pay now'},bound:null})}};
  return chrome.sendCommand(source,method,params);
 });
 const service=await createBrowserExtensionService({
  broker:{profiles:()=>[hello],async request(_profile,command){calls.push(command);return chrome.runtime.handleRequest({...command,id:chrome.nextId()});}},
  workspaceId:'workspace',stateFile:path.join(directory,'state.json'),authorityFor:()=>authority,
  now:()=>at,routine:()=>initiator.k==='routine-run', ownerInstruction:()=>({id:'owner-message',text:'Use the fixture browser'}),
  askSite:async()=> 'allow', askAction:async()=>true,...extra,
  collectFacts:async()=>floorFacts??({operation:'click',tag:'button',role:'button',name:pay?'Pay now':'Save draft',visibility:{box:{x:1,y:1,width:50,height:20},inViewport:true,opacity:1,visibility:'visible',ariaHidden:false,coveredBy:null}}),
  createEngine:engine=>{const reader=new BrowserExtensionEngine(engine);return({actsOnNodes:true,readLayer:(doc,origin)=>reader.readLayer(doc,origin),
   resolveTarget:async()=>({backendNodeId:12,document:await engine.transport.selected(),...(targetFrame?{frameId:targetFrame}:{})}),
   resolveTab:async()=>engine.transport.selected(),event(){},async close(){},
   async call(name,args){const doc=await engine.transport.selected();
    if(name==='agent_browser_open'){await engine.beforeDestination(args.url,doc);await beforeNavigate?.();await engine.transport.send('Page.navigate',{url:args.url},doc);}
    else if(name==='agent_browser_click'||name==='agent_browser_press'){
     await beforeInput?.();const method=name==='agent_browser_press'?'Input.dispatchKeyEvent':'Input.dispatchMouseEvent';
     const params=name==='agent_browser_press'?{type:'keyDown',key:'v',modifiers:2}:{type:'mousePressed',x:1,y:1,button:'left',clickCount:1};
     await engine.beforeCommand(doc,method,params);await engine.transport.send(method,params,doc);
    }
    return{content:[{type:'text',text}]};
   },
  });},
 });cleanups.push(()=>service.close());
 const binding=await service.ensureBinding({botId:'b',threadId:'t',profileId:hello.profileId});
 const call=(name,args={})=>service.dispatch(binding.bindingId,'agent_browser_'+name,args,()=>true);
 // A real extension-owned tab on an approved origin, rather than bypassing checkedTab.
 async function onSite(){await service.setSiteAccess(binding.bindingId,'https://allowed.test','allow');await call('open',{url:'https://allowed.test/'});chrome.tabs.get(1).url='https://allowed.test/';await chrome.runtime.navigation({tabId:1,frameId:0,url:'https://allowed.test/'});}
 return{service,binding,chrome,calls,call,onSite,decision,setTime:value=>at=value,setPay:value=>pay=value,setFacts:value=>floorFacts=value,setProtected:value=>protectedPage=value,setFrame:value=>targetFrame=value,setBeforeInput:value=>beforeInput=value,setBeforeNavigate:value=>beforeNavigate=value,setDuringArm:value=>duringArm=value,setText:value=>text=value};
}
it.each(['ask','never'])('F1 No limits syncs effective origins before native navigation, preserving saved %s',async rule=>{
 const f=await fixture();await f.service.setSiteAccess(f.binding.bindingId,'https://new.test',rule);
 await expect(f.call('open',{url:'https://new.test/page'})).resolves.toBeDefined();
 expect(f.chrome.api.debugger.sendCommand.mock.calls.some(([,method,params])=>method==='Page.navigate'&&params.url==='https://new.test/page')).toBe(true);
 expect(f.service.status().bindings[0].sites['https://new.test']).toBe(rule);
 const nav=f.calls.findIndex(c=>c.params.method==='Page.navigate');
 expect(f.calls.slice(0,nav).some(c=>c.operation==='bind'&&c.params.approvedOrigins.includes('https://new.test'))).toBe(true);
});

it.each(['protected','payment','clipboard','frame'])('F2 No limits executes %s through service and native runtime',async kind=>{
 const f=await fixture();await f.onSite();
 if(kind==='protected')f.setProtected(true);if(kind==='payment')f.setPay(true);
 if(kind==='frame')f.setFrame('embedded-frame');
 await expect(f.call(kind==='protected'?'get_title':kind==='clipboard'?'press':'click',kind==='clipboard'?{key:'Control+v'}:kind==='protected'?{}:{selector:'button'})).resolves.toBeDefined();
 expect(f.service.status().bindings[0].state).toBe('active');
 if(kind!=='protected')expect(f.chrome.api.debugger.sendCommand.mock.calls.some(([,method])=>method.startsWith('Input.'))).toBe(true);
});
it.each(['set','settings'].flatMap(source=>['ask','never'].map(rule=>[source,rule])))('F3 No limits keeps an admitted input live while %s saves %s',async(source,rule)=>{
 const f=await fixture();await f.onSite();
 f.setBeforeInput(async()=>{if(source==='set')await f.service.setSiteAccess(f.binding.bindingId,'https://allowed.test',rule);else await f.service.settingsChanged('b',{origin:'https://allowed.test',rule});});
 await expect(f.call('click',{selector:'button'})).resolves.toBeDefined();
 expect(f.service.status().bindings[0].sites['https://allowed.test']).toBe(rule);
 expect(f.chrome.api.debugger.sendCommand.mock.calls.some(([,method])=>method==='Input.dispatchMouseEvent')).toBe(true);
});
it.each([31*60*1000,9*60*60*1000])('F4 No limits routine keeps browser authority after %i milliseconds',async elapsed=>{
 const f=await fixture('unlimited',{k:'routine-run',form:'run',sourceRunId:'routine',sourceBotId:'b',recipientGeneration:'g',trigger:'schedule'});await f.onSite();f.setTime(1000+elapsed);
 await f.service.expireTasks();await expect(f.call('get_title')).resolves.toBeDefined();
 expect(f.service.status().bindings[0].state).toBe('active');
});
it.each(['get_text','read','raw','snapshot'])('F5 No limits %s preserves requested secrets in the model payload',async kind=>{
 const f=await fixture();await f.onSite();
 const secrets='password: fixture-secret card: 4111 1111 1111 1111 SSN: 123-45-6789';
 f.setText(kind==='raw'?`<textarea aria-label="password">fixture-secret</textarea><p>${secrets}</p>`:`<p>${secrets}</p>`);
 const output=await f.call(kind==='get_text'?'get_text':kind==='snapshot'?'snapshot':'read',kind==='get_text'?{selector:'body'}:kind==='raw'?{raw:true}:{});
 const payload=JSON.stringify(output);for(const value of ['fixture-secret','4111 1111 1111 1111','123-45-6789'])expect(payload).toContain(value);
 expect(payload).toContain('page-content');expect(redactPageOutput(secrets)).not.toContain('fixture-secret');
});

it.each(['full','auto','ask'])('control: %s still respects saved Never',async level=>{
 const f=await fixture(level);await f.service.setSiteAccess(f.binding.bindingId,'https://new.test','never');
 await expect(f.call('open',{url:'https://new.test/page'})).rejects.toThrow('site_denied');
 expect(f.chrome.api.debugger.sendCommand.mock.calls.some(([,method])=>method==='Page.navigate')).toBe(false);
});
it('control: a guest at unlimited never receives owner browser exemptions',async()=>{
 const f=await fixture('unlimited',{k:'guest'});f.decision.setOwner(false);
 await f.service.setSiteAccess(f.binding.bindingId,'https://new.test','never');
 await expect(f.call('open',{url:'https://new.test/page'})).rejects.toThrow('site_denied');
});

import {UnifiedBrowserController} from '../server/browser-control.ts';
async function nativeFixture(level='unlimited'){
 const decision=decisionFixture(level);cleanups.push(async()=>decision.dispose());
 const {root,directory}=await privateTestDirectory(path.resolve('.gnl-native-'));cleanups.push(()=>removeTempDir(root));
 const authority={claim:decision.claim,proof:'trusted',identity:{threadId:'t',generation:'g'}};
 let protectedPage=true;const calls=[];
 const native={protected:async()=>protectedPage,async request(method,params){calls.push({method,params});
  const name=params?.name;const data=name==='agent_browser_get_url'?{url:'https://fixture.test/'}:{result:'<textarea aria-label="password">fixture-secret</textarea><p>card: 4111 1111 1111 1111</p>'};
  return{content:[{type:'text',text:'fixture page'}],structuredContent:{response:{success:true,data}}};
 },async connect(){return'fixture-stream';},resetStream(){},async close(){},async command(){return{};},input(){}};
 const controller=new UnifiedBrowserController({stateFile:path.join(directory,'state.json'),createNative:()=>native});controller.register('profile',{command:'fixture',args:[],env:{}});
 return{controller,calls,authority,decision,setProtected:value=>protectedPage=value};
}
it('F2 native No limits observes protected pages before and after execution',async()=>{
 const f=await nativeFixture();await expect(f.controller.dispatch('profile','tools/call',{name:'agent_browser_snapshot'},()=>true,{authority:f.authority})).resolves.toBeDefined();
 expect(f.calls).toHaveLength(1);
});
it('F5 native No limits raw reads preserve private fields and card text',async()=>{
 const f=await nativeFixture();f.setProtected(false);
 const output=await f.controller.dispatch('profile','tools/call',{name:'agent_browser_read',arguments:{raw:true}},()=>true,{authority:f.authority,readScope:'b:t'});
 expect(JSON.stringify(output)).toContain('fixture-secret');expect(JSON.stringify(output)).toContain('4111 1111 1111 1111');
});
it('control: native Full keeps its protected-page refusal',async()=>{
 const f=await nativeFixture('full');await expect(f.controller.dispatch('profile','tools/call',{name:'agent_browser_snapshot'},()=>true,{authority:f.authority})).rejects.toThrow();
 expect(f.calls).toHaveLength(0);
});
it('F3 downgrade re-applies a saved Never without leaking effective No limits grants',async()=>{
 const f=await fixture();await f.onSite();
 await f.service.setSiteAccess(f.binding.bindingId,'https://allowed.test','never');
 await expect(f.call('get_title')).resolves.toBeDefined();f.decision.setLevel('full');
 await expect(f.call('get_title')).rejects.toThrow('site_denied');
});

it('F4 No limits renews a task whose idle timer ran between automation turns',async()=>{
 const f=await fixture();await f.onSite();f.decision.setLevel('full');f.setTime(31*60*1000);await f.service.expireTasks();f.decision.setLevel('unlimited');
 await expect(f.call('get_title')).resolves.toBeDefined();
});
it('F5 unredacted saved ranges cannot cross a permission downgrade',async()=>{
 const f=await fixture();await f.onSite();f.setText('<p>password: fixture-secret</p>');
 const result=await f.call('read');const item=result.content.find(item=>item.text?.startsWith('{'));
 const metadata=JSON.parse(item.text.slice(0,item.text.indexOf('\n')));expect(item.text).toContain('fixture-secret');
 f.decision.setLevel('full');await expect(f.call('read',{handle:metadata.handle})).rejects.toThrow(/missing|expired/);
});

it('F2 No limits bypasses owner-input taint without erasing it for lower levels',async()=>{
 const f=await nativeFixture();f.setProtected(false);const held=await f.controller.take('profile','owner');
 await f.controller.input('profile','owner',held.generation,{type:'input_keyboard',eventType:'char',text:'fixture'});
 await expect(f.controller.dispatch('profile','tools/call',{name:'agent_browser_snapshot'},()=>true,{authority:f.authority})).rejects.toThrow();
 expect(f.calls).toHaveLength(0);
 await f.controller.release('profile','owner',f.controller.status('profile').generation);
 await expect(f.controller.dispatch('profile','tools/call',{name:'agent_browser_snapshot'},()=>true,{authority:f.authority})).resolves.toBeDefined();
 expect(f.controller.status('profile').protectedReason).toBe('owner-input');
 f.decision.setLevel('full');
 await expect(f.controller.dispatch('profile','tools/call',{name:'agent_browser_snapshot'},()=>true,{authority:f.authority})).rejects.toThrow();
});

it('F2 No limits navigation ignores outside-result marks after admission',async()=>{
 const instruction={id:'owner-message',text:'https://new.test'};
 const f=await fixture('unlimited',{k:'owner-typed'},{approvalMode:()=> 'full',ownerInstruction:()=>instruction,ownerTurnInstruction:()=>instruction});
 f.setBeforeNavigate(async()=>{await expect(f.call('get_title')).rejects.toThrow('binding_busy');});
 await expect(f.call('open',{url:'https://new.test'})).resolves.toBeDefined();
 expect(f.chrome.api.debugger.sendCommand.mock.calls.some(([,method])=>method==='Page.navigate')).toBe(true);
});

it('F3 No limits input ignores a permission-only bind while native arm is pending',async()=>{
 const f=await fixture();await f.onSite();
 f.setDuringArm(async()=>{await f.service.setSiteAccess(f.binding.bindingId,'https://allowed.test','allow');});
 await expect(f.call('click',{selector:'button'})).resolves.toBeDefined();
 expect(f.chrome.api.debugger.sendCommand.mock.calls.some(([,method])=>method==='Input.dispatchMouseEvent')).toBe(true);
});
it.each([false,true])('F2 No limits clears an existing handoff without an owner message (new Never page=%s)',async moved=>{
 const continued=vi.fn();const f=await fixture('full',{k:'owner-typed'},{onContinue:continued});await f.onSite();f.setProtected(true);
 await expect(f.call('get_title')).rejects.toThrow('YOUR TURN');
 expect(f.service.status().bindings[0].state).toBe('paused');
 if(moved){await f.service.setSiteAccess(f.binding.bindingId,'https://new.test','never');f.chrome.tabs.get(1).url='https://new.test/';await f.chrome.runtime.navigation({tabId:1,frameId:0,url:'https://new.test/'});}
 f.decision.setLevel('unlimited');
 await f.service.ensureBinding({botId:'b',threadId:'t',profileId:'profile_1'});
 await expect(f.call('get_title')).resolves.toBeDefined();
 expect(f.service.status().bindings[0].state).toBe('active');expect(continued).not.toHaveBeenCalled();
 if(moved)expect(f.service.status().bindings[0].sites['https://new.test']).toBe('never');
});

it('control: owner live take-over at No limits stops the bot until Return to bot',async()=>{
 const f=await nativeFixture();f.setProtected(false);
 const held=await f.controller.take('profile','owner');
 await expect(f.controller.dispatch('profile','tools/call',{name:'agent_browser_snapshot'},()=>true,{authority:f.authority})).rejects.toThrow();
 expect(f.calls).toHaveLength(0);
 await f.controller.release('profile','owner',held.generation);
 await expect(f.controller.dispatch('profile','tools/call',{name:'agent_browser_snapshot'},()=>true,{authority:f.authority})).resolves.toBeDefined();
 expect(f.calls).toHaveLength(1);
});
it('control: No limits keeps owner Pause waiting',async()=>{
 const f=await fixture();await f.onSite();await f.service.pause(f.binding.bindingId);
 await f.service.ensureBinding({botId:'b',threadId:'t',profileId:'profile_1'});
 await expect(f.call('get_title')).rejects.toThrow();
 expect(f.service.status().bindings[0].state).toBe('paused');
 expect(f.calls.filter(c=>c.operation==='resume')).toHaveLength(0);
});
it('control: No limits Allow always capacity stays bounded for a later downgrade',async()=>{
 const f=await fixture();
 for(let i=0;i<64;i++)await f.service.setSiteAccess(f.binding.bindingId,`https://site${i}.test`,'allow');
 await expect(f.service.setSiteAccess(f.binding.bindingId,'https://overflow.test','allow')).rejects.toThrow(/64|limit|sites/i);
 expect(Object.values(f.service.status().bindings[0].sites).filter(s=>s==='allow')).toHaveLength(64);
});

it.each(['captcha','2FA'])('control: No limits keeps an existing %s owner handoff paused',async kind=>{
 const f=await fixture('full');await f.onSite();
 f.setFacts(kind==='captcha'?{operation:'click',tag:'button',name:'Verify you are human',signatures:{captcha:true}}:{operation:'fill',tag:'input',type:'text',autocomplete:'one-time-code'});
 await expect(f.call('click',{selector:'button'})).rejects.toThrow('YOUR TURN');
 expect(f.service.status().bindings[0].state).toBe('paused');
 f.decision.setLevel('unlimited');
 await f.service.ensureBinding({botId:'b',threadId:'t',profileId:'profile_1'});
 await expect(f.call('get_title')).rejects.toThrow('YOUR TURN');
 expect(f.service.status().bindings[0].state).toBe('paused');
 expect(f.calls.filter(c=>c.operation==='resume')).toHaveLength(0);
});
