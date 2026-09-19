import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnifiedBrowserController } from "./browser-control.ts";
import type { NativeBrowser, BrowserFrame } from "./browser-native-relay.ts";
const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path,{recursive:true,force:true}); });
function fixture() {
  const dir=mkdtempSync(join(tmpdir(),"murage-control-test-"));directories.push(dir);
  let frame: (f:BrowserFrame)=>void = ()=>{};
  let disconnect=()=>{};
  let protectedInput=false;
  let called=0;
  const opened:string[]=[];
  let gate: Promise<unknown>|undefined;
  const native:NativeBrowser={ protected:async()=>protectedInput, request:async(method,call)=>{
    if(method==="tools/list") return {tools:[{name:"agent_browser_snapshot"},{name:"agent_browser_open"}]};
    called++; if(call?.name==="agent_browser_open") opened.push(String((call.arguments as {url?:string}).url));
    return gate??{content:[{type:"text",text:"fixture observation"}]};},command:async(args)=>args[0]==="eval"?{result:protectedInput}:{},connect:async(f,_u,d)=>{frame=f;disconnect=d;return "fixture-stream";},input:()=>{},resetStream:()=>{},close:async()=>{} };
  const stateFile=join(dir,"control.json");
  const controller=new UnifiedBrowserController({stateFile,createNative:()=>native});
  const spec={command:"fixture",args:[],env:{}};
  controller.register("shared",spec);
  return {controller,stateFile,spec,native,opened,frame:(seq:number)=>frame({seq,data:"fixture",width:1280,height:800}),disconnect:()=>disconnect(),protect:(value=true)=>{protectedInput=value;},called:()=>called,setGate:(value:Promise<unknown>)=>{gate=value;}};
}
describe("unified browser ownership boundary",()=>{
  it("refuses both bots using a human-owned shared profile and another owner session",async()=>{
    const f=fixture();const status=await f.controller.take("shared","owner-a");
    await expect(f.controller.dispatch("shared","tools/call",{name:"agent_browser_snapshot"},()=>true)).rejects.toThrow();
    await expect(f.controller.take("shared","owner-b")).rejects.toThrow("Another owner");
    await expect(f.controller.release("shared","owner-b",status.generation)).rejects.toThrow();
    expect(f.called()).toBe(0);
  });
  it("drains admitted work but discards its observation on takeover and never queues another action",async()=>{
    const f=fixture();let finish!:(value:unknown)=>void;
    f.setGate(new Promise(resolve=>{finish=resolve;}));
    const action=f.controller.dispatch("shared","tools/call",{name:"agent_browser_snapshot"},()=>true);
    await Promise.resolve();
    await expect(f.controller.dispatch("shared","tools/call",{name:"agent_browser_snapshot"},()=>true)).rejects.toThrow("in progress");
    const taking=f.controller.take("shared","owner");
    finish({content:[{type:"text",text:"stale secret"}]});
    await expect(action).rejects.toThrow();await taking;
  });
  it("discards results when takeover lands during the final guard disarm",async()=>{
    const f=fixture();let release!:()=>void;let entered!:()=>void;
    const disarming=new Promise<void>(resolve=>{entered=resolve;});
    f.native.protected=async(armed=true)=>{if(!armed){entered();await new Promise<void>(resolve=>{release=resolve;});}return false;};
    const action=f.controller.dispatch("shared","tools/call",{name:"agent_browser_snapshot"},()=>true);
    await disarming;
    const taking=f.controller.take("shared","owner");
    release();
    await expect(action).rejects.toThrow();await taking;
  });
  it("allows an explicitly authorized desktop reclaim without clearing protected-document state",async()=>{
    const f=fixture();const first=await f.controller.take("shared","phone");
    f.controller.input("shared","phone",first.generation,{type:"input_keyboard",eventType:"char",text:"fake"});
    const next=await f.controller.reclaim("shared","desktop");
    expect(next).toMatchObject({held:true,owner:"desktop",protectedDocument:true});
    expect(()=>f.controller.input("shared","phone",first.generation,{type:"input_keyboard",eventType:"char",text:"old"})).toThrow();
  });
  it("refuses stale frames and input across ownership changes",async()=>{
    const f=fixture();await f.controller.connect("shared");f.frame(1);
    const previous=f.controller.status("shared");const held=await f.controller.take("shared","owner");
    expect(()=>f.controller.frame("shared",previous.generation)).toThrow();
    expect(()=>f.controller.input("shared","owner",previous.generation,{type:"input_keyboard",eventType:"keyDown",key:"x"})).toThrow();
    expect(f.controller.frame("shared",held.generation)).toBeNull();
    f.frame(1);expect(f.controller.frame("shared",held.generation)).toBeNull();
    f.frame(3);f.frame(2);expect(f.controller.frame("shared",held.generation)?.seq).toBe(3);
  });
  it("keeps ownership and human document taint across disconnect and server restart",async()=>{
    const f=fixture();const held=await f.controller.take("shared","owner");
    f.controller.input("shared","owner",held.generation,{type:"input_keyboard",eventType:"keyDown",key:"x"});
    f.disconnect();expect(f.controller.status("shared").held).toBe(true);
    const restored=new UnifiedBrowserController({stateFile:f.stateFile,createNative:()=>f.native});restored.register("shared",f.spec);
    expect(restored.status("shared")).toMatchObject({held:true,protectedDocument:true,connected:false});
  });
  it("withholds protected pages before native observations and retains taint after return",async()=>{
    const f=fixture();f.protect();
    await expect(f.controller.dispatch("shared","tools/call",{name:"agent_browser_snapshot"},()=>true)).rejects.toThrow();expect(f.called()).toBe(0);
    const held=await f.controller.take("shared","owner");await f.controller.release("shared","owner",held.generation);
    await expect(f.controller.dispatch("shared","tools/call",{name:"agent_browser_get_text",arguments:{selector:"body"}},()=>true)).rejects.toThrow();
  });
  it("requires current owner reopen to clear taint and never authorizes revoked turns",async()=>{
    const f=fixture();let held=await f.controller.take("shared","owner");
    f.controller.input("shared","owner",held.generation,{type:"input_keyboard",eventType:"keyDown",key:"x"});
    held=await f.controller.reopen("shared","owner",held.generation);expect(held.protectedDocument).toBe(false);
    await f.controller.release("shared","owner",held.generation);
    await expect(f.controller.dispatch("shared","tools/call",{name:"agent_browser_snapshot"},()=>false)).rejects.toThrow();expect(f.called()).toBe(0);
  });
});
// A protected page is a privacy barrier, not a broken browser: the tools stay
// listed so the bot can say what is wrong, and every refusal names its cause.
describe("a protected browser explains itself",()=>{
  const snapshot={name:"agent_browser_snapshot"};
  const refusalOf=async(promise:Promise<unknown>)=>{try{await promise;}catch(error){return error as Error&{code?:string;status?:number};}throw new Error("expected a refusal");};
  it("keeps listing tools after the owner typed in the page, and refuses reads with the owner's way out",async()=>{
    const f=fixture();const held=await f.controller.take("shared","owner");
    f.controller.input("shared","owner",held.generation,{type:"input_keyboard",eventType:"char",text:"x"});
    await f.controller.release("shared","owner",(f.controller.status("shared")).generation);
    const listed=await f.controller.dispatch("shared","tools/list",{},()=>true) as {tools:Array<{name:string}>};
    expect(listed.tools.map(tool=>tool.name)).toEqual(["agent_browser_snapshot","agent_browser_open"]);
    expect(f.controller.status("shared")).toMatchObject({protectedDocument:true,protectedReason:"owner-input"});
    const refused=await refusalOf(f.controller.dispatch("shared","tools/call",snapshot,()=>true));
    expect(refused.code).toBe("browser_protected_owner_input");
    expect(refused.message).toContain("the owner typed or clicked in it");
    expect(refused.message).toContain("Take control, then Reopen blank page");
    expect(refused.message).toContain("Do not switch to another browser");
    expect(f.called()).toBe(0);
  });
  it("does not let the bot navigate away from a page the owner typed in",async()=>{
    const f=fixture();const held=await f.controller.take("shared","owner");
    f.controller.input("shared","owner",held.generation,{type:"input_mouse",eventType:"mousePressed",x:1,y:1});
    await f.controller.release("shared","owner",f.controller.status("shared").generation);
    const refused=await refusalOf(f.controller.dispatch("shared","tools/call",{name:"agent_browser_open",arguments:{url:"https://example.com/"}},()=>true));
    expect(refused.code).toBe("browser_protected_owner_input");
    expect(f.opened).toEqual([]);expect(f.controller.status("shared").protectedDocument).toBe(true);
  });
  it("names a sensitive page as the cause and lets the bot leave it for an unprotected address",async()=>{
    const f=fixture();f.protect();
    const refused=await refusalOf(f.controller.dispatch("shared","tools/call",snapshot,()=>true));
    expect(refused.code).toBe("browser_protected_sensitive_page");
    expect(refused.message).toContain("password, one-time-code or payment field, an embedded frame");
    expect(refused.message).toContain("agent_browser_open");
    expect(f.controller.status("shared")).toMatchObject({protectedDocument:true,protectedReason:"sensitive-page"});
    // Still sensitive after the navigation: the result is withheld, the lock stays.
    const still=await refusalOf(f.controller.dispatch("shared","tools/call",{name:"agent_browser_open",arguments:{url:"https://still.example/"}},()=>true));
    expect(still.code).toBe("browser_protected_sensitive_page");
    expect(f.controller.status("shared").protectedDocument).toBe(true);
    // Reads stay refused before the bot leaves.
    await expect(f.controller.dispatch("shared","tools/call",snapshot,()=>true)).rejects.toMatchObject({code:"browser_protected_sensitive_page"});
    f.protect(false);
    await expect(f.controller.dispatch("shared","tools/call",snapshot,()=>true)).rejects.toMatchObject({code:"browser_protected_sensitive_page"});
    await expect(f.controller.dispatch("shared","tools/call",{name:"agent_browser_open",arguments:{url:"https://example.com/"}},()=>true)).resolves.toMatchObject({content:[{text:"fixture observation"}]});
    expect(f.opened).toEqual(["https://still.example/","https://example.com/"]);
    expect(f.controller.status("shared")).toMatchObject({protectedDocument:false,protectedReason:null});
    await expect(f.controller.dispatch("shared","tools/call",snapshot,()=>true)).resolves.toBeTruthy();
  });
  it("an owner keystroke on a sensitive page makes it an owner lock the bot cannot leave by itself",async()=>{
    const f=fixture();f.protect();
    await expect(f.controller.dispatch("shared","tools/call",snapshot,()=>true)).rejects.toMatchObject({code:"browser_protected_sensitive_page"});
    const held=await f.controller.take("shared","owner");
    f.controller.input("shared","owner",held.generation,{type:"input_keyboard",eventType:"char",text:"x"});
    await f.controller.release("shared","owner",f.controller.status("shared").generation);
    f.protect(false);
    await expect(f.controller.dispatch("shared","tools/call",{name:"agent_browser_open",arguments:{url:"https://example.com/"}},()=>true)).rejects.toMatchObject({code:"browser_protected_owner_input"});
    expect(f.opened).toEqual([]);
  });
  it("treats a lock saved before causes were recorded as the owner's, and keeps the cause across a restart",async()=>{
    const f=fixture();writeFileSync(f.stateFile,JSON.stringify([["shared",{generation:3,held:false,owner:null,protectedDocument:true}]]));
    const legacy=new UnifiedBrowserController({stateFile:f.stateFile,createNative:()=>f.native});legacy.register("shared",f.spec);
    expect(legacy.status("shared")).toMatchObject({protectedDocument:true,protectedReason:"owner-input"});
    f.protect();const page=fixture();page.protect();
    await expect(page.controller.dispatch("shared","tools/call",snapshot,()=>true)).rejects.toThrow();
    const restored=new UnifiedBrowserController({stateFile:page.stateFile,createNative:()=>page.native});restored.register("shared",page.spec);
    expect(restored.status("shared")).toMatchObject({protectedDocument:true,protectedReason:"sensitive-page"});
  });
  it("keeps listing tools while the owner holds control, and says the owner has it",async()=>{
    const f=fixture();await f.controller.take("shared","owner");
    const listed=await f.controller.dispatch("shared","tools/list",{},()=>true) as {tools:unknown[]};
    expect(listed.tools).toHaveLength(2);
    const refused=await refusalOf(f.controller.dispatch("shared","tools/call",snapshot,()=>true));
    expect(refused.code).toBe("browser_held");
    expect(refused.message).toContain("The owner has taken control of this browser");
    await expect(f.controller.dispatch("shared","tools/list",{},()=>false)).rejects.toMatchObject({code:"browser_not_authorized"});
  });
});

