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
  const unavailable=await OpenAICompatDriver.create({instanceId:"no-key",displayName:undefined,environment:{},enabled:true,config:{url,apiKeyEnv:"P09_UNUSED_KEY"}});
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
