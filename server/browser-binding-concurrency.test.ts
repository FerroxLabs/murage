// The real binding cache and owner route run in an isolated verification server.
// Only the native engine boundary is faked; no browser or user data is opened.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

let fixture: VerificationServer;
let headers: Record<string, string>;
const instrumentationSource = `
  const fs = await import('node:fs'), path = await import('node:path');
  const { registerHooks } = await import('node:module');
  const root = process.env.MURAGE_DATA_DIR;
  globalThis.bindingAttempt = botId => fs.appendFileSync(path.join(root, 'binding-attempts'), botId + '\\n');
  globalThis.verifyBinding = async env => {
    const session = env.AGENT_BROWSER_SESSION;
    fs.appendFileSync(path.join(root, 'binding-verifications'), session + '\\n');
    while (!fs.existsSync(path.join(root, 'release-' + session))) await new Promise(r => setTimeout(r, 10));
    if (fs.readFileSync(path.join(root, 'release-' + session), 'utf8') === 'fail') throw Error('fixture verification failed');
  };
  const configFile = path.join(root, 'config.json');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  config.features = { browser: true };
  config.browserProfiles = [{ id: 'shared', name: 'Shared' }];
  fs.writeFileSync(configFile, JSON.stringify(config));
  registerHooks({ load(url, context, next) {
    if (url.endsWith('/browser-native-relay.ts')) return { format: 'module', shortCircuit: true,
      source: 'export function createNativeBrowser(){return {connect:async()=>"fixture-stream",protected:async()=>false,request:async()=>({}),command:async()=>({}),input:()=>{},resetStream:()=>{},close:async()=>{}}}' };
    if (url.endsWith('/browser-engine.ts')) {
      let source = fs.readFileSync(new URL(url), 'utf8');
      // Permit construction of the real spec in a container, without launching its binary.
      const sandbox = 'if (browserHostRequiresSandboxBypass({';
      if (source.split(sandbox).length !== 2) throw Error('Sandbox fixture anchor changed');
      source = source.replace(sandbox, 'if (false && browserHostRequiresSandboxBypass({');
      const start = source.indexOf('export async function verifyAgentBrowserBinary(');
      const end = source.indexOf('export async function ensureChrome(', start);
      if (start < 0 || end < 0) throw Error('Version fixture anchor changed');
      return { format: 'module-typescript', shortCircuit: true, source: source.slice(0, start)
        + 'export async function verifyAgentBrowserBinary(binary, env) { await globalThis.verifyBinding(env); }\\n' + source.slice(end) };
    }
    const result = next(url, context);
    if (!url.endsWith('/server/index.ts')) return result;
    let source = String(result.source);
    const anchor = 'async function unifiedBrowserBinding(botId: string, profile: string | undefined) {';
    if (source.split(anchor).length !== 2) throw Error('Binding fixture anchor changed');
    source = source.replace(anchor, anchor + ' globalThis.bindingAttempt(botId);');
    source = source.replaceAll('await settledBrowserEngineStatus()', 'await Promise.resolve({kind:"ready",binaryPath:"fixture"})');
    return { ...result, source };
  }});
`;
const lines = (name: string) => {
  const file = join(fixture.info.dataDir, name);
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : [];
};
async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(fixture.info.url + path, { method,
    headers: { ...headers, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const bodyResult = await response.json() as { bot?: { id: string }; secret?: string; error?: string; baseRevision?: number; disclosure?: { disclosureKey: string } };
  return { status: response.status, body: bodyResult };
}
async function bot(profile?: string) {
  const created = await api("POST", "/api/bots", { name: "Binding fixture" });
  expect(created.status).toBe(201);
  const id = created.body.bot!.id;
  if (profile) {
    const preview = await api("GET", `/api/bots/${id}/browser-choice/preview?mode=builtin&profile=${encodeURIComponent(profile)}`);
    expect(preview.status).toBe(200);
    expect((await api("PATCH", `/api/bots/${id}`, { browserChoice: { mode: "builtin", profile,
      baseRevision: preview.body.baseRevision, disclosureKey: preview.body.disclosure!.disclosureKey } })).status).toBe(200);
  }
  return id;
}
const view = (id: string) => api("GET", `/api/bots/${id}/browser`);
const release = (session: string, fail = false) => writeFileSync(join(fixture.info.dataDir, "release-" + session), fail ? "fail" : "ok");
beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource });
  console.log("Binding fixture:", JSON.stringify(fixture.info));
  const proof = await api("GET", "/api/desktop-secret");
  expect(typeof proof.body.secret).toBe("string");
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret! };
}, 60_000);
afterAll(async () => {
  if (!fixture) return;
  // Release even after an assertion failure so fixture teardown cannot hang.
  for (const session of lines("binding-verifications")) release(session);
  if (process.env.BINDING_EVIDENCE_DIR && fixture) {
    appendFileSync(join(process.env.BINDING_EVIDENCE_DIR, "fixture-server.log"), readFileSync(fixture.info.logPath));
  }
  await fixture?.close();
});

it.each(["same bot", "shared profile"])("concurrent first views of %s share one verified binding", async kind => {
  const a = await bot(kind === "shared profile" ? "shared" : undefined);
  const b = kind === "shared profile" ? await bot("shared") : a;
  const before = lines("binding-verifications").length;
  const requests = [view(a), view(b)];
  await expect.poll(() => lines("binding-attempts").filter(id => id === a || id === b).length).toBe(2);
  await expect.poll(() => lines("binding-verifications").length).toBeGreaterThan(before);
  const sessions = lines("binding-verifications").slice(before);
  for (const session of sessions) release(session);
  const results = await Promise.all(requests);
  expect(results.map(result => ({ status: result.status, error: result.body.error }))).toEqual([
    { status: 200, error: undefined }, { status: 200, error: undefined },
  ]);
  expect(sessions).toHaveLength(1);
  expect((await view(a)).status).toBe(200);
  expect(lines("binding-verifications").length).toBe(before + 1);
});

it("shares initialization failure, permits retry, and does not block a different identity", async () => {
  const a = await bot(), b = await bot();
  const before = lines("binding-verifications").length;
  const first = view(a);
  await expect.poll(() => lines("binding-verifications").length).toBe(before + 1);
  const aSession = lines("binding-verifications")[before];
  const second = view(a), independent = view(b);
  await expect.poll(() => lines("binding-attempts").filter(id => id === a).length).toBe(2);
  await expect.poll(() => lines("binding-verifications").some(session => session !== aSession && !lines("binding-verifications").slice(0, before).includes(session))).toBe(true);
  const bSession = lines("binding-verifications").find((session, i) => i >= before && session !== aSession)!;
  release(bSession);
  expect((await independent).status).toBe(200);
  release(aSession, true);
  expect((await Promise.all([first, second])).map(result => result.body.error)).toEqual(["fixture verification failed", "fixture verification failed"]);
  expect(lines("binding-verifications").filter(session => session === aSession)).toHaveLength(1);
  release(aSession);
  expect((await view(a)).status).toBe(200);
  expect(lines("binding-verifications").filter(session => session === aSession)).toHaveLength(2);
});
