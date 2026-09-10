import { app, BrowserWindow, ipcMain, session } from "electron";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, createCipheriv, createDecipheriv, createHash } from "node:crypto";
import { mutateFluxCredentials } from "../electron/flux-connection-control.mjs";
import { createSecureCredentialState } from "../electron/secure-credential-state.mjs";
import { workspaceCredentialEnv } from "../electron/workspace-credentials.mjs";

const contextPath = process.env.MURAGE_FLUX_NATIVE_CONTEXT;
assert.ok(contextPath, "Run via the native fixture runner");
const context = JSON.parse(fs.readFileSync(contextPath, "utf8"));
assert.equal(fs.realpathSync(path.dirname(context.scratch)), fs.realpathSync(tmpdir()));
assert.ok(path.basename(context.scratch).startsWith("murage-flux-native-"));
app.setPath("userData", path.join(context.scratch, "user-data"));
app.commandLine.appendSwitch("disable-background-networking");
let window;
const checks = [];
let report = { passed: false };
const watchdog = setTimeout(() => { console.error("Native fixture deadline"); app.exit(1); }, 55_000);
app.on("window-all-closed", () => {});

// Callback startup deliberately avoids Electron's top-level-await readiness deadlock.
void app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith("data:") && !details.url.startsWith("file:") }));
  const bank = JSON.stringify([{ id: "other-native", preset: "mistral", label: "Other fixture", enabled: false, key: "FAKE_OTHER_NATIVE", revision: "other-revision" }]);
  const aliases = JSON.stringify([{ id: "old-native-flux", label: "Historical", enabled: false, revision: "old-revision" }]);
  const initial = { fluxApiKey: "sk-flux-FAKE_NATIVE_ORIGINAL", modelProviderConnections: bank, fluxConnectionAliases: aliases, fluxConnectionManaged: "true", unrelated: "PRESERVED_FIXTURE" };
  const credentialsFile = path.join(context.scratch, "credentials.bin");
  const encryptionKey = randomBytes(32);
  let available = true, encryptions = 0, lostAck = false, pause;
  const safeStorage = {
    isAsyncEncryptionAvailable: async () => available,
    encryptStringAsync: async text => {
      if (pause) { const pending = pause; pause = undefined; pending.enter(); await pending.wait; }
      encryptions++;
      const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
      const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
  };
  const readDocument = () => {
    const bytes = fs.readFileSync(credentialsFile), decipher = createDecipheriv("aes-256-gcm", encryptionKey, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"));
  };
  const rawFetch = globalThis.fetch;
  const transport = async (url, options) => {
    assert.equal(new URL(url).origin, context.url);
    const response = await rawFetch(url, options);
    if (lostAck && JSON.parse(options.body).phase === "commit" && response.ok) { lostAck = false; await response.arrayBuffer(); throw Error("Injected lost commit acknowledgement"); }
    return response;
  };
  const source = fs.readFileSync(path.join(context.root, "electron/main.mjs"), "utf8");
  const extract = (start, end) => {
    assert.equal(source.split(start).length, 2); assert.equal(source.split(end).length, 2);
    const text = source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
    assert.ok(text.length > 50); return text;
  };
  const saveSource = extract("async function saveSecureCredentials(credentials)", "async function secureComposioConfig()");
  const updateSource = extract("export async function updateSecureCredentialDocument(derive, afterPersist)", "function publicManagedCompanionState()").replace("export async", "async");
  const handlerSource = extract('ipcMain.handle("flux-connection:mutate"', 'ipcMain.handle("model-provider:mutate"');
  const install = new Function("ipcMain", "safeStorage", "fs", "path", "mutateFluxCredentials", "createSecureCredentialState", "fetch", "context", "initial", `
    const app={isPackaged:true};
    const CREDENTIALS_FILE=context.credentialsFile,SERVER_PORT=new URL(context.url).port,modelProviderCommitToken=context.token;
    let desktopSurfaceSecret=context.proof,credentialStoreUnavailable=false,secureCredentials=initial;
    const credentialWrites=new Set();
    const assertDesktopStartupActive=()=>{},ownedDesktopDataDir=()=>context.scratch;
    ${saveSource}
    const secureCredentialState=createSecureCredentialState(initial,saveSecureCredentials);
    ${updateSource}
    ${handlerSource}
    return {seed:()=>saveSecureCredentials(initial),setProof:value=>{desktopSurfaceSecret=value;},writes:()=>credentialWrites.size};
  `);
  const installed = install(ipcMain, safeStorage, fs, path, mutateFluxCredentials, createSecureCredentialState, transport, { ...context, credentialsFile }, initial);
  await installed.seed();
  ipcMain.on("desktop:surface-secret", event => { event.returnValue = context.proof; });
  window = new BrowserWindow({ show: false, webPreferences: { preload: path.join(context.root, "electron/preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const pageErrors = [];
  window.webContents.on("preload-error", (_event, _path, error) => pageErrors.push(error.message));
  await window.loadURL("data:text/html,<html><body>Native Flux verification</body></html>");
  assert.equal(await window.webContents.executeJavaScript('typeof window.muragebox.mutateFluxConnection === "function" && typeof window.require === "undefined" && typeof process === "undefined"'), true);
  const api = async (method, endpoint, body) => {
    const response = await rawFetch(context.url + endpoint, { method, headers: { "x-murage-surface": "desktop", "x-murage-surface-secret": context.proof, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const status = async () => { const result = await api("GET", "/api/flux-connection"); assert.equal(result.status, 200); return result.body; };
  const invoke = input => window.webContents.executeJavaScript(`window.muragebox.mutateFluxConnection(${JSON.stringify(input)}).then(value=>({ok:true,value}),error=>({ok:false,message:String(error.message)}))`);
  const replace = async key => invoke({ action: "replace", revision: (await status()).revision, key });
  const ensureSafe = result => { assert.equal(JSON.stringify(result).includes("FAKE_"), false); assert.equal(JSON.stringify(result).includes("PRESERVED_FIXTURE"), false); };
  const originalBytes = fs.readFileSync(credentialsFile);
  installed.setProof(""); assert.equal((await replace("sk-flux-FAKE_NO_PROOF")).ok, false); installed.setProof(context.proof);
  assert.deepEqual(fs.readFileSync(credentialsFile), originalBytes);
  checks.push("actual-sandboxed-preload-ipc-and-proof-refusal");

  let entered; const entering = new Promise(resolve => { entered = resolve; });
  let release; const waiting = new Promise(resolve => { release = resolve; });
  pause = { enter: entered, wait: waiting };
  const changing = replace("sk-flux-FAKE_NATIVE_NEXT");
  await entering;
  const blocked = await api("POST", "/api/flux-connection/mutate", { action: "disconnect", revision: (await status()).revision });
  assert.equal(blocked.status, 409); release();
  const changed = await changing; assert.equal(changed.ok, true); ensureSafe(changed);
  const document = readDocument(); assert.equal(document.fluxApiKey, "sk-flux-FAKE_NATIVE_NEXT"); assert.equal(document.modelProviderConnections, bank); assert.equal(document.fluxConnectionAliases, aliases); assert.equal(document.unrelated, initial.unrelated);
  assert.equal(fs.readFileSync(credentialsFile).includes(Buffer.from("FAKE_")), false);
  const config = JSON.parse(fs.readFileSync(path.join(context.dataDir, "config.json"), "utf8")); assert.equal(config.flux.apiKey, ""); assert.equal(config.modelProviders.bank, "");
  assert.equal((await status()).revision, changed.value.revision); assert.equal(installed.writes(), 0);
  checks.push("native-atomic-two-slot-alias-save-and-reservation-fence");

  const created = await api("POST", "/api/bots", { name: "Native busy fixture" });
  assert.equal(created.status, 201); const bot = created.body.bot;
  const sent = await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "__fixture_hold_authority__" }); assert.equal(sent.status, 202);
  const beforeBusy = fs.readFileSync(credentialsFile), count = encryptions, busyRevision = (await status()).revision;
  const busyResult = await replace("sk-flux-FAKE_BUSY_REFUSED"); assert.equal(busyResult.ok, false); assert.match(busyResult.message, /running work/);
  assert.equal(encryptions, count); assert.deepEqual(fs.readFileSync(credentialsFile), beforeBusy); assert.equal((await status()).revision, busyRevision);
  assert.equal((await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId })).status, 200);
  checks.push("actual-held-fake-task-refuses-before-encrypted-write-and-stops");

  const beforeRollback = readDocument(), rollbackRevision = (await status()).revision;
  lostAck = true; const rolledBack = await replace("sk-flux-FAKE_ROLLBACK"); assert.equal(rolledBack.ok, false); ensureSafe(rolledBack);
  assert.deepEqual(readDocument(), beforeRollback); assert.equal((await status()).revision, rollbackRevision);
  const afterRollback = await replace("sk-flux-FAKE_AFTER_ROLLBACK"); assert.equal(afterRollback.ok, true); ensureSafe(afterRollback);
  checks.push("native-lost-real-commit-ack-restores-document-and-runtime");

  const unavailableBytes = fs.readFileSync(credentialsFile), unavailableRevision = (await status()).revision;
  available = false; assert.equal((await replace("sk-flux-FAKE_UNAVAILABLE")).ok, false); available = true;
  assert.deepEqual(fs.readFileSync(credentialsFile), unavailableBytes); assert.equal((await status()).revision, unavailableRevision);
  const disconnected = await invoke({ action: "disconnect", revision: unavailableRevision }); assert.equal(disconnected.ok, true); assert.equal(disconnected.value.configured, false); ensureSafe(disconnected);
  const final = readDocument(); assert.equal(final.fluxApiKey, ""); assert.equal(final.modelProviderConnections, bank); assert.equal(final.fluxConnectionAliases, aliases); assert.equal(workspaceCredentialEnv(final).FLUX_API_KEY, "");
  assert.equal((await api("GET", "/api/provider-connections/old-native-flux/catalog")).status, 404);
  checks.push("unavailable-custody-refusal-and-native-managed-disconnect");
  assert.deepEqual(pageErrors, []);
  report = { passed: true, candidate: context.candidate, platform: process.platform, arch: process.arch, electron: process.versions.electron, node: process.versions.node, checks, providerCalls: 0, sourceHashes: { preload: createHash("sha256").update(fs.readFileSync(path.join(context.root, "electron/preload.cjs"))).digest("hex"), handlers: createHash("sha256").update(saveSource + updateSource + handlerSource).digest("hex") }, encryption: "fixture AES-GCM adapter; Electron safeStorage and OS keychain not called", limitation: "Actual native preload/IPC and production extracted handler/store functions with packaged branch injection; no full packaged startup, OS encryption or cross-platform qualification." };
}).catch(error => { report = { passed: false, checks, error: String(error.message).replace(/sk-flux-[A-Za-z0-9_-]+|FAKE_[A-Za-z0-9_-]+/g, "[fixture-key]") }; }).finally(() => {
  clearTimeout(watchdog);
  fs.writeFileSync(path.join(context.evidence, "result.json"), JSON.stringify(report, null, 2));
  if (window && !window.isDestroyed()) window.destroy();
  console.log(JSON.stringify(report));
  app.exit(report.passed ? 0 : 1);
});
