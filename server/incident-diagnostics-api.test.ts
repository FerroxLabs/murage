import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { requiresDesktopAuthority } from "./desktop-policy.ts";
import { parseIncidentDiagnostics } from "./incident-diagnostics.ts";

type Selection = { threadId: string; messageId: string; diagnosticId: string };
let fixture: VerificationServer, headers: Record<string, string>;
let selected: Selection, foreign: Selection, missing: Selection, legacyId: string;
const route = (selection: Selection) => "/api/diagnostics/incident?" + new URLSearchParams(selection);
async function get(path: string, authority = headers) {
  const response = await fetch(fixture.info.url + path, { headers: authority });
  return { status: response.status, body: await response.json() as any };
}
beforeAll(async () => {
  // Seed only isolated fixture data through the real Store; no provider dispatch.
  const instrumentationSource = `
    const fs=await import('node:fs');const path=await import('node:path');
    const {Store}=await import(${JSON.stringify(new URL("./store.ts", import.meta.url).href)});
    const {createLifecycleRecorder}=await import(${JSON.stringify(new URL("./drivers/lifecycle-diagnostic.ts", import.meta.url).href)});
    const {NATIVE_DIR}=await import(${JSON.stringify(new URL("./config.ts", import.meta.url).href)});
    const store=new Store(()=>({instanceId:'verification',model:'fixture'}));
    const bot=store.createBot({name:'Incident fixture'},{seedMessages:false});
    const other=store.createBot({name:'Foreign fixture'},{seedMessages:false});
    const absent=store.createBot({name:'Missing evidence fixture'},{seedMessages:false});
    const turnId='eb22599e-c710-40e2-98b3-35b56a88a2e1';
    fs.mkdirSync(NATIVE_DIR,{recursive:true});
    const file=path.join(NATIVE_DIR,bot.threadId+'.ndjson');
    const lifecycle=createLifecycleRecorder({threadId:bot.threadId,turnId,driver:'fuigoAgent',sink:(_thread,entry)=>fs.appendFileSync(file,JSON.stringify({at:new Date().toISOString(),...entry})+'\\n')});
    const diagnostic={version:1,diagnosticId:'ev-fixture-1',turnId,processGeneration:lifecycle.generation,rpcId:4,method:'session/prompt',rpcCode:-32603,httpStatus:500,terminalKind:'api',observedKind:'idle_timeout'};
    const error=store.appendMessage(bot.threadId,{role:'bot',kind:'activity',turnId,tool:{name:'error: Internal error',ok:false,errorDetails:'PRIVATE-ERROR-BODY-CANARY',diagnostic}});
    lifecycle.record('rpc_rejected',{rpcId:4,method:'session/prompt',rpcCode:-32603,httpStatus:500,terminalKind:'api',observedKind:'idle_timeout'});
    fs.appendFileSync(file,JSON.stringify({at:new Date().toISOString(),dir:'in',source:'fuigo.acp',msg:{message:'PRIVATE-NATIVE-BODY-CANARY',token:'PRIVATE-TOKEN-CANARY'}})+'\\n');
    const legacy=store.appendMessage(bot.threadId,{role:'bot',kind:'activity',tool:{name:'error: legacy',ok:false}});
    const missing=store.appendMessage(absent.threadId,{role:'bot',kind:'activity',turnId,tool:{name:'error: Internal error',ok:false,diagnostic:{...diagnostic,diagnosticId:'ev-fixture-2'}}});
    fs.writeFileSync(path.join(process.env.MURAGE_DATA_DIR,'incident-fixture.json'),JSON.stringify({selected:{threadId:bot.threadId,messageId:error.id,diagnosticId:diagnostic.diagnosticId},foreign:{threadId:other.threadId,messageId:error.id,diagnosticId:diagnostic.diagnosticId},missing:{threadId:absent.threadId,messageId:missing.id,diagnosticId:'ev-fixture-2'},legacyId:legacy.id}));
  `;
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource });
  const proof = await (await fetch(fixture.info.url + "/api/desktop-secret")).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  ({ selected, foreign, missing, legacyId } = JSON.parse(readFileSync(join(fixture.info.dataDir, "incident-fixture.json"), "utf8")));
}, 30000);
afterAll(async () => { await fixture?.close(); });

it("gates incident reads before selection handling and refuses absent or spoofed desktop proof", async () => {
  expect(requiresDesktopAuthority("GET", "/api/diagnostics/incident")).toBe(true);
  expect(requiresDesktopAuthority("GET", "/api/diagnostics/incident-other")).toBe(false);
  expect((await get(route(selected), {})).status).toBe(404);
  expect((await get(route(selected), { "x-murage-surface": "desktop", "x-murage-surface-secret": "fake-proof" })).status).toBe(404);
  expect((await get("/api/diagnostics/incident?path=private", {})).status).toBe(404);
});
it("returns only the selected safe diagnostic and matching lifecycle facts, never native or error bodies", async () => {
  const response = await get(route(selected));
  expect(response.status).toBe(200);
  expect(response.body.diagnostic.diagnosticId).toBe(selected.diagnosticId);
  expect(response.body.diagnostic.terminalKind).toBe("api");
  expect(response.body.diagnostic.observedKind).toBe("idle_timeout");
  expect(response.body.rows).toHaveLength(1);
  expect(response.body.rows[0]).toMatchObject({ event: "rpc_rejected", rpcCode: -32603, httpStatus: 500 });
  expect(JSON.stringify(response.body)).not.toContain("PRIVATE-");
  expect(JSON.stringify(response.body)).not.toContain(fixture.info.dataDir);
  const { prepareSelectedIncidentReport } = await import(new URL("../electron/incident-export.mjs", import.meta.url).href) as {
    prepareSelectedIncidentReport(selection: Selection, context: {
      fetchIncident: (selection: Selection) => Promise<Response>;
      parseIncident: typeof parseIncidentDiagnostics;
      appInfo: { version: string; platform: string };
    }): Promise<string>;
  };
  const report = await prepareSelectedIncidentReport(selected, {
    fetchIncident: selection => fetch(fixture.info.url + route(selection), { headers }),
    parseIncident: parseIncidentDiagnostics,
    appInfo: { version: "0.1.53", platform: "darwin" },
  });
  expect(report).toContain(`Diagnostic ID: ${selected.diagnosticId}`);
  expect(report).toContain('"httpStatus":500');
  expect(report).toContain('"event":"rpc_rejected"');
  expect(report).not.toContain("PRIVATE-");
  expect(report).not.toContain(fixture.info.dataDir);
});
it("foreign, unknown, wrong diagnostic and legacy selections are not found without cross-thread search", async () => {
  for (const selection of [foreign, { ...selected, threadId: "unknown-thread" }, { ...selected, messageId: "unknown-message" }, { ...selected, diagnosticId: "ev-wrong-1" }, { ...selected, messageId: legacyId }]) {
    expect((await get(route(selection))).status).toBe(404);
  }
});
it("rejects caller paths, duplicate fields and malformed selections", async () => {
  for (const suffix of ["&nativeDir=private", "&threadId=other", "&path=private"]) expect((await get(route(selected) + suffix)).status).toBe(400);
  expect((await get(route({ ...selected, threadId: "../private" }))).status).toBe(400);
  expect((await get("/api/diagnostics/incident")).status).toBe(400);
});
it("a valid saved incident with no current native evidence returns truthful missing coverage", async () => {
  const response = await get(route(missing));
  expect(response.status).toBe(200);
  expect(response.body.diagnostic.diagnosticId).toBe(missing.diagnosticId);
  expect(response.body.rows).toEqual([]);
  expect(response.body.coverage.missing).toBe(true);
  expect(response.body.coverage.scope).toBe("current-and-previous-tail");
});
