import { afterAll, beforeAll, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
let fixture: VerificationServer, headers: Record<string, string>;
const token = "a".repeat(64);
async function api(method: string, path: string, body?: unknown, privateRoute = false) {
  const response = await fetch(fixture.info.url + path, { method, headers: { ...headers, ...(privateRoute ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
}
beforeAll(async () => {
  fixture = await launchVerificationServer({}, undefined, { instrumentationSource: `
    import { readFileSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const file=join(process.env.MURAGE_DATA_DIR,'config.json');
    const config=JSON.parse(readFileSync(file,'utf8'));
    config.flux={apiKey:'sk-flux-FAKE_FILE'};
    config.modelProviders={bank:JSON.stringify([
      {id:'old-flux',preset:'flux',label:'Old account',enabled:true,key:'sk-flux-FAKE_NAMED',revision:'original'},
      {id:'disabled-flux',preset:'flux',label:'Disabled account',enabled:false,key:'sk-flux-FAKE_NAMED',revision:'disabled'},
      {id:'other-provider',preset:'mistral',label:'Other',enabled:false,key:'FAKE_OTHER_ONLY',revision:'other'}
    ])};
    writeFileSync(file,JSON.stringify(config));
    process.env.FLUX_API_KEY='sk-flux-FAKE_ENV';
    process.env.MURAGE_MODEL_PROVIDER_COMMIT_TOKEN='${token}';
    const originalFetch=globalThis.fetch;
    globalThis.fetch=(input,init)=>{
      const url=String(input);
      if(url==='https://api.fluxrouter.ai/v1/models'){
        if(init?.headers?.authorization!=='Bearer '+process.env.FLUX_API_KEY)throw Error('Wrong fixture credential');
        return Promise.resolve(new Response(JSON.stringify({data:[{id:'flux-fast'},{id:'flux-standard'}]})));
      }
      if(url.startsWith('https://'))throw Error('External network blocked in Flux fixture');
      return originalFetch(input,init);
    };
  ` });
  const proof = await api("GET", "/api/desktop-secret"); headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
}, 30_000);
afterAll(async () => { await fixture?.close(); });
it("selects conflicting keys explicitly, preserves aliases, tests catalog and disconnects across actual HTTP routes", async () => {
  const initial = await api("GET", "/api/flux-connection");
  expect(initial.status).toBe(200); expect(initial.body.conflict).toBe(true); expect(initial.body.choices).toHaveLength(4); expect(JSON.stringify(initial.body)).not.toContain("FAKE_");
  expect((await api("POST", "/api/flux-connection/replace", { phase: "begin" })).status).toBe(404);
  expect((await api("POST", "/api/flux-connection/mutate", { action: "replace", revision: initial.body.revision, key: "sk-flux-FAKE_NEXT" })).status).toBe(409);
  const selected = await api("POST", "/api/flux-connection/mutate", { action: "select", revision: initial.body.revision, connectionId: "old-flux" });
  expect(selected.status).toBe(200); expect(selected.body.conflict).toBe(false);
  const listed = await api("GET", "/api/provider-connections");
  expect(listed.body.connections.filter((row: any) => row.preset === "flux").map((row: any) => row.id)).toEqual(["legacy-flux"]);
  const saved = JSON.parse(readFileSync(join(fixture.info.dataDir, "config.json"), "utf8"));
  expect(saved.flux.apiKey).toBe("sk-flux-FAKE_NAMED"); expect(saved.flux.connectionAliases.map((row: any) => [row.id, row.enabled])).toEqual([["old-flux", true], ["disabled-flux", false]]);
  expect(JSON.stringify(saved.flux.connectionAliases)).not.toContain("FAKE"); expect(JSON.parse(saved.modelProviders.bank).map((row: any) => row.id)).toEqual(["other-provider"]);
  expect((await api("POST", "/api/flux-connection/test", {})).body).toEqual({ modelCount: 2 });
  const aliasCatalog = await api("GET", "/api/provider-connections/old-flux/catalog"); expect(aliasCatalog.body.models[0].connectionId).toBe("old-flux");
  expect((await api("POST", "/api/provider-connections/disabled-flux/refresh", {})).status).toBe(409);
  expect((await api("PUT", "/api/config", { flux: { apiKey: "sk-flux-FAKE_BYPASS" } })).status).toBe(409);
  expect((await api("POST", "/api/provider-connections/mutate", { action: "create", preset: "flux", key: "sk-flux-FAKE_BYPASS" })).status).toBe(409);
  const reserved = await api("POST", "/api/flux-connection/replace", { phase: "begin", input: { action: "replace", revision: selected.body.revision, key: "sk-flux-FAKE_REPLACE" } }, true);
  expect(reserved.status).toBe(200);
  expect((await api("POST", "/api/flux-connection/mutate", { action: "disconnect", revision: selected.body.revision })).status).toBe(409);
  const committed = await api("POST", "/api/flux-connection/replace", { phase: "commit", lease: reserved.body.lease }, true); expect(committed.status).toBe(200);
  expect((await api("POST", "/api/flux-connection/replace", { phase: "rollback", lease: reserved.body.lease }, true)).status).toBe(200);
  expect((await api("POST", "/api/flux-connection/replace", { phase: "finish", lease: reserved.body.lease }, true)).status).toBe(200);
  const restored = await api("GET", "/api/flux-connection"); expect(restored.body.revision).toBe(selected.body.revision);
  const disconnected = await api("POST", "/api/flux-connection/mutate", { action: "disconnect", revision: restored.body.revision }); expect(disconnected.status).toBe(200); expect(disconnected.body.configured).toBe(false);
  expect((await api("GET", "/api/provider-connections/old-flux/catalog")).status).toBe(404);
  expect((await api("POST", "/api/flux-connection/test", {})).status).toBe(409);
}, 30_000);
