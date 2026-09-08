import { expect, it, vi } from "vitest";
import { ImageGenerationService, parseOpenRouterImageCatalog, type ImageConnection, type ImageProvider } from "./image-generation.ts";
const PNG="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const image=()=>new Response(JSON.stringify({model:"reported-image-model",data:[{b64_json:PNG}],usage:{input_tokens:12,output_tokens:23,cost:0.04}}));
const parameters={output_format:{type:"enum",values:["png","webp"]},quality:{type:"enum",values:["low","medium","high"]},size:{type:"enum",values:["1024x1024"]}};
function fixture(provider:ImageProvider="openai") {
 let connection:ImageConnection|null={id:provider,provider,apiKey:"FAKE_CREDENTIAL_CANARY",revision:"initial"};
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
