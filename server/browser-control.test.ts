import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
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
  let gate: Promise<unknown>|undefined;
  const native:NativeBrowser={ protected:async()=>protectedInput, request:async()=>{called++;return gate??{content:[{type:"text",text:"fixture observation"}]};},command:async(args)=>args[0]==="eval"?{result:protectedInput}:{},connect:async(f,_u,d)=>{frame=f;disconnect=d;return "fixture-stream";},input:()=>{},resetStream:()=>{},close:async()=>{} };
  const stateFile=join(dir,"control.json");
  const controller=new UnifiedBrowserController({stateFile,createNative:()=>native});
  const spec={command:"fixture",args:[],env:{}};
  controller.register("shared",spec);
  return {controller,stateFile,spec,native,frame:(seq:number)=>frame({seq,data:"fixture",width:1280,height:800}),disconnect:()=>disconnect(),protect:()=>{protectedInput=true;},called:()=>called,setGate:(value:Promise<unknown>)=>{gate=value;}};
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
