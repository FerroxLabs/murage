// SPDX-License-Identifier: AGPL-3.0-or-later
// cause22 caps r3: the rigs of the permission rows of the shared owner-hops table (server/cause22-owner-hops-witness-1021.test.ts).
// Owner: lane cause22-caps-fable. Nothing under test is faked here: `permission` spawns the real permission-proxy.ts against the real
// release door, authority and ingress (the rig of cause22-owner-caps-permission-1021.test.ts, copied so a test file is never imported);
// `brokerAsk` writes to the real createPermissionBroker of an owner-bound turn; `claudeReply` drives the real server, Claude driver,
// broker, decision layer and permission proxy with the fake, nonbillable CLI. Only the `write` server's managed settings (a virtual
// file) cap a permission reply at 25000 (the CLI's own default value, not a small test cap); the `hook` server has no managed cap.
import { expect, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect as connectSocket, createServer as createSocketServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { removeTempDirSync } from "./cleanup.ts";
import { consumingFixture } from "./consuming-fixture.ts";
import { createProxyReleaseAuthority, decodeReleaseEnvelope } from "../consuming-turn-ingress.ts";
import { registerConsumingDescriptor } from "../consuming-turn-response.ts";
import { createPermissionBroker } from "../drivers/claude.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { launchVerificationServer, runControlMurage, type VerificationServer } from "../../scripts/control-murage.ts";
import { raiseLevel } from "./raise-level.ts";
import { openSse, type SseRecorder } from "./sse.ts";

const MIB = 1024 * 1024;
const PROXY = fileURLToPath(new URL("../permission-proxy.ts", import.meta.url));
const cleanups: Array<() => void | Promise<unknown>> = [];
/** After each case: restores the console spies and closes what the case opened. */
export async function cleanupPermissionHops() { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); }
const listen = (server: Server) => new Promise<number>(resolve => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
const plainJson = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };

type Call = { id: number; inputBytes: number };
type Delivered = { id: number; decision?: { behavior?: string; message?: string; updatedInput?: { content?: string } }; error?: unknown };

/** One bound turn (`owner`: bound with the owner keep, as index.ts binds an owner turn), its real release door, and the real permission
 * proxy admitted to it. `answerBytes`: a plain socket answers ask N with an allow whose narrowed input is that many bytes. Absent: the
 * real permission broker of the same turn answers every ask it is given with the owner's allow. `fill`: the text that narrowed input
 * repeats, as it stands on the answer line (default one plain letter). The calls are written to the proxy
 * one at a time, each after the one before it was answered. */
export async function permission(owner: boolean, calls: Call[], answerBytes?: number[], fill = "r", doorHandler?: (req: IncomingMessage, res: ServerResponse, ports: never) => Promise<void> | void) {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const refusals: unknown[] = [];
  const fixture = consumingFixture(undefined, { botId: randomUUID(), onRefused: verdict => { refusals.push(verdict); }, ...(owner ? { continuePending: () => true } : {}) });
  cleanups.push(() => fixture.close());
  const capabilities = new InternalCapabilities(); capabilities.begin(fixture.binding.identity.botId, fixture.turn.threadId, fixture.binding.identity.dispatchGeneration);
  const authority = createProxyReleaseAuthority(capabilities);
  const instance = authority.register(fixture.binding, registerConsumingDescriptor("proxy:permission:frame", "body"), () => []);
  // `doorHandler`: the shared table hands over its own door (turn-release-door.ts when the build has it, else the base's inline door), so
  // its rows also run on c187b11166, where that module does not exist. Without one the module is loaded here, not at the top.
  const handleTurnReleaseDoor = doorHandler ?? (await import(new URL("../turn-release-door.ts", import.meta.url).href) as typeof import("../turn-release-door.ts")).handleTurnReleaseDoor;
  const door = createServer((req: IncomingMessage, res) => { void handleTurnReleaseDoor(req, res, { capabilities, authority, json: plainJson } as never); });
  const port = await listen(door);
  cleanups.push(() => new Promise(resolve => { door.closeAllConnections(); door.close(() => resolve(undefined)); }));

  const dir = mkdtempSync(join(tmpdir(), "murage-c22-perm-"));
  cleanups.push(() => removeTempDirSync(dir));
  // what the broker side was asked: the size of each ask's input text, in order; and how often its socket closed
  const asked: number[] = []; let brokerCloses = 0;
  let socketPath = join(dir, "p.sock");
  if (answerBytes) {
    const sockets = new Set<Socket>();
    const server = createSocketServer(conn => {
      sockets.add(conn); conn.on("error", () => {}); conn.on("close", () => { brokerCloses++; });
      let pending = "";
      conn.setEncoding("utf8");
      conn.on("data", (chunk: string) => {
        pending += chunk;
        for (let nl; (nl = pending.indexOf("\n")) !== -1;) {
          const ask = JSON.parse(pending.slice(0, nl)); pending = pending.slice(nl + 1);
          const bytes = answerBytes[asked.length] ?? 16; asked.push(String(ask.input?.content ?? "").length);
          // one answer line of `bytes` narrowed input, written in 1 MiB pieces as the socket takes them
          const head = `{"t":"answer","id":${JSON.stringify(ask.id)},"behavior":"allow","updatedInput":{"file_path":"/fixture/out.txt","content":"`;
          const piece = fill.repeat(MIB / fill.length); let left = bytes;
          const pump = () => {
            while (left > 0) { const size = Math.min(left, MIB); left -= size; if (!conn.write(size === MIB ? piece : piece.slice(0, size))) { conn.once("drain", pump); return; } }
            conn.write('"}}\n');
          };
          conn.write(head); pump();
        }
      });
    });
    await new Promise<void>(resolve => server.listen(socketPath, resolve));
    cleanups.push(() => new Promise(resolve => { for (const socket of sockets) socket.destroy(); server.close(() => resolve(undefined)); }));
  } else {
    const broker = await createPermissionBroker({
      releaseBinding: fixture.binding, threadId: fixture.turn.threadId, socketPaths: [socketPath],
      onAsk: ask => { asked.push(String((ask.input as { content?: string } | undefined)?.content ?? "").length); broker.answer(ask.id, "allow", "Owner decision"); },
      onResolve: () => {},
    });
    socketPath = broker.socketPath;
    cleanups.push(() => broker.close());
  }

  const child: ChildProcess = spawn(process.execPath, [PROXY, socketPath], { stdio: ["pipe", "pipe", "pipe", "ipc"],
    env: { ...process.env, MURAGE_RELEASE_INSTANCE: instance.instanceId, MURAGE_RELEASE_TOKEN: instance.token, MURAGE_RELEASE_URL: `http://127.0.0.1:${port}` } });
  cleanups.push(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  const delivered: Delivered[] = [];
  let terminal: { reason?: string; frame?: { error?: { message?: string; data?: { code?: string } } } } | undefined, relayRefused: string | undefined, tail: Buffer[] = [];
  let wake = () => {};
  child.stderr!.resume();
  child.stdin!.on("error", () => {});
  child.stdout!.on("data", (chunk: Buffer) => {
    let start = 0;
    for (;;) {
      const end = chunk.indexOf(10, start);
      if (end < 0) { if (start < chunk.length) tail.push(chunk.subarray(start)); break; }
      const line = Buffer.concat([...tail, chunk.subarray(start, end)]).toString("utf8"); tail = []; start = end + 1;
      try {
        // the mount relay's part (mcp-mounts.ts accept): decode at the trusted ingress, then the fenced delivery to the engine
        const envelope = decodeReleaseEnvelope(line, (instance.ingress as { ownerTurn?: boolean }).ownerTurn === true);
        instance.ingress.deliver(envelope, frame => {
          const rpc = JSON.parse(frame);
          delivered.push({ id: rpc.id, error: rpc.error, ...(rpc.result?.content ? { decision: JSON.parse(rpc.result.content[0].text) } : {}) });
        });
        if (child.connected) child.send({ type: "turn-release-ack", instanceId: envelope.instanceId, sequence: envelope.sequence });
      } catch (error) { relayRefused = String((error as Error).message); child.kill("SIGKILL"); }
      wake();
    }
  });
  child.on("message", (message: any) => { if (message?.type === "turn-release-terminal") { terminal = message; wake(); } });
  child.once("exit", () => wake());
  const settled = (id: number) => delivered.some(frame => frame.id === id) || terminal !== undefined || child.exitCode !== null || child.signalCode !== null;
  for (const call of calls) {
    if (terminal || child.exitCode !== null) break;
    const line = JSON.stringify({ jsonrpc: "2.0", id: call.id, method: "tools/call",
      params: { name: "approve", arguments: { tool_name: "Write", input: { file_path: "/fixture/in.txt", content: "w".repeat(call.inputBytes) } } } });
    // the engine's call as the relay forwards it (ingress.request), then its bytes on the proxy's stdin
    instance.ingress.request(JSON.stringify({ jsonrpc: "2.0", id: call.id, method: "tools/call", params: {} }), () => {});
    child.stdin!.write(line + "\n");
    // a call nobody answers within 90 s is left unanswered (its assertion then says so) instead of holding the case for ever
    const deadline = Date.now() + 90_000;
    while (!settled(call.id) && Date.now() < deadline) await new Promise<void>(resolve => { wake = resolve; setTimeout(resolve, 1000); });
  }
  return { delivered, asked, refusals, get brokerCloses() { return brokerCloses; }, get terminal() { return terminal; }, get relayRefused() { return relayRefused; },
    answer: (id: number) => delivered.find(frame => frame.id === id) };
}

/** One ask of `mib` MiB written straight to the real permission broker of an owner-bound turn (what the proxy writes when it does
 * not know the turn is the owner's), then a small one. Returns every answer the broker wrote and whether it closed the socket. */
export async function brokerAsk(mib: number) {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const fixture = consumingFixture(undefined, { botId: randomUUID(), continuePending: () => true });
  cleanups.push(() => fixture.close());
  const dir = mkdtempSync(join(tmpdir(), "murage-c22-perm-"));
  cleanups.push(() => removeTempDirSync(dir));
  const asked: string[] = [];
  const broker = await createPermissionBroker({
    releaseBinding: fixture.binding, threadId: fixture.turn.threadId, socketPaths: [join(dir, "p.sock")],
    onAsk: ask => { asked.push(ask.id); broker.answer(ask.id, "allow", "Owner decision"); },
    onResolve: () => {},
  });
  cleanups.push(() => broker.close());
  const conn = connectSocket(broker.socketPath);
  cleanups.push(() => { conn.destroy(); });
  const answers = new Map<string, { behavior?: string; message?: string }>(); let closed = false, pendingText = "", wake = () => {};
  conn.setEncoding("utf8");
  conn.on("error", () => {}); conn.on("close", () => { closed = true; wake(); });
  conn.on("data", (chunk: string) => {
    pendingText += chunk;
    for (let nl; (nl = pendingText.indexOf("\n")) !== -1;) { const line = JSON.parse(pendingText.slice(0, nl)); pendingText = pendingText.slice(nl + 1); answers.set(line.id, { behavior: line.behavior, message: line.message }); }
    wake();
  });
  await new Promise<void>(resolve => conn.once("connect", () => resolve()));
  // the proxy's own ask line (permission-proxy.ts: t, id, tool, input), `mib` MiB of input written in 1 MiB pieces, then a small one
  conn.write('{"t":"ask","id":"big-1","tool":"Write","input":{"file_path":"/fixture/in.txt","content":"');
  const piece = "w".repeat(MIB);
  // a broker that closes the socket on the big ask (c187b11166) ends the writing here; the row then fails on `closed`, not on a timeout
  for (let sent = 0; sent < mib && !closed; sent++) if (!conn.write(piece)) await new Promise(resolve => { conn.once("drain", resolve); conn.once("close", resolve); });
  conn.write('"}}\n');
  conn.write(JSON.stringify({ t: "ask", id: "small-2", tool: "Write", input: { file_path: "/fixture/in.txt", content: "w" } }) + "\n");
  const deadline = Date.now() + 120_000;
  while (!answers.has("small-2") && !closed && Date.now() < deadline) await new Promise<void>(resolve => { wake = resolve; setTimeout(resolve, 250); });
  return { closed, answers, asked };
}

type ReplyServer = { fixture: VerificationServer; headers: Record<string, string>; stream: SseRecorder };
const replyServers = new Map<string, Promise<ReplyServer>>();
/** `write`: the Write tool through the permission-prompt MCP tool (reply cap = the managed MAX_MCP_OUTPUT_TOKENS, here 25000, the CLI's own default for it).
 * `hook`: a Bash command through the SDK PreToolUse hook relay (reply cap = 4 MiB - 1024, drivers/claude.ts allowFits), in a server
 * with no managed cap. */
async function launchReplyServer(kind: "write" | "hook"): Promise<ReplyServer> {
 const fixture=await launchVerificationServer(process.env,undefined,{instrumentationSource:`
 const fs=await import('node:fs'); const path=await import('node:path');
 const originalError=console.error;
 console.error=(...args)=>{if(args[0]==='bus: listener threw')console.info('fixture-terminal fold-error '+args[1]?.name+' '+args[1]?.message);originalError(...args);};
 (await import('node:module')).registerHooks({load(url,context,next){
  const result=next(url,context);
  if(url.endsWith('/server/index.ts'))result.source=String(result.source)
   .replace('const foldRuntimeEvent = (event: RuntimeEvent) => {', 'const foldRuntimeEvent = (event: RuntimeEvent) => { if(event.type==="turn.completed")console.info("fixture-terminal fold reached verdicts="+[...admittedLedgerLeases.values()].filter(l=>l.providerTurnId===event.turnId).map(l=>Boolean(l.verdict)).join(","));')
   .replace('case "turn.completed": {','case "turn.completed": { console.info("fixture-terminal fold admitted");');
  return result;
 }});
 const root=path.join(process.env.MURAGE_DATA_DIR,'fixture-repo');fs.mkdirSync(root,{recursive:true});
 // Virtual managed file: the fixture never reads or writes the machine's policy. Only the \`write\` server has the managed cap. The
 // \`hook\` server has NO managed cap at all (r4, ASTRA 083fb93124): the SDK hook relay's 4 MiB - 1024 is the only reply cap in that
 // server, so a hook that is not registered, or an ask that is not marked out of band, lets the 5 MiB allow through and the row fails.
 const original=fs.default.readFileSync;
 fs.default.readFileSync=function(file,...rest){
  if(String(file)==='/etc/claude-code/managed-settings.json')return JSON.stringify({env:${kind==='write'?"{MAX_MCP_OUTPUT_TOKENS:'25000'}":"{}"}});
  return original.call(this,file,...rest);
 };
 (await import('node:module')).syncBuiltinESMExports();
 const {ClaudeDriver}=await import(${JSON.stringify(new URL('../drivers/claude.ts',import.meta.url).href)});
 const create=ClaudeDriver.create.bind(ClaudeDriver);
 ClaudeDriver.create=async(...args)=>{
  const instance=await create(...args);
  instance.adapter.onEvent(event=>{if(event.type==='turn.completed')console.info('fixture-terminal driver completed '+event.ok+' '+event.stopReason);});
  const adapter=instance.decisionAdapter;
  return {...instance,decisionAdapter:{...adapter,respondToRequest:(t,r,answer,options)=>{
   const file=path.join(root,'rewrite.json');
   return adapter.respondToRequest(t,r,answer.behavior==='allow'&&fs.existsSync(file)?{...answer,updatedInput:JSON.parse(fs.readFileSync(file,'utf8'))}:answer,options);
  }}};
 };
 ${kind==='hook'?"process.env.FAKE_CLAUDE_PERM_TOOL='Bash';process.env.FAKE_CLAUDE_SDK_ACCEPT_EDITS='1';delete process.env.FAKE_CLAUDE_MANAGED_PERMISSION_LIMIT;":"process.env.FAKE_CLAUDE_PERM_TOOL='Write';process.env.FAKE_CLAUDE_PERM_WRITE='1';process.env.FAKE_CLAUDE_MANAGED_PERMISSION_LIMIT='25000';"}
 process.env.FAKE_CLAUDE_PERM_INPUT_FILE=path.join(root,'input.json');
 `});
 const proof=await(await fetch(fixture.info.url+'/api/desktop-secret')).json() as {secret:string};
 const headers={'x-murage-surface':'desktop','x-murage-surface-secret':proof.secret};
 const stream=await openSse(fixture.info.url+'/api/events',headers);
 const doctor=await runControlMurage(['doctor','--url',fixture.info.url]);expect(doctor).toMatchObject({ok:true});
 return { fixture, headers, stream };
}
export async function closeReplyServers() { for (const server of replyServers.values()) { const s = await server.catch(() => undefined); s?.stream.close(); await s?.fixture.close(); } replyServers.clear(); }
/** One owner No limits turn whose engine asks permission once; the owner's allow comes back with the input changed to `changedBytes`
 * bytes of content (the decision adapter is wrapped at the driver's own respondToRequest). Returns how the turn ended and what
 * the thread shows. */
export async function claudeReply(kind: "write" | "hook", changedBytes: number) {
 if (!replyServers.has(kind)) replyServers.set(kind, launchReplyServer(kind));
 const { fixture, headers, stream } = await replyServers.get(kind)!;
 const api = async (method: string, path: string, body?: unknown): Promise<any> => {
  const response = await fetch(fixture.info.url + path, { method, headers: { ...headers, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json(); expect(response.ok, JSON.stringify(result)).toBe(true); return result;
 };
 const cwd = join(fixture.info.dataDir, "fixture-repo");
 const { bot } = await api("POST", "/api/bots", { name: `reply ${kind} ${changedBytes}`, modelSelection: { instanceId: "verification", model: "sonnet" } });
 await api("PATCH", `/api/bots/${bot.id}`, { cwd, computer: "off", browser: false, composio: false, autoReview: "off" });
 await raiseLevel(async (method, path, body) => ({ status: 200, body: await api(method, path, body) }), bot.id, { autoApprove: true, fullAccess: true, noLimits: true, acknowledgeNoLimits: true, acknowledgeLocalAuto: true });
 const target = join(cwd, `${kind}-${changedBytes}.txt`);
 const input = kind === "hook" ? { command: "echo fixture" } : { file_path: target, content: "before" };
 const changed = kind === "hook" ? { command: "echo " + "x".repeat(changedBytes) } : { file_path: target, content: "c".repeat(changedBytes) };
 writeFileSync(join(cwd, "input.json"), JSON.stringify(input));
 writeFileSync(join(cwd, "rewrite.json"), JSON.stringify(changed));
 try {
  await api("POST", `/api/bots/${bot.id}/messages`, { text: "__fixture_permission_tool__", threadId: bot.threadId });
  const waited = await runControlMurage(["wait", "--bot", bot.id, "--timeout", "20", "--url", fixture.info.url]) as { status?: string };
  const messages = await api("GET", `/api/threads/${bot.threadId}/messages?limit=100`);
  const ends = stream.frames.map(frame => (frame as any).event ?? frame).filter((event: any) => event.threadId === bot.threadId && event.type === "turn.completed").map((event: any) => ({ ok: event.ok, stopReason: event.stopReason }));
  const texts: string[] = messages.messages.filter((m: any) => m.role === "bot" && m.kind === "text").map((m: any) => m.text);
  return { status: waited.status, ends, texts, permission: texts.filter(text => /^permission: /.test(text)), written: existsSync(target) ? readFileSync(target, "utf8").length : null,
   cards: messages.messages.filter((m: any) => (m.card?.requestHandle || m.card?.requestId) && !m.card.dismissed).length };
 } finally { await api("POST", `/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId }); }
}
