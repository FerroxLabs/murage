import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { PROVIDER_PRESETS, mutateProviderBank, parseProviderBank } from "../electron/provider-connections.mjs";
import { normalizeProviderModels, ProviderConnectionsService } from "./provider-connections.ts";
import { parseConfigPatch, stripWorkspaceCredentialEnv } from "./config.ts";
import type { ProviderPreset } from "../shared/provider-connections.ts";
const roots:string[]=[];afterEach(()=>{roots.splice(0).forEach(root=>rmSync(root,{recursive:true,force:true}));});
function fixture(preset:ProviderPreset="openai") {
 const cacheDir=mkdtempSync(join(tmpdir(),"provider-catalog-"));roots.push(cacheDir);let sequence=0;
 let bank=JSON.stringify(mutateProviderBank("[]",{action:"create",preset,key:"fixture-key-private"},()=>`record-${++sequence}`));
 const fetcher=vi.fn<typeof fetch>(async()=>new Response(JSON.stringify({data:[{id:preset==="anthropic"?"claude-sonnet-test":"gpt-5-test",name:"Fixture model"}]})));
 const make=()=>new ProviderConnectionsService({readBank:()=>bank,cacheDir,fetch:fetcher});const service=make();const id=parseProviderBank(bank)[0]!.id;
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
it("normalizes 400 eligible models with route-scoped prices and excludes media/unknown from chat",()=>{
 const f=fixture("openrouter"),connection=parseProviderBank(f.bank())[0]!;
 const rows=Array.from({length:400},(_,index)=>({id:`vendor/text-${index}`,name:`Text ${index}`,architecture:{input_modalities:["text","image"],output_modalities:["text"]},context_length:128000,pricing:{prompt:"0.000001",completion:"0.000005"},supported_parameters:["tools","reasoning"]}));
 const models=normalizeProviderModels(connection,{data:[...rows,{id:"vendor/veo-3",architecture:{output_modalities:["video"]}},{id:"unknown/model"},{id:"text-embedding-3",architecture:{output_modalities:["text"]}}]},1234);
 expect(models.filter(row=>row.chatEligible)).toHaveLength(400);expect(models[0]!.pricing).toEqual({inputPerMillion:1,outputPerMillion:5,source:PROVIDER_PRESETS.openrouter.catalogUrl,updatedAt:1234});expect(models[0]!.capabilities).toEqual({chat:true,vision:true,tools:true,reasoning:true});expect(models[0]!.contextWindow).toBe(128000);
});
it("refuses stale catalog completion after a key rotation and never retries automatically",async()=>{
 const f=fixture();let resolve!:(response:Response)=>void;f.fetcher.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));const refreshing=f.service.refresh(f.id);const original=f.service.list()[0]!;
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
