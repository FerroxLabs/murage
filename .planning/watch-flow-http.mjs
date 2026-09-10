import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { freePortBlock } from "../server/testing/ports.ts";
import { DEFAULT_INSTANCES } from "../server/default-instances.ts";

const root = await mkdtemp(join(tmpdir(), "murage-watch-http-")), data = join(root, "data"), folder = join(root, "work");
await mkdir(data); await mkdir(folder); await mkdir(join(root, "static"));
await writeFile(join(root, "static", "index.html"), "<!doctype html><title>Watch fixture</title>");
await writeFile(join(folder, "status.txt"), "first");
await writeFile(join(data, "config.json"), JSON.stringify({ instances: Object.fromEntries(Object.entries(DEFAULT_INSTANCES).map(([id, entry]) => [id, { ...entry, enabled: false }])),
  notifications: { attention: true, completion: true, failures: true, previewContent: true, quietHours: { enabled: true, start: "00:00", end: "23:59", timeZone: "UTC" } } }), { mode: 0o600 });
const port = await freePortBlock([0, 1]);
const secret = "f0123456789abcde0".repeat(4), headers = { "content-type": "application/json", "x-murage-surface": "desktop", "x-murage-surface-secret": secret };
const base = `http://127.0.0.1:${port}`, result = { startedAt: new Date().toISOString(), root, port, node: process.version, cases: [], processes: [],
  fixture: "real server, routine manager, file adapter, confirmations and Inbox; disabled engines; supplied routine clock and notification observer" };
let child, identity, stderr = "", now = Date.now(), nextId = 0;
const pending = new Map();
const launch = async () => {
  identity = undefined; stderr = "";
  child = spawn(process.execPath, ["--import", fileURLToPath(new URL("./watch-flow-http-preload.mjs", import.meta.url)), "server/index.ts"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), env: { HOME: root, USERPROFILE: root, PATH: "", MURAGE_DATA_DIR: data,
      MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1), MURAGE_STATIC_DIR: join(root, "static"), MURAGE_WATCH_FOLDER: folder,
      MURAGE_WATCH_CLOCK: String(now), MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1", MURAGE_DEV_DESKTOP_SECRET: secret }, stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  result.processes.push({ pid: child.pid }); child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-20000); });
  child.on("message", message => {
    if (message.fixture === "ready") identity = message;
    if (message.fixture === "reply") { const item = pending.get(message.id); if (item) { pending.delete(message.id); clearTimeout(item.timer); message.error ? item.reject(new Error(message.error)) : item.resolve(message); } }
  });
  const deadline = Date.now() + 30000;
  while (!identity) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Fixture server exited: ${stderr}`);
    if (Date.now() > deadline) throw new Error(`Fixture server startup timed out: ${stderr}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const health = await fetch(base + "/api/health").then(response => response.json()); assert.equal(health.pid, child.pid);
};
const stop = async () => {
  if (!child) return;
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit"); child.kill("SIGTERM"); const timeout = setTimeout(() => child.kill("SIGKILL"), 8000);
    await exited; clearTimeout(timeout);
  }
  Object.assign(result.processes.at(-1), { exitCode: child.exitCode, signalCode: child.signalCode }); assert.equal(child.exitCode, 0, stderr);
};
const control = data => new Promise((resolve, reject) => {
  const id = ++nextId, timer = setTimeout(() => { pending.delete(id); reject(new Error("Fixture IPC timed out")); }, 10000);
  pending.set(id, { resolve, reject, timer }); child.send({ fixture: "control", id, ...data });
});
const api = async (path, body, customHeaders = headers) => {
  const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: customHeaders,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
  return { status: response.status, body: await response.json() };
};
const runs = async () => (await api("/api/routines")).body.runs;
const inbox = async () => (await api("/api/inbox?view=results")).body;
try {
  await launch(); const worker = identity.workerId, chief = identity.chiefId, thread = identity.chiefThread;
  assert.equal((await api(`/api/bots/${worker}/watch-files`, undefined, {})).status, 404);
  const files = await api(`/api/bots/${worker}/watch-files`); assert.equal(files.status, 200); assert.equal(files.body.entries[0].relativePath, "status.txt");
  const input = { relativePath: "status.txt", everyMinutes: 5, expiresAt: new Date(now + 86400000).toISOString(), maxChecks: 6 };
  assert.equal((await api(`/api/bots/${worker}/watch-proposal`, { ...input, relativePath: "../status.txt" })).status >= 400, true);
  const proposal = await api(`/api/bots/${worker}/watch-proposal`, input); assert.equal(proposal.status, 201, JSON.stringify(proposal.body));
  assert.equal(proposal.body.botId, chief); assert.equal(proposal.body.threadId, thread); assert.match(proposal.body.detail, /Selected file: status.txt/);
  assert.equal((await api("/api/routines")).body.routines.length, 0);
  const confirmation = { requestId: proposal.body.requestId, behavior: "allow", threadId: thread };
  assert.equal((await api(`/api/bots/${chief}/respond`, confirmation)).status, 200);
  assert.equal((await api(`/api/bots/${chief}/respond`, confirmation)).status, 200);
  assert.equal((await api("/api/routines")).body.routines.length, 1); result.cases.push("desktop-only source selection; strict relative path; Chief-owned confirmation and duplicate confirm");
  const agentHeaders = { "content-type": "application/json", authorization: `Bearer ${identity.chiefToken}` };
  const listed = await api(`/api/internal/routines?fromBotId=${chief}&fromThreadId=${thread}`, undefined, agentHeaders);
  assert.equal(listed.status, 200); assert.equal(listed.body.routines.length, 1); assert.equal(listed.body.routines[0].watch.relativePath, "status.txt");
  const workerListed = await api(`/api/internal/routines?fromBotId=${worker}&fromThreadId=${identity.workerThread}`, undefined, { "content-type": "application/json", authorization: `Bearer ${identity.workerToken}` });
  assert.equal(workerListed.status, 200); assert.equal(workerListed.body.routines.length, 0);
  for (const action of ["pause", "resume"]) {
    const change = await api("/api/internal/routine-requests", { fromBotId: chief, fromThreadId: thread, action, routineId: listed.body.routines[0].id }, agentHeaders);
    assert.equal(change.status, 201, JSON.stringify(change.body));
    assert.equal((await api(`/api/bots/${chief}/respond`, { requestId: change.body.requestId, behavior: "allow", threadId: thread })).status, 200);
  }
  result.cases.push("actual scoped-agent list routes preserve Chief ownership; worker cannot claim watch; Chief pause/resume stays confirmation-only");
  now += 300000; await control({ now, tick: true }); assert.equal((await runs())[0].watch.outcome, "baseline"); assert.equal((await inbox()).items.filter(item => item.kind === "routine").length, 0);
  now += 300000; await control({ now, tick: true }); assert.equal((await runs())[0].watch.outcome, "unchanged"); assert.equal((await inbox()).items.filter(item => item.kind === "routine").length, 0);
  result.cases.push("real file baseline and unchanged checks produce no Inbox result");
  await writeFile(join(folder, "status.txt"), "second"); now += 300000; const changed = await control({ now, tick: true });
  assert.equal((await runs())[0].watch.outcome, "changed"); const items = (await inbox()).items.filter(item => item.kind === "routine"); assert.equal(items.length, 1);
  assert.equal(items[0].link.threadId, thread); assert.equal(items[0].duplicates, 1); assert.match(items[0].summary, /status.txt/); assert.equal(changed.notifications, 0);
  const source = await api(`/api/bots/${chief}/tasks/${thread}`, {}); assert.equal(source.status, 200); assert.equal(source.body.bot.threadId, thread);
  result.cases.push("one durable Inbox result opens original Chief thread; notification quiet hours hold");
  await stop(); await launch(); assert.equal(identity.chiefId, chief); assert.equal((await inbox()).items.filter(item => item.kind === "routine").length, 1);
  const afterRestart = await control({ now, tick: true }); assert.equal(afterRestart.notifications, 0);
  assert.equal(afterRestart.routines[0].watch.state.checks.length, 3);
  now += 300000; await control({ now, tick: true }); assert.equal((await runs())[0].watch.outcome, "unchanged");
  assert.equal((await inbox()).items.filter(item => item.kind === "routine").length, 1); result.cases.push("actual process restart retains checkpoint and deduplicates read/result publication");
  const disk = JSON.parse(await readFile(join(data, "routines.json"), "utf8")); assert.equal(disk.routines[0].watch.state.checks.length, 4);
  assert.equal(disk.runs.every(run => run.threadId === undefined && run.eventBudget.closed), true);
  assert.equal(await readFile(join(folder, "status.txt"), "utf8"), "second"); result.cases.push("four charged checks; no execution tasks/provider budgets; source bytes unchanged by watch");
  result.status = "passed";
} catch (error) { result.status = "failed"; result.error = error.message; process.exitCode = 1; }
finally {
  try { await stop(); } catch (error) { result.status = "failed"; result.cleanupError = error.message; process.exitCode = 1; }
  for (const item of pending.values()) clearTimeout(item.timer);
  result.stderr = stderr; result.finishedAt = new Date().toISOString();
  if (result.status === "passed") { await rm(root, { recursive: true, force: true }); result.cleaned = true; }
  else result.cleaned = false;
  await writeFile(new URL(process.env.MURAGE_WATCH_HTTP_OUTPUT ?? "./watch-flow-http-r1.json", import.meta.url), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
