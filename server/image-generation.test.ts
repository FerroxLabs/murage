import { expect, it, vi } from "vitest";
import { ImageGenerationService, assertCredentialOrigin, parseOpenRouterImageCatalog, type ImageConnection, type ImageProvider } from "./image-generation.ts";
const PNG="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const image=()=>new Response(JSON.stringify({model:"reported-image-model",data:[{b64_json:PNG}],usage:{input_tokens:12,output_tokens:23,cost:0.04}}));
const parameters={output_format:{type:"enum",values:["png","webp"]},quality:{type:"enum",values:["low","medium","high"]},size:{type:"enum",values:["1024x1024"]}};
function fixture(provider:ImageProvider="openai",apiKey="FAKE_CREDENTIAL_CANARY") {
 let connection:ImageConnection|null={id:provider,provider,apiKey,revision:"initial"};
 const fetcher=vi.fn<typeof fetch>(async input=>String(input).endsWith("/images/models")?new Response(JSON.stringify({data:[{id:"openai/gpt-image-2",name:"GPT Image 2",architecture:{output_modalities:["image"]},supported_parameters:parameters}]})):String(input).endsWith("/endpoints")?new Response(JSON.stringify({endpoints:[{provider_tag:"openai",supported_parameters:parameters}]})):image());
 const service=new ImageGenerationService({resolveConnection:id=>id===provider?connection:null,connectionIds:()=>[provider],fetch:fetcher});
 const finish=vi.fn(async()=>{}),publish=vi.fn(async()=>({id:"owned-artifact"})),assertActive=vi.fn(()=>{});
 const reserve=vi.fn(async()=>({finish}));const hooks={assertActive,reserve,publish};
 return{service,fetcher,finish,publish,assertActive,reserve,hooks,request:{connectionId:provider,prompt:"A watercolor mountain"},setConnection:(next:ImageConnection|null)=>{connection=next;}};
}
it("lists connections and defaults without revealing credentials or probing paid endpoints",()=>{
 const f=fixture();expect(f.service.listConnections()).toEqual([{id:"openai",provider:"openai",defaultModel:"gpt-image-2"}]);expect(JSON.stringify(f.service.listConnections())).not.toContain("CANARY");expect(f.fetcher).not.toHaveBeenCalled();
});
it("posts one OpenAI GPT Image 2 generation after reservation and returns decoded artifact metadata",async()=>{
 const f=fixture();const result=await f.service.generate(f.request,f.hooks);
 expect(f.fetcher).toHaveBeenCalledOnce();const[url,init]=f.fetcher.mock.calls[0]!;expect(url).toBe("https://api.openai.com/v1/images/generations");expect(init?.redirect).toBe("error");
 expect(JSON.parse(String(init?.body))).toEqual({model:"gpt-image-2",prompt:f.request.prompt,n:1,quality:"medium",size:"1024x1024",output_format:"png"});
 expect(f.reserve.mock.invocationCallOrder[0]).toBeLessThan(f.fetcher.mock.invocationCallOrder[0]!);
 expect(f.publish.mock.calls[0]).toEqual([expect.objectContaining({mime:"image/png",bytes:Buffer.from(PNG,"base64")}),expect.objectContaining({model:"gpt-image-2",reportedModel:"reported-image-model",usage:{inputTokens:12,outputTokens:23,costUsd:0.04}})]);
 expect(f.finish).toHaveBeenCalledWith("published");expect(result.artifact.id).toBe("owned-artifact");
});
it("uses multipart OpenAI edits containing every approved reference and never sends input_fidelity",async()=>{
 const f=fixture();const references=[{bytes:Buffer.from(PNG,"base64"),mime:"image/png" as const},{bytes:Buffer.from(PNG,"base64"),mime:"image/png" as const}];
 await f.service.generate({...f.request,operation:"edit"},f.hooks,references);
 const[url,init]=f.fetcher.mock.calls[0]!;expect(url).toBe("https://api.openai.com/v1/images/edits");expect(init?.body).toBeInstanceOf(FormData);
 const form=init!.body as FormData;expect(form.getAll("image[]")).toHaveLength(2);expect(form.get("model")).toBe("gpt-image-2");expect(form.has("input_fidelity")).toBe(false);expect(form.has("response_format")).toBe(false);
 expect(init?.headers).not.toHaveProperty("content-type");
});
it("uses the explicit Flux GPT2 alias without downgrading to GPT1.5 or forwarding unsupported edits",async()=>{
 const f=fixture("flux");await f.service.generate(f.request,f.hooks);expect(JSON.parse(String(f.fetcher.mock.calls[0]![1]?.body))).toMatchObject({model:"flux-image-gpt2",size:"1024x1024",response_format:"b64_json"});
 const edit=fixture("flux");await expect(edit.service.generate({...edit.request,operation:"edit"},edit.hooks,[{bytes:Buffer.from(PNG,"base64"),mime:"image/png"}])).rejects.toThrow("Editing is not supported");expect(edit.fetcher).not.toHaveBeenCalled();expect(edit.reserve).not.toHaveBeenCalled();
});
it("requires explicit Imagine selection for xAI rather than silently substituting for GPT2",async()=>{
 const f=fixture("xai");await expect(f.service.generate(f.request,f.hooks)).rejects.toThrow("Explicitly choose");expect(f.fetcher).not.toHaveBeenCalled();
 await f.service.generate({...f.request,model:"grok-imagine-image-2.0"},f.hooks);expect(JSON.parse(String(f.fetcher.mock.calls[0]![1]?.body))).toEqual({model:"grok-imagine-image-2.0",prompt:f.request.prompt,n:1,quality:"low",response_format:"b64_json"});
});
it("discovers OpenRouter raster models and pins a compatible endpoint without fallback",async()=>{
 const f=fixture("openrouter");await f.service.generate(f.request,f.hooks);
 expect(f.fetcher.mock.calls.map(call=>call[0])).toEqual(["https://openrouter.ai/api/v1/images/models","https://openrouter.ai/api/v1/images/models/openai/gpt-image-2/endpoints","https://openrouter.ai/api/v1/images"]);
 expect(f.fetcher.mock.calls[0]![1]?.headers).toBeUndefined();expect(f.fetcher.mock.calls[1]![1]?.headers).toBeUndefined();
 expect(JSON.parse(String(f.fetcher.mock.calls[2]![1]?.body))).toEqual({model:"openai/gpt-image-2",prompt:f.request.prompt,n:1,output_format:"png",provider:{only:["openai"],allow_fallbacks:false}});
});
it("marks vector-only and unknown-format OpenRouter models unavailable and excludes untrusted model paths",()=>{
 const rows=parseOpenRouterImageCatalog({data:[
 {id:"recraft/vector",architecture:{output_modalities:["image"]},supported_parameters:{output_format:{values:["svg"]}}},
 {id:"vendor/unknown",architecture:{output_modalities:["image"]}},
 {id:"video/model",architecture:{output_modalities:["image","video"]},supported_parameters:parameters},
 {id:"../../evil",architecture:{output_modalities:["image"]},supported_parameters:parameters},
 {id:"chat/text",architecture:{output_modalities:["text"]},supported_parameters:parameters}]});
 expect(rows).toHaveLength(3);expect(rows.every(row=>!row.generate&&!row.edit)).toBe(true);
});
it("refuses OpenRouter execution when endpoint-specific parameters do not match the selected request",async()=>{
 const f=fixture("openrouter");f.fetcher.mockImplementationOnce(async()=>new Response(JSON.stringify({data:[{id:"vendor/model",architecture:{output_modalities:["image"]},supported_parameters:parameters}]}))).mockImplementationOnce(async()=>new Response(JSON.stringify({endpoints:[{provider_tag:"vendor",supported_parameters:{output_format:{values:["svg"]}}}]})));
 await expect(f.service.generate({...f.request,model:"vendor/model"},f.hooks)).rejects.toThrow("No verified raster endpoint");expect(f.reserve).not.toHaveBeenCalled();expect(f.fetcher.mock.calls.every(call=>call[1]?.method!=="POST")).toBe(true);
});
it("rejects model/URL/key overrides and excessive prompts before permission or HTTP",async()=>{
 for(const extra of [{url:"https://untrusted.invalid"},{apiKey:"other"},{n:2},{prompt:"a".repeat(4001)},{model:"unknown-image-model"}]){const f=fixture();await expect(f.service.generate({...f.request,...extra},f.hooks)).rejects.toThrow();expect(f.fetcher).not.toHaveBeenCalled();expect(f.reserve).not.toHaveBeenCalled();}
});
it("rejects missing, excessive, mismatched and ignored references before billing",async()=>{
 const cases=[{operation:"edit",refs:[]},{operation:"generate",refs:[{bytes:Buffer.from(PNG,"base64"),mime:"image/png"}]},{operation:"edit",refs:Array(5).fill({bytes:Buffer.from(PNG,"base64"),mime:"image/png"})},{operation:"edit",refs:[{bytes:Buffer.from(PNG,"base64"),mime:"image/jpeg"}]}];
 for(const test of cases){const f=fixture();await expect(f.service.generate({...f.request,operation:test.operation},f.hooks,test.refs as any)).rejects.toThrow();expect(f.fetcher).not.toHaveBeenCalled();expect(f.reserve).not.toHaveBeenCalled();}
});
it("does not dispatch when owner permission is denied",async()=>{
 const f=fixture();f.reserve.mockRejectedValueOnce(new Error("denied"));await expect(f.service.generate(f.request,f.hooks)).rejects.toMatchObject({code:"permission-denied",outcome:"not-dispatched"});expect(f.fetcher).not.toHaveBeenCalled();
});
it("revalidates authorization and connection revision after awaited reservation",async()=>{
 const f=fixture();f.reserve.mockImplementationOnce(async()=>{f.setConnection({id:"openai",provider:"openai",apiKey:"CHANGED",revision:"new"});return{finish:f.finish};});
 await expect(f.service.generate(f.request,f.hooks)).rejects.toMatchObject({code:"connection-changed",outcome:"not-dispatched"});expect(f.fetcher).not.toHaveBeenCalled();expect(f.finish).toHaveBeenCalledWith("not-dispatched");
});
it("rejects revoked/cancelled authority before any network and checks again before publish",async()=>{
 const f=fixture();f.assertActive.mockImplementation(()=>{throw Error("revoked");});await expect(f.service.generate(f.request,f.hooks)).rejects.toMatchObject({code:"not-authorized"});expect(f.fetcher).not.toHaveBeenCalled();
 const cancelled=fixture(),controller=new AbortController();controller.abort();await expect(cancelled.service.generate(cancelled.request,{...cancelled.hooks,signal:controller.signal})).rejects.toMatchObject({code:"cancelled"});expect(cancelled.fetcher).not.toHaveBeenCalled();
 const after=fixture();after.fetcher.mockImplementationOnce(async()=>{after.assertActive.mockImplementation(()=>{throw Error("revoked after generation");});return image();});
 await expect(after.service.generate(after.request,after.hooks)).rejects.toMatchObject({code:"not-authorized",outcome:"uncertain"});expect(after.publish).not.toHaveBeenCalled();expect(after.finish).toHaveBeenCalledWith("uncertain");
});
it("never retries or falls back on a rejected or uncertain provider attempt and hides private error text",async()=>{
 for(const status of [401,429,503]){const f=fixture();f.fetcher.mockResolvedValueOnce(new Response("FAKE_CREDENTIAL_CANARY",{status}));await expect(f.service.generate(f.request,f.hooks)).rejects.toThrow("No fallback");expect(f.fetcher).toHaveBeenCalledOnce();expect(f.publish).not.toHaveBeenCalled();expect(f.finish).toHaveBeenCalledWith(status<500?"failed":"uncertain");}
 const f=fixture();f.fetcher.mockRejectedValueOnce(new Error("FAKE_CREDENTIAL_CANARY"));await expect(f.service.generate(f.request,f.hooks)).rejects.not.toThrow("CANARY");expect(f.fetcher).toHaveBeenCalledOnce();expect(f.finish).toHaveBeenCalledWith("uncertain");
});
it("rejects oversized response, invalid raster, URL-only output and extra images without publishing",async()=>{
 const responses=[()=>new Response("{}",{headers:{"content-length":String(16*1024*1024)}}),()=>new Response(JSON.stringify({data:[{b64_json:Buffer.from("<svg/>").toString("base64") }]})),()=>new Response(JSON.stringify({data:[{url:"https://untrusted.invalid/image.png"}]})),()=>new Response(JSON.stringify({data:[{b64_json:PNG},{b64_json:PNG}]}))];
 for(const response of responses){const f=fixture();f.fetcher.mockResolvedValueOnce(response());await expect(f.service.generate(f.request,f.hooks)).rejects.toThrow();expect(f.publish).not.toHaveBeenCalled();expect(f.finish).toHaveBeenCalledWith("uncertain");expect(f.fetcher).toHaveBeenCalledOnce();}
});
it("retains uncertain reservation if artifact publication fails, and sanitizes receipt failures",async()=>{
 const f=fixture();f.publish.mockRejectedValueOnce(new Error("PRIVATE_PATH"));await expect(f.service.generate(f.request,f.hooks)).rejects.toMatchObject({outcome:"uncertain"});expect(f.finish).toHaveBeenCalledWith("uncertain");
 const receipt=fixture();receipt.finish.mockRejectedValueOnce(new Error("PRIVATE_CREDENTIAL"));await expect(receipt.service.generate(receipt.request,receipt.hooks)).rejects.toMatchObject({code:"receipt-failed",outcome:"published"});expect(receipt.fetcher).toHaveBeenCalledOnce();
});
it("propagates cancellation to an in-flight provider request without retry or publication",async()=>{
 const f=fixture(),controller=new AbortController();
 f.fetcher.mockImplementationOnce(async(_input,init)=>new Promise((_resolve,reject)=>init!.signal!.addEventListener("abort",()=>reject(new Error("aborted")),{once:true})));
 const pending=f.service.generate(f.request,{...f.hooks,signal:controller.signal});
 await vi.waitFor(()=>expect(f.fetcher).toHaveBeenCalledOnce());controller.abort();
 await expect(pending).rejects.toMatchObject({outcome:"uncertain"});expect(f.publish).not.toHaveBeenCalled();expect(f.finish).toHaveBeenCalledWith("uncertain");
});
it("enforces streamed response and reference byte limits without trusting content length",async()=>{
 const f=fixture();f.fetcher.mockResolvedValueOnce(new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(15*1024*1024+1));controller.close();}})));
 await expect(f.service.generate(f.request,f.hooks)).rejects.toMatchObject({code:"oversized-response"});expect(f.publish).not.toHaveBeenCalled();
 const reference=fixture();await expect(reference.service.generate({...reference.request,operation:"edit"},reference.hooks,[{bytes:Buffer.alloc(10*1024*1024+1),mime:"image/png"}])).rejects.toThrow("bounded PNG");expect(reference.fetcher).not.toHaveBeenCalled();
});

// ── F1: per-provider reference edits ─────────────────────────────────────
// A second, byte-distinct 1x1 PNG so exact-byte assertions cannot pass by accident.
const PNG_B="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=";
const ref=(b64:string)=>({bytes:Buffer.from(b64,"base64"),mime:"image/png" as const});
const dataUrl=(b64:string)=>`data:image/png;base64,${b64}`;
const CANARY:Record<ImageProvider,string>={openai:"FAKE_OPENAI_CANARY",xai:"FAKE_XAI_CANARY",openrouter:"FAKE_OPENROUTER_CANARY",flux:"FAKE_FLUX_CANARY"};
const ORIGIN:Record<ImageProvider,string>={openai:"https://api.openai.com",xai:"https://api.x.ai",openrouter:"https://openrouter.ai",flux:"https://api.fluxrouter.ai"};
// Shape of the observed public record: no output_format key, a reference range.
const gpt2Endpoint={quality:parameters.quality,input_references:{type:"range",min:0,max:16},n:{type:"range",min:1,max:10}};
/** Fails the call unless a key goes only to its own provider origin and catalog reads carry none. */
function strict(provider:ImageProvider,endpoints:unknown={endpoints:[{provider_tag:"openai",supported_parameters:gpt2Endpoint}]}){
 const f=fixture(provider,CANARY[provider]);
 f.fetcher.mockImplementation(async(input,init)=>{
  const url=new URL(String(input)),auth=new Headers(init?.headers).get("authorization");
  if(init?.method==="POST"){if(url.origin!==ORIGIN[provider]||auth!==`Bearer ${CANARY[provider]}`)throw new Error("credential sent to the wrong origin");return image();}
  if(auth!==null)throw new Error("catalog read carried a credential");
  if(url.href==="https://openrouter.ai/api/v1/images/models")return new Response(JSON.stringify({data:[{id:"openai/gpt-image-2",name:"GPT Image 2",architecture:{output_modalities:["image"]},supported_parameters:{quality:parameters.quality}}]}));
  if(url.href==="https://openrouter.ai/api/v1/images/models/openai/gpt-image-2/endpoints")return new Response(JSON.stringify(endpoints));
  throw new Error(`unexpected fetch ${url.href}`);
 });
 const posts=()=>f.fetcher.mock.calls.filter(call=>call[1]?.method==="POST");
 return{...f,posts};
}
const xaiEdit={connectionId:"xai",model:"grok-imagine-image-2.0",prompt:"Edit the fixture",operation:"edit" as const};
const openRouterEdit={connectionId:"openrouter",prompt:"Edit the fixture",operation:"edit" as const};

it("F1-T1 routes each provider's edit to its own origin and credential, never the OpenAI transport",async()=>{
 for(const provider of ["openai","xai","openrouter"] as const){
  const f=strict(provider);
  await f.service.generate({connectionId:provider,prompt:"Edit the fixture",operation:"edit",...(provider==="xai"?{model:"grok-imagine-image-2.0"}:{})},f.hooks,[ref(PNG)]);
  expect(f.posts()).toHaveLength(1);const[url,init]=f.posts()[0]!;
  expect(new URL(String(url)).origin).toBe(ORIGIN[provider]);expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${CANARY[provider]}`);
  expect(init?.redirect).toBe("error");
  if(provider==="openai"){expect(url).toBe("https://api.openai.com/v1/images/edits");expect(init?.body).toBeInstanceOf(FormData);}
  else{expect(String(url)).not.toContain("api.openai.com");expect(typeof init?.body).toBe("string");expect(new Headers(init?.headers).get("content-type")).toBe("application/json");}
  expect(JSON.stringify(f.reserve.mock.calls)).not.toContain(CANARY[provider]);expect(JSON.stringify((f.publish.mock.calls[0] as unknown[])[1])).not.toContain(CANARY[provider]);
 }
});
it("F1-T1 refuses a key for any URL outside its provider's exact https origin",()=>{
 expect(()=>assertCredentialOrigin("xai","https://api.x.ai/v1/images/edits")).not.toThrow();
 for(const[provider,url] of [["xai","https://api.openai.com/v1/images/edits"],["openrouter","https://api.openai.com/v1/images/edits"],["openai","https://api.openai.com.evil.test/v1/images/edits"],["openai","http://api.openai.com/v1/images/edits"],["xai","https://user:pass@api.x.ai/v1/images/edits"],["flux","https://api.openai.com/v1/images/edits"],["openai","not a url"]] as const)
  expect(()=>assertCredentialOrigin(provider,url)).toThrow(expect.objectContaining({code:"credential-origin-mismatch"}));
});
it("F1-T1 publishes bounded reference capability fields per model; Flux stays generation-only",async()=>{
 const openai=(await fixture("openai").service.getCatalog("openai")).models;expect(openai.every(model=>model.edit&&model.maxReferences===4)).toBe(true);
 const flux=(await fixture("flux").service.getCatalog("flux")).models;expect(flux.every(model=>model.generate&&!model.edit&&model.maxReferences===0&&/generation only/.test(model.editUnavailableReason??""))).toBe(true);
 expect((await fixture("xai").service.getCatalog("xai")).models).toEqual([expect.objectContaining({id:"grok-imagine-image-2.0",generate:true,edit:true,maxReferences:4,editQualities:[]})]);
 const f=fixture("flux");await expect(f.service.generate({connectionId:"flux",prompt:"Edit",operation:"edit"},f.hooks,[ref(PNG)])).rejects.toMatchObject({code:"unsupported-edit",message:expect.stringContaining("generation only")});expect(f.fetcher).not.toHaveBeenCalled();expect(f.reserve).not.toHaveBeenCalled();
});
it("F1-T2 sends xAI JSON edits: image for one input, images for two to four, exact bytes, b64_json and no quality",async()=>{
 const one=strict("xai");await one.service.generate(xaiEdit,one.hooks,[ref(PNG)]);
 expect(one.posts()[0]![0]).toBe("https://api.x.ai/v1/images/edits");
 expect(JSON.parse(String(one.posts()[0]![1]?.body))).toEqual({model:"grok-imagine-image-2.0",prompt:"Edit the fixture",n:1,response_format:"b64_json",image:{type:"image_url",url:dataUrl(PNG)}});
 expect((one.reserve.mock.calls[0] as unknown[])[0]).toEqual({connectionId:"xai",provider:"xai",model:"grok-imagine-image-2.0",operation:"edit",count:1,referenceCount:1});
 const inputs=[PNG,PNG_B,PNG_B,PNG];
 for(const count of [2,4]){
  const many=strict("xai");await many.service.generate(xaiEdit,many.hooks,inputs.slice(0,count).map(ref));
  const body=JSON.parse(String(many.posts()[0]![1]?.body));
  expect(body).not.toHaveProperty("image");expect(body).not.toHaveProperty("quality");expect(body.response_format).toBe("b64_json");expect(body.n).toBe(1);
  expect(body.images).toHaveLength(count);
  body.images.forEach((item:any,index:number)=>{expect(item.type).toBe("image_url");expect(Buffer.from(item.url.slice("data:image/png;base64,".length),"base64")).toEqual(Buffer.from(inputs[index]!,"base64"));});
 }
 const five=strict("xai");await expect(five.service.generate(xaiEdit,five.hooks,[...inputs,PNG].map(ref))).rejects.toMatchObject({code:"invalid-references"});expect(five.fetcher).not.toHaveBeenCalled();
});
it("F1-T2 rejects an explicit xAI edit quality before reservation and URL-only or missing b64 results without publishing",async()=>{
 const quality=strict("xai");await expect(quality.service.generate({...xaiEdit,quality:"low"},quality.hooks,[ref(PNG)])).rejects.toMatchObject({code:"unsupported-quality"});expect(quality.fetcher).not.toHaveBeenCalled();expect(quality.reserve).not.toHaveBeenCalled();
 for(const payload of [{data:[{url:"https://untrusted.invalid/edited.png"}]},{data:[{}]},{data:[{b64_json:null,url:"https://untrusted.invalid/x.png"}]}]){
  const f=strict("xai");f.fetcher.mockImplementationOnce(async()=>new Response(JSON.stringify(payload)));
  await expect(f.service.generate(xaiEdit,f.hooks,[ref(PNG)])).rejects.toMatchObject({code:"invalid-image",outcome:"uncertain"});
  expect(f.publish).not.toHaveBeenCalled();expect(f.finish).toHaveBeenCalledWith("uncertain");expect(f.posts()).toHaveLength(1);
 }
});
it("F1-T3 pins the openai endpoint for OpenRouter input_references, refreshes it just before approval and records endpointTag",async()=>{
 const timeouts=vi.spyOn(AbortSignal,"timeout");let endpointTimeout:unknown;
 const f=strict("openrouter");const inner=f.fetcher.getMockImplementation()!;
 f.fetcher.mockImplementation(async(input,init)=>{if(String(input).endsWith("/endpoints"))endpointTimeout=timeouts.mock.calls.at(-1)?.[0];return inner(input,init);});
 try{
  const result=await f.service.generate(openRouterEdit,f.hooks,[ref(PNG),ref(PNG_B)]);
  expect(f.fetcher.mock.calls.map(call=>call[0])).toEqual(["https://openrouter.ai/api/v1/images/models","https://openrouter.ai/api/v1/images/models/openai/gpt-image-2/endpoints","https://openrouter.ai/api/v1/images"]);
  expect(endpointTimeout).toBe(15_000);
  expect(f.fetcher.mock.invocationCallOrder[1]).toBeLessThan(f.reserve.mock.invocationCallOrder[0]!);expect(f.reserve.mock.invocationCallOrder[0]).toBeLessThan(f.fetcher.mock.invocationCallOrder[2]!);
  expect(JSON.parse(String(f.posts()[0]![1]?.body))).toEqual({model:"openai/gpt-image-2",prompt:"Edit the fixture",n:1,output_format:"png",provider:{only:["openai"],allow_fallbacks:false},
   input_references:[{type:"image_url",image_url:{url:dataUrl(PNG)}},{type:"image_url",image_url:{url:dataUrl(PNG_B)}}]});
  expect((f.reserve.mock.calls[0] as unknown[])[0]).toMatchObject({provider:"openrouter",operation:"edit",referenceCount:2,endpointTag:"openai"});
  expect(result.metadata).toMatchObject({endpointTag:"openai",upstreamProvider:"openai"});
 }finally{timeouts.mockRestore();}
});
it("F1-T3 fails closed before approval when the pinned endpoint record is absent, malformed, incompatible, narrower or unreachable",async()=>{
 const range=(input_references:unknown,extra:Record<string,unknown>={})=>({endpoints:[{provider_tag:"openai",supported_parameters:{...extra,input_references}}]});
 const records:unknown[]=[
  {endpoints:[{provider_tag:"openai",supported_parameters:{quality:parameters.quality}}]},
  range({type:"enum",values:["1"]}),range({type:"range",min:"0",max:16}),range({type:"range",min:0,max:0}),range({type:"range",min:3,max:2}),range({type:"range",min:5,max:16}),
  {endpoints:[{provider_tag:"vendor-fallback",supported_parameters:gpt2Endpoint}]},
  range({type:"range",min:0,max:16},{output_format:{values:["svg"]}}),
  {endpoints:"not a list"},{},
 ];
 for(const endpoints of records){const f=strict("openrouter",endpoints);await expect(f.service.generate(openRouterEdit,f.hooks,[ref(PNG)])).rejects.toMatchObject({code:"unsupported-edit",outcome:"not-dispatched"});expect(f.reserve).not.toHaveBeenCalled();expect(f.posts()).toHaveLength(0);}
 const narrow=strict("openrouter",range({type:"range",min:0,max:1}));await expect(narrow.service.generate(openRouterEdit,narrow.hooks,[ref(PNG),ref(PNG_B)])).rejects.toMatchObject({code:"invalid-references"});expect(narrow.reserve).not.toHaveBeenCalled();expect(narrow.posts()).toHaveLength(0);
 for(const failure of [async()=>new Response("unavailable",{status:503}),async()=>{throw new Error("The operation was aborted due to timeout");}]){
  const f=strict("openrouter");const inner=f.fetcher.getMockImplementation()!;f.fetcher.mockImplementation(async(input,init)=>String(input).endsWith("/endpoints")?failure():inner(input,init));
  await expect(f.service.generate(openRouterEdit,f.hooks,[ref(PNG)])).rejects.toMatchObject({code:"catalog-unavailable",outcome:"not-dispatched"});expect(f.reserve).not.toHaveBeenCalled();expect(f.posts()).toHaveLength(0);
 }
 const other=strict("openrouter");other.fetcher.mockImplementationOnce(async()=>new Response(JSON.stringify({data:[{id:"vendor/model",architecture:{output_modalities:["image"]},supported_parameters:parameters}]})));
 await expect(other.service.generate({...openRouterEdit,model:"vendor/model"},other.hooks,[ref(PNG)])).rejects.toMatchObject({code:"unsupported-edit"});expect(other.fetcher).toHaveBeenCalledOnce();expect(other.reserve).not.toHaveBeenCalled();
});
it("F1-T3 catalog shows OpenRouter GPT2 editing only after the pinned endpoint check and keeps generation when the check fails",async()=>{
 const ok=strict("openrouter");const models=(await ok.service.getCatalog("openrouter")).models;
 expect(models).toEqual([expect.objectContaining({id:"openai/gpt-image-2",generate:true,edit:true,maxReferences:4})]);expect(models[0]).not.toHaveProperty("editUnavailableReason");
 const lower=strict("openrouter",{endpoints:[{provider_tag:"openai",supported_parameters:{...gpt2Endpoint,input_references:{type:"range",min:0,max:2}}}]});expect((await lower.service.getCatalog("openrouter")).models[0]).toMatchObject({edit:true,maxReferences:2});
 const down=strict("openrouter");const inner=down.fetcher.getMockImplementation()!;down.fetcher.mockImplementation(async(input,init)=>String(input).endsWith("/endpoints")?new Response("no",{status:500}):inner(input,init));
 expect((await down.service.getCatalog("openrouter")).models[0]).toMatchObject({generate:true,edit:false,maxReferences:0,editUnavailableReason:expect.stringContaining("could not be verified")});
 const f=strict("openrouter");await f.service.generate({connectionId:"openrouter",prompt:"A watercolor mountain"},f.hooks);
 expect(f.fetcher.mock.calls.filter(call=>String(call[0]).endsWith("/endpoints"))).toHaveLength(1);
});
it("F1 xAI and OpenRouter edits keep denial, connection-change and single-attempt behavior",async()=>{
 for(const[provider,request] of [["xai",xaiEdit],["openrouter",openRouterEdit]] as const){
  const denied=strict(provider);denied.reserve.mockRejectedValueOnce(new Error("denied"));await expect(denied.service.generate(request,denied.hooks,[ref(PNG)])).rejects.toMatchObject({code:"permission-denied",outcome:"not-dispatched"});expect(denied.posts()).toHaveLength(0);
  const changed=strict(provider);changed.reserve.mockImplementationOnce(async()=>{changed.setConnection({id:provider,provider,apiKey:"ROTATED",revision:"next"});return{finish:changed.finish};});
  await expect(changed.service.generate(request,changed.hooks,[ref(PNG)])).rejects.toMatchObject({code:"connection-changed"});expect(changed.posts()).toHaveLength(0);
  for(const status of [401,429,503]){const f=strict(provider);const inner=f.fetcher.getMockImplementation()!;f.fetcher.mockImplementation(async(input,init)=>init?.method==="POST"?new Response(CANARY[provider],{status}):inner(input,init));
   await expect(f.service.generate(request,f.hooks,[ref(PNG)])).rejects.toThrow("No fallback");expect(f.posts()).toHaveLength(1);expect(f.publish).not.toHaveBeenCalled();expect(f.finish).toHaveBeenCalledWith(status<500?"failed":"uncertain");}
 }
});
