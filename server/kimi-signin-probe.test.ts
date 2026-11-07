// L9: real routes, real Kimi snapshot and fake CLI only. No provider keys.
import { appendFileSync, writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
let fixture: VerificationServer;
let headers: Record<string, string>;
const moduleUrl = (path: string) => new URL(path, import.meta.url).href;
const access = "L9_PROBE_ACCESS_SENTINEL", refresh = "L9_PROBE_REFRESH_SENTINEL";
const body = JSON.stringify({ access_token: access, refresh_token: refresh, padding: "z".repeat(3191) });
const api = async (path: string, body?: unknown) => {
  const response = await fetch(fixture.info.url + path, { method: body ? "POST" : "GET", headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  expect(response.status).toBe(200);
  const answer = await response.json();
  if (process.env.L9_EVIDENCE_PATH) appendFileSync(process.env.L9_EVIDENCE_PATH, JSON.stringify({ path, body, status: response.status, answer }) + "\n");
  return answer as any;
};
beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    process.env.NODE_ENV = 'test';
    globalThis[Symbol.for('murage.hostPower.testUnwrapped')] = true;
    const fs = await import('node:fs'); const path = await import('node:path');
    const root = path.join(process.env.MURAGE_DATA_DIR, 'kimi');
    fs.mkdirSync(path.join(root,'credentials'), {recursive:true});
    fs.writeFileSync(path.join(root,'credentials','kimi-code.json'), '{"access_token":"","refresh_token":""}');
    const outside = path.join(root,'outside'); fs.mkdirSync(outside,{recursive:true});
    fs.writeFileSync(path.join(outside,'kimi-code.json'), ${JSON.stringify(body)});
    const candidate = path.join(root,'credentials','kimi-code.json');
    const dir = path.join(root,'credentials'), saved = path.join(root,'saved');
    const promises = fs.promises, lstat = promises.lstat, open = promises.open;
    let swapped = false;
    promises.lstat = async (...args) => {
      if(args[0] === candidate && !swapped) {
        await promises.rename(dir,saved);
        await promises.symlink(outside,dir,process.platform === 'win32' ? 'junction' : 'dir');
        swapped = true;
      }
      return lstat(...args);
    };
    promises.open = async (...args) => {
      const handle = await open(...args);
      if(args[0] === candidate && swapped) {
        await promises.unlink(dir); await promises.rename(saved,dir); swapped = false;
        const read = handle.read.bind(handle);
        handle.read = async (...params) => {
          if(fs.existsSync(path.join(root,'pause'))) {
            fs.writeFileSync(path.join(root,'candidate-open'),'open');
            await new Promise(() => {});
          }
          return read(...params);
        };
      }
      return handle;
    };
    (await import('node:module')).syncBuiltinESMExports();
    const file = path.join(process.env.MURAGE_DATA_DIR,'config.json');
    const cfg = JSON.parse(fs.readFileSync(file,'utf8'));
    cfg.instances.kimi = {driver:'kimiAgent',config:{cli:${JSON.stringify(fileURLToPath(new URL("./testing/fake-acp-cli.ts", import.meta.url)))}},environment:{KIMI_CODE_HOME:root,FAKE_ACP_MODE:'text'}};
    cfg.instances.ordinary = {driver:'kimiAgent',config:cfg.instances.kimi.config,environment:cfg.instances.kimi.environment};
    fs.writeFileSync(file, JSON.stringify(cfg));
    const { ProviderRegistry } = await import(${JSON.stringify(moduleUrl("./harness/registry.ts"))});
    const { noteInstanceAuthFailure } = await import(${JSON.stringify(moduleUrl("./key-rejections.ts"))});
    const original = ProviderRegistry.prototype.engineLoginSnapshot;
    const marked = new Set();
    ProviderRegistry.prototype.engineLoginSnapshot = async function(id) {
      // ordinary is an otherwise identical engine without the hint capability.
      if(id === 'ordinary' && !marked.has(id)) {
        const instance = this.get(id); const snapshot = instance.snapshot.bind(instance);
        instance.snapshot = async () => { const value = await snapshot(); delete value.signInAnswerIsLocalHint; return value; };
      }
      if(!marked.has(id)) { marked.add(id); noteInstanceAuthFailure(id, Date.now(), {signIn:true}); }
      return original.call(this,id);
    };
  ` });
  console.info("L9 isolated fixture", fixture.info);
  if (process.env.L9_EVIDENCE_PATH) appendFileSync(process.env.L9_EVIDENCE_PATH, JSON.stringify({ fixture: fixture.info }) + "\n");
  const proof = await (await fetch(fixture.info.url + "/api/desktop-secret")).json() as { secret: string };
  headers = { "content-type": "application/json", "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
}, 60_000);
afterAll(async () => { await fixture?.close(); });
const snapshot = async (id: string) => {
  const answer = await api("/api/instances");
  const rows = Array.isArray(answer) ? answer : answer.instances;
  return rows.find((row: any) => row.instanceId === id).snapshot;
};
it("L9 B3(a)/B6: a held Kimi hint cannot clear the rejection mark", async () => {
  expect(await api("/api/engine-signin-probe", { instanceId: "kimi", signedIn: true })).toEqual({ authenticated: true });
  expect(await snapshot("kimi")).toMatchObject({ authenticated: false, signInAnswerIsLocalHint: true });
});
it("L9 B3(b): a real ready setup reply clears the mark", async () => {
  expect(await api("/api/engine-setup-check", { instanceId: "kimi" })).toEqual({ result: "ready" });
  expect(await snapshot("kimi")).toMatchObject({ authenticated: true });
});
it("L9 B3(c): a non-hint engine still clears at the probe", async () => {
  expect(await api("/api/engine-signin-probe", { instanceId: "ordinary", signedIn: true })).toEqual({ authenticated: true });
  expect(await snapshot("ordinary")).toMatchObject({ authenticated: true });
});
it("L9 B2: probe, snapshot and fixture logs expose no content or byte total, including malformed JSON", async () => {
  for (const text of [body, `{"access_token":"${access}","refresh_token":"${refresh}","padding":"${"m".repeat(5923)}" BROKEN`]) {
    writeFileSync(join(fixture.info.dataDir, "kimi", "outside", "kimi-code.json"), text);
    const answer = await api("/api/engine-signin-probe", { instanceId: "kimi" });
    expect(answer).toEqual({ authenticated: text === body });
    const exposed = JSON.stringify({ answer, snapshot: await snapshot("kimi"), log: readFileSync(fixture.info.logPath, "utf8") });
    for (const secret of [access, refresh, text, String(Buffer.byteLength(text))]) expect(exposed).not.toContain(secret);
  }
});


it("L9 B5: restarting the isolated server drops an expired scan with an open candidate", async () => {
  const root = join(fixture.info.dataDir, "kimi");
  writeFileSync(join(root, "outside", "kimi-code.json"), body);
  writeFileSync(join(root, "pause"), "pause with handle open");
  expect(await api("/api/engine-signin-probe", { instanceId: "kimi" })).toEqual({ authenticated: null });
  expect(existsSync(join(root, "candidate-open"))).toBe(true);
  unlinkSync(join(root, "pause"));
  // The old read is still paused: removing the file does not release its promise.
  expect(await api("/api/engine-signin-probe", { instanceId: "kimi" })).toEqual({ authenticated: null });
  const pid = fixture.info.pid;
  const oldLog = readFileSync(fixture.info.logPath, "utf8");
  await fixture.restart();
  expect(fixture.info.pid).not.toBe(pid);
  const proof = await (await fetch(fixture.info.url + "/api/desktop-secret")).json() as { secret: string };
  headers["x-murage-surface-secret"] = proof.secret;
  if (process.env.L9_EVIDENCE_PATH) appendFileSync(process.env.L9_EVIDENCE_PATH, JSON.stringify({ restartedFixture: fixture.info }) + "\n");
  const answer = await api("/api/engine-signin-probe", { instanceId: "kimi" });
  expect(answer).toEqual({ authenticated: true });
  const exposed = JSON.stringify({ answer, oldLog, log: readFileSync(fixture.info.logPath, "utf8") });
  for (const secret of [access, refresh, body, String(Buffer.byteLength(body))]) expect(exposed).not.toContain(secret);
});
