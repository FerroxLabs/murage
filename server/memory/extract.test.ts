import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, rmSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { database, closeDatabase } from "../database.ts";
import { OpenAICompatDriver } from "../drivers/openai-compat.ts";
import { extractCandidates, requestMemoryExtraction } from "./extract.ts";

let server:Server|undefined;
beforeEach(()=>{closeDatabase();rmSync(DATA_DIR,{recursive:true,force:true});mkdirSync(DATA_DIR,{recursive:true});vi.stubEnv("OPENAI_COMPAT_API_KEY","");});
afterEach(async()=>{vi.unstubAllEnvs();if(server){server.closeAllConnections();await new Promise<void>(resolve=>server!.close(()=>resolve()));server=undefined;}});
async function local(handler:(request:IncomingMessage,response:ServerResponse)=>void){
  server=createServer(handler);await new Promise<void>(resolve=>server!.listen(0,"127.0.0.1",resolve));const address=server.address();
  if(!address||typeof address==="string")throw new Error("fixture did not bind TCP");return `http://127.0.0.1:${address.port}/v1`;
}
const result=(response:ServerResponse,content="[]")=>{response.setHeader("content-type","application/json");response.end(JSON.stringify({choices:[{finish_reason:"stop",message:{content}}]}));};

it("advertises extraction only with usable credentials and sends one bounded tool-free request through the configured provider",async()=>{
  let requests=0,body:Record<string,unknown>|undefined;
  const url=await local((request,response)=>{
    if(request.method==="GET"){response.end(JSON.stringify({data:[{id:"fixture-model"}]}));return;}
    requests++;let raw="";request.on("data",chunk=>{raw+=chunk;});request.on("end",()=>{body=JSON.parse(raw);expect(request.headers.authorization).toBe("Bearer fixture-key");result(response);});
  });
  const instance=await OpenAICompatDriver.create({instanceId:"extract",displayName:"Fixture",environment:{},enabled:true,config:{url,apiKeyEnv:"P09_UNUSED_KEY",key:"fixture-key",model:"fixture-model"}});
  try {
    expect(typeof instance.extractMemory).toBe("function");
    expect(await instance.extractMemory!("Keep the verified source.",2000,new AbortController().signal)).toBe("[]");
    expect(requests).toBe(1);expect(body).toMatchObject({model:"fixture-model",max_tokens:2000,stream:false});
    expect(body).not.toHaveProperty("tools");expect(body).not.toHaveProperty("tool_choice");
    expect(JSON.stringify(body)).toContain("Keep the verified source.");
  } finally {await instance.dispose();}
  // 0.1.52 spec E4: a keyless server on this machine is usable (it gets the
  // loopback placeholder key), so it extracts too; a keyless LAN endpoint is
  // unusable and advertises nothing. Nothing is fetched for the LAN instance
  // (the catalog refresh is gated on a key).
  const keylessLoopback=await OpenAICompatDriver.create({instanceId:"no-key-loopback",displayName:undefined,environment:{},enabled:true,config:{url,apiKeyEnv:"P09_UNUSED_KEY"}});
  try{expect(typeof keylessLoopback.extractMemory).toBe("function");}finally{await keylessLoopback.dispose();}
  const unavailable=await OpenAICompatDriver.create({instanceId:"no-key",displayName:undefined,environment:{},enabled:true,config:{url:"http://192.168.1.20:8000/v1",apiKeyEnv:"P09_UNUSED_KEY"}});
  try{expect(unavailable.extractMemory).toBeUndefined();}finally{await unavailable.dispose();}
});

it("refuses oversized input/output budgets before dispatch and bounds provider response bytes without retry",async()=>{
  let requests=0;const url=await local((_request,response)=>{requests++;response.writeHead(200,{"content-length":"65537"});response.end(Buffer.alloc(65537));});
  const config={url,apiKey:"fake",model:"fixture"},signal=new AbortController().signal;
  await expect(requestMemoryExtraction(config,"valid",2001,signal)).rejects.toThrow("MEMORY_EXTRACTION_LIMIT");
  await expect(requestMemoryExtraction(config,"x".repeat(65537),2000,signal)).rejects.toThrow("MEMORY_EXTRACTION_LIMIT");
  expect(requests).toBe(0);
  await expect(requestMemoryExtraction(config,"valid",2000,signal)).rejects.toThrow("MEMORY_EXTRACTION_RESPONSE_LIMIT");
  expect(requests).toBe(1);
});

it("propagates caller cancellation to the single in-flight HTTP extraction",async()=>{
  let observed!:()=>void;const arrived=new Promise<void>(resolve=>{observed=resolve;});let requests=0;
  const url=await local((_request,_response)=>{requests++;observed();}),controller=new AbortController();
  const pending=requestMemoryExtraction({url,apiKey:"fake",model:"fixture"},"source",2000,controller.signal);
  const rejected=expect(pending).rejects.toThrow();await arrived;controller.abort();await rejected;expect(requests).toBe(1);
});

it("admits only one extraction globally and reserves framed input plus bounded output before the call",async()=>{
  let release!:()=>void,calls=0;
  const first=extractCandidates("source",async()=>{calls++;await new Promise<void>(resolve=>{release=resolve;});return "[]";},new AbortController().signal);
  const second=await extractCandidates("another source",async()=>{calls++;return "[]";},new AbortController().signal);
  expect(second).toMatchObject({status:"deferred",reason:"extractor-busy"});expect(calls).toBe(1);
  const budget=JSON.parse(String(database().prepare("SELECT intent FROM memory_scope_bindings WHERE subject_id='extract-budget'").get()!.intent));
  expect(budget.input).toBeGreaterThan(Buffer.byteLength("source"));expect(budget.output).toBe(2000);expect(budget.calls).toBe(1);
  release();expect((await first).status).toBe("complete");
});

it("grounds through the admitted OpenAI compatible route with an independent tool-free prompt",async()=>{
  let body:Record<string,unknown>|undefined;
  const url=await local((request,response)=>{
    if(request.method==="GET"){response.end(JSON.stringify({data:[{id:"fixture-model"}]}));return;}
    let raw="";request.on("data",chunk=>{raw+=chunk;});request.on("end",()=>{body=JSON.parse(raw);result(response,JSON.stringify({supported:true}));});
  });
  const instance=await OpenAICompatDriver.create({instanceId:"ground",displayName:"Fixture",environment:{},enabled:true,config:{url,key:"fixture-key",apiKeyEnv:"P09_UNUSED_KEY",model:"fixture-model"}});
  try{
    expect(await instance.groundMemory!({text:"Prefers brevity",quote:"Please keep answers concise",claimType:"owner-statement",speaker:"owner",outcome:"recorded"},500,new AbortController().signal)).toBe('{"supported":true}');
    expect(body).toMatchObject({model:"fixture-model",max_tokens:500,stream:false});
    expect(body).not.toHaveProperty("tools");expect(JSON.stringify(body)).toContain("Independently judge");
    expect(JSON.stringify(body)).toContain("Please keep answers concise");
  }finally{await instance.dispose();}
});

it("the configured extraction transport sends the caller's frozen classification messages",async()=>{
  let body:any;
  const url=await local((request,response)=>{
    if(request.method==="GET"){response.end(JSON.stringify({data:[{id:"fixture-model"}]}));return;}
    let raw="";request.on("data",chunk=>raw+=chunk);request.on("end",()=>{body=JSON.parse(raw);result(response);});
  });
  const instance=await OpenAICompatDriver.create({instanceId:"frozen-extract",displayName:"Fixture",environment:{},enabled:true,config:{url,apiKeyEnv:"P09_UNUSED_KEY",key:"fixture-key",model:"fixture-model"}});
  const messages=Object.freeze([Object.freeze({role:"system",content:"Immutable contract plus retained classification guidance"}),Object.freeze({role:"user",content:JSON.stringify({source:"A source statement"})})]);
  try{
    await instance.extractMemory!("A source statement",2000,new AbortController().signal,{policyRevision:"retained-version",messages});
    expect(body.messages).toEqual(messages);expect(body.max_tokens).toBe(2000);expect(body).not.toHaveProperty("tools");
  }finally{await instance.dispose();}
});

it("the host reflection purpose permits 8,000 tokens without widening ordinary extraction",async()=>{
  let calls=0,body:any;
  const url=await local((request,response)=>{
    if(request.method==="GET"){response.end(JSON.stringify({data:[{id:"fixture-model"}]}));return;}
    calls++;let raw="";request.on("data",chunk=>raw+=chunk);request.on("end",()=>{body=JSON.parse(raw);result(response,"reflection");});
  });
  const instance=await OpenAICompatDriver.create({instanceId:"reflection",displayName:"Fixture",environment:{},enabled:true,config:{url,apiKeyEnv:"P09_UNUSED_KEY",key:"fixture-key",model:"fixture-model"}});
  const dispatch={policyRevision:"host-cycle",purpose:"reflection" as const,messages:[{role:"system",content:"Reflect on the admitted synthetic examples"},{role:"user",content:"Fixture"}]};
  try{
    await expect(instance.extractMemory!("Fixture",8000,new AbortController().signal)).rejects.toThrow("MEMORY_EXTRACTION_LIMIT");
    await expect(instance.extractMemory!("Fixture",8001,new AbortController().signal,dispatch)).rejects.toThrow("MEMORY_EXTRACTION_LIMIT");
    expect(calls).toBe(0);
    expect(await instance.extractMemory!("Fixture",8000,new AbortController().signal,dispatch)).toBe("reflection");
    expect(body.max_tokens).toBe(8000);expect(body.messages).toEqual(dispatch.messages);expect(calls).toBe(1);
  }finally{await instance.dispose();}
});
