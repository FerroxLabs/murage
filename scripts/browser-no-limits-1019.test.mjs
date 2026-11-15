// SPDX-License-Identifier: AGPL-3.0-or-later
// Service -> executor -> real extension runtime; only chrome.* and the engine are fixture transports.
import {afterEach, expect, it, vi} from 'vitest';
import path from 'node:path';
import {JSDOM} from 'jsdom';
import {BrowserExtensionIntegration} from '../server/browser-extension-integration.ts';
import {PassThrough} from 'node:stream';
import {runNativeHost,readHostConfig,FrameDecoder,encodeFrame} from '../electron/browser-extension-host.mjs';
import {inheritedPermissions,installPermissionInheritance} from '../server/permission-inheritance.ts';
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
 const chrome=chromeFixture({},extra.runtimeOptions);await chrome.runtime.initialize();const hello=await chrome.runtime.connection(true);
 const calls=[];let page;let at=1000, protectedPage=false, targetFrame, beforeInput, beforeNavigate, duringArm, pay=false, floorFacts, text='fixture page';
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
  if(method==='Input.insertText' && page){page.window.document.querySelector('textarea').value+=params.text;return{};}
  if(method==='Runtime.callFunctionOn' && page && params.functionDeclaration?.includes('allowProtected=false'))return {result:{value:page.window.eval('('+params.functionDeclaration+')').apply(page.window.document.querySelector('a,textarea'),(params.arguments??[]).map(a=>a.value))}};
  if(method==='Runtime.callFunctionOn')return{result:{value:params.functionDeclaration?.includes('elementFromPoint')?true:JSON.stringify({display:{tag:'BUTTON',label:'Pay now'},bound:null})}};
  return chrome.sendCommand(source,method,params);
 });
 const serviceOptions={
  broker:{profiles:()=>[hello],async request(_profile,command){calls.push(command);return chrome.runtime.handleRequest({...command,id:chrome.nextId()});}},
  workspaceId:'workspace',stateFile:path.join(directory,'state.json'),authorityFor:()=>authority,
  now:()=>at,routine:()=>initiator.k==='routine-run', ownerInstruction:()=>({id:'owner-message',text:'Use the fixture browser'}),
  askSite:async()=> 'allow', askAction:async()=>true,...extra,
  collectFacts:async()=>floorFacts??({operation:'click',tag:'button',role:'button',name:pay?'Pay now':'Save draft',visibility:{box:{x:1,y:1,width:50,height:20},inViewport:true,opacity:1,visibility:'visible',ariaHidden:false,coveredBy:null}}),
  createEngine:engine=>{const reader=new BrowserExtensionEngine(engine);return({actsOnNodes:true,readLayer:(doc,origin)=>reader.readLayer(doc,origin),
   resolveTarget:async()=>({backendNodeId:12,document:await engine.transport.selected(),...(targetFrame?{frameId:targetFrame}:{})}),
   resolveTab:async()=>engine.transport.selected(),event(...args){reader.event(...args);},async close(){},
   async call(name,args){const doc=await engine.transport.selected();
    if(extra.facade)return extra.facade(reader,engine,chrome,doc);
    if(name==='agent_browser_open'){await engine.beforeDestination(args.url,doc);await beforeNavigate?.();await engine.transport.send('Page.navigate',{url:args.url},doc);}
    else if(name==='agent_browser_screenshot'){await engine.beforeCommand(doc,'Page.captureScreenshot',{});await engine.transport.send('Page.captureScreenshot',{},doc);}
    else if(name==='agent_browser_fill'){await engine.beforeCommand(doc,'Input.insertText',{text:args.text});await engine.transport.send('Input.insertText',{text:args.text},doc);}
    else if(name==='agent_browser_click'||name==='agent_browser_press'){
     await beforeInput?.();const method=name==='agent_browser_press'?'Input.dispatchKeyEvent':'Input.dispatchMouseEvent';
     const params=name==='agent_browser_press'?{type:'keyDown',key:'v',modifiers:2}:{type:'mousePressed',x:1,y:1,button:'left',clickCount:1};
     await engine.beforeCommand(doc,method,params);await engine.transport.send(method,params,doc);
    }
    return{content:[{type:'text',text}]};
   },
  });},
 };
 let service;
 if(extra.integration){
  const integration=new BrowserExtensionIntegration({dataDir:directory,socketDir:directory,workspaceId:'workspace',protectedOrigins:[],bot:()=>({id:'b',name:'Fixture',browserApproval:'full'}),approvalBus:{store:decision.store,authorityFor:()=>authority,broadcast(){},onApproval(){throw Error('No limits must not show a card');}},createEngine:serviceOptions.createEngine,collectFacts:serviceOptions.collectFacts,ownerInstruction:()=>({id:'owner-message',text:'Use the fixture browser'})});
  service=await integration.start();cleanups.push(()=>integration.close());
  const input=new PassThrough(),output=new PassThrough();
  const decoder=new FrameDecoder(command=>{if(command.type==='command'){calls.push(command);void chrome.runtime.handleRequest(command).then(response=>input.write(encodeFrame(response)));}});
  output.on('data',chunk=>decoder.push(chunk));
  const host=runNativeHost({input,output,config:readHostConfig(integration.broker.configPath)});cleanups.push(async()=>host.stop());
  input.write(encodeFrame(hello));await vi.waitFor(()=>expect(integration.status().profiles).toHaveLength(1));
 }else{service=await createBrowserExtensionService(serviceOptions);cleanups.push(()=>service.close());}

 const binding=await service.ensureBinding({botId:'b',threadId:'t',profileId:hello.profileId});
 const call=(name,args={})=>service.dispatch(binding.bindingId,'agent_browser_'+name,args,()=>true);
 // A real extension-owned tab on an approved origin, rather than bypassing checkedTab.
 async function onSite(){await service.setSiteAccess(binding.bindingId,'https://allowed.test','allow');await call('open',{url:'https://allowed.test/'});chrome.tabs.get(1).url='https://allowed.test/';await chrome.runtime.navigation({tabId:1,frameId:0,url:'https://allowed.test/'});}
 return{service,binding,chrome,calls,call,onSite,decision,setPage:html=>{page=new JSDOM(html,{url:'https://allowed.test/',runScripts:'outside-only'});cleanups.push(async()=>page.window.close());},setTime:value=>at=value,setPay:value=>pay=value,setFacts:value=>floorFacts=value,setProtected:value=>protectedPage=value,setFrame:value=>targetFrame=value,setBeforeInput:value=>beforeInput=value,setBeforeNavigate:value=>beforeNavigate=value,setDuringArm:value=>duringArm=value,setText:value=>text=value};
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

it.each([['captcha','owner handoff paused'],['2FA','automatic credential handoff active']])('control: No limits keeps an existing %s %s',async kind=>{
 const f=await fixture('full');await f.onSite();
 f.setFacts(kind==='captcha'?{operation:'click',tag:'button',name:'Verify you are human',signatures:{captcha:true}}:{operation:'fill',tag:'input',type:'text',autocomplete:'one-time-code'});
 await expect(f.call('click',{selector:'button'})).rejects.toThrow('YOUR TURN');
 expect(f.service.status().bindings[0].state).toBe('paused');
 f.decision.setLevel('unlimited');
 await f.service.ensureBinding({botId:'b',threadId:'t',profileId:'profile_1'});
 if(kind==='2FA'){
  await expect(f.call('get_title')).resolves.toBeDefined();
  expect(f.service.status().bindings[0].state).toBe('active');
  expect(f.calls.filter(c=>c.operation==='resume')).toHaveLength(1);
 }else{
  await expect(f.call('get_title')).rejects.toThrow('YOUR TURN');
  expect(f.service.status().bindings[0].state).toBe('paused');
  expect(f.calls.filter(c=>c.operation==='resume')).toHaveLength(0);
 }
});


it('R1 No limits follows a cross-origin redirect without owner recovery',async()=>{
 const f=await fixture();await f.onSite();
 f.chrome.tabs.get(1).url='https://redirect.test/orders/123456';
 await f.chrome.runtime.navigation({tabId:1,frameId:0,url:f.chrome.tabs.get(1).url});
 const status=await f.chrome.runtime.handleRequest({version:1,type:'command',id:f.chrome.nextId(),bindingId:f.binding.bindingId,generation:f.service.status().bindings[0].generation,operation:'status',params:{}});
 expect(status.result.state).toBe('active');expect(status.result.url).toBe('https://redirect.test/orders/123456');
 await expect(f.call('get_title')).resolves.toBeDefined();
});
it.each([false,true])('R2 No limits captures requested private fields and frames without masking (overlay failed=%s)',async failed=>{
 const f=await fixture();await f.onSite();
 if(failed){const send=f.chrome.api.debugger.sendCommand.getMockImplementation();f.chrome.api.debugger.sendCommand.mockImplementation((source,method,params)=>{if(method==='Runtime.evaluate'&&params.expression?.includes('__muragePresence?.capture('))throw Error('fixture overlay unavailable');return send(source,method,params);});}
 f.chrome.api.debugger.sendCommand.mockClear();
 await expect(f.call('screenshot')).resolves.toBeDefined();
 const commands=f.chrome.api.debugger.sendCommand.mock.calls;
 expect(commands.some(([,m])=>m==='Page.captureScreenshot')).toBe(true);
 expect(commands.filter(([,m,p])=>m==='Runtime.evaluate' && /data-murage-frame-mask|Private field has no mask location/.test(p.expression??''))).toHaveLength(0);
});
it.each(['current-password','cc-number'])('R3 No limits recovers automatic %s holds after promotion',async autocomplete=>{
 const f=await fixture('full');await f.onSite();f.setFacts({operation:'fill',tag:'input',type:autocomplete==='cc-number'?'text':'password',autocomplete});
 await expect(f.call('fill',{selector:'input',text:'fixture'})).rejects.toThrow('YOUR TURN');
 f.decision.setLevel('unlimited');await f.service.ensureBinding({botId:'b',threadId:'t',profileId:'profile_1'});
 await expect(f.call('fill',{selector:'input',text:'fixture'})).resolves.toBeDefined();
 expect(f.service.status().bindings[0].state).toBe('active');
});
it('R3 No limits recovers an automatic checker hold after promotion',async()=>{
 const f=await fixture('full',{k:'owner-typed'},{approvalMode:()=> 'task',checker:()=>({key:'fake',deps:{models:{stage1:'fake1',stage2:'fake2'},transport:async request=>request.model==='fake1'?'FLAG':JSON.stringify({decision:'block',reason:'fixture checker'})}})});await f.onSite();
 for(let i=0;i<3;i++)await f.call('click',{selector:'button'}).catch(()=>{});
 expect(f.service.status().bindings[0].state).toBe('paused');
 f.decision.setLevel('unlimited');await f.service.ensureBinding({botId:'b',threadId:'t',profileId:'profile_1'});
 await expect(f.call('click',{selector:'button'})).resolves.toBeDefined();
});
it('R4 No limits fills an ordinary textarea with 13000 characters',async()=>{
 const f=await fixture('unlimited',{k:'owner-typed'},{integration:true});await f.onSite();f.setPage('<textarea></textarea>');
 await expect(f.call('fill',{selector:'textarea',text:'x'.repeat(13000)})).resolves.toBeDefined();
 expect(f.chrome.api.debugger.sendCommand.mock.calls.some(([,m,p])=>m==='Input.insertText'&&p.text.length===13000)).toBe(true);
});
it('R5 No limits clicks a numeric link described by the real page script',async()=>{
 const f=await fixture('unlimited',{k:'owner-typed'},{integration:true});await f.onSite();f.setPage('<a href="/orders/123456">Order</a>');
 await expect(f.call('click',{selector:'a'})).resolves.toBeDefined();
 expect(f.chrome.api.debugger.sendCommand.mock.calls.some(([,m])=>m==='Input.dispatchMouseEvent')).toBe(true);
});
it('R6 No limits visits 160 origins without overflowing native grant capacity',async()=>{
 const f=await fixture();
 for(let i=0;i<160;i++)await expect(f.call('open',{url:`https://origin${i}.test/`})).resolves.toBeDefined();
 expect(f.calls.filter(c=>c.operation==='bind').every(c=>c.params.approvedOrigins.length<=128)).toBe(true);
});
it.each(['full','auto','ask'])('R7 implicit Ask follower retains its flags under a %s chief',level=>{
 const chief={autoApprove:level!=='ask',fullAccess:level==='full',noLimits:false};
 const dispose=installPermissionInheritance(()=>chief);cleanups.push(async()=>dispose());
 const follower={autoApprove:false,fullAccess:false,noLimits:false,permissionExplicit:false};
 expect(inheritedPermissions(follower)).toEqual(follower);
});


it('D1 No limits opens a handover site through the production facade',async()=>{
 const f=await fixture('unlimited',{k:'owner-typed'},{integration:true});
 await expect(f.call('open',{url:'https://vault.bitwarden.com/'})).resolves.toBeDefined();
 f.chrome.tabs.get(1).url='https://vault.bitwarden.com/';
 await f.chrome.runtime.navigation({tabId:1,frameId:0,url:'https://vault.bitwarden.com/'});
 await expect(f.call('get_title')).resolves.toBeDefined();
 expect(f.chrome.api.debugger.sendCommand.mock.calls.some(([,m,p])=>m==='Page.navigate'&&p.url==='https://vault.bitwarden.com/')).toBe(true);
});
it.each(['closed-shadow','frame-list'])('D3 No limits recovers an unsure %s inspection hold',async kind=>{
 const f=await fixture('full');await f.onSite();
 if(kind==='frame-list')f.chrome.api.webNavigation.getAllFrames.mockRejectedValue(Error('inspection unavailable'));
 else{const send=f.chrome.api.debugger.sendCommand.getMockImplementation();f.chrome.api.debugger.sendCommand.mockImplementation((source,m,p)=>{if(m==='DOM.getDocument')throw Error('inspection unavailable');return send(source,m,p);});}
 await expect(f.call('get_title')).rejects.toThrow('YOUR TURN');
 expect(f.service.status().bindings[0].state).toBe('paused');
 f.decision.setLevel('unlimited');
 await expect(f.call('get_title')).resolves.toBeDefined();
 expect(f.service.status().bindings[0].state).toBe('active');
 expect(f.calls.filter(c=>c.operation==='resume')).toHaveLength(1);
});
it('D4 No limits fills a 70000 character textarea through native messaging',async()=>{
 const f=await fixture('unlimited',{k:'owner-typed'},{integration:true});await f.onSite();
 f.setPage('<textarea></textarea>');const text='x'.repeat(70000);await expect(f.call('fill',{selector:'textarea',text})).resolves.toBeDefined();
 expect(f.chrome.api.debugger.sendCommand.mock.calls.find(([,m,p])=>m==='Input.insertText'&&p.text===text)).toBeDefined();
});
it.each(['created-first','announced-first'])('D5 No limits ordinary download completes with its saved file (%s)',async order=>{
 const f=await fixture();await f.onSite();await f.call('click',{selector:'button'});
 const item={id:77,url:'https://allowed.test/export.csv',finalUrl:'https://allowed.test/export.csv',state:'complete',exists:true};
 f.chrome.api.downloads.search.mockImplementation(async q=>q.id===77||q.url===item.url||q.finalUrl===item.url?[item]:[]);
 const announce=()=>f.chrome.runtime.debuggerEvent({tabId:1},'Page.downloadWillBegin',{url:item.url,suggestedFilename:'export.csv'});
 if(order==='created-first')await f.chrome.runtime.downloadCreated(item);
 await announce();
 if(order==='announced-first')await f.chrome.runtime.downloadCreated(item);
 expect(await f.chrome.runtime.downloadDetermining(item)).toBe(false);
 await f.chrome.runtime.downloadChanged({id:77,state:{current:'complete'}});
 expect(f.chrome.api.downloads.cancel).not.toHaveBeenCalled();expect(f.chrome.api.downloads.removeFile).not.toHaveBeenCalled();expect(f.chrome.api.downloads.erase).not.toHaveBeenCalled();
});
it('D2 engine facade retains frame events and routes flattened cross-origin child sessions',async()=>{
 let f;let run=false;
 f=await fixture('unlimited',{k:'owner-typed'},{facade:async(reader,engine,chrome,doc)=>{
  if(!run)return {content:[{type:'text',text:'fixture'}]};
  const wire=[];reader.socket={readyState:1,send:raw=>wire.push(JSON.parse(raw))};let sequence=0;
  // The pinned engine's wire endpoint: production parsing, queueing and session routing.
  const command=async(method,params={},sessionId)=>{const id=++sequence;reader.dispatchWire(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));await vi.waitFor(()=>expect(wire.some(e=>e.id===id)).toBe(true));const response=wire.find(e=>e.id===id);if(response.error)throw Error(response.error.message);return response.result;};
  const {sessionId}=await command('Target.attachToTarget',{targetId:doc.tabId.toString(16).padStart(32,'0'),flatten:true});
  await command('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true},sessionId);
  expect(chrome.api.debugger.sendCommand.mock.calls.some(([,m,p])=>m==='Target.setAutoAttach'&&p.flatten===true&&p.autoAttach===true)).toBe(true);
  for(const [source,method,params] of [
   [{tabId:1},'Page.frameNavigated',{frame:{id:'child-frame',parentId:'main-frame',url:'https://embedded.test/editor',securityOrigin:'https://embedded.test'}}],
   [{tabId:1},'Runtime.executionContextCreated',{context:{id:31,origin:'https://embedded.test',name:'',auxData:{frameId:'child-frame',isDefault:true,type:'default'}}}],
   [{tabId:1},'Target.attachedToTarget',{sessionId:'chrome-child',targetInfo:{targetId:'child-target',type:'iframe',url:'https://embedded.test/editor'},waitingForDebugger:false}],
   [{tabId:1,sessionId:'chrome-child'},'Runtime.executionContextCreated',{context:{id:32,origin:'https://embedded.test',name:'',auxData:{frameId:'oop-frame',isDefault:true,type:'default'}}}],
  ]){const start=chrome.events.length;await chrome.runtime.debuggerEvent(source,method,params);for(const e of chrome.events.slice(start))await f.service.handleMessage('profile_1',e);}
  expect(wire.some(e=>e.method==='Page.frameNavigated'&&e.params.frame.parentId==='main-frame')).toBe(true);
  expect(wire.some(e=>e.method==='Runtime.executionContextCreated'&&e.params.context.id===31)).toBe(true);
  const child=wire.find(e=>e.method==='Target.attachedToTarget'&&e.params.targetInfo.type==='iframe');expect(child).toBeDefined();
  await command('Runtime.evaluate',{expression:'document.querySelector("textarea").value="same-process text"',contextId:31,returnByValue:true},sessionId);
  await command('Runtime.evaluate',{expression:'document.querySelector("textarea").value="child text"',contextId:32,returnByValue:true},child.params.sessionId);
  await command('Input.insertText',{text:'child input'},child.params.sessionId);
  expect(chrome.api.debugger.sendCommand.mock.calls.some(([source,m,p])=>!source.sessionId&&m==='Runtime.evaluate'&&p.contextId===31)).toBe(true);
  expect(chrome.api.debugger.sendCommand.mock.calls.some(([source,m,p])=>source.sessionId==='chrome-child'&&m==='Runtime.evaluate'&&p.contextId===32)).toBe(true);
  expect(chrome.api.debugger.sendCommand.mock.calls.some(([source,m,p])=>source.sessionId==='chrome-child'&&m==='Input.insertText'&&p.text==='child input')).toBe(true);
  return {content:[{type:'text',text:'child text'}]};
 }});
 // Bootstrap via the service's owned tab transition, then commit a real navigation event.
 await f.service.setSiteAccess(f.binding.bindingId,'https://allowed.test','allow');await f.call('open',{url:'https://allowed.test/'});
 f.chrome.tabs.get(1).url='https://allowed.test/';await f.chrome.runtime.navigation({tabId:1,frameId:0,url:'https://allowed.test/'});
 run=true;await expect(f.call('get_title')).resolves.toBeDefined();
});

it('D4 No limits chunks text above native messaging size at Unicode boundaries',async()=>{
 const f=await fixture('unlimited',{k:'owner-typed'},{integration:true});await f.onSite();f.setPage('<textarea></textarea>');
 const text='🌍<x>'.repeat(180000);await expect(f.call('fill',{selector:'textarea',text})).resolves.toBeDefined();
 const chunks=f.chrome.api.debugger.sendCommand.mock.calls.filter(([,m])=>m==='Input.insertText').map(([,m,p])=>p.text);
 expect(chunks.length).toBeGreaterThan(1);expect(chunks.join('')).toBe(text);
 for(const command of f.calls)expect(Buffer.byteLength(JSON.stringify(command))).toBeLessThanOrEqual(1024*1024);
});
it.each(['full','auto','ask'])('D1 control: %s still refuses a handover site',async level=>{
 const f=await fixture(level);await expect(f.call('open',{url:'https://vault.bitwarden.com/'})).rejects.toThrow();
 expect(f.chrome.api.debugger.sendCommand.mock.calls.some(([,m,p])=>m==='Page.navigate'&&p.url==='https://vault.bitwarden.com/')).toBe(false);
});

// Review regressions use the production wire parser, service event ingress and fake Chrome.
function engineWire(reader) {
 const wire=[];let sequence=0;
 reader.socket={readyState:1,send:raw=>wire.push(JSON.parse(raw))};
 const command=async(method,params={},sessionId)=>{
  const id=++sequence;reader.dispatchWire(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));
  await reader.wireQueue;const response=wire.find(e=>e.id===id);
  if(response?.error)throw Error(response.error.message);return response?.result;
 };
 return {wire,command};
}
async function deliver(f,source,method,params) {
 const start=f.chrome.events.length;await f.chrome.runtime.debuggerEvent(source,method,params);
 for(const event of f.chrome.events.slice(start))await f.service.handleMessage('profile_1',event);
}
async function reviewEngine(level='unlimited',runtimeOptions={}) {
 let run;let reader;let engineDoc;
 const f=await fixture(level,{k:'owner-typed'},{runtimeOptions,facade:async(r,_engine,_chrome,doc)=>{
  reader=r;engineDoc=doc;return run?run():{content:[{type:'text',text:'fixture'}]};
 }});
 await f.onSite();
 return {...f,exercise:async fn=>{run=async()=>{await fn(reader,engineDoc);return {content:[{type:'text',text:'fixture'}]};};return f.call('get_title');}};
}
it.each(['unlimited','full'])('B1 %s navigation events survive an epoch advance before inventory',async level=>{
 const f=await reviewEngine(level);
 await f.exercise(async(reader,doc)=>{
  const {wire,command}=engineWire(reader);
  await command('Target.attachToTarget',{targetId:doc.tabId.toString(16).padStart(32,'0'),flatten:true});
  await f.chrome.runtime.navigation({tabId:1,frameId:0,url:'https://allowed.test/next'});
  await deliver(f,{tabId:1},'Page.frameNavigated',{frame:{id:'new-main',url:'https://allowed.test/next'}});
  await deliver(f,{tabId:1},'Runtime.executionContextCreated',{context:{id:51,origin:'https://allowed.test',auxData:{frameId:'new-main',isDefault:true}}});
  await deliver(f,{tabId:1},'Page.loadEventFired',{timestamp:1});
  expect(wire.filter(e=>e.method).map(e=>e.method)).toEqual(expect.arrayContaining(['Page.frameNavigated','Runtime.executionContextCreated','Page.loadEventFired']));
  const before=wire.length;reader.event(1,doc.navigationEpoch,'Page.loadEventFired',{timestamp:0});expect(wire).toHaveLength(before);
 });
});
it.each(['history','hash'])('B2 iframe remains usable after a same-document %s update',async kind=>{
 const f=await reviewEngine();
 await f.exercise(async(reader,doc)=>{
  const {wire,command}=engineWire(reader);
  const {sessionId}=await command('Target.attachToTarget',{targetId:doc.tabId.toString(16).padStart(32,'0'),flatten:true});
  await command('Target.setAutoAttach',{autoAttach:true,flatten:true},sessionId);
  await deliver(f,{tabId:1},'Target.attachedToTarget',{sessionId:'child-before',targetInfo:{targetId:'iframe',type:'iframe',url:'https://embedded.test/'}});
  const child=wire.find(e=>e.method==='Target.attachedToTarget').params.sessionId;
  const url=kind==='hash'?'https://allowed.test/#next':'https://allowed.test/history';f.chrome.tabs.get(1).url=url;
  await f.chrome.runtime.navigation({tabId:1,frameId:0,url},true);
  await expect(command('Input.insertText',{text:'after same document'},child)).resolves.toBeDefined();
  expect(f.chrome.api.debugger.sendCommand.mock.calls.some(([source,m,p])=>source.sessionId==='child-before'&&m==='Input.insertText'&&p.text==='after same document')).toBe(true);
 });
});
it('B2 idle release detaches old children and restores auto-attach before new iframe input',async()=>{
 const f=await reviewEngine('unlimited',{idleDetachMs:0,presenceRenewMs:10});
 await f.exercise(async(reader,doc)=>{
  const {wire,command}=engineWire(reader);
  const {sessionId}=await command('Target.attachToTarget',{targetId:doc.tabId.toString(16).padStart(32,'0'),flatten:true});
  await command('Target.setAutoAttach',{autoAttach:true,flatten:true},sessionId);
  await deliver(f,{tabId:1},'Target.attachedToTarget',{sessionId:'old-native',targetInfo:{targetId:'iframe',type:'iframe',url:'https://embedded.test/'}});
  const child=wire.find(e=>e.method==='Target.attachedToTarget').params.sessionId;
  const start=f.chrome.events.length;
  await vi.waitFor(()=>expect(f.chrome.api.debugger.detach).toHaveBeenCalled());
  for(const event of f.chrome.events.slice(start))await f.service.handleMessage('profile_1',event);
  expect(wire.some(e=>e.method==='Target.detachedFromTarget'&&e.params.sessionId===child)).toBe(true);
  const before=f.chrome.api.debugger.sendCommand.mock.calls.length;
  await command('Runtime.enable',{},sessionId);
  expect(f.chrome.api.debugger.sendCommand.mock.calls.slice(before).some(([,m,p])=>m==='Target.setAutoAttach'&&p.autoAttach===true&&p.flatten===true)).toBe(true);
  await deliver(f,{tabId:1},'Target.attachedToTarget',{sessionId:'fresh-native',targetInfo:{targetId:'iframe',type:'iframe',url:'https://embedded.test/'}});
  const fresh=wire.filter(e=>e.method==='Target.attachedToTarget').at(-1).params.sessionId;
  await command('Input.insertText',{text:'after idle'},fresh);
  expect(f.chrome.api.debugger.sendCommand.mock.calls.some(([source,m,p])=>source.sessionId==='fresh-native'&&m==='Input.insertText'&&p.text==='after idle')).toBe(true);
 });
});
it('B3 No limits fills 300000 quotes without an approval queue size refusal',async()=>{
 const f=await fixture('unlimited',{k:'owner-typed'},{integration:true});await f.onSite();f.setPage('<textarea></textarea>');
 const text='"'.repeat(300000);await expect(f.call('fill',{selector:'textarea',text})).resolves.toBeDefined();
 expect(f.chrome.api.debugger.sendCommand.mock.calls.filter(([,m])=>m==='Input.insertText').map(([,m,p])=>p.text).join('')).toBe(text);
 for(const c of f.calls)expect(Buffer.byteLength(JSON.stringify(c))).toBeLessThanOrEqual(1024*1024);
});
it.each(['created-first','filename-first'].flatMap(order=>[false,true].map(announced=>({order,announced}))))('B4 No limits download ignores another binding URL block ($order, announced=$announced)',async({order,announced})=>{
 const f=await fixture();await f.onSite();
 await f.chrome.command('bind',{profileId:'profile_1',botName:'Ask bot',approvedOrigins:['https://allowed.test']},1,'ask-bot');
 const tabs=await f.chrome.command('tab_list',{},1,'ask-bot');
 const tabId=tabs.result[0].tabId;
 f.chrome.tabs.get(tabId).url='https://allowed.test/';await f.chrome.runtime.navigation({tabId,frameId:0,url:'https://allowed.test/'});
 await f.chrome.command('cdp',{method:'Page.enable',tabId,navigationEpoch:2},1,'ask-bot');
 const item={id:88,url:'https://allowed.test/export.csv',state:'complete',exists:true};
 await f.chrome.runtime.debuggerEvent({tabId},'Page.downloadWillBegin',{url:item.url,suggestedFilename:'export.csv'});
 await f.call('click',{selector:'button'});
 // Keep both original scenarios; also exercise explicit owner URL announcements.
 if(announced)await f.chrome.runtime.debuggerEvent({tabId:1},'Page.downloadWillBegin',{url:item.url,suggestedFilename:'export.csv'});
 f.chrome.api.downloads.search.mockImplementation(async q=>q.id===88||q.url===item.url?[item]:[]);
 if(order==='created-first')await f.chrome.runtime.downloadCreated(item);
 expect(await f.chrome.runtime.downloadDetermining(item)).toBe(false);
 if(order==='filename-first')await f.chrome.runtime.downloadCreated(item);
 await f.chrome.runtime.downloadChanged({id:88,state:{current:'complete'}});
 expect(f.chrome.api.downloads.cancel).not.toHaveBeenCalled();expect(f.chrome.api.downloads.removeFile).not.toHaveBeenCalled();expect(f.chrome.api.downloads.erase).not.toHaveBeenCalled();
});
it('M1 engine sweeps child sessions on epoch change, late detach and tab removal',async()=>{
 const f=await reviewEngine();
 await f.exercise(async(reader,doc)=>{
  const {command}=engineWire(reader);const {sessionId}=await command('Target.attachToTarget',{targetId:doc.tabId.toString(16).padStart(32,'0'),flatten:true});
  const attach=()=>reader.event(1,doc.navigationEpoch,'Target.attachedToTarget',{sessionId:'native',targetInfo:{targetId:'iframe',type:'iframe'}});
  attach();expect(reader.children.size).toBe(1);
  reader.event(1,doc.navigationEpoch+1,'Page.loadEventFired',{});expect(reader.children.size).toBe(0);expect(reader.sessions.size).toBe(1);
  reader.event(1,doc.navigationEpoch+1,'Target.attachedToTarget',{sessionId:'new-native',targetInfo:{targetId:'iframe',type:'iframe'}});
  reader.event(1,doc.navigationEpoch+2,'Target.detachedFromTarget',{sessionId:'new-native'});expect(reader.children.size).toBe(0);
  await command('Target.getTargets');reader.event(1,doc.navigationEpoch+2,'Target.attachedToTarget',{sessionId:'remaining-native',targetInfo:{targetId:'iframe',type:'iframe'}});expect(reader.children.size).toBe(1);
  await command('Target.closeTarget',{targetId:doc.tabId.toString(16).padStart(32,'0')});expect(reader.children.size).toBe(0);expect(reader.sessions.size).toBe(0);
  await command('Target.createTarget',{url:'about:blank'});
  void sessionId;
 });
});

it.each(['inventory','tab removal'])('M1 child sessions are swept by %s',async kind=>{
 const f=await reviewEngine();
 await f.exercise(async(reader,doc)=>{
  const {command}=engineWire(reader);await command('Target.attachToTarget',{targetId:doc.tabId.toString(16).padStart(32,'0'),flatten:true});
  await deliver(f,{tabId:1},'Target.attachedToTarget',{sessionId:'native',targetInfo:{targetId:'iframe',type:'iframe'}});
  expect(reader.children.size).toBe(1);
  if(kind==='inventory'){
   await f.chrome.runtime.navigation({tabId:1,frameId:0,url:'https://allowed.test/next'});
   await command('Target.getTargets');
  }else await command('Target.closeTarget',{targetId:doc.tabId.toString(16).padStart(32,'0')});
  expect(reader.children.size).toBe(0);
  expect(reader.sessions.size).toBe(kind==='inventory'?1:0);
  if(kind==='tab removal')await command('Target.createTarget',{url:'about:blank'});
 });
});

it('B2 committed navigation replaces children and delivers a fresh iframe session before inventory',async()=>{
 const f=await reviewEngine();
 await f.exercise(async(reader,doc)=>{
  const {wire,command}=engineWire(reader);await command('Target.attachToTarget',{targetId:doc.tabId.toString(16).padStart(32,'0'),flatten:true});
  await deliver(f,{tabId:1},'Target.attachedToTarget',{sessionId:'old-native',targetInfo:{targetId:'old-iframe',type:'iframe'}});
  const old=wire.find(e=>e.method==='Target.attachedToTarget').params.sessionId;
  f.chrome.tabs.get(1).url='https://allowed.test/next';
  const start=f.chrome.events.length;await f.chrome.runtime.navigation({tabId:1,frameId:0,url:'https://allowed.test/next'});
  for(const event of f.chrome.events.slice(start))await f.service.handleMessage('profile_1',event);
  await deliver(f,{tabId:1},'Target.attachedToTarget',{sessionId:'new-native',targetInfo:{targetId:'new-iframe',type:'iframe'}});
  const fresh=wire.filter(e=>e.method==='Target.attachedToTarget').at(-1).params.sessionId;
  expect(fresh).not.toBe(old);expect(reader.children.size).toBe(1);
  await expect(command('Input.insertText',{text:'after navigation'},fresh)).resolves.toBeDefined();
  expect(f.chrome.api.debugger.sendCommand.mock.calls.some(([source,m,p])=>source.sessionId==='new-native'&&m==='Input.insertText'&&p.text==='after navigation')).toBe(true);
 });
});
