// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Real-size busy-profile rig (1.0.21 release gate). Owner: rig-realsize lane (this script, load.sh, verdict.mjs).
// Consumers: release canaries (Linux container on the build host, macOS canary) and the memory-fence fix lanes.
//
// The 1.0.21 canaries all ran fresh or small profiles on idle machines. The field failure (long delegated Claude turns on a
// 13 GB profile with 38 bots, No limits, machine load 4-12) needs all of these at once, so this rig builds them:
//   1. a real server with the repository's fake Claude engine (no keys), 38 bots in 7 rooms, all No limits;
//   2. owner MCP servers on every turn (the engine calls them through Murage's mount relay and turn-release verdicts);
//   3. tracked MEMORY.md notebooks per bot, imported for real (memory active), re-written every minute by a
//      routine-shaped writer, so the tracked sync re-imports and revokes receipts while turns run ("cause=import");
//   4. a history ballast in messages.db up to RIG_DB_GB, so every query runs against a real-size file;
//   5. background CPU + IO load (load.sh) and an injected admission-ledger lock pulse (the server's main thread takes the
//      real io-budget ledger word and keeps it past the 2 s worker deadline, as a busy checkpointer does under load);
//   6. waves of concurrent long turns (RIG_STEPS tool steps, FAKE_CUSTOM_TOOL_REPEAT) plus bot-to-bot delegations
//      through the real /api/internal/delegate-bot route, mid-turn.
// Verdict (verdict.mjs): RED on any MEMORY_CONTEXT_REVOKED / retained-budget / emit refusal / dispatch revoke / setup
// failure / withheld reply / owner mount lost. Completion (completion.mjs) is judged per turn id: every sent turn must have
// its OWN final reply delivered, every accepted delegation must have its delegated turn finished and its answer handed back
// to the asker, and no turn of the drive may end other than turn.completed ok. A run that did not create
// the pressure (no tracked notebook, no delegation, no lock pulse, ballast short of RIG_DB_GB) is INVALID (exit 2), never GREEN.
//
// Run: node --experimental-strip-types scripts/rig-realsize/rig.mts   (env knobs below)
// Evidence: RIG_OUT is the evidence root; this run writes only into RIG_OUT/<RIG_RUN_ID> (a new id when unset), a dir that
// must not exist yet (verdict.mjs openRun). Its last write is the seal run-complete.json (sealRun), written only when a verdict
// was reached; a run that fails leaves an unsealed dir, which a replay (verdict.mjs <root> <run id>) refuses as INVALID.
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { launchVerificationServer } from "../control-murage.ts";
import { exitCodeOf, newRunId, openRun, sealRun, verdictOfEvidence } from "./verdict.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const num = (name: string, fallback: number) => { const raw = process.env[name]; return raw && /^[0-9.]+$/.test(raw) ? Number(raw) : fallback; };
const K = {
  bots: num("RIG_BOTS", 38), teams: num("RIG_TEAMS", 7), dbGb: num("RIG_DB_GB", 10), notebookKb: Math.min(num("RIG_NOTEBOOK_KB", 240), 250), topics: num("RIG_TOPICS", 8),
  steps: num("RIG_STEPS", 120), stepMs: num("RIG_STEP_MS", 2500), concurrent: num("RIG_CONCURRENT", 8), delegations: num("RIG_DELEGATIONS", 2),
  driveMin: num("RIG_DRIVE_MIN", 30), lockHoldMs: num("RIG_LOCK_HOLD_MS", 2600), lockEveryMs: num("RIG_LOCK_EVERY_MS", 60000),
  routineMs: num("RIG_ROUTINE_MS", 60000), loadCpu: num("RIG_LOAD_CPU", 8), loadIo: num("RIG_LOAD_IO", 2), mcpMs: num("RIG_MCP_MS", 300),
  turnTimeoutMin: num("RIG_TURN_TIMEOUT_MIN", 25),
};
const RUN_ID = process.env.RIG_RUN_ID || newRunId();
const EVIDENCE_ROOT = process.env.RIG_OUT ?? join(ROOT, ".rig-realsize-out");
let OUT: string;
// a fresh dir per run, or no run at all: an existing dir (an earlier run, or an earlier try of this id) is never written into
try { OUT = openRun(EVIDENCE_ROOT, RUN_ID); } catch (error) { console.error(`[rig] RIG INVALID: cannot start run ${RUN_ID}: ${(error as Error).message}`); process.exit(2); }
// anything thrown outside the run's own try (or a rejected top-level await) is a rig failure: exit 2, never Node's 1 (= RED)
for (const event of ["uncaughtException", "unhandledRejection"] as const) process.on(event, (error) => { console.error(`[rig] RIG INVALID: the rig itself failed (${event}): ${(error as Error)?.stack ?? error}`); process.exit(2); });
const note = (line: string) => { const text = `[${new Date().toISOString()}] ${line}`; console.log(text); appendFileSync(join(OUT, "rig.log"), text + "\n"); };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
note(`rig start run=${RUN_ID} evidence=${OUT} ${JSON.stringify(K)}`);

// ---- 1. server: owner MCP servers + engine knobs + the admission-lock holder, all inside the server's own fixture preload
const OWNER_SERVERS = ["ops_metrics", "tv_control", "notes_sync"];
const MCP_SOURCE = `import {createInterface} from 'node:readline';
const delay=Number(process.argv[2])||0;
createInterface({input:process.stdin}).on('line',line=>{
 const q=JSON.parse(line);if(q.id===undefined)return;
 let result={};
 if(q.method==='initialize')result={protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'rig-owner',version:'1'}};
 if(q.method==='tools/list')result={tools:[{name:'status',inputSchema:{type:'object',properties:{text:{type:'string'}}}}]};
 if(q.method==='tools/call')result={content:[{type:'text',text:'owner tool status ok '+'x'.repeat(2000)}]};
 setTimeout(()=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+String.fromCharCode(10)),q.method==='tools/call'?delay:0);
});`;
const ioBudgetUrl = pathToFileURL(join(ROOT, "server", "io-budget.ts")).href;
const ledgerUrl = pathToFileURL(join(ROOT, "server", "admission-shared.ts")).href;
const instrumentationSource = `
  {
    const fs = await import('node:fs'), path = await import('node:path');
    const root = process.env.MURAGE_DATA_DIR, file = path.join(root, 'config.json');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    const service = path.join(root, 'rig-owner-mcp.mjs');
    fs.writeFileSync(service, ${JSON.stringify(MCP_SOURCE)});
    cfg.mcpServers = Object.fromEntries(${JSON.stringify(OWNER_SERVERS)}.map(name => [name, {command: process.execPath, args: [service, '${K.mcpMs}'], env: {}, enabled: true}]));
    Object.assign(cfg.instances.verification.environment ??= {}, {
      FAKE_CUSTOM_TOOL_SERVER: '${OWNER_SERVERS[0]}', FAKE_CUSTOM_TOOL_REPEAT: '${K.steps}', FAKE_CUSTOM_TOOL_STEP_MS: '${K.stepMs}',
      FAKE_CUSTOM_TOOL_TIMEOUT_MS: '120000', FAKE_CLAUDE_DUMP_EACH_TURN: '1', FAKE_CLAUDE_DUMP_HISTORY: path.join(root, 'fake-claude-dumps.jsonl'),
    });
    fs.writeFileSync(file, JSON.stringify(cfg));
  }
  if (${K.lockHoldMs} > 0) setTimeout(async () => {
    // Injected admission-lock delay: hold the real io-budget ledger word (admission-shared.ts) past the main
    // thread's no-wait rule and the workers' 2 s deadline, every RIG_LOCK_EVERY_MS, as a busy WAL worker does.
    const { ioBudget } = await import(${JSON.stringify(ioBudgetUrl)});
    const { checkpointLedger } = await import(${JSON.stringify(ledgerUrl)});
    // Main-thread pulse: one non-blocking compare-exchange (the main thread's own rule), then release on a timer while the event
    // loop keeps serving, so every other main-thread admission in the window misses (AdmissionLockTimeout at timer/settle/
    // checkpointAdmissionBuffer, as in the field) and every worker section waits out its 2 s deadline.
    const word = new BigInt64Array(ioBudget.checkpointAdmissionBuffer(false));
    let n = 0;
    setInterval(() => {
      const ledger = checkpointLedger(word.buffer, 0);
      try { ledger.lock(); } catch { console.error("[rig] admission ledger lock busy, holder thread=" + String(Atomics.load(word, 0) >> 32n)); return; }
      n++;
      setTimeout(() => { ledger.unlock(); console.error("[rig] admission ledger lock held ms=${K.lockHoldMs} n=" + n + " after=" + String(Atomics.load(word, 0))); }, ${K.lockHoldMs});
    }, ${K.lockEveryMs}).unref();
  }, 20000).unref();
`;

let trackedLinks = 0, eventReconnects = 0;
let server: Awaited<ReturnType<typeof launchVerificationServer>> | undefined;
let exitCode = 2;
let reached: string | undefined; // the live verdict, once the run has one; sealed only after teardown
let stopLoad = () => {};
let loadGone: Promise<unknown> = Promise.resolve();
try {
server = await launchVerificationServer({ ...process.env }, undefined, { instrumentationSource, readyTimeoutMs: 900_000, dumpLog: true });
const dataDir = server.info.dataDir;
const logs: string[] = [server.info.logPath];
note(`server up ${server.info.url} data=${dataDir}`);
const { ProductClient } = await import(pathToFileURL(join(ROOT, "scripts", "no-limits-live", "run.mjs")).href);
const proof = await (await fetch(`${server.info.url}/api/desktop-secret`)).json() as { secret: string };
const headers: Record<string, string> = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret, "content-type": "application/json" };
const client = new ProductClient(server.info.url, headers, dataDir, K.turnTimeoutMin * 60_000);
// One reset connection must not end a 70 minute run: under load a kept-alive socket can be closed by the server just as the
// next request goes out. A request that got no response at all is tried again (sends carry their own sendId, so a repeat is
// the same send); every retry is logged and counted, and a server that is really gone still fails the run after the tries.
let apiRetries = 0;
const api = async (method: string, path: string, body?: unknown) => {
  let res: Response | undefined, text = "";
  for (let attempt = 1; ; attempt++) {
    try { res = await fetch(server!.info.url + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); text = await res.text(); break; }
    catch (error) {
      if (attempt >= 4) throw error;
      apiRetries++;
      note(`api retry ${attempt} ${method} ${path.split("?")[0]}: ${(error as Error).message} ${String((error as { cause?: unknown }).cause ?? "")}`);
      await sleep(500 * attempt);
    }
  }
  let json: any; try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; }
  return { status: res.status, json };
};

// ---- 2. 38 bots in 7 rooms, all No limits
const instances = (await api("GET", "/api/instances")).json;
const model = instances.instances.find((i: any) => i.instanceId === "verification").models.options[0].id;
const ROLES = ["Ops Manager", "Analyst", "Writer", "Scheduler", "Researcher", "Reviewer"];
const TOPICS = ["anchor", "harbor", "orchard", "granite", "lantern", "meadow", "quarry", "summit", "willow", "canyon", "ember", "glacier"];
type Bot = { id: string; threadId: string; name: string; team: number; topic: string };
const bots: Bot[] = [];
for (let i = 0; i < K.bots; i++) {
  const name = `Rig ${ROLES[i % ROLES.length]} ${i + 1}`;
  const cwd = join(dataDir, "rig-cwd", String(i)); mkdirSync(cwd, { recursive: true });
  const bot = await client.bot(name, { id: "verification", model }, cwd, "unlimited");
  bots.push({ id: bot.id, threadId: bot.threadId, name, team: i % K.teams, topic: TOPICS[i % TOPICS.length] });
}
for (let t = 0; t < K.teams; t++) {
  const members = bots.filter((b) => b.team === t).map((b) => b.id);
  const made = await api("POST", "/api/groups", { name: `Rig team ${t + 1}`, memberIds: members, setup: { bulletin: "", defaultResponder: { kind: "everyone" } } });
  note(`room ${t + 1} members=${members.length} status=${made.status}`);
}
note(`bots=${bots.length} unlimited, model=${model}`);

// ---- 3. tracked notebooks (real import, memory active) + a routine that re-writes each notebook's first line every minute
const lineOf = (b: Bot, i: number) => `Line ${String(i).padStart(5, "0")}: ${TOPICS[(i >> 5) % TOPICS.length]} ${b.topic} notes the owner keeps for ${b.name}`.padEnd(95, ".");
const notebook = (b: Bot, stamp: string) => {
  const count = Math.max(64, Math.floor((K.notebookKb * 1024) / 96));
  return [`Line 00000: status checked ${stamp} by the routine`.padEnd(95, "."), ...Array.from({ length: count - 1 }, (_, i) => lineOf(b, i + 1))].join("\n");
};
const notebookPath = (b: Bot) => join(dataDir, "workspaces", b.id, "MEMORY.md");
// the import reads at most 256 KB a file (memory/import.ts readSelected), so a big memory is MEMORY.md plus memory/<topic>.md files
const topicName = (k: number) => `topic-${TOPICS[k % TOPICS.length]}-${k}.md`;
for (const b of bots) {
  mkdirSync(join(dirname(notebookPath(b)), "memory"), { recursive: true });
  writeFileSync(notebookPath(b), notebook(b, "0000-00-00T00:00"));
  for (let k = 0; k < K.topics; k++) writeFileSync(join(dirname(notebookPath(b)), "memory", topicName(k)), notebook({ ...b, topic: TOPICS[(k + 5) % TOPICS.length] }, `topic ${k}`));
}
// the owner's path: Settings > Memory > turn on and import. Each call tracks one page of detected notebooks (memory/import.ts
// migrateDetectedMemoryNotebooks); repeat until a call imports nothing more.
let tracked = 0, calls = 0, enabled: any;
for (; calls < 400; calls++) {
  enabled = await api("POST", "/api/memory/action", { action: "enable-and-import" });
  const imported = Number(enabled.json?.imported ?? 0);
  tracked += imported;
  if (enabled.status >= 300) { note(`enable-and-import status=${enabled.status} ${JSON.stringify(enabled.json).slice(0, 200)}`); break; }
  if (!imported && !enabled.json?.paused) break;
}
// the rest is tracked by the server's own idle walk (index.ts onIdleConsolidation -> memory.idle.migrate, by cursor): the
// background import a real owner's machine runs; wait for it a bounded time, it keeps running during the drive anyway
const linkCount = async () => { const l = (await api("POST", "/api/memory/action", { action: "import-inventory" })).json?.links; return Array.isArray(l) ? l.length : 0; };
for (const until = Date.now() + num("RIG_IMPORT_WAIT_MIN", 2) * 60_000; Date.now() < until && await linkCount() < bots.length * (K.topics + 1);) await sleep(10_000);
const links = (await api("POST", "/api/memory/action", { action: "import-inventory" })).json?.links;
trackedLinks = Array.isArray(links) ? links.length : 0;
note(`memory mode=${enabled.json?.status?.mode} notebooks tracked=${tracked} links=${Array.isArray(links) ? links.length : "?"} files=${bots.length * (K.topics + 1)} calls=${calls + 1}`);

// ---- 4. a short real history on every bot (real rows, receipts, lineage) before the ballast
for (const b of bots.slice(0, Math.min(bots.length, 12))) {
  const sent = await api("POST", `/api/bots/${b.id}/messages`, { threadId: b.threadId, text: `__custom_tool__:${OWNER_SERVERS[1]} warm up: what are my ${b.topic} notes`, sendId: randomUUID() });
  if (sent.status >= 300) note(`warm send ${b.name} status=${sent.status} ${JSON.stringify(sent.json).slice(0, 200)}`);
}

// ---- events: every turn start/end per thread
type Ended = { threadId: string; type: string; ok?: boolean; stopReason?: string; generation?: number; at: number };
const allEnds: Ended[] = [];
const allStarts: { threadId: string; generation?: number; at: number }[] = [];
const ends = new Map<string, Ended[]>();
const starts = new Map<string, number>();
let eventsAbort = new AbortController();
const followEvents = async () => {
  for (;;) {
    try {
      const res = await fetch(server.info.url + "/api/events", { headers, signal: eventsAbort.signal });
      let buffer = ""; const decoder = new TextDecoder();
      for await (const chunk of res.body as any) {
        buffer += decoder.decode(chunk, { stream: true });
        let i;
        while ((i = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, i).trimEnd(); buffer = buffer.slice(i + 1);
          if (!line.startsWith("data:")) continue;
          let frame: any; try { frame = JSON.parse(line.slice(5).trim()); } catch { continue; }
          const e = frame.event ?? frame, threadId = e.threadId ?? frame.threadId;
          if (!threadId || !e.type) continue;
          if (e.type === "turn.started") { starts.set(threadId, (starts.get(threadId) ?? 0) + 1); allStarts.push({ threadId, generation: e.generation, at: Date.now() }); }
          if (["turn.completed", "turn.failed", "turn.interrupted"].includes(e.type)) {
            const end = { threadId, type: e.type, ok: e.ok, stopReason: e.stopReason, generation: e.generation, at: Date.now() };
            const list = ends.get(threadId) ?? []; list.push(end); ends.set(threadId, list); allEnds.push(end);
            appendFileSync(join(OUT, "turn-ends.jsonl"), JSON.stringify({ threadId, type: e.type, ok: e.ok, stopReason: e.stopReason, at: new Date().toISOString() }) + "\n");
          }
        }
      }
    } catch { /* reconnect below unless stopping */ }
    if (eventsAbort.signal.aborted) return;
    eventReconnects++;
    await sleep(1000);
  }
};
let follower = followEvents();
const waitIdle = async (limitMs: number) => {
  const until = Date.now() + limitMs;
  while (Date.now() < until) {
    const busy = [];
    for (const b of bots) if ((await api("GET", `/api/bots/${b.id}`)).json?.bot?.busy) busy.push(b.name);
    if (!busy.length) return true;
    await sleep(3000);
  }
  return false;
};
note(`warm turns idle=${await waitIdle(10 * 60_000)}`);

// ---- 5. history ballast to RIG_DB_GB (server stopped): archived conversations in messages.db
eventsAbort.abort(); await follower;
await server.stop();
const dbFile = join(dataDir, "messages.db");
{
  const db = new DatabaseSync(dbFile);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=OFF");
  const insert = db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)");
  const target = K.dbGb * 1024 ** 3;
  const filler = TOPICS.join(" ").repeat(24);
  let n = 0, t0 = Date.now();
  while (statSync(dbFile).size + (existsSync(dbFile + "-wal") ? statSync(dbFile + "-wal").size : 0) < target) {
    db.exec("BEGIN");
    for (let i = 0; i < 20000; i++, n++) {
      const thread = `rig-archive-${Math.floor(n / 4000)}`, id = `m${n}`, role = n % 2 ? "assistant" : "user";
      const text = `Archived ${role} line ${n}: ${filler}`;
      insert.run(thread, id, Date.UTC(2025, 0, 1) + n * 1000, role, "text", text, JSON.stringify({ id, role, kind: "text", text, at: Date.UTC(2025, 0, 1) + n * 1000 }));
    }
    db.exec("COMMIT");
    if (n % 400000 === 0) { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); note(`ballast rows=${n} size=${(statSync(dbFile).size / 1024 ** 3).toFixed(2)}G`); }
  }
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); db.close();
  note(`ballast done rows=${n} size=${(statSync(dbFile).size / 1024 ** 3).toFixed(2)}G in ${Math.round((Date.now() - t0) / 1000)}s`);
}

// ---- 6. busy machine: restart on the real-size profile under CPU/IO load
// The load is one child in its own process group, held by a pipe on its stdin (load.sh). Closing the pipe stops it, and the
// kernel closes the pipe if this process dies in any way. No pid is written, read back or signalled from here, so nothing
// this run did not start can be hit (an earlier rig read pids from a reusable file).
let loadEndedEarly: string | undefined;
if (K.loadCpu + K.loadIo > 0) {
  let stopping = false;
  const load: ChildProcess = spawn("sh", [join(HERE, "load.sh"), join(dataDir, "rig-load"), String(K.loadCpu), String(K.loadIo)], { stdio: ["pipe", "inherit", "inherit"], detached: true });
  load.on("error", (error) => { if (stopping) return; loadEndedEarly ??= `did not start: ${error.message}`; note(`load failed to start: ${error.message}`); });
  load.on("exit", (code, signal) => { if (!stopping) { loadEndedEarly ??= `ended before the run did (exit=${code} signal=${signal})`; note(`load ${loadEndedEarly}`); } });
  load.stdin!.on("error", () => { /* the load already ended */ });
  loadGone = new Promise((resolve) => { load.once("exit", resolve); load.once("error", resolve); });
  stopLoad = () => { stopping = true; load.stdin!.end(); };
}
const driveStartedAt = Date.now();
const { openTurns } = await import(pathToFileURL(join(HERE, "completion.mjs")).href);
const driveEvents = () => ({ starts: allStarts.filter((e) => e.at >= driveStartedAt), ends: allEnds.filter((e) => e.at >= driveStartedAt) });
await server.restart();
logs.push(server.info.logPath);
// a restarted server mints a new desktop secret
headers["x-murage-surface-secret"] = ((await (await fetch(`${server.info.url}/api/desktop-secret`)).json()) as { secret: string }).secret;
note(`server restarted on the real-size profile`);
eventReconnects = 0; // only the drive's stream decides whether turn starts and ends may be missing
eventsAbort = new AbortController(); follower = followEvents();
let routineStamp = 0;
const routine = setInterval(() => {
  const stamp = new Date().toISOString().slice(0, 16);
  for (const b of bots) { try { writeFileSync(notebookPath(b), notebook(b, stamp)); } catch { /* bot folder moved */ } }
  routineStamp++;
}, K.routineMs);

// ---- 7. waves: concurrent long No limits turns + mid-turn delegations
type Sent = { bot: Bot; tag: string; sendId: string; status: number; at: number; delegatedTo?: Bot };
type Delegation = { tag: string; status: number; taskId?: string; fromThreadId: string; toThreadId: string };
const sent: Sent[] = [];
const delegations: Delegation[] = [];
let delegationsSkipped = 0;
const dumpsFile = join(dataDir, "fake-claude-dumps.jsonl");
const commsTokenFor = (tag: string): string | undefined => {
  if (!existsSync(dumpsFile)) return undefined;
  const lines = readFileSync(dumpsFile, "utf8").split("\n").filter((line) => line.includes(tag));
  for (const line of lines.reverse()) {
    try {
      const dump = JSON.parse(line);
      const content = dump.credFile?.content ?? {};
      const token = content.agents?.MURAGE_COMMS_TOKEN ?? dump.mcpConfig?.mcpServers?.agents?.env?.MURAGE_COMMS_TOKEN;
      if (typeof token === "string") return token;
    } catch { /* partial line */ }
  }
  return undefined;
};
const driveUntil = Date.now() + K.driveMin * 60_000;
let wave = 0;
while (Date.now() < driveUntil) {
  wave++;
  const picks = Array.from({ length: K.concurrent }, (_, i) => bots[(wave * K.concurrent + i * 5) % bots.length]);
  for (const [i, b] of picks.entries()) {
    const tag = `rigturn-${wave}-${i}-${randomUUID().slice(0, 8)}`;
    const server_ = OWNER_SERVERS[i % OWNER_SERVERS.length];
    const sendId = randomUUID();
    const res = await api("POST", `/api/bots/${b.id}/messages`, { threadId: b.threadId, sendId,
      text: `__custom_tool__:${server_} ${tag} Long task for ${b.name}: go through my ${b.topic} and ${TOPICS[(i + 3) % TOPICS.length]} notes and the latest routine status checked, step by step, and report.` });
    sent.push({ bot: b, tag, sendId, status: res.status, at: Date.now() });
    note(`wave ${wave} send ${b.name} tag=${tag} status=${res.status}`);
  }
  if (sent.filter((row) => row.tag.startsWith(`rigturn-${wave}-`)).every((row) => row.status >= 300)) { note(`wave ${wave}: every send refused, stopping`); break; }
  // delegations: a running turn hands work to a teammate through the real comms route
  await sleep(Math.min(90_000, K.steps * K.stepMs / 3));
  for (const s of sent.filter((row) => row.tag.startsWith(`rigturn-${wave}-`)).slice(0, K.delegations)) {
    const to = bots.find((b) => b.team === s.bot.team && b.id !== s.bot.id && !picks.includes(b)) ?? bots.find((b) => b.id !== s.bot.id)!;
    const token = commsTokenFor(s.tag);
    if (!token) { delegationsSkipped++; note(`delegation skipped: no comms token yet for ${s.tag}`); continue; }
    const res = await fetch(`${server.info.url}/api/internal/delegate-bot`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ fromBotId: s.bot.id, fromThreadId: s.bot.threadId, toBotId: to.id, message: `__custom_tool__:${OWNER_SERVERS[2]} ${s.tag}-delegated Please check my ${to.topic} notes and the routine status checked today, and report back.`, depth: 0 }) });
    const body = await res.text();
    let taskId: string | undefined; try { const id = JSON.parse(body)?.taskId; if (typeof id === "string") taskId = id; } catch { /* not JSON: refused */ }
    // accepted is only "queued": whether the delegated turn ran and its answer came back is judged at the end, by task id
    delegations.push({ tag: s.tag, status: res.status, ...(taskId ? { taskId } : {}), fromThreadId: s.bot.threadId, toThreadId: to.threadId });
    if (res.ok) s.delegatedTo = to;
    note(`delegation ${s.bot.name} -> ${to.name} status=${res.status} ${body.slice(0, 160)}`);
  }
  const idle = await waitIdle(K.turnTimeoutMin * 60_000);
  note(`wave ${wave} idle=${idle}`);
  if (!idle) break;
}
clearInterval(routine);
// judge only a settled run: a delegated answer wakes its asker for one more turn after the wave went idle, and that turn must
// end (and be judged) too. Settled = two checks in a row with no bot busy and every turn that started also ended.
let settled = 0;
for (const until = Date.now() + K.turnTimeoutMin * 60_000; settled < 2 && Date.now() < until;) {
  await sleep(5000);
  settled = (await waitIdle(4000)) && !openTurns(driveEvents()).length ? settled + 1 : 0;
}
note(`settled=${settled >= 2} open=${JSON.stringify(openTurns(driveEvents()))}`);

// ---- 8. evidence + verdict
const messagesOut = join(OUT, "messages.jsonl");
writeFileSync(messagesOut, "");
const rowsByThread: Record<string, any[]> = {};
for (const b of bots) {
  const rows: any[] = [];
  let whole = false;
  for (let before: string | undefined, pages = 0; pages < 200; pages++) {
    const got = await api("GET", `/api/threads/${b.threadId}/messages?limit=200${before ? `&before=${encodeURIComponent(before)}` : ""}`);
    const page = got.json;
    // a conversation the rig could not read in full cannot be judged: that is a rig failure (exit 2), never a pass
    if (got.status !== 200 || !Array.isArray(page.messages)) throw new Error(`reading ${b.name}'s conversation failed status=${got.status}`);
    rows.unshift(...page.messages);
    if (!page.hasMore) { whole = true; break; }
    if (!page.messages[0]?.id || page.messages[0].id === before) break;
    before = page.messages[0].id;
  }
  if (!whole) throw new Error(`reading ${b.name}'s conversation did not reach its start (${rows.length} rows)`);
  // the fields completion.mjs judges by, as the server stamped them
  rowsByThread[b.threadId] = rows.map((m) => ({ id: m.id, role: m.role, kind: m.kind, text: m.text, status: m.status, sendId: m.sendId, dispatchedIn: m.dispatchedIn, turnId: m.turnId, turnTerminal: m.turnTerminal, murageLine: m.murageLine }));
  for (const m of rowsByThread[b.threadId]) appendFileSync(messagesOut, JSON.stringify({ bot: b.name, threadId: b.threadId, ...m }) + "\n");
}
const completionInput = {
  sends: sent.map((s) => ({ tag: s.tag, threadId: s.bot.threadId, sendId: s.sendId, status: s.status })),
  delegations,
  ...driveEvents(),
};
writeFileSync(join(OUT, "completion-input.json"), JSON.stringify(completionInput, null, 1) + "\n");
eventsAbort.abort(); await follower;
await server.stop();
stopLoad();
for (const [i, path] of logs.entries()) if (existsSync(path)) copyFileSync(path, join(OUT, `server-${i}.log`));
const serverLog = join(OUT, "server.log");
writeFileSync(serverLog, logs.filter(existsSync).map((path) => readFileSync(path, "utf8")).join("\n"));
// what the rig measured about its own pressure goes into the evidence, and the verdict is made from the evidence alone
// (verdict.mjs verdictOfEvidence): the same function a replay runs, so both always agree, INVALID included
writeFileSync(join(OUT, "validity-input.json"), JSON.stringify({ trackedLinks, lockHoldMs: K.lockHoldMs, dbGb: K.dbGb, dbBytes: existsSync(dbFile) ? statSync(dbFile).size : 0, loadEndedEarly: loadEndedEarly ?? null, eventReconnects }, null, 1) + "\n");
const result = verdictOfEvidence(OUT);
const { completion, invalid } = result;
for (const u of completion.unfinished) note(`UNFINISHED ${u.tag} ${u.reason}`);
for (const d of completion.delegationsIncomplete) note(`DELEGATION INCOMPLETE ${d.tag} task=${d.taskId} ${d.reason}`);
for (const e of completion.badEnds) note(`BAD TURN END thread=${e.threadId} ${e.type} ok=${e.ok} stopReason=${e.stopReason}`);
for (const t of completion.stillRunning) note(`TURN STILL RUNNING thread=${t.threadId} started=${t.started} ended=${t.ended}`);
const unfinished = completion.unfinished.length;
const summary = { ...result, unfinished, delegationsIncomplete: completion.delegationsIncomplete.length, badTurnEnds: completion.badEnds.length, delegationsSkipped, apiRetries,
  turnsStillRunning: completion.stillRunning.length,
  completion: { unfinished: completion.unfinished, delegationsIncomplete: completion.delegationsIncomplete, badEnds: completion.badEnds, stillRunning: completion.stillRunning },
  turns: sent.length, delegations: sent.filter((s) => s.delegatedTo).length, waves: wave, routineRewrites: routineStamp,
  dbBytes: existsSync(dbFile) ? statSync(dbFile).size : 0, knobs: K, lockHolds: (readFileSync(serverLog, "utf8").match(/\[rig\] admission ledger lock held/g) ?? []).length };
writeFileSync(join(OUT, "verdict.json"), JSON.stringify(summary, null, 2) + "\n");
note(`RIG ${summary.verdict} invalid=${invalid.join(";") || "-"} red=${summary.red.join(",") || "-"} gate=${JSON.stringify(result.gate)} shape=${JSON.stringify(result.shape)} turns=${summary.turns} unfinished=${unfinished} delegations=${summary.delegations} delegationsIncomplete=${summary.delegationsIncomplete} delegationsSkipped=${delegationsSkipped} apiRetries=${apiRetries} badTurnEnds=${summary.badTurnEnds} turnsStillRunning=${summary.turnsStillRunning} db=${(summary.dbBytes / 1024 ** 3).toFixed(2)}G`);
note(`replay: node scripts/rig-realsize/verdict.mjs ${EVIDENCE_ROOT} ${RUN_ID}`);
reached = summary.verdict;
} catch (error) {
  note(`RIG INVALID: the rig itself failed: ${(error as Error)?.stack ?? error} ${String((error as { cause?: unknown })?.cause ?? "")}`);
  // keep the server's own log: a rig failure is often the server going away, and the profile is removed below
  try { if (server && existsSync(server.info.logPath)) copyFileSync(server.info.logPath, join(OUT, "server-at-failure.log")); } catch { /* evidence only */ }
  exitCode = 2;
} finally {
  // the load works inside the profile: let its group go (it ends on the closed pipe) before the profile is removed
  stopLoad();
  await Promise.race([loadGone, sleep(15_000)]);
  if (server && process.env.RIG_KEEP_PROFILE !== "1") await server.close().catch(() => {});
}
// the seal is the run's last write, after teardown: a run killed before this point (or that never reached a verdict) has no
// seal, and a replay refuses it. Nothing writes into OUT after it (a seal failure goes to stderr, not to rig.log).
if (reached) {
  try { sealRun(OUT, RUN_ID, reached); exitCode = exitCodeOf(reached); }
  catch (error) { console.error(`[rig] RIG INVALID: could not seal run ${RUN_ID}: ${(error as Error).message}`); exitCode = 2; }
}
process.exit(exitCode);
