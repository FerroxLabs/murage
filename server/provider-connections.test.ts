import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { PROVIDER_PRESETS, mutateProviderBank, parseProviderBank } from "../electron/provider-connections.mjs";
import { normalizeProviderModels, ProviderConnectionsService } from "./provider-connections.ts";
import { parseConfigPatch, stripWorkspaceCredentialEnv } from "./config.ts";
import type { ProviderPreset } from "../shared/provider-connections.ts";
const roots:string[]=[];afterEach(()=>{roots.splice(0).forEach(root=>rmSync(root,{recursive:true,force:true}));});
function fixture(preset:ProviderPreset="openai",now?:()=>number) {
 const cacheDir=mkdtempSync(join(tmpdir(),"provider-catalog-"));roots.push(cacheDir);let sequence=0;
 let bank=JSON.stringify(mutateProviderBank("[]",{action:"create",preset,key:"fixture-key-private"},()=>`record-${++sequence}`));
 const fetcher=vi.fn<typeof fetch>(async()=>new Response(JSON.stringify({data:[{id:preset==="anthropic"?"claude-sonnet-test":"gpt-5-test",name:"Fixture model"}]})));
 const make=()=>new ProviderConnectionsService({readBank:()=>bank,cacheDir,fetch:fetcher,now});const service=make();const id=parseProviderBank(bank)[0]!.id;
 return{cacheDir,service,fetcher,id,make,bank:()=>bank,setBank:(next:string)=>{bank=next;},mutate:async(input:unknown)=>{const before=bank;bank=JSON.stringify(mutateProviderBank(bank,input,()=>`record-${++sequence}`));await service.changed(before,bank);}};
}
it("binds eight presets to fixed issuer endpoints, never arbitrary caller URLs",()=>{
 expect(Object.keys(PROVIDER_PRESETS)).toHaveLength(8);
 expect(()=>mutateProviderBank("[]",{action:"create",preset:"openai",key:"sk-proj-fixture-key-private",url:"https://untrusted.invalid"},()=>"fixture")).toThrow("Only a provider");
 expect(()=>mutateProviderBank("[]",{action:"create",preset:"openrouter",key:"sk-proj-fixture-key-private"},()=>"fixture")).toThrow("different provider");
 expect(()=>mutateProviderBank("[]",{action:"create",preset:"openai",key:"sk-admin-fixture-key-private"},()=>"fixture")).toThrow("inference API key");
});
it("keeps distinct named accounts and excludes every key from public snapshots",async()=>{
 const f=fixture();await f.mutate({action:"create",preset:"openai",label:"Second account",key:"another-fixture-private-key"});expect(f.service.list()).toHaveLength(2);
 expect(f.service.list()[0]!.id).not.toBe(f.service.list()[1]!.id);expect(JSON.stringify(f.service.list())).not.toContain("private");expect(f.fetcher).not.toHaveBeenCalled();
});
it("requires current revisions, retains native labels and notifies only changed security routes",async()=>{
 const f=fixture(),first=f.service.list()[0]!,listener=vi.fn();f.service.subscribe(listener);
 await f.mutate({action:"update",id:f.id,revision:first.revision,label:"New account label"});expect(f.service.resolve(f.id)?.label).toBe("New account label");expect(f.service.list()[0]!.revision).toBe(first.revision);expect(listener).toHaveBeenLastCalledWith([]);
 await f.mutate({action:"update",id:f.id,revision:first.revision,key:"replacement-private-key"});expect(f.service.isCurrent(f.id,first.revision)).toBe(false);expect(listener).toHaveBeenLastCalledWith([f.id]);
 await expect(f.mutate({action:"remove",id:f.id,revision:first.revision})).rejects.toThrow("changed");
});
it("reads scoped catalog metadata only from the chosen provider with bounded no-redirect requests",async()=>{
 for(const preset of Object.keys(PROVIDER_PRESETS) as ProviderPreset[]){const f=fixture(preset);await f.service.refresh(f.id);expect(f.fetcher.mock.calls[0]![0]).toBe(PROVIDER_PRESETS[preset].catalogUrl);expect(f.fetcher.mock.calls[0]![1]?.redirect).toBe("error");expect(f.fetcher.mock.calls[0]![1]?.method).toBeUndefined();expect(f.fetcher).toHaveBeenCalledOnce();}
});
it("uses Anthropic auth and safe bounded cursor pagination",async()=>{
 const f=fixture("anthropic");f.fetcher.mockResolvedValueOnce(new Response(JSON.stringify({data:[{id:"claude-first"}],has_more:true,last_id:"first/id"}))).mockResolvedValueOnce(new Response(JSON.stringify({data:[{id:"claude-second"}],has_more:false})));
 const catalog=await f.service.refresh(f.id);expect(catalog.models).toHaveLength(2);expect(f.fetcher.mock.calls[0]![1]?.headers).toMatchObject({"x-api-key":"fixture-key-private","anthropic-version":"2023-06-01"});expect(f.fetcher.mock.calls[1]![0]).toBe("https://api.anthropic.com/v1/models?after_id=first%2Fid");
});
it("retains a last-good provider-specific catalog on auth/network errors without inventing pricing",async()=>{
 const f=fixture();const original=await f.service.refresh(f.id);f.fetcher.mockResolvedValueOnce(new Response("PRIVATE_ERROR_CANARY",{status:401}));const failed=await f.service.refresh(f.id);
 expect(failed.models).toEqual(original.models);expect(failed.stale).toBe(true);expect(failed.error?.code).toBe("unauthorized");expect(JSON.stringify(failed)).not.toContain("PRIVATE_ERROR");expect(failed.models[0]!.pricing).toBeUndefined();expect(f.service.list()[0]!.state).toBe("needs-attention");
 const restarted=f.make();expect(restarted.getCatalog(f.id).models).toEqual(original.models);expect(readFileSync(join(f.cacheDir,f.id+".json"),"utf8")).not.toContain("private");
});
it("preserves credential bank when metadata cache is corrupt",()=>{
 const f=fixture();mkdirSync(f.cacheDir,{recursive:true});writeFileSync(join(f.cacheDir,f.id+".json"),"CORRUPT_CACHE");const bank=f.bank();expect(f.make().getCatalog(f.id).error?.code).toBe("invalid-catalog");expect(f.bank()).toBe(bank);expect(readFileSync(join(f.cacheDir,f.id+".json"),"utf8")).toBe("CORRUPT_CACHE");
});
it("recognizes current DeepSeek Flash and documented vision aliases without broad model guessing",()=>{
 const f=fixture("deepseek"),connection=parseProviderBank(f.bank())[0]!;
 const ids=["deepseek-flash","deepseek-v4-flash","deepseek-v4-flash-vision-exp"];
 const models=normalizeProviderModels(connection,{data:[...ids.map(id=>({id})),{id:"deepseek-v4-pro"},{id:"deepseek-future"},{id:"deepseek-image"}]},1234);
 for(const id of ids)expect(models.find(row=>row.id===id)).toMatchObject({chatEligible:true,capabilities:{chat:true,vision:true}});
 expect(models.find(row=>row.id==="deepseek-v4-pro")?.capabilities.vision).toBeUndefined();
 for(const id of ["deepseek-future","deepseek-image"])expect(models.find(row=>row.id===id)?.chatEligible).toBe(false);
 expect(normalizeProviderModels(connection,{data:[{id:"deepseek-flash",capabilities:{vision:false},architecture:{output_modalities:["image"]}}]},1234)[0]).toMatchObject({chatEligible:false,capabilities:{vision:false}});
});
it("repairs old sparse DeepSeek cache classification without network or credential changes",async()=>{
 const f=fixture("deepseek"),connection=parseProviderBank(f.bank())[0]!,bank=f.bank();
 mkdirSync(f.cacheDir,{recursive:true});
 const cachePath=join(f.cacheDir,f.id+".json");
 const sparse={connectionId:f.id,preset:"deepseek",id:"deepseek-flash",label:"Flash",enabled:true,chatEligible:false,capabilities:{chat:false},outputModalities:["unknown"]};
 const bytes=JSON.stringify({revision:connection.revision,catalog:{connectionId:f.id,models:[sparse,{...sparse,id:"deepseek-future"}],fetchedAt:1234,stale:false,assurance:"catalog-only"}});
 writeFileSync(cachePath,bytes);
 const restarted=f.make();
 expect(restarted.getCatalog(f.id).models[0]).toMatchObject({id:"deepseek-flash",connectionId:f.id,chatEligible:true,capabilities:{chat:true,vision:true},outputModalities:["text"]});
 expect(restarted.getCatalog(f.id).models[1]?.chatEligible).toBe(false);
 expect(f.bank()).toBe(bank);expect(readFileSync(cachePath,"utf8")).toBe(bytes);expect(f.fetcher).not.toHaveBeenCalled();
});
it("normalizes 400 eligible models with route-scoped prices and excludes media/unknown from chat",()=>{
 const f=fixture("openrouter"),connection=parseProviderBank(f.bank())[0]!;
 const rows=Array.from({length:400},(_,index)=>({id:`vendor/text-${index}`,name:`Text ${index}`,architecture:{input_modalities:["text","image"],output_modalities:["text"]},context_length:128000,pricing:{prompt:"0.000001",completion:"0.000005"},supported_parameters:["tools","reasoning"]}));
 const models=normalizeProviderModels(connection,{data:[...rows,{id:"vendor/veo-3",architecture:{output_modalities:["video"]}},{id:"unknown/model"},{id:"text-embedding-3",architecture:{output_modalities:["text"]}}]},1234);
 expect(models.filter(row=>row.chatEligible)).toHaveLength(400);expect(models[0]!.pricing).toEqual({inputPerMillion:1,outputPerMillion:5,source:PROVIDER_PRESETS.openrouter.catalogUrl,updatedAt:1234});expect(models[0]!.capabilities).toEqual({chat:true,vision:true,tools:true,reasoning:true});expect(models[0]!.contextWindow).toBe(128000);
});
it.each(["openai","flux"] as const)("refuses stale %s catalog completion after a key rotation and never retries automatically",async(preset)=>{
 const f=fixture(preset);let resolve!:(response:Response)=>void;f.fetcher.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));const refreshing=f.service.refresh(f.id);const original=f.service.list()[0]!;
 await f.mutate({action:"update",id:f.id,revision:original.revision,key:"changed-private-key"});resolve(new Response(JSON.stringify({data:[{id:"gpt-stale"}]})));
 expect((await refreshing).error?.code).toBe("connection-changed");expect(f.service.getCatalog(f.id).models).toEqual([]);expect(f.fetcher).toHaveBeenCalledOnce();
});
it("rejects oversized/model-flood/looping catalogs with typed failures",async()=>{
 const f=fixture();f.fetcher.mockResolvedValueOnce(new Response("{}",{headers:{"content-length":String(5*1024*1024)}}));expect((await f.service.refresh(f.id)).error?.code).toBe("invalid-catalog");
 const loop=fixture("anthropic");loop.fetcher.mockImplementation(async()=>new Response(JSON.stringify({data:[{id:"claude-one"}],has_more:true,last_id:"same"})));expect((await loop.service.refresh(loop.id)).error?.code).toBe("invalid-catalog");expect(loop.fetcher).toHaveBeenCalledTimes(2);
});
it("does not leak the provider credential bank or commit bearer into engine environments",()=>{
 const env={MURAGE_MODEL_PROVIDER_CONNECTIONS:"PRIVATE_BANK",MURAGE_MODEL_PROVIDER_COMMIT_TOKEN:"PRIVATE_COMMIT",PATH:"/fixture"};stripWorkspaceCredentialEnv(env);expect(env).toEqual({PATH:"/fixture"});
 expect(()=>parseConfigPatch({modelProviders:{bank:"[]"}})).toThrow("Models settings");
});
it("lists legacy credentials virtually without copying them into the named bank",()=>{
 const f=fixture();const service=new ProviderConnectionsService({readBank:()=>"[]",cacheDir:f.cacheDir,legacyConnections:()=>[{id:"legacy-flux",preset:"flux",label:"Existing Flux",key:"FAKE_LEGACY_SECRET",enabled:true,revision:"legacy-revision",legacy:true,managedIn:"engines"}]});
 expect(service.list()[0]).toMatchObject({id:"legacy-flux",legacy:true,managedIn:"engines",configured:true});expect(JSON.stringify(service.list())).not.toContain("FAKE_LEGACY");expect(service.isCurrent("legacy-flux","legacy-revision")).toBe(true);
});


it.each(["openai","flux"] as const)("refreshes enabled %s catalogs once due at24hours and preserves keys and last-good rows", async (preset) => {
 let now=1000;const f=fixture(preset,()=>now),bank=f.bank();
 await f.service.refreshDue();expect(f.fetcher).toHaveBeenCalledTimes(1);const first=f.service.getCatalog(f.id);
 now+=24*60*60_000-1;await f.service.refreshDue();expect(f.fetcher).toHaveBeenCalledTimes(1);
 now++;f.fetcher.mockResolvedValueOnce(new Response("private failure",{status:401}));await f.service.refreshDue();
 expect(f.fetcher).toHaveBeenCalledTimes(2);expect(f.service.getCatalog(f.id)).toMatchObject({models:first.models,stale:true,error:{code:"unauthorized"}});
 now+=60_000;await f.service.refreshDue();expect(f.fetcher).toHaveBeenCalledTimes(2);
 await f.service.refresh(f.id);expect(f.fetcher).toHaveBeenCalledTimes(3);expect(f.bank()).toBe(bank);
 expect(f.service.getCatalog(f.id).models[0].pricing).toBeUndefined();
});
it.each(["openai","flux"] as const)("shares scheduled/manual %s requests and refuses disabled connections without fetching",async(preset)=>{
 let now=1000;const f=fixture(preset,()=>now);let finish!:(response:Response)=>void;
 f.fetcher.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
 const scheduled=f.service.refreshDue(),manual=f.service.refresh(f.id);expect(f.fetcher).toHaveBeenCalledOnce();
 finish(new Response(JSON.stringify({data:[{id:"gpt-6-new-catalog"},{id:"image-only"}]})));await Promise.all([scheduled,manual]);
 expect(f.service.getCatalog(f.id).models.filter(model=>model.chatEligible).map(model=>model.id)).toEqual(["gpt-6-new-catalog"]);
 const connection=f.service.list()[0];await f.mutate({action:"update",id:f.id,revision:connection.revision,enabled:false});
 now+=24*60*60_000;await f.service.refreshDue();expect(f.fetcher).toHaveBeenCalledOnce();
 await expect(f.service.refresh(f.id)).rejects.toThrow(/Enable/);
});
it("respects a fresh persisted catalog on restart before the daily boundary",async()=>{
 let now=1000;const f=fixture("openai",()=>now);await f.service.refresh(f.id);now+=60_000;
 await f.make().refreshDue();expect(f.fetcher).toHaveBeenCalledOnce();
 now+=24*60*60_000;await f.make().refreshDue();expect(f.fetcher).toHaveBeenCalledTimes(2);
});

it("automatically discovers the complete per-key Flux catalog with explicit capability authority",async()=>{
 const f=fixture("flux",()=>1000);
 f.fetcher.mockResolvedValueOnce(new Response(JSON.stringify({data:[
  ...["flux-auto","flux-fast","flux-standard","flux-reasoning","flux-pinned-glm-5-3","future-vendor-choice"].map(id=>({id,capability:"chat"})),
  {id:"future-visual-arm",capability:"image"},{id:"future-voice-arm",capability:"audio"},
  {id:"flux-pinned-disabled",capability:"chat",active:false},
 ]})));
 await f.service.refreshDue();expect(f.fetcher).toHaveBeenCalledOnce();
 const catalog=f.service.getCatalog(f.id);
 expect(catalog.models.filter(model=>model.enabled&&model.chatEligible).map(model=>model.id)).toEqual(["flux-auto","flux-fast","flux-standard","flux-reasoning","flux-pinned-glm-5-3","future-vendor-choice"]);
 expect(catalog.models.find(model=>model.id==="future-visual-arm")).toMatchObject({chatEligible:false,outputModalities:["image"]});
 expect(catalog.models.find(model=>model.id==="future-voice-arm")).toMatchObject({chatEligible:false,outputModalities:["audio"]});
 expect(f.fetcher.mock.calls[0][0]).toBe(PROVIDER_PRESETS.flux.catalogUrl);
});
it("honors Flux metadata over names and refuses unknown or conflicting media capabilities",()=>{
 const f=fixture("flux"),connection=parseProviderBank(f.bank())[0]!;
 const rows=normalizeProviderModels(connection,{data:[{id:"image-analysis-chat",capability:"chat"},{id:"flux-auto",capability:"image"},{id:"flux-fast",capability:"unknown"},{id:"flux-standard",capability:"chat",output_modalities:["audio"]}]},1000);
 expect(rows.map(row=>row.chatEligible)).toEqual([true,false,false,false]);
});
it("does not automatically refresh a conflicting legacy Flux credential",async()=>{
 const f=fixture("flux");const service=new ProviderConnectionsService({readBank:()=>"[]",cacheDir:f.cacheDir,fetch:f.fetcher,
  legacyConnections:()=>[{id:"legacy-flux",preset:"flux",label:"Flux",enabled:true,key:"fake-only",revision:"r1",legacy:true,managedIn:"connections",legacyError:"Choose the existing connection"}]});
 await service.refreshDue();expect(f.fetcher).not.toHaveBeenCalled();expect(service.list()[0].catalog.error?.code).toBe("unavailable");
});

it("never ships a raw model id as a label when the provider's catalog omits names",()=>{
 // Sean, 2026-09-18: the picker showed the SAME model twice — "Flux Auto"
 // from the engine catalog (server/flux-routing.ts:227) and the literal
 // `flux-auto` from this connection, because Flux's /v1/models carries no
 // `name` and the fallback chain ended at row.id.
 const f=fixture("flux"),connection=parseProviderBank(f.bank())[0]!;
 const models=normalizeProviderModels(connection,{data:[
  {id:"flux-auto",capability:"chat"},
  {id:"flux-reasoning",capability:"chat"},
  {id:"flux-pinned-deepseek-flash-max",capability:"chat"},
  {id:"claude-opus-5",capability:"chat",name:"Claude Opus 5"},
 ]},1);
 expect(models.map(model=>model.label)).toEqual(["Flux Auto","Flux Reasoning","Flux Pinned Deepseek Flash Max","Claude Opus 5"]);
});
it("still prefers a name the provider actually supplied over the Flux table",()=>{
 const f=fixture("flux"),connection=parseProviderBank(f.bank())[0]!;
 const [model]=normalizeProviderModels(connection,{data:[{id:"flux-auto",capability:"chat",name:"Flux Automatic"}]},1);
 expect(model!.label).toBe("Flux Automatic");
});

it("keeps flux-voice out of the chat picker even when Flux states no capability",async()=>{
 // The whole defect: `flux-image` was excluded by MEDIA's `image`, `flux-voice`
 // by nothing, so the only thing keeping a voice model out of the chat list was
 // Flux always populating an OPTIONAL `capability` field. These rows carry none.
 const f=fixture("flux"),connection=parseProviderBank(f.bank())[0]!;
 // Text output declared and no `capability`: this is the shape that makes
 // MEDIA the ONLY thing standing between flux-voice and the chat list, because
 // a declared `output` short-circuits knownChat's own alias test.
 const text={architecture:{output_modalities:["text"]}};
 const models=normalizeProviderModels(connection,{data:[
  {id:"flux-voice",...text},{id:"flux-image",...text},
  {id:"flux-auto",...text},{id:"flux-fast",...text},{id:"flux-reasoning",...text},{id:"flux-standard",...text},
  {id:"flux-pinned-claude-opus-5",...text},
 ]},1);
 const chat=models.filter(model=>model.chatEligible).map(model=>model.id);
 expect(chat).toEqual(["flux-auto","flux-fast","flux-reasoning","flux-standard","flux-pinned-claude-opus-5"]);
 expect(models.find(model=>model.id==="flux-voice")!.chatEligible).toBe(false);
 expect(models.find(model=>model.id==="flux-image")!.chatEligible).toBe(false);
 // With nothing declared at all, knownChat's flux alias test is a second
 // defence — but it is the only one MEDIA does not back up, which is why the
 // case above exists.
 const bare=normalizeProviderModels(connection,{data:[{id:"flux-voice"},{id:"flux-auto"}]},1);
 expect(bare.filter(model=>model.chatEligible).map(model=>model.id)).toEqual(["flux-auto"]);
});
it("excludes rerankers by id, and still admits the chat model named Musica",()=>{
 // `rerank` was added with `voice`; `music` was rejected because it would have
 // excluded gemma-4-26b-a4b-it-musica, which is a chat model.
 const f=fixture("openrouter"),connection=parseProviderBank(f.bank())[0]!;
 const models=normalizeProviderModels(connection,{data:[
  // text output declared on all three, so MEDIA's id test is what decides
  {id:"cohere/rerank-v4-pro",architecture:{output_modalities:["text"]}},
  {id:"voyage/rerank-2.5",architecture:{output_modalities:["text"]}},
  {id:"gemma-4-26b-a4b-it-musica",architecture:{output_modalities:["text"]}},
 ]},1);
 expect(models.filter(model=>model.chatEligible).map(model=>model.id)).toEqual(["gemma-4-26b-a4b-it-musica"]);
});
