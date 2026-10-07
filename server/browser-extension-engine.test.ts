// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe,it,expect,vi } from "vitest";
import { BrowserExtensionEngine, extensionEngineTools } from "./browser-extension-engine.ts";
import type { ExtensionDocument } from "./browser-extension-executor.ts";
function fixture(){
  let active=true;let documents:ExtensionDocument[]=[{profileId:"profile",tabId:7,frameId:"main",navigationEpoch:1,origin:"https://example.test",url:"https://example.test/"}];
  const send=vi.fn(async(_method:string,_params:Record<string,unknown>,_document:ExtensionDocument):Promise<any>=>({result:{type:"number",value:1}}));const beforeCommand=vi.fn(async()=>{}),beforeDestination=vi.fn(async()=>{});
  const engine=new BrowserExtensionEngine({dataDir:"/unused-fixture",realmId:"workspace",bindingId:"binding",authorize:()=>active,beforeCommand,beforeDestination,
    transport:{documents:async()=>structuredClone(documents),selected:async()=>({...documents[0]}),send,newTab:async url=>{const document={...documents[0],tabId:8,url,origin:url==='about:blank'?'null':new URL(url).origin};documents.push(document);return document;},closeTab:async id=>{documents=documents.filter(doc=>doc.tabId!==id)},selectTab:async id=>documents.find(doc=>doc.tabId===id)!},
  });
  const command=(method:string,params:Record<string,unknown>={},sessionId?:string)=>(engine as unknown as {command:(method:string,params:Record<string,unknown>,sessionId?:string)=>Promise<any>}).command(method,params,sessionId);
  return{engine,command,send,beforeCommand,beforeDestination,navigate:()=>{documents[0]={...documents[0],navigationEpoch:documents[0].navigationEpoch+1};},stop:()=>active=false,blank:()=>{documents[0]={...documents[0],url:'about:blank',origin:'null'};}};
}
describe('scoped engine CDP facade (no native process)',()=>{
 it('publishes pinned27 tool descriptions and owned schemas',()=>{const tools=extensionEngineTools();expect(tools).toHaveLength(27);expect(tools.every(tool=>typeof tool.description==='string')).toBe(true);expect(tools.find(tool=>tool.name==='agent_browser_read')?.inputSchema).toMatchObject({additionalProperties:false,properties:{requireMd:{type:'boolean'}}});expect(tools.some(tool=>tool.name==='agent_browser_eval')).toBe(false);});
 it('exposes only supplied scoped targets using engine-compatible32hex aliases',async()=>{const f=fixture();const result=await f.command('Target.getTargets');expect(result.targetInfos).toHaveLength(1);expect(result.targetInfos[0].targetId).toBe('00000000000000000000000000000007');expect(f.send).not.toHaveBeenCalled();});
 it('attaches only an exact known target and refuses foreign target/session',async()=>{const f=fixture();await expect(f.command('Target.attachToTarget',{targetId:'foreign',flatten:true})).rejects.toThrow('outside');const {sessionId}=await f.command('Target.attachToTarget',{targetId:'00000000000000000000000000000007',flatten:true});await f.command('Runtime.evaluate',{expression:'1'},sessionId);expect(f.beforeCommand).toHaveBeenCalled();await expect(f.command('Runtime.evaluate',{expression:'1'},'other')).rejects.toThrow('does not belong');});
 it('does not forward browser-wide storage or target inventory',async()=>{const f=fixture();await expect(f.command('Storage.getCookies')).rejects.toThrow('not permitted');const {sessionId}=await f.command('Target.attachToTarget',{targetId:'00000000000000000000000000000007',flatten:true});await expect(f.command('Network.getCookies',{},sessionId)).rejects.toThrow('not permitted');expect(f.send).not.toHaveBeenCalled();});
 it('admits new destinations before owned target creation',async()=>{const f=fixture();const result=await f.command('Target.createTarget',{url:'https://another.test/'});expect(result.targetId).toBe('00000000000000000000000000000008');expect(f.beforeDestination).toHaveBeenCalledWith('https://another.test/',expect.objectContaining({tabId:7}));});
 it('synthesizes blank liveness only and forwards real setup events',async()=>{const f=fixture();f.blank();const {sessionId}=await f.command('Target.attachToTarget',{targetId:'00000000000000000000000000000007',flatten:true});expect(await f.command('Runtime.evaluate',{expression:'1'},sessionId)).toEqual({result:{type:'number',value:1}});expect(f.send).not.toHaveBeenCalled();await f.command('Network.enable',{},sessionId);expect(f.send).toHaveBeenCalledWith('Network.enable',{},expect.objectContaining({url:'about:blank'}));await expect(f.command('Runtime.evaluate',{expression:'document.cookie'},sessionId)).rejects.toThrow('cannot be inspected');});
 it('rechecks current authority rather than retaining initial admission',async()=>{const f=fixture();const {sessionId}=await f.command('Target.attachToTarget',{targetId:'00000000000000000000000000000007',flatten:true});f.stop();await expect(f.command('Runtime.evaluate',{expression:'1'},sessionId)).rejects.toThrow('no longer authorised');expect(f.send).not.toHaveBeenCalled();});
});

const historyParams=(expression="history.back()")=>({expression,returnByValue:true,awaitPromise:true});
async function historyFixture(){
  const f=fixture();let history={currentIndex:1,entries:[{id:10,url:"https://example.test/back"},{id:20,url:"https://example.test/"},{id:30,url:"https://example.test/forward"}]};
  f.send.mockImplementation(async method=>method==="Page.getNavigationHistory"?structuredClone(history):{});
  const {sessionId}=await f.command("Target.attachToTarget",{targetId:"00000000000000000000000000000007",flatten:true});
  return{...f,sessionId,setHistory:(next:typeof history)=>{history=next;}};
}
describe("pinned history navigation translation",()=>{
  it.each([["history.back()",10,"back"],["history.forward()",30,"forward"]] as const)("translates %s to exact scoped history acknowledgement",async(expression,entryId,path)=>{
    const f=await historyFixture();expect(await f.command("Runtime.evaluate",historyParams(expression),f.sessionId)).toEqual({result:{type:"undefined"}});
    expect(f.beforeDestination).toHaveBeenCalledWith(`https://example.test/${path}`,expect.objectContaining({tabId:7,navigationEpoch:1}));
    expect(f.send.mock.calls.map(([method])=>method)).toEqual(["Page.getNavigationHistory","Page.getNavigationHistory","Page.navigateToHistoryEntry"]);
    expect(f.send).toHaveBeenLastCalledWith("Page.navigateToHistoryEntry",{entryId},expect.objectContaining({tabId:7}));
  });
  it("does not navigate when destination approval is denied",async()=>{const f=await historyFixture();f.beforeDestination.mockRejectedValueOnce(Error("destination denied"));await expect(f.command("Runtime.evaluate",historyParams(),f.sessionId)).rejects.toThrow("destination denied");expect(f.send.mock.calls.some(([method])=>method==="Page.navigateToHistoryEntry")).toBe(false);});
  it("refuses a document change while approval waits",async()=>{const f=await historyFixture();f.beforeDestination.mockImplementationOnce(async()=>{f.navigate();});await expect(f.command("Runtime.evaluate",historyParams(),f.sessionId)).rejects.toThrow("document changed");expect(f.send.mock.calls.some(([method])=>method==="Page.navigateToHistoryEntry")).toBe(false);});
  it("refuses changed adjacent entry identity even without document navigation",async()=>{const f=await historyFixture();f.beforeDestination.mockImplementationOnce(async()=>{f.setHistory({currentIndex:1,entries:[{id:99,url:"https://example.test/replaced"},{id:20,url:"https://example.test/"}]});});await expect(f.command("Runtime.evaluate",historyParams(),f.sessionId)).rejects.toThrow("history destination changed");expect(f.send.mock.calls.some(([method])=>method==="Page.navigateToHistoryEntry")).toBe(false);});
  it.each([{contextId:3},{uniqueContextId:"other"},{targetId:"other"},{returnByValue:false},{awaitPromise:false}])("rejects history shape extension %j",async patch=>{const f=await historyFixture();await expect(f.command("Runtime.evaluate",{...historyParams(),...patch},f.sessionId)).rejects.toThrow("history command shape");expect(f.send).not.toHaveBeenCalled();});
  it("acknowledges an absent adjacent history entry without navigation",async()=>{const f=await historyFixture();f.setHistory({currentIndex:0,entries:[{id:20,url:"https://example.test/"}]});expect(await f.command("Runtime.evaluate",historyParams(),f.sessionId)).toEqual({result:{type:"undefined"}});expect(f.beforeDestination).not.toHaveBeenCalled();expect(f.send).toHaveBeenCalledTimes(1);});
  it("preserves current authority after the approval await",async()=>{const f=await historyFixture();f.beforeDestination.mockImplementationOnce(async()=>{f.stop();});await expect(f.command("Runtime.evaluate",historyParams(),f.sessionId)).rejects.toThrow("no longer authorised");expect(f.send.mock.calls.some(([method])=>method==="Page.navigateToHistoryEntry")).toBe(false);});
});

describe("a dialog answer from the engine is not queued behind the blocked command (lane chromebatch1)",()=>{
  it("Page.handleJavaScriptDialog is dispatched while an Input command from the same engine is still waiting",async()=>{
    const f=fixture();const {sessionId}=await f.command("Target.attachToTarget",{targetId:"00000000000000000000000000000007",flatten:true});
    let release!:()=>void;const blocked=new Promise<void>(resolve=>{release=resolve;});
    f.send.mockImplementation(async method=>{if(method==="Input.dispatchMouseEvent")await blocked;return {};});
    const sent:string[]=[];const engine=(f as unknown as {engine:unknown}).engine as {socket:unknown;dispatchWire:(raw:string)=>void};
    engine.socket={readyState:1,send:(text:string)=>sent.push(text)};
    engine.dispatchWire(JSON.stringify({id:1,sessionId,method:"Input.dispatchMouseEvent",params:{type:"mouseReleased",x:1,y:1}}));
    engine.dispatchWire(JSON.stringify({id:2,sessionId,method:"Page.handleJavaScriptDialog",params:{accept:true}}));
    await vi.waitFor(()=>expect(f.send.mock.calls.map(([method])=>method)).toContain("Page.handleJavaScriptDialog"),{timeout:2000});
    expect(sent.map(text=>JSON.parse(text).id)).toContain(2);expect(sent.map(text=>JSON.parse(text).id)).not.toContain(1);
    release();await vi.waitFor(()=>expect(sent.map(text=>JSON.parse(text).id)).toContain(1),{timeout:2000});
  });
  it("other commands still run one at a time, in order",async()=>{
    const f=fixture();const {sessionId}=await f.command("Target.attachToTarget",{targetId:"00000000000000000000000000000007",flatten:true});
    let release!:()=>void;const blocked=new Promise<void>(resolve=>{release=resolve;});
    f.send.mockImplementation(async method=>{if(method==="Input.dispatchMouseEvent")await blocked;return {};});
    const engine=(f as unknown as {engine:unknown}).engine as {socket:unknown;dispatchWire:(raw:string)=>void};engine.socket={readyState:1,send:()=>{}};
    engine.dispatchWire(JSON.stringify({id:1,sessionId,method:"Input.dispatchMouseEvent",params:{type:"mouseReleased",x:1,y:1}}));
    engine.dispatchWire(JSON.stringify({id:2,sessionId,method:"Runtime.evaluate",params:{expression:"1"}}));
    await new Promise(resolve=>setTimeout(resolve,100));
    expect(f.send.mock.calls.map(([method])=>method)).not.toContain("Runtime.evaluate");
    release();await vi.waitFor(()=>expect(f.send.mock.calls.map(([method])=>method)).toContain("Runtime.evaluate"),{timeout:2000});
  });
});


describe("Chrome proof: retain the first relay refusal for the tool call", () => {
  it.each([
    ["browser_extension_refused", "YOUR TURN: the owner must answer this page."],
    ["uncertain", "uncertain"],
    ["stale_generation", "stale_generation"],
    ["stale_binding", "stale_binding"],
  ])("keeps %s when a later command loses authority", async (code, message) => {
    const f = fixture();
    const { sessionId } = await f.command("Target.attachToTarget", { targetId: "00000000000000000000000000000007", flatten: true });
    const internal = f.engine as any;
    const wire: any[] = [];
    internal.socket = { readyState: 1, send: (raw: string) => wire.push(JSON.parse(raw)) };
    internal.start = async () => {};
    internal.client = { request: async () => {
      f.beforeCommand.mockImplementationOnce(async () => { f.stop(); throw Object.assign(Error(message), { code }); });
      internal.dispatchWire(JSON.stringify({ id: 101, sessionId, method: "Runtime.evaluate", params: { expression: "1" } }));
      await internal.wireQueue;
      internal.dispatchWire(JSON.stringify({ id: 102, sessionId, method: "Runtime.evaluate", params: { expression: "1" } }));
      await internal.wireQueue;
      return { isError: true, content: [{ type: "text", text: "later engine failure" }] };
    } };
    await expect(f.engine.call("agent_browser_close", {})).rejects.toMatchObject({ code, message });
    expect(wire.find(item => item.id === 101).error.message).not.toBe("Browser authority, document or operation refused.");
    // The original error belongs only to this call, not a later owner-authorised call.
    internal.options.authorize = () => true;
    internal.client.request = async () => ({ content: [{ type: "text", text: "next call" }] });
    await expect(f.engine.call("agent_browser_close", {})).resolves.toMatchObject({ content: [{ text: "next call" }] });
  });
});

// Windows (Windows test machine; Chrome 155, Edge 154, Brave 154): the pinned engine never answers an alert. agent-browser 0.36.0 answers
// alert and beforeunload from a background task that first writes a line to stderr; its daemon's stderr is a pipe from the
// short-lived CLI that started it, and only on Unix is it pointed at /dev/null. On Windows the write fails (the reader is gone),
// eprintln! panics, and the task ends before Page.handleJavaScriptDialog is sent. The click's input then waits until the
// extension's input deadline (uncertain), the binding is fenced, and the rest of the click reads stale_generation.
// Replayed here in that order: the alert opens while the click's mouseReleased is in flight, and the engine sends nothing.
describe("an alert the bot's own click opened is answered by Murage, not by the engine's background task (Windows order)",()=>{
  const INPUT_DEADLINE_MS=3_000;
  const windowsOrder=async(type="alert")=>{
    const f=fixture();const {sessionId}=await f.command("Target.attachToTarget",{targetId:"00000000000000000000000000000007",flatten:true});
    // Chrome holds the input until the dialog is answered; the extension gives up on it at its deadline and reports it uncertain.
    let answered!:()=>void;const dialogAnswered=new Promise<void>(resolve=>{answered=resolve;});
    f.send.mockImplementation(async(method:string)=>{
      if(method==="Input.dispatchMouseEvent"){let timer:NodeJS.Timeout|undefined;try{await Promise.race([dialogAnswered,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(Error("uncertain"),{code:"uncertain"})),INPUT_DEADLINE_MS);})]);}finally{clearTimeout(timer);}return {};}
      if(method==="Page.handleJavaScriptDialog")answered();
      return {};
    });
    const sent:Record<string,any>[]=[];const engine=f.engine as unknown as {socket:unknown;dispatchWire:(raw:string)=>void;callRefusal?:{first?:unknown}};
    engine.socket={readyState:1,send:(text:string)=>sent.push(JSON.parse(text))};
    engine.callRefusal={};// a tool call (the click) is in flight
    engine.dispatchWire(JSON.stringify({id:1,sessionId,method:"Input.dispatchMouseEvent",params:{type:"mouseReleased",x:1,y:1,button:"left",clickCount:1}}));
    await vi.waitFor(()=>expect(f.send.mock.calls.map(([method])=>method)).toContain("Input.dispatchMouseEvent"));
    // The dialog opens before the input returns. The engine's own answer never comes (its task is gone on Windows).
    f.engine.event(7,1,"Page.javascriptDialogOpening",{type,message:"Fixture alert: saved",url:"",hasBrowserHandler:true});
    return {f,sent,engine};
  };
  const answers=(f:ReturnType<typeof fixture>)=>f.send.mock.calls.filter(([method])=>method==="Page.handleJavaScriptDialog").map(([,params])=>params);
  it("answers the alert through admission, and the click's input returns well inside its deadline",async()=>{
    const {f,sent}=await windowsOrder();
    await vi.waitFor(()=>expect(sent.find(message=>message.id===1)).toBeDefined(),{timeout:INPUT_DEADLINE_MS+2_000});
    expect(sent.find(message=>message.id===1)).toMatchObject({result:{}});
    expect(answers(f)).toEqual([{accept:true}]);
    expect((f.beforeCommand.mock.calls as unknown[][]).some(([,method])=>method==="Page.handleJavaScriptDialog")).toBe(true);
  });
  it("never shows the engine an opening it would answer itself, so exactly one answer is sent",async()=>{
    const {f,sent}=await windowsOrder();
    await vi.waitFor(()=>expect(sent.find(message=>message.id===1)).toBeDefined(),{timeout:INPUT_DEADLINE_MS+2_000});
    expect(sent.some(message=>message.method==="Page.javascriptDialogOpening")).toBe(false);
    expect(answers(f)).toHaveLength(1);
  });
  it("leaves a confirm to the owner: the engine is told, Murage answers nothing",async()=>{
    const {f,sent}=await windowsOrder("confirm");
    await vi.waitFor(()=>expect(sent.some(message=>message.method==="Page.javascriptDialogOpening")).toBe(true));
    await new Promise(resolve=>setTimeout(resolve,200));
    expect(answers(f)).toEqual([]);
  });
  it("a refused answer (the owner declined the card, or a hand-over) is kept for the click, as an engine answer's refusal was",async()=>{
    const f=fixture();const {sessionId}=await f.command("Target.attachToTarget",{targetId:"00000000000000000000000000000007",flatten:true});
    const refused=Object.assign(Error("The browser action was not approved."),{code:"browser_extension_refused"});
    f.beforeCommand.mockImplementation((async(_document:unknown,method:string)=>{if(method==="Page.handleJavaScriptDialog")throw refused;}) as never);
    const engine=f.engine as unknown as {socket:unknown;callRefusal?:{first?:unknown}};engine.socket={readyState:1,send:()=>{}};
    const refusal:{first?:unknown}={};engine.callRefusal=refusal;void sessionId;
    f.engine.event(7,1,"Page.javascriptDialogOpening",{type:"alert",message:"Fixture alert: saved",url:""});
    await vi.waitFor(()=>expect(refusal.first).toBe(refused));
    expect(answers(f)).toEqual([]);
  });
  it("after Stop (authority gone) the opening is neither answered nor passed on: the fence holds",async()=>{
    const f=fixture();await f.command("Target.attachToTarget",{targetId:"00000000000000000000000000000007",flatten:true});
    const sent:unknown[]=[];(f.engine as unknown as {socket:unknown}).socket={readyState:1,send:(text:string)=>sent.push(text)};
    f.stop();f.engine.event(7,1,"Page.javascriptDialogOpening",{type:"alert",message:"Fixture alert: saved",url:""});
    await new Promise(resolve=>setTimeout(resolve,200));
    expect(answers(f)).toEqual([]);expect(sent).toEqual([]);
  });
});
