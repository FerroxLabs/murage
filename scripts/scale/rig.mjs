// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Scale rig scenario runner (SCALE-PLAN section 5). Runs inside a container, from the tree under test
// (/work), against a data dir gen.ts built. Every scenario reports p50, p90 and max.
//
//   node /scale-rig/rig.mjs prime   start once on a fresh generated dir (upgrade-time boot), fetch the memory model,
//                                   send two real turns to Sable so its engine session exists, stop
//   node /scale-rig/rig.mjs run     the scenarios, results to $SCALE_OUT/results-<label>.json
//
// env: MURAGE_DATA_DIR (a copy of the generated dir), SCALE_LABEL, SCALE_SHAPE, SCALE_OUT (default /out),
//      LOAD=1 (busy loops + balloon: LOAD_LOOPS, LOAD_BALLOON_GB), SLOW_DISK=1 (fsync shim, FSYNC_DELAY_US),
//      SCALE_SCENARIOS (comma list, default all), SCALE_HOT_TURNS, SCALE_TURN_TIMEOUT_MS.
import { spawn } from "node:child_process";
import http from "node:http";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { shape as shapeOf } from "./shapes.mjs";
import { stats } from "./stats.mjs";

const MODE = process.argv[2] ?? "run";
const RIG = new URL(".", import.meta.url).pathname;
const DATA = resolve(process.env.MURAGE_DATA_DIR ?? "");
if (!DATA.startsWith(resolve(process.env.SCALE_ROOT ?? "/scale") + "/") || DATA.split("/").includes(".murage")) { console.error(`rig.mjs refuses MURAGE_DATA_DIR=${DATA}`); process.exit(2); }
const LABEL = process.env.SCALE_LABEL ?? "tree";
const SHAPE = shapeOf(process.env.SCALE_SHAPE ?? "pr");
const OUT = process.env.SCALE_OUT ?? "/out";
const SCEN = new Set((process.env.SCALE_SCENARIOS ?? "appStart,turnPrep,slope,memorySearch,ui,typing,routineBurst,revoke").split(","));
const PORT = 18899, URL_ = `http://127.0.0.1:${PORT}`, SECRET = randomBytes(32).toString("hex");
const TURN_TIMEOUT = Number(process.env.SCALE_TURN_TIMEOUT_MS ?? 600_000);
const HOME = "/tmp/scale-home", LOG = join(OUT, `server-${LABEL}-${MODE}.log`);
mkdirSync(OUT, { recursive: true }); mkdirSync(HOME, { recursive: true }); mkdirSync("/tmp/scale-tmp", { recursive: true });
// one log per run (the server restarts append to it)
writeFileSync(LOG, "");
const RUN_START = Date.now();
const R = { label: LABEL, mode: MODE, shape: process.env.SCALE_SHAPE ?? "pr", load: process.env.LOAD === "1", slowDisk: process.env.SLOW_DISK === "1", startedAt: new Date().toISOString(), scenarios: {}, notes: [] };
const save = () => writeFileSync(join(OUT, `results-${LABEL}${MODE === "prime" ? "-prime" : ""}.json`), JSON.stringify(R, null, 1));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(`[rig ${LABEL} ${new Date().toISOString().slice(11, 19)}]`, ...a);

// ---- config: fake engines that answer at once
const fluxKey = process.env.FLUX_KEY_FILE && existsSync(process.env.FLUX_KEY_FILE) ? readFileSync(process.env.FLUX_KEY_FILE, "utf8").trim() : "";
const config = JSON.parse(readFileSync(join(DATA, "config.json"), "utf8"));
config.instances = { grok: { driver: "grokAgent", config: { cli: join(RIG, "fake-acp.sh"), fullAuto: true } }, claude: { driver: "claudeAgent", config: { cli: join(RIG, "fake-claude.sh") } } };
// The Flux test key only reaches the server when asked for (connected apps are never enabled here).
if (fluxKey && process.env.SCALE_FLUX === "1") config.flux = { apiKey: fluxKey };
writeFileSync(join(DATA, "config.json"), JSON.stringify(config, null, 2), { mode: 0o600 });
const gen = JSON.parse(readFileSync(join(DATA, "scale-gen.json"), "utf8"));

// ---- overloaded machine
let loadProc = null;
if (process.env.LOAD === "1" && MODE === "run") {
  loadProc = spawn(process.execPath, [join(RIG, "load.mjs"), process.env.LOAD_LOOPS ?? "4", process.env.LOAD_BALLOON_GB ?? "0", "/tmp/scale-load.pids"], { stdio: "inherit" });
  await sleep(3000);
}
const stopLoad = () => { try { for (const pid of readFileSync("/tmp/scale-load.pids", "utf8").split("\n").filter(Boolean)) { try { process.kill(Number(pid), "SIGKILL"); } catch {} } } catch {} loadProc?.kill("SIGKILL"); };

// ---- server
const env = {
  PATH: process.env.PATH, HOME, USERPROFILE: HOME, XDG_CONFIG_HOME: `${HOME}/.config`, XDG_CACHE_HOME: `${HOME}/.cache`, XDG_DATA_HOME: `${HOME}/.local/share`,
  TMPDIR: "/tmp/scale-tmp", LANG: "C.UTF-8", MURAGE_DATA_DIR: DATA, MURAGE_PORT: String(PORT), MURAGE_WEBHOOK_PORT: String(PORT + 1),
  MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1", MURAGE_DEV_DESKTOP_SECRET: SECRET, MURAGE_TURN_TRACE: "1", MURAGE_ANNOUNCEMENTS_URL: "off",
  MURAGE_STATIC_DIR: "/work/dist", FAKE_CLAUDE_MODE: "happy", FAKE_ACP_MODE: "happy", FAKE_ACP_UNIQUE_SESSIONS: "1", HERMES_HOME: `${HOME}/.hermes`,
  ...(process.env.SLOW_DISK === "1" && existsSync("/scale-tools/fsync-delay.so") ? { LD_PRELOAD: "/scale-tools/fsync-delay.so", FSYNC_DELAY_US: process.env.FSYNC_DELAY_US ?? "8000" } : {}),
};
if (process.env.SLOW_DISK === "1" && !env.LD_PRELOAD) R.notes.push("SLOW_DISK asked for but /scale-tools/fsync-delay.so is missing: disk not slowed");
let server = null;
function startServer() {
  const fd = openSync(LOG, "a");
  server = spawn(process.execPath, ["--experimental-strip-types", "--import", join(RIG, "eld.mjs"), "server/index.ts"], { cwd: "/work", env, stdio: ["ignore", fd, fd] });
  return performance.now();
}
async function stopServer() {
  if (!server) return;
  const s = server; server = null;
  s.kill("SIGTERM");
  for (let i = 0; i < 300 && s.exitCode === null && s.signalCode === null; i++) await sleep(100);
  if (s.exitCode === null && s.signalCode === null) s.kill("SIGKILL");
}
const H = { "x-murage-surface": "desktop", "x-murage-surface-secret": SECRET, "content-type": "application/json" };
// node:http rather than fetch: fetch gives up on a response that takes more than 300 s (undici's header timeout),
// and on a big data dir a send can block that long before the server answers.
const agent = new http.Agent({ keepAlive: false });
function request(method, path, body, timeout) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(URL_ + path, { method, agent, timeout, headers: { ...H, ...(data === undefined ? {} : { "content-length": Buffer.byteLength(data) }) } }, res => {
      let text = ""; res.setEncoding("utf8"); res.on("data", chunk => { text += chunk; }); res.on("end", () => resolve({ status: res.statusCode ?? 0, text })); res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error(`${method} ${path} timed out after ${timeout} ms`)));
    req.on("error", reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}
async function api(method, path, body, timeout = 120000) {
  const t = performance.now();
  const res = await request(method, path, body, timeout).catch(async () => { await sleep(200); return request(method, path, body, timeout); });
  const ms = performance.now() - t;
  let json; try { json = JSON.parse(res.text); } catch { json = res.text.slice(0, 300); }
  if (res.status < 200 || res.status >= 300) throw new Error(`${method} ${path} ${res.status} ${typeof json === "string" ? json : JSON.stringify(json).slice(0, 300)}`);
  return { json, ms, bytes: res.text.length };
}
async function waitHealthy(t0, cap = 1_800_000) {
  for (;;) {
    try { const r = await fetch(URL_ + "/api/health", { signal: AbortSignal.timeout(2000) }); if (r.ok) return Math.round(performance.now() - t0); } catch {}
    if (performance.now() - t0 > cap) throw new Error("server not healthy");
    if (server && (server.exitCode !== null || server.signalCode !== null)) throw new Error(`server exited ${server.exitCode ?? server.signalCode}`);
    await sleep(100);
  }
}
const logText = () => { try { return readFileSync(LOG, "utf8"); } catch { return ""; } };
const logSize = () => { try { return statSync(LOG).size; } catch { return 0; } };
const logFrom = off => {
  try { const size = statSync(LOG).size, buf = Buffer.alloc(Math.max(0, size - off)), fd = openSync(LOG, "r"); try { readSync(fd, buf, 0, buf.length, off); } finally { closeSync(fd); } return buf.toString("utf8"); }
  catch { return logText().slice(off); }
};

// ---- SSE: turn ends per thread
const waiters = new Map();
let sseAbort = null;
async function sse() {
  sseAbort = new AbortController();
  for (;;) {
    try {
      const res = await fetch(URL_ + "/api/events", { headers: H, signal: sseAbort.signal });
      const dec = new TextDecoder(); let buf = "";
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true }); let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line.startsWith("data: ") || !line.includes("turn.")) continue;
          let o; try { o = JSON.parse(line.slice(6)); } catch { continue; }
          const ev = o.event ?? o, tid = ev.threadId ?? o.threadId;
          if ((ev.type === "turn.completed" || ev.type === "turn.failed") && waiters.has(tid)) { const w = waiters.get(tid); waiters.delete(tid); w({ type: ev.type, at: performance.now() }); }
        }
      }
    } catch { if (sseAbort.signal.aborted) return; await sleep(500); }
  }
}
// ---- health prober: how long a request waits while things run (a frozen server shows here)
const probes = []; let probing = false;
async function probeLoop() { probing = true; while (probing) { const t = performance.now(); try { await fetch(URL_ + "/api/health", { signal: AbortSignal.timeout(60000) }); } catch {} probes.push({ at: Date.now(), ms: performance.now() - t }); await sleep(100); } }
const probeWindow = (from, to) => stats(probes.filter(p => p.at >= from && p.at <= to).map(p => Math.round(p.ms)));
// Per second of the run, the worst event-loop stall: the histogram's max, or the gap between two lines when the
// loop was blocked so long that the one-second timer itself could not run (a minute-long block shows only as a gap).
function eldStalls(text) {
  const rows = [...text.matchAll(/\[eld\] t=(\d+) p50=[\d.]+ p99=[\d.]+ max=([\d.]+)/g)].map(m => ({ t: +m[1], max: +m[2] }));
  return rows.map((r, i) => ({ t: r.t, stall: Math.max(r.max, i ? r.t - rows[i - 1].t - 1000 : 0) }));
}
function eldWindow(from, to) {
  const rows = eldStalls(logText()).filter(r => r.t >= from && r.t <= to);
  return { ...stats(rows.map(r => r.stall)), secondsOver100: rows.filter(r => r.stall > 100).length, secondsOver250: rows.filter(r => r.stall > 250).length };
}
// ---- server-process CPU (the server and its children: engines, memory worker), not the load generator
function treeCpuTicks(root) {
  const kids = new Map();
  for (const pid of readdirSync("/proc").filter(n => /^\d+$/.test(n))) {
    try { const st = readFileSync(`/proc/${pid}/stat`, "utf8"); const f = st.slice(st.lastIndexOf(")") + 2).split(" "); const ppid = Number(f[1]); kids.set(Number(pid), { ppid, ticks: Number(f[11]) + Number(f[12]) }); } catch {}
  }
  let total = 0; const stack = [root]; const seen = new Set();
  while (stack.length) { const p = stack.pop(); if (seen.has(p)) continue; seen.add(p); total += kids.get(p)?.ticks ?? 0; for (const [pid, k] of kids) if (k.ppid === p) stack.push(pid); }
  return total;
}
const HZ = 100;

// ---- turns
function parseTrace(text) {
  const byId = {};
  for (const l of text.split("\n")) {
    if (!l.includes("[turn-trace]")) continue;
    const id = /id=(\w+)/.exec(l)?.[1], p = /phase=([\w.\-/]+)/.exec(l)?.[1], at = Number(/ at=(\d+)/.exec(l)?.[1]), ms = /\bms=(\d+)/.exec(l)?.[1];
    if (!id || !p) continue;
    const ph = (byId[id] ??= {});
    if (ph[p] === undefined) ph[p] = ms !== undefined ? { at, ms: Number(ms) } : at;
    if (p === "turn.done") ph.outcome = /outcome=([\w-]+)/.exec(l)?.[1];
  }
  return byId;
}
const atOf = (ph, k) => (typeof ph?.[k] === "object" ? ph[k].at : ph?.[k]);
async function turn(botId, threadId, text) {
  const mark = logSize();
  // The turn ends on its SSE event, or on the trace's turn.done line: a turn that fails in setup sends no turn event,
  // and the event stream can drop while the server is blocked for minutes.
  let finish;
  const done = new Promise(resolve => { finish = resolve; waiters.set(threadId, resolve); });
  const t0 = performance.now();
  await api("POST", `/api/bots/${botId}/messages`, { text, threadId }, TURN_TIMEOUT);
  const watch = (async () => {
    for (;;) {
      await sleep(250);
      if (waiters.get(threadId) !== finish) return;
      // only when this is the one turn in flight: trace lines carry no thread id
      // this turn's own trace: the one received after the send (an earlier turn's last lines can land after the mark)
      const own = waiters.size === 1 ? Object.values(parseTrace(logFrom(mark))).find(ph => ph.received !== undefined && ph["turn.done"] !== undefined) : undefined;
      if (own) { waiters.delete(threadId); finish({ type: ["completed", "ok"].includes(own.outcome) ? "turn.completed" : `turn.${own.outcome}`, at: performance.now() }); return; }
      if (performance.now() - t0 > TURN_TIMEOUT) { waiters.delete(threadId); finish({ type: "timeout" }); return; }
    }
  })();
  const r = await done; await watch;
  const wall = Math.round((r.at ?? performance.now()) - t0);
  await sleep(300);
  const tail = logFrom(mark);
  const traces = parseTrace(tail);
  const main = Object.values(traces).find(ph => ph.received !== undefined) ?? Object.values(traces)[0] ?? {};
  const memLine = /\[memory\] turn ([^\n]*)/.exec(tail)?.[1] ?? "";
  const field = k => { const m = new RegExp(`\\b${k}=([\\w:.\\-]+)`).exec(memLine); return m ? m[1] : undefined; };
  const resets = [...tail.matchAll(/memory continuation reset[^\n]*/g)].map(m => m[0].slice(0, 160));
  return {
    wall, outcome: r.type, resets: resets.length, resetReasons: resets.slice(0, 2),
    prep: atOf(main, "dispatch.send") ?? atOf(main, "prompt.sent") ?? (field("pre") !== undefined ? Number(field("pre")) : undefined),
    firstText: atOf(main, "engine.first-text") ?? atOf(main, "engine.first-token") ?? atOf(main, "ttft"),
    recallMs: main["memory.bundle"]?.ms ?? (field("recall") !== undefined ? Number(field("recall")) : undefined),
    recallMode: field("recallMode"),
  };
}
const PROMPT = n => `Turn ${n}. The weekly client report covers pipeline, renewals and hiring. Summarise the open items for item ${n}.`;
function turnSummary(turns) {
  return { n: turns.length, prep: stats(turns.map(t => t.prep)), firstText: stats(turns.map(t => t.firstText)), wall: stats(turns.map(t => t.wall)),
    resets: turns.reduce((a, t) => a + t.resets, 0), failed: turns.filter(t => t.outcome !== "turn.completed").length, resetReasons: [...new Set(turns.flatMap(t => t.resetReasons))].slice(0, 3) };
}
async function scenario(name, fn) {
  if (!SCEN.has(name)) return;
  const from = Date.now();
  log(`scenario ${name} start`);
  try { R.scenarios[name] = { ...(await fn()) }; }
  catch (error) { R.scenarios[name] = { ...R.scenarios[name], error: String(error.message).slice(0, 400) }; log(`scenario ${name} error`, error.message); }
  const to = Date.now();
  R.scenarios[name].eld = eldWindow(from, to);
  R.scenarios[name].healthProbe = probeWindow(from, to);
  R.scenarios[name].seconds = Math.round((to - from) / 1000);
  R.scenarios[name].window = { from, to };
  save(); log(`scenario ${name} done in ${R.scenarios[name].seconds} s`);
}
// async, so the health prober and CPU sampler keep running while the browser works
function pw(mode, file, seconds) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [join(RIG, "pw.mjs"), URL_, SECRET, mode, file, String(seconds ?? "")], { cwd: "/work", env: { ...process.env, HOME: "/tmp/scale-pwhome" }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", d => { out += d; }); child.stderr.on("data", d => { err = (err + d).slice(-2000); });
    const timer = setTimeout(() => child.kill("SIGKILL"), 1_800_000);
    child.on("close", () => {
      clearTimeout(timer);
      const line = out.split("\n").find(l => l.startsWith("PW "));
      resolve(line ? JSON.parse(line.slice(3)) : { error: (out + err).slice(-600) });
    });
  });
}
const findBot = (bots, name) => bots.find(b => b.name === name);

// ================================================================== prime
if (MODE === "prime") {
  const t0 = startServer();
  R.firstBootMs = await waitHealthy(t0);
  log("first boot (upgrade-time) healthy in", R.firstBootMs);
  void sse();
  try { await api("POST", "/api/memory/action", { action: "model-download", confirm: true }, 600000); R.notes.push("memory model downloaded"); }
  catch (error) { R.notes.push(`memory model not downloaded (semantic recall stays off): ${String(error.message).slice(0, 160)}`); }
  const bots = (await api("GET", "/api/bots?messages=0", undefined, 600000)).json.bots;
  const sable = findBot(bots, "Sable");
  R.primeTurns = [];
  for (let i = 0; i < 2; i++) R.primeTurns.push(await turn(sable.id, sable.threadId, PROMPT(i)));
  log("prime turns", JSON.stringify(R.primeTurns.map(t => [t.wall, t.outcome])));
  await sleep(2000);
  await stopServer();
  save(); log("PRIME DONE"); process.exit(0);
}

// ================================================================== run
void probeLoop();
// app start on the big data dir: process start to healthy, three times
if (SCEN.has("appStart")) {
  const boots = [];
  for (let i = 0; i < 3; i++) { const t0 = startServer(); boots.push(await waitHealthy(t0)); if (i < 2) { await sleep(3000); await stopServer(); } }
  R.scenarios.serverBoot = { boot: stats(boots), samples: boots };
} else { const t0 = startServer(); R.bootMs = await waitHealthy(t0); }
void sse();
await sleep(2000);
const bots = (await api("GET", "/api/bots?messages=0", undefined, 600000)).json.bots;
const sable = findBot(bots, "Sable"), slope = findBot(bots, "Slope"), capt = findBot(bots, "Capt");
R.gen = gen; save();

await scenario("ui", async () => {
  const flows = await pw("flows", join(OUT, `pw-flows-${LABEL}.json`));
  return { flows: Object.fromEntries(Object.entries(flows.flows ?? {}).map(([k, v]) => [k, { usable: stats(v.usable), settled: stats(v.settled) }])), errors: flows.errors ?? flows.error };
});

// turn prep and Murage-added time to first token on the resumed long session (the fake engine answers at once)
await scenario("turnPrep", async () => {
  const n = Number(process.env.SCALE_HOT_TURNS ?? (R.shape === "extreme" ? 6 : 12));
  const turns = []; const cap = performance.now() + Number(process.env.SCALE_HOT_CAP_MS ?? 2_400_000);
  for (let i = 0; i < n && performance.now() < cap; i++) { const t = await turn(sable.id, sable.threadId, PROMPT(1000 + i)); turns.push(t); log("hot turn", i, t.wall, t.outcome, `prep=${t.prep} resets=${t.resets}`); }
  // the first turn resumes the generated 2,000-receipt session; later ones run on whatever session it left
  return { ...turnSummary(turns), firstResume: turns[0] && { wall: turns[0].wall, prep: turns[0].prep, resets: turns[0].resets, reasons: turns[0].resetReasons }, turns };
});

// per-turn cost at turns 10, 100 and 500 of one resumed session
await scenario("slope", async () => {
  const total = Number(process.env.SCALE_SLOPE_TURNS ?? SHAPE.slopeTurns);
  const marks = [10, 100, 500].filter(m => m <= total);
  // marks the run does not reach are left out (the gate then reports how far it got)
  const all = [];
  // a time cap: a tree that needs seconds per turn would take hours to reach turn 500; it reports how far it got
  const cap = performance.now() + Number(process.env.SCALE_SLOPE_CAP_MS ?? (R.shape === "extreme" ? 5_400_000 : 3_600_000));
  for (let i = 1; i <= total && performance.now() < cap; i++) { const t = await turn(slope.id, slope.threadId, PROMPT(i)); all.push(t); if (i % 50 === 0) log("slope", i, t.wall, `prep=${t.prep} resets=${t.resets}`); }
  // each mark: the five turns ending at it (turn 10 = turns 6..10)
  const at = Object.fromEntries(marks.filter(m => m <= all.length).map(m => [`turn${m}`, turnSummary(all.slice(Math.max(0, m - 5), m))]));
  return { ...at, reached: all.length, last: turnSummary(all.slice(-5)), resets: all.reduce((a, t) => a + t.resets, 0), failed: all.filter(t => t.outcome !== "turn.completed").length, prepByTurn: all.map(t => t.prep) };
});

// memory search while a bot is capturing: recall on a fresh Sable task (the heaviest memory), plus the owner's search.
// Capt's turn goes first each round, so its capture (and the generated pending-job backlog) is being worked while
// Sable's turn recalls. The two never overlap in the log, so each trace belongs to the turn it is read for.
await scenario("memorySearch", async () => {
  const captTurns = [];
  const task = (await api("POST", `/api/bots/${sable.id}/tasks`, {})).json;
  const threadId = task.task?.threadId ?? task.threadId ?? task.bot?.threadId;
  const turns = [];
  const cap = performance.now() + Number(process.env.SCALE_SEARCH_CAP_MS ?? (R.shape === "extreme" ? 2_400_000 : 900_000));
  for (let i = 0; i < 12 && performance.now() < cap; i++) {
    captTurns.push(await turn(capt.id, capt.threadId, PROMPT(5000 + i)).catch(e => ({ outcome: String(e.message) })));
    turns.push(await turn(sable.id, threadId, `What did we decide about ${["pipeline", "renewals", "hiring", "vendor contracts"][i % 4]}? ${PROMPT(7000 + i)}`));
  }
  const owner = [];
  for (let i = 0; i < 12 && (i < 3 || performance.now() < cap); i++) {
    const t = performance.now();
    try { const r = await api("POST", "/api/memory/action", { action: "list", query: ["weekly report", "vendor contracts", "renewals", "hiring plan"][i % 4], botId: sable.id, view: "search" }, 60000); owner.push({ ms: Math.round(performance.now() - t), hits: (r.json.records ?? []).length }); }
    catch (error) { owner.push({ ms: Math.round(performance.now() - t), hits: 0, error: String(error.message).slice(0, 120) }); }
  }
  const recalled = turns.filter(t => t.outcome === "turn.completed" && t.recallMode && !String(t.recallMode).startsWith("skipped"));
  return {
    recall: stats(turns.map(t => t.recallMs)), recallModes: turns.map(t => t.recallMode ?? "n/a"),
    recallSuccess: turns.some(t => t.recallMode !== undefined) ? recalled.length / turns.length : null,
    owner: stats(owner.map(o => o.ms)), ownerSuccess: owner.filter(o => o.hits > 0).length / owner.length, ownerErrors: owner.filter(o => o.error).map(o => o.error).slice(0, 2),
    turnPrep: stats(turns.map(t => t.prep)), captureTurns: captTurns.length,
  };
});

// background CPU of the server and its children while the owner types and nothing is sent
await scenario("typing", async () => {
  const pid = server.pid, seconds = 30, samples = [];
  let last = treeCpuTicks(pid), lastAt = performance.now(), sampling = true;
  const file = join(OUT, `pw-type-${LABEL}.json`);
  try { rmSync(`${file}.start`); } catch {}
  const sampler = (async () => { while (sampling) { await sleep(1000); const now = treeCpuTicks(pid), at = performance.now(); if (existsSync(`${file}.start`)) samples.push(Math.round(((now - last) / HZ) / ((at - lastAt) / 1000) * 100) / 100); last = now; lastAt = at; } })();
  const typed = await pw("type", file, seconds);
  sampling = false; await sampler;
  return { cores: stats(samples), samples, msPerKey: stats(typed.flows?.typing?.msPerKey ?? []), error: typed.error };
});

// routines due at the same minute: due time to run start
await scenario("routineBurst", async () => {
  const n = SHAPE.burstRoutines, due = Math.ceil((Date.now() + 90_000) / 60_000) * 60_000;
  const made = [];
  for (let i = 0; i < n; i++) {
    const bot = bots[(i * 7) % bots.length];
    made.push((await api("POST", "/api/routines", { name: `Burst ${i}`, prompt: `Post one line about item ${i}.`, botId: bot.id, target: "bot", runOn: "ember", enabled: true, permissionMode: "auto", schedule: { type: "interval", everyMinutes: 60, anchorAt: due }, durationMinutes: 30 })).json.routine);
  }
  const ids = new Set(made.map(r => r.id));
  const from = Date.now();
  let runs = [];
  while (Date.now() < due + 600_000) {
    await sleep(5000);
    runs = (await api("GET", `/api/routines?from=${due - 60_000}`, undefined, 120000)).json.runs.filter(r => ids.has(r.routineId));
    if (runs.length >= n && runs.every(r => r.startedAt)) break;
  }
  for (const r of made) await api("PATCH", `/api/routines/${r.id}`, { enabled: false }).catch(() => {});
  const starts = runs.filter(r => r.startedAt).map(r => r.startedAt - r.scheduledFor);
  return { routines: n, runs: runs.length, started: starts.length, start: stats(starts), statuses: [...new Set(runs.map(r => r.status))], eldDuringBurst: eldWindow(due - 2000, Math.max(due + 60_000, Date.now())), healthDuringBurst: probeWindow(due - 2000, due + 60_000), waitedFrom: from };
});

// revoke / forget: how long the app freezes (request time, health requests stuck behind it, event-loop stall)
await scenario("revoke", async () => {
  const db = new DatabaseSync(join(DATA, "messages.db"), { readOnly: true });
  // a source many receipts of the long session cite, and a record cited there too
  const sess = db.prepare("SELECT native_session AS s FROM memory_disclosures WHERE thread_id=? ORDER BY created_at DESC LIMIT 1").get(sable.threadId)?.s;
  const cited = sess ? db.prepare("SELECT json_extract(j.value,'$.id') AS id, count(*) AS n FROM memory_disclosures d, json_each(d.source_versions) j WHERE d.thread_id=? AND d.native_session=? GROUP BY 1 ORDER BY n DESC LIMIT 3").all(sable.threadId, sess) : [];
  const records = sess ? db.prepare("SELECT json_extract(j.value,'$.id') AS id, json_extract(j.value,'$.version') AS version, count(*) AS n FROM memory_disclosures d, json_each(d.record_versions) j WHERE d.thread_id=? AND d.native_session=? GROUP BY 1,2 ORDER BY n DESC LIMIT 3").all(sable.threadId, sess) : [];
  db.close();
  const actions = [
    ...records.slice(0, 2).map(r => ({ action: "archive", id: String(r.id), version: Number(r.version) })),
    ...cited.slice(0, 2).map(c => ({ action: "forget", kind: "source", id: String(c.id) })),
  ];
  const freezes = [];
  for (const body of actions) {
    const from = Date.now(), t = performance.now();
    let error;
    try { await api("POST", "/api/memory/action", body, 600000); } catch (e) { error = String(e.message).slice(0, 160); }
    const ms = Math.round(performance.now() - t);
    await sleep(2500);
    freezes.push({ action: body.action, ms, error, eldMax: eldWindow(from, Date.now()).max, healthMax: probeWindow(from, Date.now()).max });
  }
  const after = await turn(sable.id, sable.threadId, PROMPT(9000));
  return { request: stats(freezes.map(f => f.ms)), freeze: stats(freezes.map(f => Math.max(f.eldMax ?? 0, f.healthMax ?? 0))), freezes, turnAfter: { wall: after.wall, prep: after.prep, resets: after.resets, reasons: after.resetReasons } };
});

R.eldAll = eldWindow(RUN_START, Date.now());
R.resetLines = (logText().match(/memory continuation reset/g) ?? []).length;
R.finishedAt = new Date().toISOString();
probing = false; sseAbort?.abort();
save();
await stopServer();
stopLoad();
log("DONE");
process.exit(0);
