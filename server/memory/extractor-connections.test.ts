import { memoryExtractionMessages } from "./extract.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderInstance } from "../contracts.ts";
import { memoryExtractorConnections, resolveMemoryExtractor } from "./extractor-connections.ts";

afterEach(() => vi.unstubAllGlobals());

describe("memory extractor connections", () => {
  it("offers Flux tiers using the existing key, without treating native login as extraction", () => {
    const native = { instanceId: "claude", displayName: "Claude", enabled: true } as ProviderInstance;
    const choices = memoryExtractorConnections([native], "fixture-key");
    expect(choices.filter(item=>item.eligible).map(item => item.instanceId)).toEqual(["@murage/flux-fast", "@murage/flux-standard", "@murage/flux-auto"]);
    expect(choices.find(item=>item.instanceId==="claude")).toMatchObject({eligible:false});
    expect(memoryExtractorConnections([], null).every(item => !item.eligible)).toBe(true);
    expect(resolveMemoryExtractor(null, [])).toBeNull();
  });

  it("uses capability rather than a vendor allowlist, and excludes disabled connections", () => {
    const extractMemory = vi.fn();
    const connection = { instanceId: "custom", displayName: "Existing custom connection", enabled: true, extractMemory } as unknown as ProviderInstance;
    expect(memoryExtractorConnections([connection], null).at(-1)?.instanceId).toBe("custom");
    expect(resolveMemoryExtractor("custom", [{ ...connection, enabled: false }])).toBeNull();
    expect(resolveMemoryExtractor("missing", [connection])).toBeNull();
  });

  it("makes one capped tool-free request to Flux and rereads the key before sending", async () => {
    let key: string | null = "initial-fixture-key";
    const extract = resolveMemoryExtractor("@murage/flux-fast", [], () => key)!;
    const request = vi.fn(async () => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "[]" } }] })));
    vi.stubGlobal("fetch", request);
    key = "replacement-fixture-key";
    expect(await extract("Owner prefers daily reports.", 100, new AbortController().signal)).toBe("[]");
    expect(request).toHaveBeenCalledTimes(1);
    const [url, init] = request.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe("https://api.fluxrouter.ai/v1/chat/completions");
    expect(init.redirect).toBe("error");
    expect(init.headers).toMatchObject({ authorization: "Bearer replacement-fixture-key" });
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: "flux-fast", max_tokens: 100, stream: false });
    expect(body).not.toHaveProperty("tools");
    expect(body.messages).toEqual(memoryExtractionMessages("Owner prefers daily reports."));
    key = null;
    expect(() => extract("source", 100, new AbortController().signal)).toThrow("MEMORY_EXTRACTOR_UNAVAILABLE");
    expect(request).toHaveBeenCalledTimes(1);
  });
});

it("defaults dynamically and never falls back from an unavailable explicit choice",async()=>{
 const {resolveLearningConnection}=await import("./extractor-connections.ts");
 expect(resolveLearningConnection({selected:null,instances:[],readKey:()=>"fake",defaultOn:false})).toMatchObject({source:"default",instanceId:"@murage/flux-fast"});
 expect(resolveLearningConnection({selected:"missing",instances:[],readKey:()=>"fake",defaultOn:false})).toMatchObject({source:"none",extractor:null});
});

it("pauses a refused default until the key changes and never keeps a revoked key",async()=>{
 const {resolveLearningConnection}=await import("./extractor-connections.ts");let key:string|null="fake-refused-key";
 const fetcher=vi.fn(async()=>new Response("denied",{status:401}));vi.stubGlobal("fetch",fetcher);
 try{
 const input={selected:null,instances:[],readKey:()=>key,defaultOn:false};
 const first=resolveLearningConnection(input);await expect(first.extractor!("tea",2000,new AbortController().signal)).rejects.toThrow("MEMORY_EXTRACTION_REQUEST_FAILED");
 expect(resolveLearningConnection(input)).toMatchObject({source:"none",reason:"Learning is paused: the connection was refused. Check your key in Settings."});
 key="replacement-key";const next=resolveLearningConnection(input);expect(next.source).toBe("default");key=null;
 await expect(async()=>next.extractor!("tea",2000,new AbortController().signal)).rejects.toThrow("MEMORY_EXTRACTOR_UNAVAILABLE");expect(fetcher).toHaveBeenCalledTimes(1);
 }finally{vi.unstubAllGlobals();}
});

it("offers a single provider key without selecting it and resolves replacements at dispatch",async()=>{
 const {ProviderConnectionsService}=await import("../provider-connections.ts");const {resolveLearningConnection}=await import("./extractor-connections.ts");
 const {mkdtempSync,rmSync}=await import("node:fs"),{tmpdir}=await import("node:os"),{join}=await import("node:path");const root=mkdtempSync(join(tmpdir(),"learning-provider-"));
 let row={id:"fixture",preset:"openai",label:"My key",enabled:true,key:"fixture-key-one",revision:"r1"};
 const service=new ProviderConnectionsService({readBank:()=>JSON.stringify([row]),cacheDir:root,fetch:async()=>new Response(JSON.stringify({data:[{id:"gpt-fixture",output_modalities:["text"]}]}))});
 try{
 // The synthetic model declares text output; its invented name is not a known chat family.
 const catalog=await service.refresh("fixture");expect(catalog.models).toMatchObject([{id:"gpt-fixture",chatEligible:true}]);const input={selected:null,instances:[],providerConnections:service,readKey:()=>null,defaultOn:false};
 expect(resolveLearningConnection(input)).toMatchObject({source:"none",suggestion:{instanceId:"provider:fixture",label:"My key"}});
 const selected=resolveLearningConnection({...input,selected:"provider:fixture"});expect(selected.source).toBe("chosen");
 row={...row,key:"fixture-key-two",revision:"r2"};await service.refresh("fixture");
 const request=vi.fn(async()=>new Response(JSON.stringify({choices:[{message:{content:"[]"}}]})));vi.stubGlobal("fetch",request);
 await selected.extractor!("tea",2000,new AbortController().signal);expect((request.mock.calls[0] as unknown as [URL,RequestInit])[1].headers).toMatchObject({authorization:"Bearer fixture-key-two"});
 await selected.extractor!.ground!({text:"tea",quote:"tea",claimType:"owner-statement",speaker:"owner",outcome:"recorded"},8,new AbortController().signal);
 expect(JSON.parse(String((request.mock.calls.at(-1) as unknown as [URL,RequestInit])[1].body)).max_tokens).toBe(8);
 row={...row,enabled:false};expect(resolveLearningConnection({...input,selected:"provider:fixture",readKey:()=>"flux-fake"})).toMatchObject({source:"none",extractor:null});
 await expect(selected.extractor!("tea",2000,new AbortController().signal)).rejects.toThrow("MEMORY_EXTRACTOR_UNAVAILABLE");
 }finally{rmSync(root,{recursive:true,force:true});vi.unstubAllGlobals();}
});

it("returns none when credentials disappear during resolution",async()=>{
 const {resolveLearningConnection}=await import("./extractor-connections.ts");let reads=0;
 expect(resolveLearningConnection({selected:"@murage/flux-fast",instances:[],readKey:()=>++reads===1?"fixture":null,defaultOn:false})).toMatchObject({source:"none",extractor:null,reason:expect.any(String)});
});
it("excludes provider Flux and de-duplicates the legacy compatible engine",async()=>{
 const {ProviderConnectionsService}=await import("../provider-connections.ts");const {resolveLearningConnection}=await import("./extractor-connections.ts");
 const {mkdtempSync,rmSync}=await import("node:fs"),{tmpdir}=await import("node:os"),{join}=await import("node:path");const root=mkdtempSync(join(tmpdir(),"learning-choices-"));
 const service=new ProviderConnectionsService({readBank:()=>JSON.stringify([{id:"bank-flux",preset:"flux",label:"Flux bank",enabled:true,key:"sk-flux-fixture-key",revision:"r"}]),cacheDir:root,legacyConnections:()=>[{id:"legacy-openai-compatible",preset:"openai",label:"Existing key",enabled:true,key:"fixture-key",revision:"r",legacy:true,managedIn:"engines"}],fetch:async()=>new Response(JSON.stringify({data:[{id:"gpt-4",output_modalities:["text"]}]}))});
 try{
 await service.refresh("bank-flux");await service.refresh("legacy-openai-compatible");
 const instance={instanceId:"compatible",driverKind:"openai-compat",displayName:"Existing key",enabled:true,extractMemory:async()=>"[]"} as unknown as ProviderInstance;
 const choices=memoryExtractorConnections([instance],null,service);expect(choices.some(c=>c.instanceId==="provider:bank-flux")).toBe(false);
 expect(choices.filter(c=>c.eligible)).toHaveLength(1);expect(resolveLearningConnection({selected:null,instances:[instance],providerConnections:service,readKey:()=>null,defaultOn:false}).suggestion?.instanceId).toBe("compatible");
 }finally{rmSync(root,{recursive:true,force:true});}
});

it.each(["default","chosen","instance"])("forwards the reserved grounding maximum through %s",async kind=>{
 const {resolveLearningConnection}=await import("./extractor-connections.ts");
 const groundMemory=vi.fn(async()=>'{"supported":true}');
 const instances=[{instanceId:"fixture",enabled:true,displayName:"Fixture",extractMemory:async()=>"[]",groundMemory}] as unknown as ProviderInstance[];
 const fetcher=vi.fn(async()=>new Response(JSON.stringify({choices:[{message:{content:'{"supported":true}'}}]})));vi.stubGlobal("fetch",fetcher);
 const connection=resolveLearningConnection({selected:kind==="default"?null:kind==="instance"?"fixture":"@murage/flux-fast",instances,readKey:()=>"fixture-key",defaultOn:false});
 const input={text:"tea",quote:"tea",claimType:"owner-statement" as const,speaker:"owner",outcome:"recorded"};
 await connection.extractor!.ground!(input,8,new AbortController().signal);
 if(kind==="instance")expect(groundMemory).toHaveBeenCalledWith(input,8,expect.any(AbortSignal));
 else expect(JSON.parse(String((fetcher.mock.calls[0] as unknown as [URL,RequestInit])[1].body)).max_tokens).toBe(8);
});

it.each(["flux","instance"])("caps legacy %s grounding at the reserved maximum",async kind=>{
 const groundMemory=vi.fn(async()=>'{"supported":true}');
 const instance={instanceId:"fixture",enabled:true,extractMemory:async()=>"[]",groundMemory} as unknown as ProviderInstance;
 const fetcher=vi.fn(async()=>new Response(JSON.stringify({choices:[{message:{content:'{"supported":true}'}}]})));vi.stubGlobal("fetch",fetcher);
 const extractor=resolveMemoryExtractor(kind==="flux"?"@murage/flux-fast":"fixture",[instance],()=>"fixture-key")!;
 const input={text:"tea",quote:"tea",claimType:"owner-statement" as const,speaker:"owner",outcome:"recorded"};
 for(const maximum of [8,500]){
  await extractor.ground!(input,maximum,new AbortController().signal);
  if(kind==="instance")expect(groundMemory).toHaveBeenLastCalledWith(input,Math.min(64,maximum),expect.any(AbortSignal));
  else expect(JSON.parse(String((fetcher.mock.calls.at(-1) as unknown as [URL,RequestInit])[1].body)).max_tokens).toBe(Math.min(64,maximum));
 }
});
