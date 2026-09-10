import { app, BrowserWindow, session } from "electron";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { createServerConnections, openServerPrompt } from "../server-connection.mjs";

const evidence = process.env.MURAGE_CONNECTION_EVIDENCE;
assert.ok(evidence);
process.env.MURAGE_COMPANION_DIR = join(evidence, "companion");
app.setPath("userData", join(evidence, "electron"));
async function run() {
console.log("SERVER_CONNECTION_NATIVE_READY");
const { createBrowserHandler } = await import("../../companion/src/browser.ts");
const { DeviceRegistry } = await import("../../companion/src/devices.ts");
const forwarded = [];
const engine = new URL(process.env.MURAGE_FIXTURE_HARNESS);
const recordingHarness = createServer((req, res) => {
  forwarded.push({ path: req.url, companion: req.headers["x-murage-companion"], surface: req.headers["x-murage-surface"], secret: req.headers["x-murage-surface-secret"] });
  const upstream = request({ hostname: engine.hostname, port: engine.port, path: req.url, method: req.method, headers: req.headers }, answer => {
    res.writeHead(answer.statusCode, answer.headers); answer.pipe(res);
  });
  upstream.on("error", () => { res.writeHead(502); res.end(); });
  req.pipe(upstream);
});
await new Promise(resolve => recordingHarness.listen(0, "127.0.0.1", resolve));
const devices = new DeviceRegistry();
const door = createServer(createBrowserHandler({ harnessPort: recordingHarness.address().port, devices, identity: () => ({ scheme: "http", hosts: new Set(["127.0.0.1"]) }) }));
await new Promise(resolve => door.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${door.address().port}`;
const errors = [];
const onError = error => errors.push(error.message);
const pause = () => new Promise(resolve => setTimeout(resolve, 100));
async function until(check, message) {
  const end = Date.now() + 15_000;
  while (Date.now() < end) { if (await check()) return; await pause(); }
  throw new Error(message);
}
async function screenshot(window, name) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const captured = await window.webContents.capturePage();
      assert.equal(captured.isEmpty(), false, `Empty ${name} capture`);
      writeFileSync(join(evidence, `${name}.png`), captured.toPNG());
      return;
    } catch (error) {
      if (error.message !== "UnknownVizError" || attempt === 2) throw new Error(`Capture ${name}: ${error.message}`, { cause: error });
      console.log(`SERVER_CONNECTION_CAPTURE_RETRY ${name} ${attempt + 1}`);
      await pause();
    }
  }
}
try {
  const local = new BrowserWindow({ show: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await local.loadURL("data:text/html,<h1>Local workspace fixture</h1><input aria-label='Local note'>");
  await session.defaultSession.cookies.set({ url: "https://local-fixture.invalid", name: "local-proof", value: "retained" });
  const connections = createServerConnections({ BrowserWindow, session, allowLoopbackHttp: true, onError });
  let prompt = openServerPrompt({ BrowserWindow, session, connections, parent: local, onError });
  await until(() => prompt.webContents.executeJavaScript("!!document.querySelector('#address')"), "Prompt did not load");
  await screenshot(prompt, "prompt");
  assert.equal(await prompt.webContents.executeJavaScript("document.activeElement.id"), "address");
  await prompt.webContents.executeJavaScript("document.querySelector('[name=cancel]').click()");
  await until(() => prompt.isDestroyed(), "Cancel did not close prompt");
  prompt = openServerPrompt({ BrowserWindow, session, connections, parent: local, onError });
  await until(() => prompt.webContents.executeJavaScript("!!document.querySelector('#address')"), "Prompt did not load");
  await prompt.webContents.executeJavaScript(`document.querySelector('#address').value=${JSON.stringify(origin)};document.querySelector('form').requestSubmit()`);
  await until(() => prompt.isDestroyed(), "Connect did not close prompt");
  const remote = await connections.connect(origin);
  await screenshot(remote, "sign-in");
  const preferences = remote.webContents.getLastWebPreferences();
  assert.equal(preferences.preload, undefined);
  assert.equal(preferences.sandbox, true);
  assert.equal(preferences.contextIsolation, true);
  assert.deepEqual(await remote.webContents.executeJavaScript("[typeof window.muragebox,typeof require,typeof process]"), ["undefined", "undefined", "undefined"]);
  const pairing = devices.openPairing();
  await remote.webContents.executeJavaScript(`document.querySelector('#cc').value=${JSON.stringify(pairing.code)};document.querySelector('#cb').click()`);
  await until(() => remote.webContents.getURL() === `${origin}/`, "Pairing did not enter workspace");
  await until(() => remote.webContents.executeJavaScript("!!document.querySelector('#root')?.children.length"), "Remote renderer did not mount");
  await until(() => remote.webContents.executeJavaScript("!!document.querySelector('[aria-label=\"Bots and navigation\"]') && !document.body.innerText.includes('Connecting to the bot server…')"), "Remote renderer did not connect to its server");
  await screenshot(remote, "connected");
  const api = (path, method = "GET", body) => remote.webContents.executeJavaScript(`fetch(${JSON.stringify(path)},{method:${JSON.stringify(method)},headers:{'content-type':'application/json'},${body === undefined ? "" : `body:${JSON.stringify(JSON.stringify(body))},`}}).then(async r=>({status:r.status,body:await r.json()}))`);
  const created = await api("/api/bots", "POST", { name: "Remote window proof" });
  assert.equal(created.status, 201, JSON.stringify(created));
  const bot = created.body.bot;
  const task = await api(`/api/bots/${bot.id}/tasks`, "POST", { title: "Remote chat proof" });
  assert.equal(task.status, 201, JSON.stringify(task));
  assert.equal(task.body.bot.id, bot.id);
  const threadId = task.body.task.threadId;
  assert.equal(task.body.bot.threadId, threadId);
  assert.deepEqual((await api(`/api/threads/${threadId}/messages?limit=10`)).body.messages, []);
  const sent = await api(`/api/bots/${bot.id}/messages`, "POST", { text: "hello", threadId });
  assert.equal(sent.status, 202, JSON.stringify(sent));
  assert.equal(sent.body.threadId, threadId);
  let messages;
  await until(async () => { messages = await api(`/api/threads/${threadId}/messages?limit=10`); return messages.status === 200 && messages.body.messages?.some(message => message.role === "bot" && message.kind === "text" && message.text?.trim()); }, "Fake engine did not reply through remote browser");
  writeFileSync(join(evidence, "chat-proof.json"), JSON.stringify(messages, null, 2));
  assert.ok(forwarded.some(entry => entry.path.startsWith("/api/bots") && entry.companion === "1"));
  assert.ok(forwarded.every(entry => entry.companion === "1" && entry.surface === undefined && entry.secret === undefined));
  const denied = await api("/api/config", "POST", {});
  assert.equal(denied.status, 403);
  const beforeRenewal = await remote.webContents.session.cookies.get({ url: origin });
  const renewal = await api("/session/renew", "POST");
  assert.equal(renewal.status, 200);
  assert.notDeepEqual(await remote.webContents.session.cookies.get({ url: origin }), beforeRenewal);
  devices.revoke(devices.list()[0].id);
  assert.equal((await api("/api/bots")).status, 401);
  await remote.loadURL(`${origin}/enter`);
  await screenshot(remote, "revoked-sign-in");
  const remoteSession = remote.webContents.session;
  await connections.disconnect(remote);
  assert.deepEqual(await remoteSession.cookies.get({}), []);
  assert.equal((await session.defaultSession.cookies.get({ name: "local-proof" })).length, 1);
  assert.equal(await local.webContents.executeJavaScript("document.querySelector('input').value='still usable';document.querySelector('input').value"), "still usable");
  assert.deepEqual(errors, []);
  console.log("SERVER_CONNECTION_NATIVE_PASS");
} catch (error) { console.error(error.stack); process.exitCode = 1; }
finally {
  for (const window of BrowserWindow.getAllWindows()) window.destroy();
  door.closeAllConnections(); recordingHarness.closeAllConnections();
  await Promise.all([new Promise(resolve => door.close(resolve)), new Promise(resolve => recordingHarness.close(resolve))]);
  app.exit(process.exitCode ?? 0);
}
}
void app.whenReady().then(run).catch(error => { console.error(error.stack); app.exit(1); });
