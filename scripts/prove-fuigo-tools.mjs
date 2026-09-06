#!/usr/bin/env node
// Opt-in real-provider proof. All engine homes, projects and harness data are disposable.
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { freePortBlock } from "../server/testing/ports.ts";
import { removeTempDir, waitForExit } from "../server/testing/cleanup.ts";
import { verifyPinnedBinary } from "./prepare-fuigo.mjs";
import { permittedProofPermission } from "./fuigo-proof-proxy.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({ options: {
  cli: { type: "string", default: join(root, "dist-native/fuigo/darwin-arm64/fuigo") },
  output: { type: "string", default: join(root, ".planning/fuigo-tools-proof.json") },
  "allow-provider": { type: "boolean", default: false },
} });
if (!values["allow-provider"]) throw new Error("This real-provider fixture requires --allow-provider.");
const key = process.env.FLUX_API_KEY?.trim();
if (!key?.trim()) throw new Error("An existing FLUX_API_KEY environment credential is required; no credential file is read.");
const cli = resolve(values.cli);
const compiled = join(root, "dist-server");
if (!existsSync(cli) || !existsSync(join(compiled, "index.js"))) throw new Error("Build the pinned Fuigo artifact and compiled server before this proof.");
const output = resolve(values.output);
const owned = mkdtempSync(join(tmpdir(), "murage-fuigo-proof-"));
const home = join(owned, "home"), fuigoHome = join(home, ".fuigo"), project = join(owned, "project");
const dataDir = join(owned, "data"), serverDir = join(owned, "server"), temp = join(owned, "tmp");
const evidencePath = join(owned, "proxy.ndjson"), phasePath = join(owned, "phase.txt"), processesPath = join(owned, "processes.ndjson");
for (const path of [home, fuigoHome, project, dataDir, temp]) mkdirSync(path, { recursive: true });
const receipt = { status: "BLOCKED", source: {}, checks: {}, proxy: [], limitations: [
  "Representative synthetic global/project inheritance; not Sean's exact live environment.",
  "Twelve visible tools and selected live calls do not prove all twelve workflows.",
  "This proof does not accept the separately blocked internal-capability package.",
] };
const cleanEnv = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, USERPROFILE: home,
  FUIGO_HOME: fuigoHome, XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"),
  XDG_DATA_HOME: join(home, ".local/share"), APPDATA: join(home, "AppData/Roaming"), LOCALAPPDATA: join(home, "AppData/Local"),
  TMPDIR: temp, TMP: temp, TEMP: temp, LANG: "en_US.UTF-8", FLUX_API_KEY: key };
for (const name of ["SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"]) if (process.env[name]) cleanEnv[name] = process.env[name];
const globalCanary = `global-${randomUUID()}`, projectCanary = `project-${randomUUID()}`;
const profile = join(owned, "profile.md"), wrapper = join(owned, "fuigo-wrapper.mjs");
let harness, base, desktop = {}, requester, target;
let stopped = false;
const stop = () => { stopped = true; };
process.once("SIGINT", stop); process.once("SIGTERM", stop);
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const records = (file) => {
  try { return readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }); }
  catch { return []; }
};
const assert = (condition, message) => { if (!condition) throw new Error(message); };
async function api(method, path, body) {
  const response = await fetch(base + path, { method, headers: { "content-type": "application/json", ...desktop },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
  const result = await response.json();
  if (!response.ok) throw new Error(`Fixture API ${method} ${path.split("?")[0]} returned ${response.status}`);
  return result;
}
async function poll(check, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (!stopped && Date.now() < deadline) {
    if (records(evidencePath).some((event) => event.type === "unexpected_call")) throw new Error("Unexpected tool call; proof cancelled");
    if (harness && (harness.exitCode !== null || harness.signalCode !== null)) throw new Error("Owned harness exited during proof");
    const result = await check();
    if (result) return result;
    await pause(200);
  }
  throw new Error(stopped ? "Proof interrupted" : "Proof deadline expired");
}
async function botState(id) { return (await api("GET", "/api/bots?messages=100")).bots.find((bot) => bot.id === id); }
const answeredPermissions = new Set();
async function answerFixturePermission(state, phase) {
  const cards = (state?.messages ?? []).filter(message => message.kind === "options" && message.card && !message.card.answered
    && message.card.tool !== "ask_bot" && !answeredPermissions.has(message.card.requestId));
  if (!cards.length) return;
  if (cards.length !== 1 || answeredPermissions.size >= 8) throw new Error("Ambiguous or excessive fixture permission requests");
  const card = cards[0].card;
  const native = records(join(dataDir, "native", `${requester.threadId}.ndjson`));
  const request = native.findLast(entry => entry.msg?.method === "session/request_permission"
    && String(entry.msg.params?.toolCall?.rawInput?.command ?? entry.msg.params?.toolCall?.title ?? "").slice(0, 200) === card.subtitle);
  const toolCall = request?.msg?.params?.toolCall;
  const allowed = permittedProofPermission(toolCall, phase, target.id);
  if (!allowed) {
    const name = toolCall?._meta?.["fuigo/tool"]?.name;
    receipt.permissionRejected = { canonicalName: ["search_tool", "use_tool", "bash", "read_file"].includes(name) ? name : "unrecognized",
      hasCanonicalMetadata: Boolean(toolCall?._meta?.["fuigo/tool"]), matchedNativeRequest: Boolean(request) };
    throw new Error("Permission did not match an exact approved fixture operation");
  }
  answeredPermissions.add(card.requestId);
  await api("POST", `/api/threads/${requester.threadId}/respond`, { requestId: card.requestId, behavior: "allow" });
  (receipt.fixturePermissions ??= []).push({ phase, operation: allowed, decision: "allow-once" });
}
function requireHealthyTurn(state) {
  const failure = state?.messages?.findLast((message) => message.kind === "activity" && message.tool?.ok === false && /^error:/i.test(message.tool.name ?? ""));
  if (!failure) return;
  const description = failure.tool.name;
  receipt.failureKind = /authentication|credential|api.key|401/i.test(description) ? "authentication"
    : /model/i.test(description) ? "model" : "provider";
  throw new Error(`Fuigo ${receipt.failureKind} failure before proof completed`);
}

try {
  receipt.source.commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  receipt.source.fixtureSha256 = createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex");
  receipt.source.proxyShimSha256 = createHash("sha256").update(readFileSync(join(root, "scripts/fuigo-proof-proxy.mjs"))).digest("hex");
  receipt.source.compiledIndexSha256 = createHash("sha256").update(readFileSync(join(compiled, "index.js"))).digest("hex");
  const binary = readFileSync(cli);
  verifyPinnedBinary(binary, `${process.platform}-${process.arch}`);
  receipt.source.fuigoSha256 = createHash("sha256").update(binary).digest("hex");
  const version = execFileSync(cli, ["--version"], { env: cleanEnv, cwd: project, encoding: "utf8", timeout: 10_000 });
  receipt.source.fuigoVersion = version.match(/fuigo\s+1\.0\.4[^\r\n]*/i)?.[0] ?? "unexpected version";
  assert(/fuigo\s+1\.0\.4\b/i.test(version), "Pinned Fuigo 1.0.4 is required");
  writeFileSync(join(fuigoHome, "AGENTS.md"), `In the final answer after list_bots, include this inherited global marker: ${globalCanary}. Do not inspect files or invoke other tools.\n`);
  writeFileSync(join(project, "AGENTS.md"), `In the final answer after list_bots, include this inherited project marker: ${projectCanary}. Follow the explicit user request.\n`);
  writeFileSync(profile, "---\nname: murage-tool-proof\ndescription: Disposable Murage tool proof\ntools: [use_tool]\nagentsMd: true\ndiscoverSkills: false\ninjectDefaultTools: false\n---\nUse only requested Murage tools.\n");
  // A same-name inherited MCP is intentionally distinguishable from the
  // actual injected agents proxy. Startup is harmless even if it is loaded.
  const collision = join(owned, "collision.mjs");
  writeFileSync(collision, `import readline from 'node:readline';import {appendFileSync} from 'node:fs';
const log=event=>appendFileSync(${JSON.stringify(processesPath)},JSON.stringify(event)+'\\n',{mode:0o600});
log({type:'start',pid:process.pid});process.on('exit',()=>log({type:'exit',pid:process.pid}));
readline.createInterface({input:process.stdin}).on('line',line=>{try{const m=JSON.parse(line);if(m.id===undefined)return;
const result=m.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture-collision',version:'1'}}:
m.method==='tools/list'?{tools:[{name:'collision_only',description:'fixture',inputSchema:{type:'object',properties:{}}}]}:{content:[{type:'text',text:'wrong fixture server'}]};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');}catch{}});`);
  writeFileSync(join(fuigoHome, "config.toml"), `[subagents]\nenabled = false\n\n[mcp_servers.agents]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(collision)}]\n`);
  writeFileSync(wrapper, `#!${process.execPath}
import {spawn} from 'node:child_process';import {appendFileSync} from 'node:fs';
const args=process.argv.slice(2);const at=args.indexOf('agent');if(at>=0)args.splice(at+1,0,'--agent-profile',${JSON.stringify(profile)});
const child=spawn(${JSON.stringify(cli)},args,{env:process.env,stdio:'inherit'});
const log=(event)=>appendFileSync(${JSON.stringify(processesPath)},JSON.stringify(event)+'\\n',{mode:0o600});
log({type:'start',pid:process.pid,childPid:child.pid});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
child.on('error',()=>{log({type:'exit',pid:process.pid});process.exit(1)});
child.on('close',(code)=>{log({type:'exit',pid:process.pid});process.exit(code??1)});
`);
  chmodSync(wrapper, 0o700);
  cpSync(compiled, serverDir, { recursive: true });
  const proxy = join(serverDir, "drivers/agents-proxy.js"), realPath = join(serverDir, "drivers/agents-proxy-real.js");
  renameSync(proxy, realPath);
  writeFileSync(proxy, `import {runProxy} from ${JSON.stringify(pathToFileURL(join(root, "scripts/fuigo-proof-proxy.mjs")).href)};\nawait runProxy(${JSON.stringify({ realPath, evidencePath, phasePath })});\n`);
  writeFileSync(phasePath, "read");
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ instances: {
    "fuigo-proof": { driver: "fuigoAgent", displayName: "Fuigo proof", config: { cli: wrapper, workspace: project, fullAuto: false } },
    "inert-proof": { driver: "fixture-unavailable" },
  }, features: { skillRecorder: true, browser: false } }));
  harness = spawn(process.execPath, [join(serverDir, "index.js")], { cwd: project,
    env: { ...cleanEnv, MURAGE_DATA_DIR: dataDir, MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1), MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1" },
    stdio: ["ignore", "ignore", "ignore"] });
  await poll(async () => { try { return (await api("GET", "/api/health")).app === "murage"; } catch { return false; } }, 30_000);
  const proof = await api("GET", "/api/desktop-secret");
  assert(typeof proof.secret === "string" && proof.secret.length > 0, "Fixture desktop proof unavailable");
  desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  const section = `Proof-${randomUUID()}`;
  const create = async (name, hidden = false) => {
    const bot = (await api("POST", "/api/bots", { name })).bot;
    await api("PATCH", `/api/bots/${bot.id}`, { name, section, hidden, modelSelection: { instanceId: "fuigo-proof", model: "gpt-6-astra", effort: "medium" },
      cwd: project, autoApprove: false, autoReview: "off", approvePeerComms: false, composio: false, browser: false, computer: "off" });
    return { ...bot, name };
  };
  requester = await create(`Requester-${randomUUID()}`);
  target = await create(`PeerA-${randomUUID()}`);
  const peer = await create(`PeerB-${randomUUID()}`), hidden = await create(`Excluded-${randomUUID()}`, true);
  // This target cannot run a provider even if a fixture unexpectedly grants approval.
  await api("PATCH", `/api/bots/${target.id}`, { modelSelection: { instanceId: "inert-proof", model: "fixture" } });
  await api("POST", `/api/bots/${requester.id}/messages`, { text: "Call list_bots from the Murage agents server exactly once with {} (via use_tool and tool discovery if needed). Return only the returned peer names/IDs and the inherited global/project markers, then finish. Do not read files or call other tools." });
  await poll(async () => {
    const state = await botState(requester.id);
    requireHealthyTurn(state);
    await answerFixturePermission(state, "read");
    return state && !state.busy && records(evidencePath).some((event) => event.type === "result" && event.name === "list_bots");
  });
  const firstEvents = records(evidencePath);
  const expectedNames = ["list_bots", "ask_bot", "delegate_bot", "check_delegation", "wait_delegation", "create_bot", "request_credential", "list_routines", "propose_routine", "propose_routine_action", "skills_list", "skill_manage"];
  const catalog = firstEvents.find((event) => event.type === "catalog");
  assert(catalog && expectedNames.every((name) => catalog.names.includes(name)) && catalog.names.length === 12 && !catalog.unexpectedCount, "Twelve production agent tools were not observed");
  assert(firstEvents.filter((event) => event.type === "call" && event.name === "list_bots").length === 1, "Expected exactly one read-phase list_bots call");
  const found = firstEvents.find((event) => event.type === "result" && event.name === "list_bots")?.peers ?? [];
  assert([target, peer].every((bot) => found.some((item) => item.id === bot.id)), "Harness result did not contain expected fixture peers");
  assert(!found.some((item) => item.id === requester.id || item.id === hidden.id), "Excluded fixture bot appeared in result");
  const returned = (await botState(requester.id)).messages.filter((message) => message.role === "bot" && message.kind === "text").map((message) => message.text ?? "").join("\n");
  assert(returned.includes(target.name) && returned.includes(peer.name), "Read result did not return fixture peer names");
  assert(returned.includes(globalCanary) && returned.includes(projectCanary), "Inherited global/project instruction markers were not returned");
  Object.assign(receipt.checks, { pinnedVersion: true, catalog12: true, productionMountWinsCollision: true, actualHarnessRead: true, representativeGlobalAndProjectInheritance: true });

  writeFileSync(phasePath, "approval");
  await api("PATCH", `/api/bots/${requester.id}`, { approvePeerComms: true });
  const targetBefore = (await botState(target.id)).messages.length;
  await api("POST", `/api/bots/${requester.id}/messages`, { text: `Call ask_bot from the Murage agents server exactly once with bot_id ${target.id}, message "Fixture approval cancellation proof". Wait for the user's approval. Do not call any other tool.` });
  await poll(async () => {
    const state = await botState(requester.id);
    requireHealthyTurn(state);
    const card = state.messages.find((message) => message.card?.tool === "ask_bot" && !message.card?.answered);
    await answerFixturePermission(state, "approval");
    return card;
  });
  await api("POST", `/api/bots/${requester.id}/interrupt`, { threadId: requester.threadId });
  await poll(async () => !(await botState(requester.id)).busy, 10_000);
  assert(records(evidencePath).filter((event) => event.type === "call" && event.name === "ask_bot").length === 1, "Expected one actual ask_bot call for approval cancellation");
  assert(!(await botState(requester.id)).messages.some((message) => message.card?.tool === "ask_bot" && !message.card.answered), "Peer approval remained open after cancellation");
  assert((await botState(target.id)).messages.length === targetBefore, "Approval cancellation changed the target transcript");
  Object.assign(receipt.checks, { realPeerApprovalObserved: true, sourceCancelled: true, noTargetDispatch: true });
  receipt.status = "ACCEPTED_SCOPED";
} catch (error) {
  // Never export provider messages, stderr, credentials or private headers.
  receipt.error = String(error instanceof Error ? error.message : "Fixture failed").split(key).join("[redacted]").slice(0, 300);
  process.exitCode = 1;
} finally {
  if (requester && harness?.exitCode === null) {
    try { await api("POST", `/api/bots/${requester.id}/interrupt`, { threadId: requester.threadId }); } catch {}
  }
  await waitForExit(harness, { signal: "SIGTERM", graceMs: 5000 });
  const deadline = Date.now() + 7000;
  let active = [];
  do {
    const state = new Map();
    for (const event of records(processesPath)) { if (event.type === "start") state.set(event.pid, event); else if (event.type === "exit") state.delete(event.pid); }
    for (const event of records(evidencePath)) { if (event.type === "proxy_start") state.set(event.pid, event); else if (event.type === "proxy_exit") state.delete(event.pid); }
    active = [...state.values()].filter((event) => [event.pid, event.childPid].some((pid) => {
      if (!Number.isInteger(pid)) return false;
      try { process.kill(pid, 0); return true; } catch { return false; }
    }));
    if (!active.length) break;
    await pause(100);
  } while (Date.now() < deadline);
  receipt.checks.ownedProcessesExited = !active.length && (!harness || harness.exitCode !== null || harness.signalCode !== null);
  receipt.proxy = records(evidencePath).map(({ type, name, names, unexpectedCount, code, isError, peers }) => ({ type, name, names, unexpectedCount, code, isError, peers }));
  if (!receipt.checks.ownedProcessesExited) { receipt.status = "BLOCKED"; receipt.error = "Owned process cleanup remains unverified"; process.exitCode = 1; }
  if (!receipt.checks.ownedProcessesExited) receipt.retainedFixture = owned;
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
  if (receipt.checks.ownedProcessesExited) await removeTempDir(owned);
  process.stdout.write(JSON.stringify({ status: receipt.status, evidence: output, ...(receipt.retainedFixture ? { retainedFixture: owned } : {}) }) + "\n");
}
