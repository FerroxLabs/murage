// Gate M5 small cut (1.0.12, designs/FLUX-KEY-SMALL-M5-1012.md), on the real
// server over HTTP:
//   1. a Flux key save leaves no stale copy in any store (encrypted document,
//      config.json, the connection bank, the server env and memory);
//   2. a restart with a stale shell FLUX_API_KEY uses the saved key;
//   3. the server says a restart is needed after a key change, and not after
//      a first connect.
// The Electron half runs in-process: the real mutateFluxCredentials over the
// real secure credential state, posting to the real commit-token routes.
import { afterEach, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";
import { createSecureCredentialState } from "../electron/secure-credential-state.mjs";
import { mutateFluxCredentials } from "../electron/flux-connection-control.mjs";
import { desktopFluxEnvironment, workspaceCredentialEnv } from "../electron/workspace-credentials.mjs";

const TOKEN = "c".repeat(64);
const OLD = "sk-flux-FAKE_STALE_OLD", NEXT = "sk-flux-FAKE_SAVED_NEXT", SHELL = "sk-flux-FAKE_STALE_SHELL";
const FLUX_CONFIG = pathToFileURL(fileURLToPath(new URL("./flux-config.ts", import.meta.url))).href;
const OTHER_ROW = { id: "other-provider", preset: "mistral", label: "Other", enabled: false, key: "FAKE_OTHER_ONLY", revision: "other" };
const OLD_FLUX_ROW = { id: "old-flux", preset: "flux", label: "Old account", enabled: true, key: OLD, revision: "original" };

type Server = { fixture: VerificationServer; headers: Record<string, string> };
const running: VerificationServer[] = [];
afterEach(async () => { while (running.length) await running.pop()!.close(); });

/** Instrumentation: the fixture config and env, a Flux Router stand-in that
 * logs every bearer, and a dump of what the server process holds. */
function instrumentation(config: Record<string, unknown>, env: Record<string, string | null>) {
  return `
    import { appendFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const dir=process.env.MURAGE_DATA_DIR, file=join(dir,'config.json');
    const cfg=JSON.parse(readFileSync(file,'utf8')); Object.assign(cfg, ${JSON.stringify(config)}); writeFileSync(file, JSON.stringify(cfg));
    for (const [name,value] of Object.entries(${JSON.stringify(env)})) { if (value===null) delete process.env[name]; else process.env[name]=value; }
    process.env.MURAGE_MODEL_PROVIDER_COMMIT_TOKEN='${TOKEN}';
    const originalFetch=globalThis.fetch;
    globalThis.fetch=(input,init)=>{
      const url=String(input);
      if(url.startsWith('https://api.fluxrouter.ai/')){
        const auth=new Headers(init?.headers).get('authorization')??'';
        appendFileSync(join(dir,'bearers.log'), auth.replace(/^Bearer /,'')+'\\n');
        if(url==='https://api.fluxrouter.ai/v1/models')return Promise.resolve(new Response(JSON.stringify({data:[{id:'flux-fast'},{id:'flux-standard'}]})));
        return Promise.resolve(new Response('{}',{status:404}));
      }
      if(url.startsWith('https://'))return Promise.reject(new TypeError('External network blocked in fixture'));
      return originalFetch(input,init);
    };
    const flux=await import(${JSON.stringify(FLUX_CONFIG)});
    setInterval(()=>{
      const dump={effective:flux.fluxKey()??'',env:{FLUX_API_KEY:process.env.FLUX_API_KEY??null,MURAGE_MODEL_PROVIDER_CONNECTIONS:process.env.MURAGE_MODEL_PROVIDER_CONNECTIONS??null,MURAGE_FLUX_AMBIENT_KEY:process.env.MURAGE_FLUX_AMBIENT_KEY??null}};
      writeFileSync(join(dir,'held.json.tmp'),JSON.stringify(dump)); renameSync(join(dir,'held.json.tmp'),join(dir,'held.json'));
    },100).unref();
  `;
}

async function launch(config: Record<string, unknown>, env: Record<string, string | null>): Promise<Server> {
  const fixture = await launchVerificationServer({}, undefined, { instrumentationSource: instrumentation(config, env) });
  running.push(fixture);
  const proof = await fetch(fixture.info.url + "/api/desktop-secret").then(response => response.json() as Promise<{ secret: string }>);
  return { fixture, headers: { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret } };
}
async function api(server: Server, method: string, path: string, body?: unknown, privateRoute = false) {
  const response = await fetch(server.fixture.info.url + path, { method, headers: { ...server.headers, ...(privateRoute ? { authorization: `Bearer ${TOKEN}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
}
const readText = (server: Server, name: string) => { const file = join(server.fixture.info.dataDir, name); return existsSync(file) ? readFileSync(file, "utf8") : ""; };
const savedConfig = (server: Server) => JSON.parse(readText(server, "config.json"));
/** What the server process holds, once it holds `effective`. */
async function held(server: Server, effective: string) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const text = readText(server, "held.json");
    if (text) { const dump = JSON.parse(text); if (dump.effective === effective || Date.now() > deadline) return dump; }
    else if (Date.now() > deadline) throw new Error("the server never reported what it holds");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
/** Bearers Flux Router saw during a key test. */
async function testBearers(server: Server) {
  const before = readText(server, "bearers.log").length;
  const tested = await api(server, "POST", "/api/flux-connection/test", {});
  return { tested, bearers: readText(server, "bearers.log").slice(before).split("\n").filter(Boolean) };
}
/** The desktop half: the encrypted document and the real mutate road. */
function desktop(server: Server, initial: Record<string, string>) {
  let disk = structuredClone(initial);
  const secure = createSecureCredentialState(disk, async value => { disk = structuredClone(value); });
  const post = async (route: string, body: unknown) => {
    const answer = await api(server, "POST", route, body, true);
    if (answer.status !== 200) throw Object.assign(new Error(answer.body.error), { status: answer.status });
    return answer.body;
  };
  return {
    mutate: (input: unknown) => mutateFluxCredentials(input, { packaged: true, updateDocument: (derive, afterPersist) => secure.update(derive, afterPersist), post }),
    disk: () => disk,
  };
}

it("a desktop save leaves no stale copy in the store, config.json, the bank or the server, and asks for a restart", async () => {
  // Every old copy holds the SAME old key, so the replace is not conflict-refused.
  const bank = JSON.stringify([OLD_FLUX_ROW, OTHER_ROW]);
  const server = await launch({ flux: { apiKey: OLD } }, { FLUX_API_KEY: OLD, MURAGE_MODEL_PROVIDER_CONNECTIONS: bank });
  const shell = desktop(server, { unrelated: "PRESERVE", fluxApiKey: OLD, modelProviderConnections: bank });
  const before = await api(server, "GET", "/api/flux-connection");
  expect(before.body).toMatchObject({ configured: true, conflict: false, restartRequired: false });

  const status = await shell.mutate({ action: "replace", revision: before.body.revision, key: NEXT }) as any;
  expect(status.restartRequired).toBe(true);
  expect(JSON.stringify(status)).not.toContain("FAKE");

  // The encrypted document: the new key, managed, no flux row in the bank, the old row only as a keyless alias.
  const disk = shell.disk();
  expect(disk).toMatchObject({ unrelated: "PRESERVE", fluxApiKey: NEXT, fluxConnectionManaged: "true" });
  expect(JSON.parse(disk.modelProviderConnections).map((row: any) => row.id)).toEqual(["other-provider"]);
  expect(JSON.parse(disk.fluxConnectionAliases).map((row: any) => row.id)).toEqual(["old-flux"]);
  expect(JSON.stringify(disk)).not.toContain(OLD);
  // config.json: tombstones only.
  const config = savedConfig(server);
  expect(config.flux.apiKey).toBe(""); expect(config.modelProviders.bank).toBe("");
  expect(JSON.stringify(config)).not.toContain(OLD);
  // The server process: env and the read-through key.
  const inServer = await held(server, NEXT);
  expect(inServer.effective).toBe(NEXT);
  expect(inServer.env.FLUX_API_KEY).toBe(NEXT);
  expect(inServer.env.MURAGE_FLUX_AMBIENT_KEY).toBeNull();
  expect(JSON.stringify(inServer)).not.toContain(OLD);
  expect(JSON.parse(inServer.env.MURAGE_MODEL_PROVIDER_CONNECTIONS).map((row: any) => row.id)).toEqual(["other-provider"]);
  const listed = await api(server, "GET", "/api/provider-connections");
  expect(listed.body.connections.filter((row: any) => row.preset === "flux").map((row: any) => row.id)).toEqual(["legacy-flux"]);
  // The live key is the new one on the wire.
  const { tested, bearers } = await testBearers(server);
  expect(tested.body).toEqual({ modelCount: 2 });
  expect(bearers.length).toBeGreaterThan(0);
  expect(new Set(bearers)).toEqual(new Set([NEXT]));
  // The prompt survives a Settings reload.
  expect((await api(server, "GET", "/api/flux-connection")).body.restartRequired).toBe(true);
}, 120_000);

it("a config-only save rewrites config.json; a first connect needs no restart, a replace does", async () => {
  const server = await launch({}, { FLUX_API_KEY: null });
  const empty = await api(server, "GET", "/api/flux-connection");
  expect(empty.body).toMatchObject({ configured: false, restartRequired: false });
  const connected = await api(server, "POST", "/api/flux-connection/mutate", { action: "connect", revision: empty.body.revision, key: OLD });
  expect(connected.status).toBe(200);
  expect(connected.body.restartRequired).toBe(false);
  expect(savedConfig(server).flux.apiKey).toBe(OLD);

  const replaced = await api(server, "POST", "/api/flux-connection/mutate", { action: "replace", revision: connected.body.revision, key: NEXT });
  expect(replaced.status).toBe(200);
  expect(replaced.body.restartRequired).toBe(true);
  const config = savedConfig(server);
  expect(config.flux.apiKey).toBe(NEXT);
  expect(JSON.stringify(config)).not.toContain(OLD);
  const inServer = await held(server, NEXT);
  expect(inServer.effective).toBe(NEXT);
  expect(JSON.stringify(inServer)).not.toContain(OLD);
  const { bearers } = await testBearers(server);
  expect(new Set(bearers)).toEqual(new Set([NEXT]));
}, 120_000);

it("a restart with a stale shell FLUX_API_KEY uses the saved key", async () => {
  // What a desktop save leaves behind (the first test's shape): the managed store
  // holds NEXT, config.json holds tombstones. The shell that starts Murage still
  // exports an old key.
  const store = { fluxApiKey: NEXT, fluxConnectionManaged: "true", modelProviderConnections: JSON.stringify([OTHER_ROW]), fluxConnectionAliases: "[]" };
  const child = { ...desktopFluxEnvironment({ PATH: "/bin", FLUX_API_KEY: SHELL }, store), ...workspaceCredentialEnv(store) };
  expect(child.FLUX_API_KEY).toBe(NEXT);
  const server = await launch({ flux: { apiKey: "", connectionAliases: [] }, modelProviders: { bank: "" } }, {
    FLUX_API_KEY: child.FLUX_API_KEY ?? null,
    MURAGE_FLUX_AMBIENT_KEY: child.MURAGE_FLUX_AMBIENT_KEY ?? null,
    MURAGE_FLUX_CONNECTION_ALIASES: child.MURAGE_FLUX_CONNECTION_ALIASES ?? null,
    MURAGE_MODEL_PROVIDER_CONNECTIONS: child.MURAGE_MODEL_PROVIDER_CONNECTIONS ?? null,
  });
  const inServer = await held(server, NEXT);
  expect(inServer.effective).toBe(NEXT);
  expect(JSON.stringify(inServer)).not.toContain(SHELL);
  const status = await api(server, "GET", "/api/flux-connection");
  expect(status.body).toMatchObject({ configured: true, conflict: false, restartRequired: false });
  const { bearers } = await testBearers(server);
  expect(new Set(bearers)).toEqual(new Set([NEXT]));
  // A commit the desktop then rolls back (its document write failed) asks for no restart.
  const reserved = await api(server, "POST", "/api/flux-connection/replace", { phase: "begin", input: { action: "replace", revision: status.body.revision, key: OLD } }, true);
  expect(reserved.status).toBe(200);
  const committed = await api(server, "POST", "/api/flux-connection/replace", { phase: "commit", lease: reserved.body.lease }, true);
  expect(committed.body.restartRequired).toBe(true);
  expect((await api(server, "POST", "/api/flux-connection/replace", { phase: "rollback", lease: reserved.body.lease }, true)).status).toBe(200);
  expect((await api(server, "POST", "/api/flux-connection/replace", { phase: "finish", lease: reserved.body.lease }, true)).status).toBe(200);
  expect((await api(server, "GET", "/api/flux-connection")).body.restartRequired).toBe(false);
  expect((await held(server, NEXT)).effective).toBe(NEXT);
}, 120_000);

it("removing a key that lived only in an enabled bank row asks for a restart; a disabled row does not", async () => {
  for (const [enabled, expected] of [[true, true], [false, false]] as const) {
    const bank = JSON.stringify([{ ...OLD_FLUX_ROW, enabled }, OTHER_ROW]);
    const server = await launch({}, { FLUX_API_KEY: null, MURAGE_MODEL_PROVIDER_CONNECTIONS: bank });
    const status = await api(server, "GET", "/api/flux-connection");
    expect(status.body.restartRequired).toBe(false);
    const removed = await api(server, "POST", "/api/flux-connection/mutate", { action: "disconnect", revision: status.body.revision });
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ configured: false, restartRequired: expected });
    expect(JSON.stringify(savedConfig(server))).not.toContain(OLD);
    await new Promise(resolve => setTimeout(resolve, 400)); // past the next dump of the server's state
    expect(JSON.stringify(await held(server, ""))).not.toContain(OLD);
    await running.pop()!.close();
  }
}, 120_000);

it("with no stored key, the key saved in config.json beats a stale shell key, which is only offered as a choice", async () => {
  const child = { ...desktopFluxEnvironment({ PATH: "/bin", FLUX_API_KEY: SHELL }, {}), ...workspaceCredentialEnv({}) };
  expect(Object.hasOwn(child, "FLUX_API_KEY")).toBe(false);
  const server = await launch({ flux: { apiKey: NEXT } }, { FLUX_API_KEY: null, MURAGE_FLUX_AMBIENT_KEY: child.MURAGE_FLUX_AMBIENT_KEY ?? null });
  const inServer = await held(server, NEXT);
  expect(inServer.effective).toBe(NEXT);
  expect(inServer.env.FLUX_API_KEY).toBeNull();
  const status = await api(server, "GET", "/api/flux-connection");
  expect(status.body.conflict).toBe(true);
  expect(status.body.choices.map((choice: any) => choice.id)).toContain("legacy-flux-environment");
  expect(JSON.stringify(status.body)).not.toContain("FAKE");
  // Nothing is sent until the owner chooses.
  expect((await testBearers(server)).tested.status).toBe(409);
}, 120_000);
