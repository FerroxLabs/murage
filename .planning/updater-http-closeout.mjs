import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { freePortBlock } from "../server/testing/ports.ts";
import { nativeFixtureBinary } from "../server/testing/fuigo-native-fixture.ts";
import { DEFAULT_INSTANCES } from "../server/default-instances.ts";
import { safeWipe } from "../server/testing/safe-wipe.mjs";

const root = await mkdtemp(join(tmpdir(), "murage-updater-http-")), data = join(root, "data"), bundle = join(root, "bundle");
const port = await freePortBlock([0, 1]);
const secret = "0123456789abcdef".repeat(4), base = `http://127.0.0.1:${port}`;
const headers = { "content-type": "application/json", "x-murage-surface": "desktop", "x-murage-surface-secret": secret };
const initialCli = join(root, "custom-cli"), bundledCli = join(bundle, "fuigo");
await mkdir(data); await mkdir(bundle); await mkdir(join(root, "static"));
await writeFile(join(root, "static", "index.html"), "<!doctype html><title>Updater fixture</title>");
await writeFile(initialCli, "preserved-custom-engine"); await writeFile(bundledCli, nativeFixtureBinary("darwin-arm64"));
const instances = Object.fromEntries(Object.entries(DEFAULT_INSTANCES).map(([id, item]) => [id, { ...item, enabled: false }]));
instances.fuigo.config = { cli: initialCli };
await writeFile(join(data, "config.json"), JSON.stringify({ instances }), { mode: 0o600 });
const result = { startedAt: new Date().toISOString(), sourceCandidate: "ca190343", node: process.version, root, port,
  authority: "real server/index.ts owner HTTP routes, config persistence and provider reload callback",
  fixtureBoundary: "disabled engine fleet; fake registry bytes and injected FuigoProbe; actual native proof is separate", cases: [] };
const child = spawn(process.execPath, ["--import", fileURLToPath(new URL("./updater-http-preload.mjs", import.meta.url)), "server/index.ts"], {
  cwd: fileURLToPath(new URL("../", import.meta.url)),
  env: { HOME: root, USERPROFILE: root, PATH: "", MURAGE_DATA_DIR: data, MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1),
    MURAGE_FUIGO_DIR: bundle, MURAGE_STATIC_DIR: join(root, "static"), MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1", MURAGE_DEV_DESKTOP_SECRET: secret },
  stdio: ["ignore", "pipe", "pipe", "ipc"],
});
result.pid = child.pid;
let stdout = "", stderr = "", ready = false, controlId = 0;
const pending = new Map();
child.stdout.on("data", chunk => { stdout = (stdout + chunk).slice(-20000); });
child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-20000); });
child.on("message", message => {
  if (message.fixture === "ready") ready = true;
  if (message.fixture === "reply") {
    const item = pending.get(message.id); if (!item) return; pending.delete(message.id); clearTimeout(item.timer);
    message.error ? item.reject(new Error(message.error)) : item.resolve(message.state);
  }
});
const control = value => new Promise((resolve, reject) => {
  const id = ++controlId, timer = setTimeout(() => { pending.delete(id); reject(new Error("Fixture IPC timeout")); }, 5000);
  pending.set(id, { resolve, reject, timer }); child.send({ fixture: "control", id, ...value });
});
const api = async (body, customHeaders = headers, method = "POST") => {
  const response = await fetch(`${base}/api/engine-management/fuigo`, { method, headers: customHeaders,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
  return { status: response.status, body: await response.json() };
};
const selected = async () => JSON.parse(await readFile(join(data, "config.json"), "utf8")).instances.fuigo.config.cli;
const hash = async path => createHash("sha256").update(await readFile(path)).digest("hex");
try {
  const deadline = Date.now() + 30000;
  while (!ready) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Fixture server exited: ${stderr}`);
    if (Date.now() > deadline) throw new Error(`Fixture server startup timed out: ${stderr}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const health = await fetch(`${base}/api/health`).then(response => response.json()); assert.equal(health.pid, child.pid);
  assert.equal((await api({ action: "check" })).status, 200); assert.equal(await selected(), initialCli);
  assert.equal((await api({ action: "install" })).status, 500); assert.equal(await selected(), initialCli);
  assert.equal((await control({})).downloads, 0);
  assert.equal((await api({ action: "update", cli: "/not-allowed" })).status, 400);
  assert.equal((await api({ action: "check" }, { ...headers, "content-type": "text/plain" })).status, 415);
  result.cases.push("owner metadata check; custom selection preserved; strict action body and content type");
  assert.equal((await api({ action: "use-managed" })).status, 200); const first = await selected(); const firstHash = await hash(first);
  await control({ version: "1.0.10" }); assert.equal((await api({ action: "update" })).status, 200); const second = await selected(); const secondHash = await hash(second);
  assert.notEqual(first, second); assert.equal((await api(undefined, headers, "GET")).body.rollbackAvailable, true);
  assert.equal((await api({ action: "rollback" })).status, 200); assert.equal(await selected(), first);
  assert.equal((await api({ action: "use-bundled" })).status, 200); assert.equal(await selected(), bundledCli);
  result.cases.push("use-managed A; update B; rollback A; use-bundled with actual persisted config and provider reload");
  const beforeBusy = await control({ busy: true }); assert.equal(beforeBusy.directRuns, 1); assert.equal(beforeBusy.primaryBotBusy, false);
  assert.equal((await api({ action: "update" })).status, 500); assert.equal(await selected(), bundledCli);
  const afterBusy = await control({ busy: false }); assert.equal(afterBusy.downloads, beforeBusy.downloads);
  result.cases.push("independent thread blocks initial update even while primary bot busy flag is false");
  for (const mode of ["probe-busy", "root-busy", "probe-stale", "root-stale"]) {
    await control({ mode, cli: bundledCli, busy: false });
    const failure = await api({ action: "update" }); assert.equal(failure.status, 500);
    const state = await control({}); assert.equal(state.providerConfigBusy, false);
    assert.equal(await selected(), mode.endsWith("stale") ? join(data, "concurrent-choice") : bundledCli);
    if (mode === "probe-stale") assert.match(failure.body.error, /selected Fuigo engine changed/);
    if (mode.startsWith("root-")) assert.match(failure.body.error, /activation did not complete/);
    result.cases.push(`${mode}: refused before persistence; concurrent selection or prior bundle preserved`);
  }
  await control({ mode: "normal", cli: bundledCli, busy: false, failReload: true });
  const reloadFailure = await api({ action: "update" }); assert.equal(reloadFailure.status, 500);
  assert.equal(await selected(), bundledCli); assert.equal((await control({})).providerConfigBusy, false);
  result.cases.push("provider reload failure rolls actual persisted CLI back and releases config mutation gate");
  await control({ mode: "normal" }); assert.equal((await api({ action: "update" })).status, 200);
  assert.notEqual(await selected(), bundledCli);
  assert.equal(await hash(first), firstHash); assert.equal(await hash(second), secondHash);
  assert.equal(await readFile(initialCli, "utf8"), "preserved-custom-engine");
  result.cases.push("subsequent update succeeds after rollback; prior managed and custom bytes remain intact");
  Object.assign(result, { status: "passed", finalState: await control({}) });
} catch (error) { Object.assign(result, { status: "failed", error: error.message }); process.exitCode = 1; }
finally {
  for (const item of pending.values()) clearTimeout(item.timer);
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit"); child.kill("SIGTERM");
    const kill = setTimeout(() => child.kill("SIGKILL"), 8000); await exited; clearTimeout(kill);
  }
  result.processClosed = true; result.exitCode = child.exitCode; result.signalCode = child.signalCode;
  result.stderr = stderr; result.stdout = stdout; result.finishedAt = new Date().toISOString();
  if (result.status === "passed" && child.exitCode === 0) { await safeWipe(root); result.cleaned = true; }
  else { result.status = "failed"; result.cleaned = false; process.exitCode = 1; }
  await writeFile(new URL("./updater-closeout-http-r1.json", import.meta.url), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
