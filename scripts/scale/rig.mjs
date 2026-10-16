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
//      SCALE_SCENARIOS (comma list, default all), SCALE_HOT_TURNS, SCALE_COLD_TURNS, SCALE_TURN_TIMEOUT_MS,
//      SCALE_REVOKE_INDEX=ready|building (building: the revocation index is reset to not ready on this copy and the
//      revoke scenario runs first and alone, before the backfill can finish),
//      SCALE_IDLE_MS (default 480000: the idle window before the end-of-run storage measurement, past the server's
//      5 minute idle mark so its storage maintenance runs; 0 skips it).
import { spawn } from "node:child_process";
import http from "node:http";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { shape as shapeOf } from "./shapes.mjs";
import { stats } from "./stats.mjs";
import { liveBytes, measureStorage, slopeBytes } from "./storage.mjs";
import { acpPool, indexState, matchTurnEvent, MIN_RESUMED_SHARE, openTraces, progressClock, recallSuccess, resetLines, resumedShare, rigServerEnv, termsVersionFrom, trulyResumed, turnFromLog, upgradeChatResult, upgradeStatus } from "./rig-config.mjs";

const MODE = process.argv[2] ?? "run";
const RIG = new URL(".", import.meta.url).pathname;
const DATA = resolve(process.env.MURAGE_DATA_DIR ?? "");
if (!DATA.startsWith(resolve(process.env.SCALE_ROOT ?? "/scale") + "/") || DATA.split("/").includes(".murage")) { console.error(`rig.mjs refuses MURAGE_DATA_DIR=${DATA}`); process.exit(2); }
const LABEL = process.env.SCALE_LABEL ?? "tree";
const SHAPE = shapeOf(process.env.SCALE_SHAPE ?? "pr");
const OUT = process.env.SCALE_OUT ?? "/out";
const REVOKE_INDEX = process.env.SCALE_REVOKE_INDEX ?? "ready";
if (!["ready", "building"].includes(REVOKE_INDEX)) { console.error(`SCALE_REVOKE_INDEX is ready or building, not ${REVOKE_INDEX}`); process.exit(2); }
// the building pass measures revoke while the index builds: it runs first and alone (no app-start boots, no other scenario)
const SCEN = new Set(REVOKE_INDEX === "building" ? ["revoke"] : (process.env.SCALE_SCENARIOS ?? "appStart,turnPrep,coldStart,slope,memorySearch,ui,typing,routineBurst,revoke").split(","));
const PORT = 18899, URL_ = `http://127.0.0.1:${PORT}`, SECRET = randomBytes(32).toString("hex");
const TURN_TIMEOUT = Number(process.env.SCALE_TURN_TIMEOUT_MS ?? 600_000);
const HOME = "/tmp/scale-home", LOG = join(OUT, `server-${LABEL}-${MODE}.log`);
mkdirSync(OUT, { recursive: true }); mkdirSync(HOME, { recursive: true }); mkdirSync("/tmp/scale-tmp", { recursive: true });
// one log per run (the server restarts append to it)
writeFileSync(LOG, "");
const RUN_START = Date.now();
const R = { label: LABEL, mode: MODE, shape: process.env.SCALE_SHAPE ?? "pr", load: process.env.LOAD === "1", slowDisk: process.env.SLOW_DISK === "1", acpPool: acpPool(process.env), revokeIndex: REVOKE_INDEX, startedAt: new Date().toISOString(), scenarios: {}, notes: [] };
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
// the building pass: the revocation index back to not ready on this data-dir copy (never the cache), before the server starts
const indexReady = () => { try { const db = new DatabaseSync(join(DATA, "messages.db"), { readOnly: true }); try { return db.prepare("SELECT ready FROM memory_revocation_index_build WHERE id=1").get()?.ready ?? null; } finally { db.close(); } } catch { return null; } };
if (MODE === "run" && REVOKE_INDEX === "building") {
  const db = new DatabaseSync(join(DATA, "messages.db"));
  try { db.prepare("UPDATE memory_revocation_index_build SET ready=0,cursor=NULL,done=0,finished_at=NULL WHERE id=1").run(); } finally { db.close(); }
  R.notes.push(`revocation index reset to not ready before start (ready=${indexReady()}); revoke runs first and alone`);
}

// ---- overloaded machine
let loadProc = null;
if (process.env.LOAD === "1" && MODE === "run") {
  loadProc = spawn(process.execPath, [join(RIG, "load.mjs"), process.env.LOAD_LOOPS ?? "4", process.env.LOAD_BALLOON_GB ?? "0", "/tmp/scale-load.pids"], { stdio: "inherit" });
  await sleep(3000);
}
const stopLoad = () => { try { for (const pid of readFileSync("/tmp/scale-load.pids", "utf8").split("\n").filter(Boolean)) { try { process.kill(Number(pid), "SIGKILL"); } catch {} } } catch {} loadProc?.kill("SIGKILL"); };

// ---- server
const termsVersion = termsVersionFrom(existsSync("/work/shared/terms.ts") ? readFileSync("/work/shared/terms.ts", "utf8") : "");
const env = {
  PATH: process.env.PATH, HOME, USERPROFILE: HOME, XDG_CONFIG_HOME: `${HOME}/.config`, XDG_CACHE_HOME: `${HOME}/.cache`, XDG_DATA_HOME: `${HOME}/.local/share`,
  TMPDIR: "/tmp/scale-tmp", LANG: "C.UTF-8", MURAGE_DATA_DIR: DATA, MURAGE_PORT: String(PORT), MURAGE_WEBHOOK_PORT: String(PORT + 1),
  MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1", MURAGE_DEV_DESKTOP_SECRET: SECRET, MURAGE_TURN_TRACE: "1", MURAGE_ANNOUNCEMENTS_URL: "off",
  MURAGE_STATIC_DIR: "/work/dist", FAKE_CLAUDE_MODE: "happy", FAKE_ACP_MODE: "happy", FAKE_ACP_UNIQUE_SESSIONS: "1", HERMES_HOME: `${HOME}/.hermes`,
  ...rigServerEnv(process.env, termsVersion),
  ...(process.env.SLOW_DISK === "1" && existsSync("/scale-tools/fsync-delay.so") ? { LD_PRELOAD: "/scale-tools/fsync-delay.so", FSYNC_DELAY_US: process.env.FSYNC_DELAY_US ?? "8000" } : {}),
};
if (!termsVersion) R.notes.push("shared/terms.ts has no readable TERMS_VERSION: the UI flows will stop at the terms screen");
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

// ---- SSE: turn ends, keyed by the engine turn each wait started (rig-config matchTurnEvent)
const waits = new Set();
const seenTurnIds = new Map();
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
          const e = { ...ev, threadId: tid };
          for (const w of waits) {
            const m = matchTurnEvent(e, w);
            if (m === "started") w.turnId = e.turnId;
            if (m === "ended") { waits.delete(w); w.resolve({ type: e.type === "turn.completed" && e.ok === false ? "turn.failed" : e.type, at: performance.now(), turnId: e.turnId }); }
          }
          if (e.turnId) { if (!seenTurnIds.has(tid)) seenTurnIds.set(tid, new Set()); seenTurnIds.get(tid).add(e.turnId); }
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
// Each turn: wait until no earlier trace is still open, send with its own request id (sendId), then read only the
// traces that started after the send. The turn ends when its own trace (and a re-dispatch of it) is done; the event
// stream's end for its own engine turn gives the wall time when it arrives.
const ownedTraces = new Set();
let lastTurnMark = 0;
const QUIESCE_MS = Number(process.env.SCALE_QUIESCE_MS ?? 60_000);
async function quiesce() {
  const t = performance.now();
  for (;;) {
    const open = openTraces(logFrom(lastTurnMark));
    if (!open.length) return { waited: Math.round(performance.now() - t) };
    if (performance.now() - t > QUIESCE_MS) return { waited: Math.round(performance.now() - t), stillOpen: open.length };
    await sleep(250);
  }
}
async function turn(botId, threadId, text) {
  const q = await quiesce();
  const mark = logSize();
  lastTurnMark = mark;
  const requestId = `rig-${randomBytes(12).toString("hex")}`;
  const wait = { threadId, requestId, before: new Set(seenTurnIds.get(threadId) ?? []), turnId: undefined };
  const ended = new Promise(resolve => { wait.resolve = resolve; });
  waits.add(wait);
  const t0 = performance.now();
  let messageId;
  try { messageId = (await api("POST", `/api/bots/${botId}/messages`, { text, threadId, sendId: requestId }, TURN_TIMEOUT)).json?.message?.id; }
  catch (error) { waits.delete(wait); throw error; }
  const acceptedMs = Math.round(performance.now() - t0);
  let sseEnd = null; void ended.then(r => { sseEnd = r; });
  let rec, traceDoneAt = null;
  for (;;) {
    await sleep(250);
    rec = turnFromLog(logFrom(mark), threadId, ownedTraces);
    if (rec.done && traceDoneAt === null) traceDoneAt = performance.now();
    // the trace is the authority; the event gets up to 5 s more, for the wall time
    if (traceDoneAt !== null && (sseEnd || rec.redispatched || performance.now() - traceDoneAt > 5000)) break;
    if (performance.now() - t0 > TURN_TIMEOUT) break;
  }
  waits.delete(wait);
  for (const id of [rec.traceId, rec.redispatchTraceId]) if (id) ownedTraces.add(id);
  const timedOut = traceDoneAt === null;
  // the event's time only when it is surely this turn's: the wait saw its own turn.started first
  const sseOwn = Boolean(sseEnd && wait.turnId !== undefined && sseEnd.turnId === wait.turnId);
  const endAt = !rec.redispatched && sseOwn ? Math.min(sseEnd.at, traceDoneAt ?? Infinity) : traceDoneAt;
  const outcome = timedOut ? "timeout" : ["completed", "ok"].includes(rec.outcome) ? "turn.completed" : rec.outcome ? `turn.${rec.outcome}` : sseEnd?.type ?? "turn.unknown";
  return {
    ...rec, requestId, messageId, engineTurnId: wait.turnId ?? sseEnd?.turnId, sseMatched: sseOwn,
    wall: Math.round((endAt ?? performance.now()) - t0), acceptedMs, outcome, quiesceMs: q.waited, ...(q.stillOpen ? { openBefore: q.stillOpen } : {}),
  };
}
const PROMPT = n => `Turn ${n}. The weekly client report covers pipeline, renewals and hiring. Summarise the open items for item ${n}.`;
function turnSummary(turns) {
  return { n: turns.length, prep: stats(turns.map(t => t.prep)), firstText: stats(turns.map(t => t.firstText)), wall: stats(turns.map(t => t.wall)),
    resets: turns.reduce((a, t) => a + t.resets, 0), failed: turns.filter(t => t.outcome !== "turn.completed").length, resetReasons: [...new Set(turns.flatMap(t => t.resetReasons))].slice(0, 3),
    engineCold: turns.filter(t => t.engineCold === true).length, engineWarm: turns.filter(t => t.engineCold === false).length,
    redispatched: turns.filter(t => t.redispatched).length, foreignTraces: turns.reduce((a, t) => a + (t.foreignTraces ?? 0), 0), unmatchedEvents: turns.filter(t => !t.sseMatched).length };
}
// The server with the engine pool on or off for one scenario (a restart when it differs), then back to the base run's.
const BASE_POOL = acpPool(process.env);
let poolOn = BASE_POOL;
async function setPool(on) {
  if (on === poolOn) return;
  await stopServer();
  if (on) env.MURAGE_ACP_POOL = "1"; else delete env.MURAGE_ACP_POOL;
  const t0 = startServer();
  const ms = await waitHealthy(t0);
  poolOn = on;
  R.notes.push(`server restarted with the engine pool ${on ? "on" : "off"} (healthy in ${ms} ms)`);
  await sleep(Number(process.env.SCALE_RESTART_SETTLE_MS ?? 5000));
}
async function withPool(on, fn) { await setPool(on); try { return { ...(await fn()), acpPool: poolOn }; } finally { await setPool(BASE_POOL); } }
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
// the building pass starts revoke at once (the backfill is racing it); Sable's ids come from the generator's manifest
const building = REVOKE_INDEX === "building";
if (!building) await sleep(2000);
const bots = building && gen.sage?.threadId ? [{ id: gen.sage.botId, threadId: gen.sage.threadId, name: "Sable" }] : (await api("GET", "/api/bots?messages=0", undefined, 600000)).json.bots;
const sable = findBot(bots, "Sable"), slope = findBot(bots, "Slope"), capt = findBot(bots, "Capt");
R.gen = gen; save();

// The owner chatting while the upgrade's "Checking earlier memory" phase runs (the banner says "You can chat as usual"): the
// real install's preview froze for minutes. Needs the FIRST boot of an unprimed copy of the extreme dir (a primed dir has
// finished its check): run it alone, SCALE_SCENARIOS=chatDuringPostUpgradeCheck. Reads /api/health `upgrade` in the shape of
// shared/upgrade-contract.mjs (rig-config.mjs upgradeStatus): the phase runs while stage is "background" and complete is not true, and
// it is finished only when the contract says complete. A reading that is missing or not the contract's shape is never a success.
// Two loops run side by side: the progress clock reads the health once a second whatever a message is doing, and a message goes out
// every 30 s whether or not the last one has come back.
await scenario("chatDuringPostUpgradeCheck", async () => {
  const state = async () => { try { const r = await fetch(URL_ + "/api/health", { signal: AbortSignal.timeout(5000) }); return upgradeStatus(await r.json()); } catch (error) { return { kind: "unknown", reason: String(error.message).slice(0, 60) }; } };
  const cap = performance.now() + Number(process.env.SCALE_UPGRADE_CHAT_CAP_MS ?? 10_800_000);
  let first = await state();
  for (let i = 0; i < 120 && first.kind !== "running" && first.kind !== "failed" && performance.now() < cap; i++) { await sleep(1000); first = await state(); }
  if (first.kind !== "running") return { error: `no post-upgrade check was running (${first.kind}${first.reason ? `: ${first.reason}` : ""}): run this scenario alone on an unprimed copy of the extreme data dir, on a server that reports /api/health upgrade (shared/upgrade-contract.mjs)`, firstState: first, ...upgradeChatResult({ finished: false, sends: [], pollFailures: 0, pollCount: 1 }) };
  const from = Date.now(), t0 = performance.now();
  const sends = [], inflight = [], percents = [];
  const clock = progressClock(first.progress, 0);
  let last = first, finished = false, failedReason, pollFailures = 0, pollCount = 1, nextSend = performance.now();
  while (performance.now() < cap) {
    if (performance.now() >= nextSend) {
      nextSend += 30_000;
      inflight.push(turn(sable.id, sable.threadId, PROMPT(20_000 + sends.length + inflight.length)).catch(e => ({ outcome: String(e.message).slice(0, 80) })).then(t => sends.push(t)));
    }
    await sleep(1000);
    last = await state(); pollCount++;
    if (last.kind === "unknown") pollFailures++;
    else if (last.progress !== undefined) { clock.read(last.progress, performance.now() - t0); const step = `${last.phase}:${last.percent ?? "?"}`; if (percents.at(-1) !== step) percents.push(step); }
    if (last.kind === "finished") { finished = true; break; }
    if (last.kind === "failed") { failedReason = last.reason ?? "blocked"; break; }
  }
  const progress = clock.finish(performance.now() - t0);
  await Promise.all(inflight);
  const to = Date.now();
  return {
    checkSeconds: Math.round((to - from) / 1000), sends: sends.length,
    ...upgradeChatResult({ finished, failedReason, sends, pollFailures, pollCount }),
    accepted: stats(sends.map(t => t.acceptedMs)), engineStarted: stats(sends.map(t => t.engineStarted)), firstText: stats(sends.map(t => t.firstText)),
    stall: eldWindow(from, to), frozen: stats(progress.gaps), longestAtOnePercent: progress.longest, percentSteps: percents.slice(-20),
  };
});

await scenario("ui", async () => {
  const flows = await pw("flows", join(OUT, `pw-flows-${LABEL}.json`));
  // the waterfall in brief (the full rows are in pw-flows-<label>.json): per flow and rep, request count, bytes, the slowest five
  const waterfall = Object.fromEntries(Object.entries(flows.waterfall ?? {}).map(([k, reps]) => [k, reps.map(r => ({
    requests: r.requests.length, bytes: r.requests.reduce((a, q) => a + (q.bytes ?? 0), 0), lastEnd: Math.max(0, ...r.requests.map(q => q.end ?? 0)),
    slowest: [...r.requests].sort((a, b) => (b.ms ?? 0) - (a.ms ?? 0)).slice(0, 5).map(q => `${q.method} ${q.url.slice(0, 80)} ${q.start}-${q.end} ms ${q.bytes ?? "?"} B`) }))]));
  return { flows: Object.fromEntries(Object.entries(flows.flows ?? {}).map(([k, v]) => [k, { usable: stats(v.usable), settled: stats(v.settled) }])), waterfall, errors: flows.errors ?? flows.error };
});

// turn prep and Murage-added time to first token on the resumed long session (the fake engine answers at once).
// Runs with the engine pool on, so a turn after the first can reuse a warm engine: `warm` holds only the turns whose
// engine.acquire says cold=false (the warm-session row); each turn records engineCold and pooling.
await scenario("turnPrep", () => withPool(true, async () => {
  const n = Number(process.env.SCALE_HOT_TURNS ?? (R.shape === "extreme" ? 6 : 12));
  const turns = []; const cap = performance.now() + Number(process.env.SCALE_HOT_CAP_MS ?? 2_400_000);
  for (let i = 0; i < n && performance.now() < cap; i++) { const t = await turn(sable.id, sable.threadId, PROMPT(1000 + i)); turns.push(t); log("hot turn", i, t.wall, t.outcome, `prep=${t.prep} cold=${t.engineCold} resets=${t.resets}`); }
  // the first turn resumes the generated 2,000-receipt session; later ones run on whatever session it left
  return { ...turnSummary(turns), warm: turnSummary(turns.filter(t => t.engineCold === false)), firstResume: turns[0] && { wall: turns[0].wall, prep: turns[0].prep, resets: turns[0].resets, reasons: turns[0].resetReasons }, turns };
}));

// Murage-added time to first token on a cold engine: the pool off (the shipped default), so every turn starts its engine.
// Only turns whose engine.acquire says cold=true count.
await scenario("coldStart", () => withPool(false, async () => {
  const n = Number(process.env.SCALE_COLD_TURNS ?? 6);
  const turns = [];
  for (let i = 0; i < n; i++) { const t = await turn(sable.id, sable.threadId, PROMPT(3000 + i)); turns.push(t); log("cold turn", i, t.wall, t.outcome, `firstText=${t.firstText} cold=${t.engineCold}`); }
  const cold = turns.filter(t => t.engineCold === true);
  return { ...turnSummary(cold), sent: turns.length, notCold: turns.length - cold.length, turns };
}));

// per-turn cost at turns 10, 100 and 500 of one resumed session
await scenario("slope", async () => {
  const total = Number(process.env.SCALE_SLOPE_TURNS ?? SHAPE.slopeTurns);
  const marks = [10, 100, 500].filter(m => m <= total);
  // marks the run does not reach are left out (the gate then reports how far it got)
  const all = [];
  // storage: live bytes and the thread's message count before the first turn and after each (STORAGE-AUDIT section 6 slope row)
  const sdb = new DatabaseSync(join(DATA, "messages.db"), { readOnly: true });
  const countRows = sdb.prepare("SELECT count(*) AS n FROM messages WHERE thread_id=?");
  const samples = [];
  const sample = () => { try { samples.push({ live: liveBytes(sdb), messages: Number(countRows.get(slope.threadId)?.n ?? 0) }); } catch (error) { samples.push({ error: String(error.message).slice(0, 120) }); } };
  sample();
  // a time cap: a tree that needs seconds per turn would take hours to reach turn 500; it reports how far it got
  const cap = performance.now() + Number(process.env.SCALE_SLOPE_CAP_MS ?? (R.shape === "extreme" ? 5_400_000 : 3_600_000));
  try { for (let i = 1; i <= total && performance.now() < cap; i++) { const t = await turn(slope.id, slope.threadId, PROMPT(i)); all.push(t); sample(); if (i % 50 === 0) log("slope", i, t.wall, `prep=${t.prep} resumed=${t.resumed} resets=${t.resets}`); } }
  finally { sdb.close(); }
  const sampleError = samples.find(x => x.error)?.error;
  R.storageSlope = sampleError ? { error: `slope storage: a sample failed: ${sampleError}` } : slopeBytes(samples);
  // each mark: the turns among the five ending at it (turn 10 = turns 6..10) that truly resumed the session (the engine
  // resumed it, no reset in the turn); prep is the trace's dispatch.send only
  const at = Object.fromEntries(marks.filter(m => m <= all.length).map(m => [`turn${m}`, turnSummary(all.slice(Math.max(0, m - 5), m).filter(trulyResumed))]));
  const share = resumedShare(all), resumedN = all.slice(1).filter(trulyResumed).length;
  const out = { ...at, reached: all.length, last: turnSummary(all.slice(-5).filter(trulyResumed)), resumedShare: share, resumedTurns: resumedN,
    notResumed: all.map((t, i) => (i > 0 && !trulyResumed(t) ? i + 1 : null)).filter(Boolean).slice(0, 50),
    resets: all.reduce((a, t) => a + t.resets, 0), failed: all.filter(t => t.outcome !== "turn.completed").length, prepByTurn: all.map(t => t.prep), resumedByTurn: all.map(t => t.resumed) };
  // a long-session check on a session that did not stay resumed measures nothing: say so loudly
  if (share === null || share < MIN_RESUMED_SHARE) out.error = `slope invalid: only ${resumedN} of ${Math.max(0, all.length - 1)} turns after the first resumed the session (${share === null ? "none" : Math.round(share * 100)}% < ${MIN_RESUMED_SHARE * 100}%)`;
  return out;
});

// memory search while a bot is capturing: recall on a fresh Sable task (the heaviest memory), plus the owner's search.
// Capt's turn goes first each round, so its capture (and the generated pending-job backlog) is being worked while
// Sable's turn recalls. Each turn is read from its own trace (a re-dispatch of Capt's is followed and finished before
// Sable's send) and scored by the bundle it sent; the success share is Sable's alone, Capt's is reported apart.
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
  const bot = list => ({ turns: list.length, recallSuccess: recallSuccess(list), recallHits: list.map(t => t.recallHits ?? null), recallModes: list.map(t => t.recallMode ?? "n/a"),
    hitsFrom: list.map(t => t.recallHitsSource), redispatched: list.filter(t => t.redispatched).length, foreignTraces: list.reduce((a, t) => a + (t.foreignTraces ?? 0), 0) });
  return {
    recall: stats(turns.map(t => t.recallMs)), recallModes: turns.map(t => t.recallMode ?? "n/a"),
    recallSuccess: recallSuccess(turns), byBot: { [sable.name]: bot(turns), [capt.name]: bot(captTurns.filter(t => t.traceId !== undefined)) },
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
  // lateness from each run's own slot (its first due time plus its place in the 60 s dispatch spread); from that due time too, for reference.
  // Runs that never started are counted apart (unstarted): the percentiles cover started runs only, so a gate reads both.
  const starts = runs.filter(r => r.startedAt).map(r => r.startedAt - (r.slotAt ?? r.scheduledFor));
  const fromDue = runs.filter(r => r.startedAt).map(r => r.startedAt - (r.dueAt ?? r.scheduledFor));
  return { routines: n, runs: runs.length, started: starts.length, unstarted: runs.length - starts.length, coalesced: runs.reduce((sum, r) => sum + (r.coalescedOccurrences ?? 0), 0), start: stats(starts), startFromDue: stats(fromDue), statuses: [...new Set(runs.map(r => r.status))], eldDuringBurst: eldWindow(due - 2000, Math.max(due + 60_000, Date.now())), healthDuringBurst: probeWindow(due - 2000, due + 60_000), waitedFrom: from };
});

// revoke / forget: how long the app freezes (request time, health requests stuck behind it, event-loop stall), per
// revocation index state. The session is the one with the most receipts that cite sources (never the newest: a reset
// leaves a fresh session whose receipts cite nothing). Fewer than 1 archive and 2 forget actions is a rig error.
await scenario("revoke", async () => {
  const db = new DatabaseSync(join(DATA, "messages.db"), { readOnly: true });
  const sess = db.prepare("SELECT native_session AS s, count(*) AS n FROM memory_disclosures WHERE thread_id=? AND native_session IS NOT NULL AND json_array_length(source_versions)>0 GROUP BY 1 ORDER BY n DESC LIMIT 1").get(sable.threadId);
  const session = sess?.s, citing = Number(sess?.n ?? 0);
  const cited = session ? db.prepare("SELECT json_extract(j.value,'$.id') AS id, count(*) AS n FROM memory_disclosures d, json_each(d.source_versions) j WHERE d.thread_id=? AND d.native_session=? GROUP BY 1 ORDER BY n DESC LIMIT 3").all(sable.threadId, session) : [];
  const records = session ? db.prepare("SELECT json_extract(j.value,'$.id') AS id, count(*) AS n FROM memory_disclosures d, json_each(d.record_versions) j WHERE d.thread_id=? AND d.native_session=? AND json_array_length(d.record_versions)>0 GROUP BY 1 ORDER BY n DESC LIMIT 6").all(sable.threadId, session) : [];
  // archive needs the record's CURRENT version (a receipt cites the version it was shown, often an older one: MEMORY_VERSION_CONFLICT),
  // so read it now and only archive records that are active, so the archive is measured and not ended by the conflict
  const current = records.map(r => db.prepare("SELECT version FROM memory_records WHERE id=? AND state='active' ORDER BY version DESC LIMIT 1").get(String(r.id))).map((row, i) => row ? { id: String(records[i].id), version: Number(row.version) } : null).filter(Boolean);
  db.close();
  const archives = [...new Map(current.map(r => [r.id, r])).values()].slice(0, 2).map(r => ({ action: "archive", id: r.id, version: r.version }));
  const forgets = cited.slice(0, 2).map(c => ({ action: "forget", kind: "source", id: String(c.id) }));
  const target = { session, citingReceipts: citing, hotSession: gen.hot?.session ?? null };
  if (archives.length < 1 || forgets.length < 2) {
    const error = `revoke: built ${archives.length} archive and ${forgets.length} forget actions (needs 1 and 2) from session ${session ?? "none"} with ${citing} citing receipts`;
    log("REVOKE NOT MEASURED", error);
    return { indexMode: REVOKE_INDEX, target, byState: { [REVOKE_INDEX]: { error } } };
  }
  const freezes = [];
  for (const body of [...archives, ...forgets]) {
    const before = indexReady(), readyLogged = logText().includes("[memory] revocation index ready");
    const from = Date.now(), t = performance.now();
    let error;
    try { await api("POST", "/api/memory/action", body, 600000); } catch (e) { error = String(e.message).slice(0, 160); }
    const ms = Math.round(performance.now() - t);
    const after = indexReady();
    await sleep(2500);
    freezes.push({ action: body.action, ms, error, indexReadyBefore: before, indexReadyAfter: after, readyLoggedBefore: readyLogged, state: indexState(before, after), eldMax: eldWindow(from, Date.now()).max, healthMax: probeWindow(from, Date.now()).max });
  }
  const freezeOf = f => Math.max(f.eldMax ?? 0, f.healthMax ?? 0);
  // one row per index state: an action whose state flipped while it ran (or could not be read) belongs to neither
  const byState = {};
  for (const state of ["ready", "building"]) {
    const rows = freezes.filter(f => f.state === state);
    if (rows.length) byState[state] = { n: rows.length, request: stats(rows.map(f => f.ms)), freeze: stats(rows.map(freezeOf)) };
  }
  if (!byState[REVOKE_INDEX]) byState[REVOKE_INDEX] = { error: `revoke: not measured in the ${REVOKE_INDEX} state: the actions ran in ${[...new Set(freezes.map(f => f.state))].join(", ")}` };
  // the building pass ends here: a turn would only race the backfill further
  const after = building ? null : await turn(sable.id, sable.threadId, PROMPT(9000));
  return { indexMode: REVOKE_INDEX, target, request: stats(freezes.map(f => f.ms)), freeze: stats(freezes.map(freezeOf)), byState, freezes,
    ...(after ? { turnAfter: { wall: after.wall, prep: after.prep, resets: after.resets, reasons: after.resetReasons } } : {}) };
});

// idle: no owner action past the server's 5 minute mark, so its storage maintenance (reclaim, incremental vacuum) runs
// before the file-vs-live row is measured (not on the building pass, which only measures revoke)
const IDLE_MS = building ? 0 : Number(process.env.SCALE_IDLE_MS ?? 480_000);
if (IDLE_MS > 0) { log(`idle ${Math.round(IDLE_MS / 1000)} s before the storage measurement`); await sleep(IDLE_MS); }
R.eldAll = eldWindow(RUN_START, Date.now());
// real resets only (`memory continuation reset thread=…`), not the `reset loop` summary lines
R.resetLines = resetLines(logText()).length;
R.finishedAt = new Date().toISOString();
probing = false; sseAbort?.abort();
save();
await stopServer();
stopLoad();
// storage at the end of the run (STORAGE-AUDIT section 6), with the server stopped: dbstat per table, live and file
// bytes, events/; dbstat missing is recorded as an error the gate fails on
try {
  const t = performance.now();
  const sdb = new DatabaseSync(join(DATA, "messages.db"));
  try { R.storage = { ...measureStorage(sdb, { file: join(DATA, "messages.db"), eventsDir: join(DATA, "events") }), idleMs: IDLE_MS }; } finally { sdb.close(); }
  if (R.storageSlope) R.storage.slope = R.storageSlope;
  R.storage.seconds = Math.round((performance.now() - t) / 1000);
  log(`storage: live ${R.storage.liveBytes} B, file ${R.storage.fileBytes} B, messages b-tree ${R.storage.messagesBytes ?? "?"} B${R.storage.error ? `, ${R.storage.error}` : ""}`);
} catch (error) { R.storage = { error: `storage not measured: ${String(error.message).slice(0, 200)}` }; log("STORAGE NOT MEASURED", error.message); }
delete R.storageSlope;
save();
log("DONE");
process.exit(0);
