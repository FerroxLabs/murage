import { afterAll, beforeAll, expect, it } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
let fixture:VerificationServer;
let headers:Record<string,string>;
async function api(method:string,path:string,body?:unknown,owner=true){const response=await fetch(fixture.info.url+path,{method,headers:{...(owner?headers:{}),...(body===undefined?{}:{"content-type":"application/json"})},body:body===undefined?undefined:JSON.stringify(body)});return{status:response.status,body:await response.json() as any};}
beforeAll(async()=>{
 fixture=await launchVerificationServer({...process.env,MURAGE_MODEL_PROVIDER_CONNECTIONS:"",MURAGE_MODEL_PROVIDER_COMMIT_TOKEN:"",MURAGE_OPENAI_IMAGE_KEY:"",XAI_API_KEY:"",FLUX_API_KEY:"",OPENAI_COMPAT_API_KEY:""},undefined,{instrumentationSource:`
 const originalFetch=globalThis.fetch;
 globalThis.fetch=(input,init)=>{
   const url=String(input);
   if(url==='https://api.openai.com/v1/models'){
     if(init?.headers?.authorization!=='Bearer sk-proj-FAKE_HTTP_KEY_ONLY')throw new Error('Unexpected fixture key');
     return Promise.resolve(new Response(JSON.stringify({data:[{id:'gpt-5-fixture'},{id:'gpt-image-2'}]})));
   }
   if(url.startsWith('https://'))throw new Error('External network blocked in provider fixture');
   return originalFetch(input,init);
 };`});
 const proof=await api("GET","/api/desktop-secret",undefined,false);headers={"x-murage-surface":"desktop","x-murage-surface-secret":proof.body.secret};
},30000);
afterAll(async()=>{await fixture?.close();});
it("persists endpoint-bound named providers on the isolated actual HTTP surface and exposes only safe catalogs",async()=>{
 expect((await api("GET","/api/provider-connections",undefined,false)).status).toBe(404);
 expect((await api("POST","/api/provider-connections/replace",{bank:"[]",expectedRevision:"[]"})).status).toBe(404);
 expect((await api("POST","/api/provider-connections/mutate",{action:"create",preset:"openrouter",key:"sk-proj-FAKE_HTTP_KEY_ONLY"})).status).toBe(400);
 const created=await api("POST","/api/provider-connections/mutate",{action:"create",preset:"openai",label:"HTTP fixture",key:"sk-proj-FAKE_HTTP_KEY_ONLY"});expect(created.status).toBe(200);expect(created.body.storage).toBe("local-config");
 const connection=created.body.connections.find((row:any)=>row.label==="HTTP fixture");expect(connection.baseUrl).toBe("https://api.openai.com/v1");expect(JSON.stringify(created.body)).not.toContain("FAKE_HTTP_KEY");
 const catalog=await api("POST",`/api/provider-connections/${connection.id}/refresh`,{});expect(catalog.status).toBe(200);expect(catalog.body.models.filter((row:any)=>row.chatEligible).map((row:any)=>row.id)).toEqual(["gpt-5-fixture"]);expect(catalog.body.assurance).toBe("catalog-only");
 const snapshot=await api("GET","/api/provider-connections");expect(snapshot.body.connections.find((row:any)=>row.id===connection.id).state).toBe("catalog-ready");expect(JSON.stringify(snapshot.body)).not.toContain("FAKE_HTTP_KEY");
 expect((await api("PUT","/api/config",{modelProviders:{bank:"[]"}})).status).toBe(400);
 const persisted=JSON.parse(readFileSync(join(fixture.info.dataDir,"config.json"),"utf8"));expect(persisted.modelProviders.bank).toContain("FAKE_HTTP_KEY"); // explicit isolated dev-config custody, never production plaintext
 expect((await api("POST","/api/provider-connections/mutate",{action:"remove",id:connection.id,revision:connection.revision})).status).toBe(200);
 expect((await api("GET","/api/provider-connections")).body.connections.some((row:any)=>row.id===connection.id)).toBe(false);
});
