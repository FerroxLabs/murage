import { prepareSourceNative } from "./native-preflight.mjs";
import { prepareLongThread } from "./long-thread.mjs";
import { firstSendRecorder, allEldWindows } from "./smooth-config.mjs";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The smoothness gate runner (SMOOTHNESS-GATE-105): Sean's day as a fixed scenario set, run against a COPY of his real
// data on a box (never a laptop), with fake engines first on PATH so every millisecond, byte and card is Murage's own.
// Results go to $SMOOTH_OUT/results-<label>.json; smooth-gate.mjs judges them against budgets.json.
//
//   MURAGE_DATA_DIR=/smooth-data/murage SMOOTH_WORK=/work SMOOTH_OUT=/out SMOOTH_LABEL=<label> node scripts/smoothness/smooth.mjs
//
// env: SMOOTH_CTL (control dir for the engine wrappers, default /tmp/smooth-ctl), SMOOTH_SCENARIOS (comma list, default all), SMOOTH_S10_ENGINES (S10 Auto engines, default claude,codex,fuigo),
//      SMOOTH_APP_DIR (v5.8: unpacked/installed app root, or Murage.app on macOS; unset keeps the source launch),
//      SMOOTH_S10_ASK_ENGINE (S10 Ask shell engine, default fuigo),
//      SMOOTH_ENGINES=fake|real (real: no wrappers, the PATH engines as they are; the fake-only steps are reworded, see README),
//      LOAD=1 (recorded; the load itself is stress-ng on the host, see hz-smooth.sh), SMOOTH_TURN_TIMEOUT_MS (default 180000),
//      SMOOTH_IDLE_S (default 180), SMOOTH_ROUTINES (default 8), SMOOTH_STOP_LEVEL (real engines: the S8 Stop bot's level,
//      default full; S7's switch bot stays at Ask and the runner answers its cards). Every runner bot has its own folder under /tmp/smooth-work; a timed-out turn is stopped and the bot
//      waited idle before the next send; every bot a scenario made is stopped when the scenario ends.
// Nothing here prints message content: counts, ids, timings and the fakes' own fixed words only.
import { execFile, spawn, spawnSync } from "node:child_process";
import http from "node:http";
import { appendFileSync, chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { cpus, loadavg } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { stats } from "../scale/stats.mjs";
import { createRequire } from "node:module";
import { observedDataDir, packagedBoots, packagedLayout, packagedStartupPreflight, packagedTracePreflight, prepareCompileCache, readAppMetadata, readElectronVersion, refusePackagedLeg, serverLaunch } from "./packaged.mjs";
import { fakeVersionBanner, fakeVersionShell, initialResults, proveFakeResolvers, stopOwnedServer } from "./packaged.mjs";
import { drainRoomCards, enforceRoomSettlement, recordCleanupFailure, roomBudget, roomSchemaError, measuredEld, warmIoCounts, ioWriteStats } from "./smooth-config.mjs";
import { roomProofRefusal, runRoomRouteProof } from "./smooth-config.mjs";
import { evidenceLedger, writeEvidence } from "./evidence.mjs";
import { allTimed, cardStat, eldSummary, idleIoCounts, keptText, pageCovers, routinePrompt, winLeftovers, workerSliceWall } from "./smooth-config.mjs";
import { controlAdapter, restoreControls, failureEventRecord, failedTurnKey, failedTurnRecord, keptTurnEnd, nativeRpcErrorsIn } from "./smooth-config.mjs";
import { matchTurnEvent, openTraces, resetLines, termsVersionFrom, turnFromLog } from "../scale/rig-config.mjs";
import { answerCards, botFolder, cardTimings, cardsIn, ownerAnswer, chainFromManager, chainFromServer, contextChangedIn, countSignatures, DEV_COMMANDS, eldStalls, errorRowsIn, heldPrompt, LEVELS, levelPatch, openCards, permissionWaits, roomReplies, routineBurst, sampleWindow, withPeak, cgroupPathOf, cgroupCpuUsec, cgroupMemMb, coresBetween, coresFromTopLine, macTable, legRss, parseTopProcs, preStartCheck, rigPidTracker, rigProvenance, topSampleCollector, treeCores, leftovers, leftoverNames, winLine, winPeakProcs, winCores, keptCard, traceLinesOf, realDelegationPrompt, dataDirRealOk, browserHostVerdict, dataDirAllowed, osPassThrough, WIN_TELEMETRY_PS, encodedPowerShell, SERVER_START_MARK, startupNotesIn, stopAndSettle, STOP_COMMANDS, stopKind, waitFor, withheldIn, workingDeleteVerdict } from "./smooth-config.mjs";

const DATA = resolve(process.env.MURAGE_DATA_DIR ?? "");
const WIN = process.platform === "win32";
const OUT = resolve(process.env.SMOOTH_OUT ?? "/out");
const LABEL = (process.env.SMOOTH_LABEL ?? "tree").replace(/[^\w.-]/g, "-");
const RUN_ID = process.env.SMOOTH_RUN_ID || randomBytes(16).toString("hex");
const ENGINES = process.env.SMOOTH_ENGINES === "real" ? "real" : "fake";
const R = initialResults({ rigVersion: "5.10", mode: process.env.SMOOTH_APP_DIR ? "packaged" : "source", label: LABEL, runId: RUN_ID,
  startedAt: new Date().toISOString(), engines: ENGINES, roomProofRequested: process.env.SMOOTH_ROOM_PROOF === "1",
  scenarios: {}, all: {}, notes: [], failedTurns: { count: 0, records: [] }, created: { bots: [], groups: [], routines: [] } });
const evidence = evidenceLedger({ results: R,
  writeResults: () => writeFileSync(join(OUT, `results-${LABEL}.json`), JSON.stringify(R, null, 1)),
  setExitCode: code => { process.exitCode = code; } });
const save = evidence.save;
process.on("exit", code => { process.exitCode = evidence.beforeExit(code); });
let refusalCleanup = async () => {};
let refusalReason = null;
const refusePackaged = reason => {
  refusalReason = reason; // Telemetry callbacks can refuse while the main task is awaiting a sample.
  return refusePackagedLeg(reason, { results: R, save, report: message => console.error(message),
    stop: () => refusalCleanup(), exit: code => process.exit(evidence.beforeExit(code)) });
};
mkdirSync(OUT, { recursive: true });
save(); // Supersede an older PASS before data, app metadata, Electron or native validation.
const proofRefusal = roomProofRefusal(R.roomProofRequested, ENGINES);
if (proofRefusal) await refusePackaged(proofRefusal);
try {
if (!process.env.MURAGE_DATA_DIR || !dataDirAllowed(DATA)) throw Error(`MURAGE_DATA_DIR=${DATA}: it must be a copy under a path containing "smooth"`);
// RIG-SMOOTH-R2 (a): the dir must exist (the launchers create it) and the real path of it and of every ancestor must stay out of
// .murage: a symlink or junction anywhere on the path is refused, whatever its depth.
if (!existsSync(DATA) || !statSync(DATA).isDirectory()) throw Error(`MURAGE_DATA_DIR=${DATA}: it does not exist (the launcher creates it)`);
if (!dataDirRealOk(DATA, p => realpathSync.native(p))) throw Error(`MURAGE_DATA_DIR=${DATA}: its real path, or an ancestor's, is not an allowed copy`);
if (existsSync(join(DATA, "routines.json"))) throw Error("data copy still has routines.json (delete it in the copy first)");
} catch (error) { await refusePackaged(error.message); }
const WORK = resolve(process.env.SMOOTH_WORK ?? process.cwd());
// All platforms, including direct Windows/package launches: output must survive
// deleting either the data copy or checkout. Resolve symlinks/junctions as well.
try {
  for (const dir of [DATA, WORK]) {
    const rel = relative(realpathSync.native(dir), realpathSync.native(OUT));
    if (!rel || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${WIN ? "\\" : "/"}`))) throw Error("SMOOTH_OUT must be outside the data dir and working copy");
  }
} catch (error) { await refusePackaged(error.message); }
const APP = process.env.SMOOTH_APP_DIR ? packagedLayout(process.env.SMOOTH_APP_DIR) : null;
let appMetadata = null, electronMetadata = null;
if (APP) {
  try {
    for (const file of [APP.executable, APP.serverEntry]) if (!statSync(file).isFile()) throw Error(`not a file: ${file}`);
    appMetadata = readAppMetadata(APP.resources);
    if (typeof appMetadata.version !== "string" || !appMetadata.version.trim()) throw Error("app package.json has no version");
    electronMetadata = readElectronVersion(APP);
  } catch (error) { await refusePackaged(`invalid SMOOTH_APP_DIR (${error.message})`); }
}
const CTL = resolve(process.env.SMOOTH_CTL ?? "/tmp/smooth-ctl");
const SCEN = new Set((process.env.SMOOTH_SCENARIOS ?? "boot,routineBurst,delegation,room,trust,autoEveryday,longThread,deletion,engineSwitch,stop,idle").split(","));
const PORT = Number(process.env.SMOOTH_PORT ?? 18977), URL_ = `http://127.0.0.1:${PORT}`, SECRET = randomBytes(32).toString("hex");
const TURN_TIMEOUT = Number(process.env.SMOOTH_TURN_TIMEOUT_MS ?? 180_000);
// Windows: an ssh session has USERPROFILE and often no HOME; the engines' sign-ins live under USERPROFILE
const HOME = ENGINES === "real" ? (process.env.HOME ?? (WIN ? process.env.USERPROFILE : undefined) ?? "/tmp/smooth-home") : "/tmp/smooth-home";
const WORKDIR = "/tmp/smooth-work"; // the root of the bots' folders (one per bot, botFolder): never inside a real home
const LOG = join(OUT, `server-${LABEL}.log`);
for (const d of [OUT, HOME, WORKDIR, CTL, join(CTL, "bin"), join(CTL, "prompts"), "/tmp/smooth-tmp"]) mkdirSync(d, { recursive: true });
writeFileSync(LOG, "");
const RUN_START = Date.now();
let serverReady = false;
const markSend = firstSendRecorder({ results: R, runId: RUN_ID, runStart: RUN_START, now: Date.now,
  logSize: () => statSync(LOG).size, ready: () => serverReady && Boolean(server),
  requestId: () => randomBytes(16).toString("hex"), save, fail: evidence.fail,
  persist: mark => {
    const dir = join(OUT, "debug"); mkdirSync(dir, { recursive: true, mode: 0o700 });
    return writeEvidence({ kind: "firstSend", ...mark }, {
      open: () => openSync(join(dir, `run-events-${RUN_ID}.jsonl`), "a", 0o600),
      append: (fd, text) => writeFileSync(fd, text), fsync: fsyncSync, close: closeSync, fail: evidence.fail,
    });
  } });
const NOT_RUN = (process.env.SMOOTH_ENGINES_NOT_RUN ?? "").split(",").filter(Boolean); // engines present but not usable (recorded as "not run")
Object.assign(R, rigProvenance({ env: process.env, platform: process.platform, git: () => spawnSync("git", ["-C", new URL(".", import.meta.url).pathname, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 5000 }).stdout, mdutil: () => spawnSync("/usr/bin/mdutil", ["-s", "/"], { encoding: "utf8", timeout: 5000 }).stdout }));
Object.assign(R, { appDir: APP?.appDir ?? null, appVersion: appMetadata?.version ?? null, serverEntry: APP?.serverEntry ?? join(WORK, "server/index.ts"), tree: process.env.TREE_SHA ?? null, engines: ENGINES, ...(NOT_RUN.length ? { enginesNotRun: NOT_RUN } : {}), load: process.env.LOAD === "1" });
if (APP) Object.assign(R, { electronVersion: electronMetadata.version, electronVersionSource: electronMetadata.source,
  electronVersionFile: electronMetadata.file, electronVersionExecutable: electronMetadata.executable });
// RIG-SMOOTH-R2 v3 d2: the native files the server will use, by sha256, against the build under test. On Windows with real engines both
// must be present and match, and the product's own resolver must land on the hashed helper, so a direct run cannot bypass the leg.
try {
  if (!APP) R.nativePreflight = await prepareSourceNative({ work: WORK, expectedSha256: process.env.SMOOTH_ENGINE_EXCLUSION_SHA256 });
  const plat = `${process.platform}-${process.arch}`, realWin = WIN && ENGINES === "real";
  const sha = f => existsSync(f) ? createHash("sha256").update(readFileSync(f)).digest("hex") : null;
  const check = (key, file, expected) => {
    const sha256 = sha(file), verdict = browserHostVerdict({ sha256, expected: expected || null });
    R.env = { ...R.env, [key]: { path: file, sha256, expected: expected || null, verdict } };
    if (verdict === "mismatch" || (expected && verdict === "absent") || (realWin && verdict !== "ok")) throw Error(`${key} ${file} verdict ${verdict}; it must be the build under test`);
  };
  const helper = APP ? join(APP.resources, "browser-extension", plat, WIN ? "murage-browser-host.exe" : "murage-browser-host") : join(WORK, "dist-native", "browser-extension", plat, WIN ? "murage-browser-host.exe" : "murage-browser-host");
  check("browserHost", helper, process.env.SMOOTH_BROWSER_HOST_SHA256);
  check("engineExclusion", APP ? join(APP.resources, "engine-exclusion.node") : join(WORK, "dist-native", "engine-exclusion", plat, "engine-exclusion.node"), process.env.SMOOTH_ENGINE_EXCLUSION_SHA256);
  if (realWin) {
    let got = null; try { got = (await import(pathToFileURL(join(WORK, "electron/browser-extension-windows.mjs")).href)).resolveWindowsBrowserHelper({ resources: APP?.resources ?? null }); } catch (error) { got = `resolver failed: ${String(error?.message ?? error).slice(0, 160)}`; }
    if (String(got).toLowerCase() !== helper.toLowerCase()) throw Error(`the server would use ${got}, not the hashed helper ${helper}`);
    // the addon that counts is the file the product's own loader opens, not the file we hashed: ask the loader, with the server's env
    for (const name of ["MURAGE_RESOURCES_PATH", "OMB_RESOURCES_PATH", "MURAGE_ENGINE_EXCLUSION_PATH"]) if (process.env[name]) throw Error(`${name} is set, so the loader could open another addon`);
    if (!APP) {
      const hashedAddon = join(WORK, "dist-native", "engine-exclusion", plat, "engine-exclusion.node");
      let opened = null;
      try {
        const addon = (await import(pathToFileURL(join(WORK, "server/engine-exclusion.ts")).href)).loadExclusionAddon();
        const files = Object.keys(createRequire(import.meta.url).cache).filter(k => /engine-exclusion\.node$/i.test(k));
        opened = addon && files.length === 1 ? realpathSync(files[0]) : `addon ${addon ? "loaded" : "not loaded"}, native files seen: ${files.join(", ") || "none"}`;
      } catch (error) { opened = `loader failed: ${String(error?.message ?? error).slice(0, 160)}`; }
      if (String(opened).toLowerCase() !== realpathSync(hashedAddon).toLowerCase()) throw Error(`the loader opened ${opened}, not the hashed addon ${hashedAddon}`);
    } // packaged: the preload witnesses the compiled loader in its own Electron process during preflight
  }
} catch (error) { await refusePackaged(error.message); }
// The product's own redaction, from the tree under test. Without it no payload or error text is kept.
let redact = null;
try { redact = (await import(pathToFileURL(join(WORK, "server/redact.ts")).href)).redactSecretsInText; } catch (error) { R.notes.push(`redaction not loaded: ${String(error?.message ?? error).slice(0, 160)}`); }
const keepCard = (scenario, threadId, row) => { const id = row?.card?.requestId; if (typeof id !== "string") return; R.cardPayloads = R.cardPayloads ?? {}; if (!R.cardPayloads[id]) R.cardPayloads[id] = { scenario, threadId, at: row.at ?? null, ...keptCard(row.card, redact) }; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(`[smooth ${LABEL} ${new Date().toISOString().slice(11, 19)}]`, ...a);
const note = s => { R.notes.push(s); log("note:", s); };

// ---- engine wrappers: named as the default instances' CLIs, first on PATH, mode from a control file read at spawn
const { ctl, readControl } = controlAdapter({ pathOf: name => join(CTL, name), readFileSync, writeFileSync, rmSync });
const controlFailure = error => {
  R.controlRestoreFailed = true;
  recordCleanupFailure(R, keptText(error.message, redact));
  save();
};
const restore = values => restoreControls({ ctl, readControl, values, onFailure: controlFailure });
const ownedThreads = new Set(), journaledTurns = new Set(), pendingEnrichments = new Set();
const activeEvidenceTurns = new Map();
const ownedThreadScenarios = new Map(), activeJournalTurns = new Map();
let journalTurnSequence = 0;
function registerOwnedThreads(json) {
  const add = threadId => {
    if (typeof threadId !== "string") return;
    ownedThreads.add(threadId);
    if (!ownedThreadScenarios.has(threadId)) ownedThreadScenarios.set(threadId, currentScenario);
  };
  for (const bot of [...(json?.bots ?? []), ...(json?.bot ? [json.bot] : [])]) {
    if (!R.created.bots.includes(bot.id)) continue;
    add(bot.threadId);
    for (const task of bot.tasks ?? []) add(task.threadId);
  }
  for (const group of [...(json?.groups ?? []), ...(json?.group ? [json.group] : [])]) {
    if (R.created.groups.includes(group.id)) add(group.threadId);
  }
}
// SMOOTH_DEBUG=1: the fakes' stderr, argv and RPC log go to $SMOOTH_OUT/debug (a diagnosis run only; the lane dir is deleted after)
const DEBUG = process.env.SMOOTH_DEBUG === "1" ? join(OUT, "debug") : "";
const wrappers = APP ? Object.fromEntries(["fuigo", "grok", "claude"].map(name => {
  const path = join(CTL, "bin", name), witness = randomBytes(24).toString("hex");
  return [name, { path, witness, banner: fakeVersionBanner(name, witness) }];
})) : {};
if (DEBUG) mkdirSync(DEBUG, { recursive: true });
function writeWrappers() {
  const acp = cli => `#!/bin/sh
# ${cli}: the fake ACP engine (server/testing/fake-acp-cli.ts); mode and knobs from ${CTL} at spawn
${APP ? fakeVersionShell(cli, wrappers[cli].witness) + "\n" : ""}M=$(cat "${CTL}/${cli}.mode" 2>/dev/null); export FAKE_ACP_MODE="\${M:-happy}" FAKE_ACP_MCP_LIST=all:ready FAKE_ACP_UNIQUE_SESSIONS=1
[ -f "${CTL}/delegate-to" ] && export FAKE_ACP_DELEGATE_TO="$(cat "${CTL}/delegate-to")"
[ -f "${CTL}/permission-command" ] && export FAKE_ACP_PERMISSION_COMMAND="$(cat "${CTL}/permission-command")"
[ -f "${CTL}/gate-file" ] && export FAKE_ACP_GATE_FILE="$(cat "${CTL}/gate-file")"
export FAKE_ACP_TOOL_MS=45000 FAKE_ACP_PROMPT_DUMP="${CTL}/prompts/${cli}-$$.json"
${DEBUG ? `export FAKE_ACP_RPC_LOG="${DEBUG}/${cli}-$$.rpc"; exec 2>>"${DEBUG}/${cli}-$$.stderr"; echo "argv: $*" >&2` : ""}
exec node --experimental-strip-types "${WORK}/server/testing/fake-acp-cli.ts" "$@"
`;
  const claude = `#!/bin/sh
# claude: the fake claude CLI (server/testing/fake-claude-cli.ts)
${APP ? fakeVersionShell("claude", wrappers.claude.witness) + "\n" : ""}export FAKE_CLAUDE_MODE=happy FAKE_CLAUDE_DUMP_LOG="${CTL}/prompts/claude.jsonl"
${DEBUG ? `export FAKE_CLAUDE_PROBE_LOG="${DEBUG}/claude-probe.jsonl"; exec 2>>"${DEBUG}/claude-$$.stderr"; echo "argv: $*" >&2` : ""}
exec node --experimental-strip-types "${WORK}/server/testing/fake-claude-cli.ts" "$@"
`;
  for (const [name, body] of [["grok", acp("grok")], ["fuigo", acp("fuigo")], ["claude", claude]]) { const p = join(CTL, "bin", name); writeFileSync(p, body); chmodSync(p, 0o755); }
  for (const f of ["grok.mode", "fuigo.mode", "delegate-to", "permission-command", "gate-file"]) ctl(f, null);
  // Engines are found the way an owner's are: the server hands engines the PATH of the owner's login shell (Rule 74a), so the
  // wrappers go first on that shell's PATH too, through this run's own home (never a real one).
  const line = `export PATH="${join(CTL, "bin")}:$PATH"\n`;
  for (const f of [".profile", ".bash_profile", ".bashrc", ".zshenv", ".zprofile", ".zshrc"]) writeFileSync(join(HOME, f), line);
  // Fuigo refuses before spawning when it sees neither a key nor a login (acp/fuigo.ts isAuthenticated): the run's home holds a
  // placeholder login file, so the fake is spawned as a signed-in Fuigo would be. It carries no credential and nothing reads it.
  mkdirSync(join(HOME, ".fuigo"), { recursive: true }); writeFileSync(join(HOME, ".fuigo", "auth.json"), "{}\n");
}
if (ENGINES === "fake") writeWrappers();
const promptDumps = () => readdirSync(join(CTL, "prompts")).map(f => readFileSync(join(CTL, "prompts", f), "utf8"));
const clearPromptDumps = () => { for (const f of readdirSync(join(CTL, "prompts"))) { try { rmSync(join(CTL, "prompts", f)); } catch {} } };

// ---- server
const termsVersion = termsVersionFrom(existsSync(join(WORK, "shared/terms.ts")) ? readFileSync(join(WORK, "shared/terms.ts"), "utf8") : "");
if (!termsVersion) note("shared/terms.ts has no readable TERMS_VERSION");
const env = {
  PATH: ENGINES === "fake" ? `${join(CTL, "bin")}:${process.env.PATH}` : process.env.PATH, HOME, USERPROFILE: HOME, XDG_CONFIG_HOME: `${HOME}/.config`, XDG_CACHE_HOME: `${HOME}/.cache`, XDG_DATA_HOME: `${HOME}/.local/share`,
  TMPDIR: "/tmp/smooth-tmp", LANG: "C.UTF-8", MURAGE_DATA_DIR: APP ? realpathSync.native(DATA) : DATA, MURAGE_PORT: String(PORT), MURAGE_WEBHOOK_PORT: String(PORT + 1),
  MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1", MURAGE_DEV_DESKTOP_SECRET: SECRET, MURAGE_TURN_TRACE: "1", MURAGE_ANNOUNCEMENTS_URL: "off",
  ...(termsVersion ? { MURAGE_TERMS_ACCEPTED: termsVersion } : {}),
  ...(process.env.FLUX_KEY_FILE && ENGINES === "real" ? { FLUX_KEY_FILE: process.env.FLUX_KEY_FILE } : {}),
  // macOS and Windows real legs only (Linux passes nothing more): the OS variables the engines need, see osPassThrough
  ...(ENGINES === "real" ? Object.fromEntries(osPassThrough(process.platform).filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]])) : {}),
  ...(WIN ? { TEMP: resolve("/tmp/smooth-tmp"), TMP: resolve("/tmp/smooth-tmp") } : {}),
};
// Real leg, Fuigo: its key is read from a file into the server's environment (the owner environment Fuigo is handed), never
// an argument, a log line or a result. Murage's own Flux account is not configured, so no connected-apps flow can start.
if (ENGINES === "real" && process.env.SMOOTH_FUIGO_KEY_FILE) {
  const key = readFileSync(process.env.SMOOTH_FUIGO_KEY_FILE, "utf8").trim();
  if (key) env.FUIGO_API_KEY = key;
  R.fuigoKey = key ? "from file" : "file empty";
}
let server = null, stopping = false, serverLogMark = 0, lastServerPid = null, packagedLaunch = null;
R.all.serverExits = 0;
function startServer() {
  if (refusalReason !== null) throw Error(refusalReason);
  // profiling only when a leg asks for it; a profiled leg's timings are read knowing that
  const cpuProf = process.env.SMOOTH_CPU_PROF_DIR ? ["--cpu-prof", "--cpu-prof-interval=5000", `--cpu-prof-dir=${process.env.SMOOTH_CPU_PROF_DIR}`] : [];
  if (cpuProf.length) R.cpuProfiled = true; // judge() marks such a leg invalid
  const launch = packagedLaunch ?? serverLaunch({ appDir: APP?.appDir, appVersion: appMetadata?.version, electronVersion: electronMetadata?.version, gepaPin: appMetadata?.murageGepaManifests?.[`${process.platform}-${process.arch}`] ?? "", work: WORK, env: APP ? { ...env, MURAGE_BOOT_NONCE: randomBytes(24).toString("hex") } : env, execPath: process.execPath, cpuProf });
  if (APP && !packagedLaunch) {
    R.fixtureEnvOmitted = launch.fixtureEnvOmitted;
    R.compileCache = prepareCompileCache(launch.env.NODE_COMPILE_CACHE);
    packagedLaunch = launch; // Identical env and cache on warm and later restarts; never prepare it again.
    save();
  }
  serverReady = false;
  serverLogMark = statSync(LOG).size;
  const fd = openSync(LOG, "a");
  writeSync(fd, `${SERVER_START_MARK} t=${Date.now()}\n`);
  stopping = false;
  server = spawn(launch.executable, launch.args, { cwd: launch.cwd, env: launch.env, stdio: launch.stdio.map(x => x === "log" ? fd : x), windowsHide: true });
  lastServerPid = server.pid ?? null;
  closeSync(fd);
  const s = server;
  s.on("error", error => { if (server === s) { R.all.serverExits++; note(`server spawn failed: ${error.message}`); server = null; } });
  s.on("exit", (code, signal) => { if (!stopping && server === s) { R.all.serverExits++; note(`server exited on its own (${code ?? signal})`); server = null; } });
  return performance.now();
}
async function stopServer() {
  serverReady = false;
  await drainFailureEnrichments("server stop");
  if (!server) return false;
  const s = server; stopping = true; server = null;
  return stopOwnedServer({ child: s, platform: process.platform, send: message => s.send(message), kill: signal => s.kill(signal), spawnSync, sleep });
}
const H = { "x-murage-surface": "desktop", "x-murage-surface-secret": SECRET, "content-type": "application/json" };
const agent = new http.Agent({ keepAlive: false });
function request(method, path, body, timeout) {
  markSend(method, path, body);
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(URL_ + path, { method, agent, timeout, headers: { ...H, ...(data === undefined ? {} : { "content-length": Buffer.byteLength(data) }) } }, res => {
      let text = ""; res.setEncoding("utf8"); res.on("data", c => { text += c; }); res.on("end", () => resolve({ status: res.statusCode ?? 0, text })); res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error(`${method} ${path} timed out after ${timeout} ms`)));
    req.on("error", reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}
/** A request; `{ status, json, ms }`. Throws on a transport failure only: a 4xx/5xx is an answer the scenarios read. */
async function call(method, path, body, timeout = 120_000) {
  if (method === "DELETE") await drainFailureEnrichments("resource deletion");
  const t = performance.now();
  const res = await request(method, path, body, timeout).catch(error => {
    recordTransportFailure("call", method);
    throw error;
  });
  let json, unparsed = false; try { json = JSON.parse(res.text); } catch { json = {}; unparsed = res.text.trim() !== ""; }
  registerOwnedThreads(json);
  return { status: res.status, json, unparsed, ms: Math.round(performance.now() - t) };
}
function recordTransportFailure(adapter, method) {
  (R.transportFailures ??= []).push({ adapter, method, epochMs: Date.now(), requestId: R.firstSend?.requestId ?? null });
  evidence.fail(`${adapter} transport attempt failed`);
}
// S3 only: an absolute abort covers headers AND body; no implicit retry of a POST.
async function roomCall(method, path, body, budget) {
  if (method === "DELETE") await drainFailureEnrichments("room deletion");
  markSend(method, path, body);
  try {
    const res = await fetch(URL_ + path, { method, headers: H,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(Math.max(1, Math.ceil(budget.remaining(budget.timeout)))) });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = null; }
    registerOwnedThreads(json);
    return { status: res.status, json };
  } catch (error) {
    recordTransportFailure("roomCall", method);
    throw error;
  }
}
/** Put a bot at a level the way the desktop app does (src/lib/level-change.ts, 1.0.13 UX-TRUST-L1B): a raise to Full access or
 *  No limits reads the preview first, PATCHes the defaults with previewId and ifRev, then applies it to the open conversations. */
async function setLevel(botId, level) {
  const plain = level === "ask" || level === "auto";
  if (plain) return call("PATCH", `/api/bots/${botId}`, levelPatch(level));
  const refresh = `/api/bots/${botId}/permissions/refresh`, targetLevel = level === "unlimited" ? "no-limits" : level;
  const preview = await call("POST", refresh, { scope: "open", targetLevel });
  if (preview.status !== 200) return preview;
  const p = preview.json;
  const set = await call("PATCH", `/api/bots/${botId}`, { ...levelPatch(level), settingsScope: "defaults", previewId: p.previewId, ifRev: p.botRev });
  if (set.status !== 200 || !(p.eligible?.length > 0)) return set;
  const applied = await call("POST", refresh, { scope: "open", rosterId: p.rosterId, targetLevel: p.targetLevel, afterRev: set.json.permissionRev });
  return applied.status === 200 ? set : applied;
}
async function api(method, path, body, timeout) {
  const r = await call(method, path, body, timeout);
  if (r.status < 200 || r.status >= 300) throw new Error(`${method} ${path} ${r.status} ${String(r.json?.error ?? "").slice(0, 160)}`);
  if (r.unparsed) throw new Error(`${method} ${path} ${r.status}: the answer is not JSON`); // a success nobody can read is a failed read, never an empty answer
  return r;
}
async function waitHealthy(t0, cap = 900_000) {
  for (;;) {
    let health = null;
    try { const r = await fetch(URL_ + "/api/health", { signal: AbortSignal.timeout(2000) }); if (r.ok) health = APP ? await r.json() : {}; } catch {}
    if (health) {
      const ms = Math.round(performance.now() - t0);
      if (APP) {
        try {
          const evidence = await packagedStartupPreflight({ health, expectedPid: server?.pid, expectedData: realpathSync.native(DATA), secret: SECRET,
            readLog: () => logFrom(serverLogMark), call, waitFor,
            expectedNative: WIN && ENGINES === "real" ? realpathSync.native(R.env.engineExclusion.path) : null });
          if (ENGINES === "fake") evidence.fakeResolvers = await proveFakeResolvers({ call, wrappers });
          R.preflight = { ...R.preflight, ...evidence }; save();
        } catch (error) { await refusePackaged(error.message); }
      }
      serverReady = true;
      return ms;
    }
    if (APP && (!server || performance.now() - t0 > cap)) {
      const observed = observedDataDir(DATA, lastServerPid);
      const expected = realpathSync.native(DATA);
      if (observed && (WIN ? observed.toLowerCase() !== expected.toLowerCase() : observed !== expected)) await refusePackaged(`data-dir override ignored: opened ${observed}; expected ${expected}`);
      await refusePackaged("server did not become healthy; check the packaged entry, Electron --import support and server log");
    }
    if (performance.now() - t0 > cap) throw new Error("server not healthy");
    if (!server) throw new Error("server exited before it was healthy");
    await sleep(100);
  }
}
// An unreadable log throws: the scenario records the error and its rows read not measured. It never becomes "" and so a count of zero.
const logText = () => readFileSync(LOG, "utf8");
const logSize = () => statSync(LOG).size; // the log is created before any scenario, so a missing file is a failed read, never size 0
const logFrom = off => {
  const size = statSync(LOG).size;
  if (off > size) throw new Error(`server log shrank: mark ${off}, size ${size}`); // the log only ever appends
  const buf = Buffer.alloc(size - off), fd = openSync(LOG, "r");
  let got = 0;
  try { while (got < buf.length) { const n = readSync(fd, buf, got, buf.length - got, off + got); if (n === 0) break; got += n; } } finally { closeSync(fd); }
  if (got < buf.length) throw new Error(`server log short read: ${got} of ${buf.length}`);
  return buf.toString("utf8");
};

// ---- SSE turn ends (scale rig attribution: keyed by the engine turn each wait saw start)
const waits = new Set(); const seenTurnIds = new Map(); let sseAbort = null, sseReader = null;
async function sse() {
  sseAbort = new AbortController();
  while (!sseAbort.signal.aborted) {
    try {
      const res = await fetch(URL_ + "/api/events", { headers: H, signal: sseAbort.signal });
      const dec = new TextDecoder(); let buf = "";
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true }); let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line.startsWith("data: ")) continue;
          let o; try { o = JSON.parse(line.slice(6)); } catch { continue; }
          registerOwnedThreads(o); // bot frames include new routine/delegation task threads
          const ev = o.event ?? o, tid = ev.threadId ?? o.threadId; const e = { ...ev, threadId: tid };
          if (e.type === "turn.started") activeJournalTurns.set(tid, e.turn ?? ++journalTurnSequence);
          e.turn ??= activeJournalTurns.get(tid);
          journalFailureEvent(e, ownedThreadScenarios.get(tid) ?? currentScenario);
          for (const w of waits) {
            if (e.threadId === w.threadId && e.type === "turn.started" && !e.turnId) w.journalTurn = e.turn;
            const m = matchTurnEvent(e, w);
            if (m === "started" || m === "ended") { w.turnId = e.turnId; w.journalTurn = e.turn; w.attemptEnded = m === "ended"; if (m === "started") w.end = null; }
            if (m === "ended") { w.before.add(e.turnId); w.end = { type: e.type === "turn.completed" && e.ok === false ? "turn.failed" : e.type, at: performance.now(), turnId: e.turnId, ...keptTurnEnd(e, redact) }; w.resolve(w.end); }
          }
          if (e.turnId) { if (!seenTurnIds.has(tid)) seenTurnIds.set(tid, new Set()); seenTurnIds.get(tid).add(e.turnId); }
        }
      }
    } catch { if (sseAbort.signal.aborted) return; await sleep(500); }
  }
}

// ---- RIG-SMOOTH-R2 v3 telemetry (see smooth-config.mjs): each reading is pushed when it was taken or arrived, so a stalled reader shows
// up as a gap. Nothing here depends on a server being up. STAMP is taken before the sampler and before any server starts.
const samples = []; let sampling = false; const PRE_START_LOAD1 = loadavg()[0], STAMP_MS = Date.now(); const NCPU = cpus().length;
const telChildren = [];
process.on("exit", () => { for (const c of telChildren) { try { c.kill(); } catch {} } });
const sleep1 = ms => new Promise(r => setTimeout(r, ms));
const onLines = (stream, fn) => { let buf = ""; stream.on("data", d => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) fn(line); } }); };
const invalidLeg = why => refusePackaged(why);
let tel = "none";
async function linuxTelemetry() {
  tel = "linux-cgroup";
  const path = cgroupPathOf(readFileSync("/proc/self/cgroup", "utf8"));
  const dir = path === null ? null : join("/sys/fs/cgroup", path);
  R.telemetryMode = { mode: tel, cgroup: path };
  let prev = null;
  while (sampling) {
    let cpuUs = null, mem = null;
    if (dir) { try { cpuUs = cgroupCpuUsec(readFileSync(join(dir, "cpu.stat"), "utf8")); } catch {} try { mem = cgroupMemMb(readFileSync(join(dir, "memory.current"), "utf8")); } catch {} }
    const t = Date.now(), s = { t, rss: mem };
    if (cpuUs === null) s.cores = null; else { const now = { t, cpuS: cpuUs / 1e6 }; if (prev) s.cores = coresBetween(prev, now); prev = now; }
    samples.push(s);
    await sleep1(1000);
  }
}
const linuxPeak = () => { try { const p = cgroupPathOf(readFileSync("/proc/self/cgroup", "utf8")); return p === null ? null : cgroupMemMb(readFileSync(join("/sys/fs/cgroup", p, "memory.peak"), "utf8")); } catch { return null; } };
const rigPids = rigPidTracker(); rigPids.add(process.pid); // every pid the rig itself spawns (ps, top, burst shell): never Murage tree, never a vanished member
const macPs = () => new Promise(res => { const ch = execFile("ps", ["-A", "-o", "pid=,ppid=,uid=,lstart=,rss=,comm="], { env: { ...process.env, LC_ALL: "C" }, maxBuffer: 16 << 20, timeout: 2500 }, (e, out) => res(e ? null : macTable(out))); rigPids.add(ch.pid); ch.once("exit", () => rigPids.release(ch.pid)); });
async function macTelemetry() {
  tel = "mac-wholebox-cpu+leg-user-rss";
  const uid = process.getuid();
  R.telemetryMode = { mode: tel, stampMs: STAMP_MS };
  const first = await macPs();
  if (!first) return invalidLeg("the process table cannot be read");
  const left = leftovers(first, { uid, stampMs: STAMP_MS, selfPid: process.pid });
  const start = preStartCheck(PRE_START_LOAD1, [...SCEN]); Object.assign(R, { preStartLoad1: Number.isFinite(PRE_START_LOAD1) ? PRE_START_LOAD1 : null, boxBusyAtStart: start.busy }); if (start.refuse) return invalidLeg(start.reason);
  if (left.length) return invalidLeg(`leftover processes of this user invalidate the leg: ${JSON.stringify(left).slice(0, 400)}`);
  const top = spawn("top", ["-l", "0", "-s", "1", "-n", "0"], { stdio: ["ignore", "pipe", "ignore"] }); telChildren.push(top); rigPids.add(top.pid); top.once("exit", () => rigPids.release(top.pid));
  let firstTop = true;
  // S9.cpuTree: a second top lists per-process CPU; the tree is the leg user's processes born after the stamp (smooth-config treeCores).
  // The whole-box top above is untouched.
  const TREE_N = 5000; // every process: top's own "Processes: N total" says how many rows a whole sample holds
  const treeTop = spawn("top", ["-l", "0", "-s", "1", "-n", String(TREE_N), "-o", "cpu", "-stats", "pid,uid,cpu"], { stdio: ["ignore", "pipe", "ignore"] }); telChildren.push(treeTop); rigPids.add(treeTop.pid); treeTop.once("exit", () => rigPids.release(treeTop.pid));
  let firstTree = true, prevTree = new Map(), chain = Promise.resolve();
  const settleBlock = async b => {
    const table = await macPs(); // a fresh table per sample: no stale birth times, a failed read is no reading
    const procs = parseTopProcs(b.lines);
    const r = table ? treeCores(procs, table, { uid, stampMs: STAMP_MS, rigPids: rigPids.list(), expectedRows: b.total, ncpu: NCPU, prev: prevTree }) : null;
    prevTree = r ? r.members : new Map();
    samples.push({ t: b.t, treeCores: r ? r.cores : null, ...(r ? { vanishedCores: r.vanishedCores, otherCores: r.otherCores, appleCores: r.appleCores, procCpu: r.procCpu } : {}) });
  };
  const collector = topSampleCollector(b => {
    if (firstTree) { firstTree = false; return; } // top first sample is since boot
    chain = chain.then(() => settleBlock(b)).catch(e => note("process-tree sample failed: " + String(e?.message).slice(0, 120)));
  });
  onLines(treeTop.stdout, line => collector.line(line));
  // a sample cut off by top ending is an unreadable tick, never a missing one
  treeTop.on("exit", () => { if (sampling) { note("process-tree top ended: S9.cpuTree not measured from here"); if (collector.end()) samples.push({ t: Date.now(), treeCores: null }); } });
  // every Mac leg keeps its burst log beside the results: a reading over 0.25 cores, at most once per 20 s, records the top processes. Its cost is in the reading, which reads high.
  // The file exists on every Mac leg; an empty file with macBursts 0 means no burst, and a file that cannot be made refuses the leg.
  const bursts = join(OUT, `bursts-${LABEL}.txt`); let lastBurst = 0;
  try { writeFileSync(bursts, ""); } catch (error) { return invalidLeg(`the burst log cannot be written: ${String(error?.message ?? error).slice(0, 200)}`); }
  R.macBursts = 0;
  const burstLog = cores => { if (!(cores > 0.25) || Date.now() - lastBurst < 20_000) return; lastBurst = Date.now(); R.macBursts++; let bfd = null; try { appendFileSync(bursts, "== " + new Date().toISOString().slice(11, 19) + " cores " + cores + " (two top samples; the second is the reading)\n"); bfd = openSync(bursts, "a"); } catch { note("a burst snapshot could not open its log"); return; } const p = spawn("/usr/bin/top", ["-l", "2", "-s", "1", "-n", "6", "-o", "cpu", "-stats", "pid,cpu,time,command"], { stdio: ["ignore", bfd, "ignore"] }); try { closeSync(bfd); } catch {} telChildren.push(p); rigPids.add(p.pid); p.once("exit", () => rigPids.release(p.pid)); p.on("error", () => note("a burst snapshot failed to start")); p.on("exit", (code, signal) => { if (code !== 0) note(`a burst snapshot failed: ${code ?? signal}`); }); };
  onLines(top.stdout, line => { if (!line.startsWith("CPU usage:")) return; if (firstTop) { firstTop = false; return; } const cores = coresFromTopLine(line, NCPU); samples.push({ t: Date.now(), cores }); burstLog(cores); }); // top's first reading is since boot
  top.on("exit", () => { if (sampling) note("top ended: Mac CPU reads not measured from here"); });
  while (sampling) {
    const r = legRss(await macPs(), { uid, stampMs: STAMP_MS });
    samples.push({ t: Date.now(), rss: r ? r.rss : null, load1: loadavg()[0] });
    await sleep1(1000);
  }
}
function winTelemetry() {
  tel = "win-wholebox-cpu+leg-user-rss";
  R.telemetryMode = { mode: tel, stampMs: STAMP_MS };
  const p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedPowerShell(WIN_TELEMETRY_PS)], { env: { ...process.env, SMOOTH_STAMP_MS: String(STAMP_MS) }, stdio: ["ignore", "pipe", "ignore"], windowsHide: true }); telChildren.push(p);
  let prev = null;
  onLines(p.stdout, line => {
    const t = Date.now();
    if (line.startsWith("LEFTOVER")) { const { invalid, left } = winLeftovers(line); if (invalid) invalidLeg("the process snapshot could not be read for the leftover check"); if (left.length) invalidLeg(`leftover processes invalidate the leg: ${left.join(",").slice(0, 400)}`); return; }
    // Windows only: the per-process snapshot at each new RSS maximum. Linux has a cgroup peak and the Mac has its burst log; neither changes.
    if (line.startsWith("PEAKPROCS")) { const pk = winPeakProcs(line); if (pk && pk.rssMb >= (R.rssPeakProcs?.rssMb ?? 0)) R.rssPeakProcs = { atMs: t, rssMb: pk.rssMb, top: pk.top }; return; }
    const v = winLine(line);
    if (!v) { samples.push({ t, cores: null, rss: null }); return; }
    const s = { t, rss: v.rss }; if (prev) s.cores = winCores(prev, v, NCPU); prev = v; samples.push(s);
  });
  p.on("exit", () => { if (sampling) note("the Windows sampler ended: CPU and RSS read not measured from here"); });
}
function startTelemetry() { sampling = true; if (WIN) winTelemetry(); else if (process.platform === "darwin") void macTelemetry().catch(e => note(`Mac telemetry ended: ${String(e?.message).slice(0, 120)}`)); else void linuxTelemetry().catch(e => note(`Linux telemetry ended: ${String(e?.message).slice(0, 120)}`)); }
/** The first reading of each counter marks the start of the whole-run window. No server starts before it (cap 60 s): a leg whose
 * sampler never read anything still runs, and its rows read not measured. */
let windowFrom = null;
async function telemetryReady(cap = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < cap) { const c = samples.find(s => Number.isFinite(s.cores)), r = samples.find(s => Number.isFinite(s.rss)); if (c && r) { windowFrom = Math.max(c.t, r.t); return; } await sleep1(100); }
  windowFrom = RUN_START; note("telemetry gave no reading within 60 s");
}
const window_ = (from, to) => sampleWindow(samples, from, to, stats);
// SMOOTH-RIG-RESTART-GAP: the budget reads the fixed rule; `raw` keeps the old rule's numbers next to it.
function eldWindow(from, to) {
  const { raw, fixed, restarts } = eldStalls(logText(), from, to);
  const sum = w => eldSummary(w, stats);
  return { ...sum(fixed), raw: sum(raw), restarts };
}

// ---- turns (one at a time per thread; the trace is the authority, the event stream gives the wall time)
const ownedTraces = new Set(); let lastTurnMark = 0;
function appendFailureRecord(record) {
  if (record.kind === "first") R.failedTurns.count++;
  const previous = R.failedTurns.records.findIndex(row => row.key === record.key);
  if (previous >= 0) R.failedTurns.records.splice(previous, 1);
  R.failedTurns.records.push(record);
  if (R.failedTurns.records.length > 50) R.failedTurns.records.shift();
  // runId on every journaled line: a reused label or an appended journal never mixes runs unlabelled (P2-9).
  return writeEvidence({ ...record, runId: RUN_ID }, { open: () => openSync(join(OUT, `failed-turns-${LABEL}.jsonl`), "a", 0o600),
    append: appendFileSync, fsync: fsyncSync, close: closeSync,
    fail: reason => { R.failedTurnLogError = reason; evidence.fail(reason); } });
}
function journalFailureEvent(event, scenario, enrichmentDue = false) {
  const key = failedTurnKey(event);
  const record = failureEventRecord({ event, ownedThreads, seen: journaledTurns,
    at: new Date().toISOString(), scenario }, redact);
  // Observe the obligation while turn() is active, before resolving its waiter.
  // It survives a subsequent throw before keepFailedTurn() is reached.
  if (record || journaledTurns.has(key)) evidence.observe(key, enrichmentDue || activeEvidenceTurns.has(event.threadId));
  if (record) {
    if (appendFailureRecord(record)) evidence.written(key, "first");
    journaledTurns.add(key); // deduplication alone is never durable completion
  }
  return record;
}
async function drainFailureEnrichments(boundary) {
  const deadline = Date.now() + 10_000;
  while (pendingEnrichments.size) {
    let timer;
    const completed = await Promise.race([
      Promise.allSettled([...pendingEnrichments].map(entry => entry.promise)).then(() => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now())); }),
    ]);
    clearTimeout(timer);
    if (completed && !pendingEnrichments.size) return;
    if (!completed || Date.now() >= deadline) {
      const reason = `failed-turn enrichment timed out: ${pendingEnrichments.size} pending`;
      R.failedTurnEnrichmentTimeout = reason;
      evidence.fail(reason);
      for (const entry of pendingEnrichments) {
        entry.expired = true;
        appendFailureRecord({ ...entry.first, kind: "enriched", enrichmentError: reason });
      }
      pendingEnrichments.clear();
      return;
    }
  }
}
async function keepFailedTurn(result, { botId, threadId, turnId, turn, mark, sinceAt, scenario }) {
  if (!result.failed || !R.created.bots.includes(botId)) return result;
  const event = { ...result, type: "turn.failed", threadId, turnId, turn };
  journalFailureEvent(event, scenario, true);
  const key = failedTurnKey(event);
  const first = failureEventRecord({ event, ownedThreads, seen: new Set(),
    at: new Date().toISOString(), scenario }, redact);
  if (!first) return result;
  const entry = { first, expired: false, promise: null };
  // Schedule only after the first fsync, and register before the microtask runs.
  entry.promise = Promise.resolve().then(async () => {
    // Only this turn's Murage error rows; a general bot reply is never a fallback.
    let transcriptError = null;
    const last = await threadMessages(threadId, 40, roomBudget(Date.now() + 10_000, Date.now, 10_000)).catch(error => {
      transcriptError = keptText(error?.message ?? error, redact, 300); return null;
    });
    if (entry.expired) return result;
    if (transcriptError) note(`failed-turn enrichment transcript read failed: ${transcriptError}`);
    const rows = errorRowsIn(last ?? []).filter(row => turnId && row.turnId ? row.turnId === turnId : typeof row.at === "number" && row.at >= sinceAt);
    if (last === null) result.error = "messages unreadable: error class not read";
    else if (!rows.length) result.error = "no error row for this turn";
    try { result.errorTrace = traceLinesOf(logFrom(mark), result.traceId, redact); }
    catch (error) { result.errorTrace = []; note(`failed turn trace unreadable: ${keptText(error?.message, redact, 160)}`); }
    result.rpcErrors = [];
    // server/config.ts:655 and drivers/native.ts:230-231: only this owned thread,
    // current turn window, both bounded rotation segments; never retain raw frames.
    if (typeof threadId === "string" && /^[\w-]+$/.test(threadId)) for (const suffix of [".previous.ndjson", ".ndjson"]) {
      try { result.rpcErrors.push(...nativeRpcErrorsIn(readFileSync(join(DATA, "native", threadId + suffix), "utf8"), sinceAt, redact)); }
      catch (error) { if (error?.code !== "ENOENT") note(`failed turn native trace unreadable: ${keptText(error?.message, redact, 160)}`); }
    }
    const record = { ...first, ...failedTurnRecord({ at: new Date().toISOString(), scenario, botId, result, errorRows: rows }, redact),
      kind: "enriched", ...(transcriptError ? { enrichmentError: transcriptError } : {}) };
    Object.assign(result, { error: record.error, rpcErrors: record.rpcErrors, errorTrace: record.errorTrace });
    R.turnErrors ??= {}; R.turnErrors[record.error] = (R.turnErrors[record.error] ?? 0) + 1;
    if (appendFailureRecord(record)) evidence.written(key, "enriched");
    return result;
  }).catch(error => {
    if (!entry.expired) {
      const reason = keptText(error?.message ?? error, redact, 300);
      evidence.fail("failed-turn enrichment failed before durable completion");
      if (appendFailureRecord({ ...first, kind: "enriched", enrichmentError: reason })) evidence.written(key, "enriched");
      note(`failed-turn enrichment failed: ${reason}`);
    }
    return result;
  }).finally(() => pendingEnrichments.delete(entry));
  pendingEnrichments.add(entry);
  return entry.promise;
}
async function quiesce(ms = 30_000) {
  const t = performance.now();
  for (;;) { const open = openTraces(logFrom(lastTurnMark)); if (!open.length || performance.now() - t > ms) return; await sleep(250); }
}
async function turn(botId, threadId, text, { timeout = TURN_TIMEOUT, wait = true, extraMs = () => 0 } = {}) {
  if (wait) await quiesce();
  const mark = logSize(); lastTurnMark = mark;
  const sinceAt = Date.now(), scenario = currentScenario;
  const keepFailure = result => keepFailedTurn(result, { botId, threadId, turnId: w.turnId, turn: w.journalTurn ?? requestId, mark, sinceAt, scenario });
  const requestId = `smooth-${randomBytes(12).toString("hex")}`;
  const w = { threadId, requestId, logicalSend: true, before: new Set(seenTurnIds.get(threadId) ?? []), turnId: undefined };
  const ended = new Promise(resolve => { w.resolve = resolve; }); waits.add(w);
  activeEvidenceTurns.set(threadId, w);
  try {
  const t0 = performance.now();
  const sent = await call("POST", `/api/bots/${botId}/messages`, { text, threadId, sendId: requestId }, timeout);
  if (sent.status < 200 || sent.status >= 300) { waits.delete(w); return await keepFailure({ outcome: `send ${sent.status}`, acceptedMs: sent.ms, wall: sent.ms, failed: true, status: sent.status }); }
  const acceptedMs = Math.round(performance.now() - t0);
  let sseEnd = null; void ended.then(r => { sseEnd = r; });
  let rec, traceDoneAt = null, deadlineExpired = false;
  for (;;) {
    await sleep(250);
    rec = turnFromLog(logFrom(mark), threadId, ownedTraces);
    sseEnd = w.end ?? sseEnd;
    // A provider terminal can be an unwritten attempt. Keep this logical send's waiter through its retries;
    // the thread must settle before its result allows scenario cleanup to send Stop.
    const retryPending = rec.redispatched && (!rec.done || (await getBot(botId)).busy);
    if (retryPending) { traceDoneAt = null; if (performance.now() - t0 > timeout + extraMs()) { deadlineExpired = true; break; } continue; }
    if (rec.done && traceDoneAt === null) traceDoneAt = performance.now();
    if (traceDoneAt !== null && (sseEnd || rec.redispatched || performance.now() - traceDoneAt > 5000)) break;
    if (sseEnd && performance.now() - sseEnd.at > 5000) break; // the thread's own end event is the authority when traces are shared by concurrent turns (S6) or absent (refused before dispatch)
    if (performance.now() - t0 > timeout + extraMs()) { deadlineExpired = true; break; } // extraMs: time the owner spent on cards (S7), outside the turn's own clock
  }
  waits.delete(w);
  // a timed-out turn is stopped and the bot waited idle before anything else goes to it: a message sent to a still-busy
  // engine is queued and starts the moment the old turn ends, so the next turn would measure the leftover one
  const timeoutStop = deadlineExpired || traceDoneAt === null && !sseEnd ? await settleBot(botId, threadId) : undefined;
  if (timeoutStop) { R.timeoutStops = (R.timeoutStops ?? 0) + 1; if (!timeoutStop.settled) note(`turn timeout: bot ${botId.slice(0, 8)} still busy ${timeoutStop.ms} ms after Stop`); }
  for (const id of rec.traceIds ?? [rec.traceId, rec.redispatchTraceId]) if (id) ownedTraces.add(id);
  const timedOut = deadlineExpired || traceDoneAt === null && !sseEnd;
  const sseOwn = Boolean(sseEnd && w.turnId !== undefined && sseEnd.turnId === w.turnId);
  const endAt = !rec.redispatched && sseOwn ? Math.min(sseEnd.at, traceDoneAt ?? Infinity) : (traceDoneAt ?? sseEnd?.at);
  const outcome = timedOut ? "timeout" : rec.redispatched && rec.done ? (["completed", "ok"].includes(rec.outcome) ? "turn.completed" : `turn.${rec.outcome ?? "unknown"}`) : sseEnd?.type === "turn.failed" ? "turn.failed" : ["completed", "ok"].includes(rec.outcome) ? "turn.completed" : rec.outcome ? `turn.${rec.outcome}` : sseEnd?.type ?? "turn.unknown";
  const result = { ...rec, ...keptTurnEnd(sseEnd, redact), ...(timeoutStop ? { timeoutStop } : {}), requestId, wall: Math.round((endAt ?? performance.now()) - t0), acceptedMs, outcome, failed: outcome !== "turn.completed" };
  return await keepFailure(result);
  } finally { activeEvidenceTurns.delete(threadId); waits.delete(w); }
}
const PROMPT = (n, what = "the weekly client report") => `Turn ${n}. Summarise the open items of ${what} in two lines.`;
const summary = turns => ({ n: turns.length, failed: turns.filter(t => t.failed).length, prep: stats(turns.map(t => t.prep)), firstText: allTimed(turns.map(t => t.firstText), stats), wall: stats(turns.map(t => t.wall)), resets: turns.reduce((a, t) => a + (t.resets ?? 0), 0), outcomes: turns.map(t => t.outcome) });

// ---- roster helpers
let instances = {};
async function loadInstances() {
  const list = (await api("GET", "/api/instances")).json.instances;
  if (!Array.isArray(list)) throw new Error("instances unreadable"); // no list would skip every S10 engine and read failed 0
  // an engine with no default model (an empty string) takes its first listed option; "default" only when it lists none
  const modelOf = i => i.models?.default || [i.models?.options ?? []].flat().map(o => typeof o === "string" ? o : o?.id ?? o?.value).find(Boolean) || "default";
  instances = Object.fromEntries(list.map(i => [i.instanceId, { state: i.snapshot?.state, reason: i.snapshot?.reason, version: i.snapshot?.version, model: modelOf(i), driverKind: i.driverKind }]));
  R.instances = Object.fromEntries(Object.entries(instances).filter(([id]) => ["claude", "fuigo", "grok", "codex"].includes(id)).map(([id, v]) => [id, { state: v.state, driverKind: v.driverKind, model: v.model, ...(v.state === "available" ? {} : { reason: String(v.reason ?? "").slice(0, 200), version: v.version }) }]));
}
/** Stop one bot's turn in `threadId` (a bot-wide Stop if that does not settle) and wait until the bot reads idle. */
async function settleBot(botId, threadId, cap = 60_000) {
  return stopAndSettle({
    stop: async all => (await call("POST", `/api/bots/${botId}/interrupt`, all ? { all: true } : threadId ? { threadId } : {}, 60_000)).status,
    // a bot the scenario deleted is really not busy; any other failed read throws, it never reads as idle
    isBusy: async () => { const r = await call("GET", `/api/bots/${botId}`, undefined, 30_000); if (r.status === 404) return false; if (r.status !== 200 || typeof r.json?.bot?.busy !== "boolean") throw new Error(`bot busy state unreadable: status ${r.status}`); return r.json.bot.busy; },
    cap,
  });
}
let currentScenario = "run"; let scenarioBots = []; // the bots (and the thread each works in) the running scenario made or borrowed
const engineFor = role => ENGINES === "real" ? (process.env[`SMOOTH_REAL_${role.toUpperCase()}`] ?? "claude") : role === "fast" ? "fuigo" : role === "scripted" ? "grok" : "claude";
async function makeBot(name, role) {
  const instanceId = engineFor(role);
  const { bot } = (await api("POST", "/api/bots", {})).json;
  R.created.bots.push(bot.id);
  registerOwnedThreads({ bot });
  const cwd = botFolder(WORKDIR, currentScenario, name); mkdirSync(cwd, { recursive: true });
  const patch = { name, modelSelection: { instanceId, model: instances[instanceId]?.model || "default" }, cwd };
  const r = await call("PATCH", `/api/bots/${bot.id}`, patch);
  if (r.status !== 200) { note(`bot ${name}: PATCH ${r.status} ${String(r.json?.error ?? "").slice(0, 100)}; trying without cwd`); await api("PATCH", `/api/bots/${bot.id}`, { name, modelSelection: patch.modelSelection }); }
  const made = (await api("GET", `/api/bots/${bot.id}`)).json.bot;
  scenarioBots.push({ id: bot.id, threadId: made?.threadId });
  return made;
}
// every reader of a bot's state goes through here: a busy value that is not true or false is a failed read, never idle
let scenarioFrom = null;
const getBot = async id => { const bot = (await api("GET", `/api/bots/${id}`)).json.bot; if (typeof bot?.busy !== "boolean") throw new Error("bot busy state unreadable"); return bot; };
// an answer without both lists is a failed read: an empty roster would skip the transcripts the S2 rows count
const botsList = async () => { const json = (await api("GET", "/api/bots?messages=0", undefined, 300_000)).json; if (!Array.isArray(json?.bots) || !Array.isArray(json?.groups)) throw new Error("roster unreadable"); return json; };
async function threadMessages(threadId, limit = 80, budget = null) {
  let rows = [], before = null;
  for (let pages = 0; pages < 50; pages++) {
    const path = `/api/threads/${threadId}/messages?limit=${pages ? 200 : limit}${before ? `&before=${encodeURIComponent(before)}` : ""}`;
    const r = budget ? await roomCall("GET", path, undefined, { ...budget, timeout: budget.remaining(60_000) }) : await call("GET", path, undefined, 60_000);
    if (budget && (r.status === 404 || (r.status === 200 && !Array.isArray(r.json?.messages)))) throw roomSchemaError("room messages route or field missing");
    // a failed read throws, so the scenario's rows read not measured; only a real, successful empty list can make a count of zero
    if (r.status !== 200 || !Array.isArray(r.json?.messages)) throw new Error(`messages of a thread unreadable: status ${r.status}`);
    rows = [...r.json.messages, ...rows];
    // the rows count only once they reach back past the scenario's start, so a count of zero is never just a short page; older pages are read by the route's own cursor
    if (pageCovers(rows, r.json.hasMore, scenarioFrom)) return rows;
    before = r.json.messages[0]?.id;
    if (typeof before !== "string") throw new Error("transcript cursor unreadable");
  }
  throw new Error("transcript does not reach the scenario's start in 50 pages");
}
// the thread's open-cards view (every open request card on the active branch), not a transcript page that may not reach it
async function openCardsOf(threadId) {
  let oc = await call("GET", `/api/threads/${threadId}/open-cards`, undefined, 30_000);
  // pending means the route's answer is incomplete: never zero cards and never "that card closed"
  // The server's own preparation can hold it while a turn runs (up to 120 s, transcript-backfill.ts), so this waits past that: a later answer reads high, never low.
  for (const t0 = Date.now(); oc.status === 200 && oc.json?.pending === true && Date.now() - t0 < 150_000;) { R.openCardsPendingPolls = (R.openCardsPendingPolls ?? 0) + 1; await sleep(1000); oc = await call("GET", `/api/threads/${threadId}/open-cards`, undefined, 30_000); }
  if (oc.status === 200 && oc.json?.pending === true) throw new Error("open cards incomplete: pending for 150 s");
  // the transcript stands in only where the route does not exist (older builds), with a window long enough for an older open card
  if (oc.status !== 404 && !(oc.status === 200 && Array.isArray(oc.json?.openCards))) throw new Error(`open cards unreadable: status ${oc.status}`);
  const open = openCards(oc.status === 200 ? oc.json.openCards : await threadMessages(threadId, 200));
  for (const row of open) keepCard(currentScenario, threadId, row);
  return open;
}
/** The server's hand-off receipts (read-only; a missing or half-written file reads as none). */
const delegationReceipts = () => { let text; try { text = readFileSync(join(DATA, "delegation-receipts.json"), "utf8"); } catch (error) { if (error?.code === "ENOENT") return []; throw error; } const v = JSON.parse(text); if (!Array.isArray(v)) throw new Error("delegation receipts unreadable"); return v; };

const ROOM_LATER = ["trust", "autoEveryday", "longThread", "deletion", "engineSwitch", "stop", "idle"];
let roomCleanup = null, roomState = null;
async function scenario(name, fn) {
  if (R.roomNeverSettled || R.controlRestoreFailed) { R.scenarios[name] = { invalid: R.legFailureReason ?? "room never settled" }; save(); return; }
  if (!SCEN.has(name)) return;
  const from = Date.now(); let mark = null, measurement = null;
  currentScenario = name; scenarioBots = []; scenarioFrom = from;
  log(`scenario ${name} start`);
  try { mark = logSize(); R.scenarios[name] = { ...(await fn({ mark, from,
    endMeasurement: () => { measurement = { to: Date.now(), text: logFrom(mark) }; },
  })) }; }
  catch (error) { R.scenarios[name] = { ...R.scenarios[name], error: keptText(error?.stack ?? error?.message ?? error, redact, 600) || "scenario failed" }; log(`scenario ${name} error`, keptText(error?.message ?? error, redact, 300)); }
  // 4(d): wrapper exceptions must pass the same gate as drain TIMEOUT/ERROR.
  const finishRoom = async () => {
    if (name !== "room") return;
    if (R.scenarios.room?.error || !roomState?.done || roomState?.incomplete) {
      roomState ??= { incomplete: true, notes: [] };
      roomState.incomplete = true;
      // If creation failed before the identity was read, settlement cannot be proved.
      const unavailable = async () => { throw Error("room identity unavailable"); };
      const options = roomCleanup ?? { state: roomState, now: Date.now, sleep, fetchRoom: unavailable,
        fetchMembers: unavailable, fetchMessages: unavailable, fetchOpen: unavailable, keepCard: () => {}, respond: unavailable };
      await enforceRoomSettlement({ options, results: R, laterScenarios: ROOM_LATER, stopServer });
    }
    Object.assign(R.scenarios.room, roomState);
    for (const message of roomState.notes.splice(0)) note(keptText(message, redact, 1000));
  };
  await finishRoom();
  if (R.controlRestoreFailed && name !== "room") await stopServer();
  // every turn the scenario left running is stopped before the next scenario starts (measured after the scenario's own rows)
  const ends = [];
  for (const b of name === "room" || R.roomNeverSettled || R.controlRestoreFailed ? [] : scenarioBots) { try { ends.push(await settleBot(b.id, b.threadId, 30_000)); } catch (error) { ends.push({ settled: false, error: keptText(error?.message ?? error, redact, 100) }); } }
  R.scenarios[name] = { ...R.scenarios[name], endStop: { bots: ends.length, leftBusy: ends.filter(e => !e.settled).length, escalated: ends.filter(e => e.escalated).length, maxMs: ends.length ? Math.max(...ends.map(e => e.ms ?? 0)) : 0 } };
  if (ends.some(e => !e.settled)) note(`scenario ${name}: ${ends.filter(e => !e.settled).length} bot(s) still busy after the end-of-scenario Stop`);
  currentScenario = "run"; scenarioBots = [];
  const to = measurement?.to ?? Date.now();
  // an unreadable log leaves these rows absent and records why; the scenario's other measurements, the save and the cleanup still happen
  let fromLog = {};
  try {
    if (mark === null) throw new Error("no log mark");
    const text = measurement?.text ?? logFrom(mark);
    fromLog = { log: countSignatures(text), eld: eldWindow(from, to), ...(name === "room" ? { workerSliceWall: workerSliceWall(text) } : {}) };
  }
  catch (error) { const why = keptText(error?.message ?? error, redact, 200); R.scenarios[name] = { ...R.scenarios[name], error: R.scenarios[name]?.error ?? why }; note(`scenario ${name}: the server log could not be read: ${why}`); }
  await finishRoom(); // Includes final-collection/log exceptions caught by the wrapper.
  R.scenarios[name] = { ...R.scenarios[name], ...fromLog, ...window_(from, to), seconds: Math.round((to - from) / 1000), window: { from, to } };
  save(); log(`scenario ${name} done in ${R.scenarios[name].seconds} s`);
}

// ================================================================== run
const shutdownSse = async () => { sseAbort?.abort(); await sseReader; return true; };
refusalCleanup = async () => {
  sampling = false;
  await stopServer();
  await shutdownSse();
  await drainFailureEnrichments("controlled exit");
  evidence.audit();
};
startTelemetry();
await telemetryReady();
R.dataDirEmptyAtStart = !existsSync(DATA) || readdirSync(DATA).length === 0; // read before any server start; the only proof a row may say "empty data dir"
// Every packaged leg proves a cold cache and measures its warm restart; only cold feeds S0.boot.
// Source mode retains its existing boot samples and scenario selection.
if (APP) {
  try {
    await packagedBoots({ startServer, waitHealthy, stopServer, settle: () => sleep(3000), results: R, save, note, logSize,
      measure: w => ({ ...window_(w.from, w.to), eld: eldWindow(w.from, w.to), ioBudget: countSignatures(logFrom(w.logFrom)).ioBudget }) });
  } catch (error) { await refusePackaged(error.message); }
} else if (SCEN.has("boot")) {
  const boots = [];
  for (let i = 0; i < 2; i++) { const t0 = startServer(); boots.push(await waitHealthy(t0)); if (i === 0) { await sleep(3000); await stopServer(); } }
  R.scenarios.boot = { healthy: stats(boots), samples: boots };
} else { const t0 = startServer(); R.bootMs = await waitHealthy(t0); }
sseReader = sse();
await sleep(2000);
if (APP) {
  try { await loadInstances(); } catch (error) { await refusePackaged(error.message); }
} else await loadInstances();
log("instances", JSON.stringify(R.instances));
if (APP) {
  // A trace is emitted on dispatch, not at boot. One isolated, named bot proves the flag before measured scenarios.
  try {
    R.preflight = await packagedTracePreflight({ makeBot, call, logSize, logFrom, readStartupLog: () => logFrom(serverLogMark), waitFor, settleBot, evidence: R.preflight });
    delete R.preflight.refusal;
    save();
  } catch (error) { await refusePackaged(error.message); }
}
const roster = await botsList();
const realBots = (roster.bots ?? []).filter(b => !b.hidden);
R.roster = { bots: roster.bots?.length ?? 0, groups: roster.groups?.length ?? 0, visibleBots: realBots.length };
save();

// S1 morning burst: routines due the same minute, met by a server that just started (the Mac waking into its morning)
await scenario("routineBurst", async () => {
  const n = Number(process.env.SMOOTH_ROUTINES ?? 8);
  const bots = []; for (let i = 0; i < n; i++) bots.push(await makeBot(`Smooth Routine ${i}`, "fast"));
  // MurageMain 11-06: on real legs S1 measures the burst, not Ask: a new bot is at Ask and a routine runs at the lower of its ceiling and the bot (S4.ask covers Ask).
  const routineMode = ENGINES === "real" ? "unlimited" : "auto";
  if (ENGINES === "real") for (const b of bots) {
    const set = await setLevel(b.id, "unlimited");
    if (set.status !== 200) throw new Error(`S1 level not set: status ${set.status}`);
    const now = await getBot(b.id);
    if (!(now.autoApprove === true && now.fullAccess === true && now.noLimits === true)) throw new Error("S1 level did not read back as No limits");
  }
  const due = Math.ceil((Date.now() + 150_000) / 60_000) * 60_000;
  const made = [];
  for (let i = 0; i < n; i++) {
    const r = await api("POST", "/api/routines", { name: `Smooth burst ${i}`, prompt: routinePrompt(ENGINES, i), botId: bots[i].id, target: "bot", runOn: "ember", enabled: true, permissionMode: routineMode, schedule: { type: "interval", everyMinutes: 60, anchorAt: due }, durationMinutes: 30 });
    if (r.json.routine?.permissionMode !== routineMode) throw new Error(`S1 routine mode read back ${r.json.routine?.permissionMode}`);
    made.push(r.json.routine); R.created.routines.push(r.json.routine.id);
  }
  const ids = new Set(made.map(r => r.id));
  clearPromptDumps();
  // the restart: down 40 s before the due minute, up 15 s before it, so the burst meets the startup hold and the connector check
  const downAt = due - 40_000; if (Date.now() < downAt) await sleep(downAt - Date.now());
  await stopServer();
  const upAt = due - 15_000; if (Date.now() < upAt) await sleep(upAt - Date.now());
  const t0 = startServer(); const restartMs = await waitHealthy(t0);
  let runs = null;
  while (runs === null || Date.now() < due + 600_000) { // at least one real read, so no run list never reads as no failed runs
    await sleep(5000);
    const r = await call("GET", `/api/routines?from=${due - 120_000}`, undefined, 120_000);
    if (r.status !== 200 || !Array.isArray(r.json?.runs)) throw new Error(`routine runs unreadable: status ${r.status}`);
    runs = r.json.runs;
    const mine = runs.filter(x => ids.has(x.routineId));
    if (mine.length >= n && mine.every(x => typeof x.startedAt === "number" && x.status !== "running" && x.status !== "queued")) break;
  }
  const burst = routineBurst(runs, ids);
  let cards = 0, cardsUnread = 0;
  for (const run of runs.filter(x => ids.has(x.routineId))) { const tid = run.threadId ?? bots.find(b => b.id === run.botId)?.threadId; if (!tid) cardsUnread++; if (tid) { const rows = cardsIn(await threadMessages(tid, 40)); cards += rows.length; for (const row of rows) keepCard("routineBurst", tid, row); } }
  for (const r of made) await call("PATCH", `/api/routines/${r.id}`, { enabled: false });
  // runs still going after the wait (a real engine's slow turn, a run held on a card) are stopped, so they do not hold the
  // install-wide run slots and every later scenario's turns behind them
  for (const b of bots) await call("POST", `/api/bots/${b.id}/interrupt`, { all: true }, 60_000);
  return { routines: n, restartMs, ...burst, failedRuns: burst.statuses && !burst.statuses["?"] ? burst.statuses.failed ?? 0 : null, lateness: allTimed(burst.lateness, stats), fromDue: stats(burst.fromDue), startupNotes: ENGINES === "fake" && promptDumps().length ? startupNotesIn(promptDumps()) : null, cards: cardsUnread ? null : cards, bots: bots.map(b => b.id) };
});

// S2 delegation chain: owner -> manager -> worker A, then worker B; each result wakes the manager
await scenario("delegation", async ({ mark }) => {
  const manager = await makeBot("Smooth Manager", "scripted");
  const workers = [await makeBot("Smooth Worker A", "fast"), await makeBot("Smooth Worker B", "fast")];
  ctl("grok.mode", "lead-delegate");
  const chain = [], turns = [], s2Known = new Set();
  try {
    for (const worker of workers) {
      ctl("delegate-to", worker.id);
      const before = chainFromManager(await threadMessages(manager.threadId, 60));
      const t0 = performance.now(), sinceAt = Date.now() - 1;
      let handed;
      if (ENGINES === "real") {
        // a prompt a real model can act on; a card the hand-off raises is answered as the owner would, and kept
        const t = turn(manager.id, manager.threadId, realDelegationPrompt(worker), { wait: false });
        let ended = null; void t.then(x => { ended = x; });
        await answerCards({ fetchCards: () => openCardsOf(manager.threadId), respond: card => { const a = ownerAnswer(card); return a ? call("POST", `/api/threads/${manager.threadId}/respond`, a) : null; }, isDone: () => ended !== null, cap: TURN_TIMEOUT, known: s2Known });
        handed = await t;
      } else handed = await turn(manager.id, manager.threadId, `LEAD_ASSIGN: hand the payments count to ${worker.name} (${worker.id}) and report when it is back.`);
      turns.push(handed);
      // counted from server state (hand-off source rows and receipts), so a real engine's hand-off counts as the fake's does
      const read = async () => chainFromServer({ managerMessages: await threadMessages(manager.threadId, 80), receipts: delegationReceipts(), workerId: worker.id, workerName: worker.name, sinceAt });
      let srv = await read();
      // the result can raise a card on the worker's or the manager's thread while it runs: answered the same way
      while (performance.now() - t0 < 180_000 && srv.receipts === 0) {
        await sleep(1000); srv = await read();
        if (ENGINES === "real") for (const tid of [manager.threadId, worker.threadId]) for (const row of await openCardsOf(tid)) { const id = row.card.requestId; if (s2Known.has(id)) continue; s2Known.add(id); const a = ownerAnswer(row.card); if (a) await call("POST", `/api/threads/${tid}/respond`, a); }
      }
      const tailRows = await threadMessages(manager.threadId, 60);
      const now = chainFromManager(tailRows);
      // real engines: what the manager's turn did (row kinds, tool names, the first words), so a missing hand-off can be read
      const managerTail = ENGINES === "real" ? (tailRows ?? []).filter(m => m && (typeof m.at !== "number" || m.at >= sinceAt)).slice(-25)
        .map(m => ({ kind: m.kind, role: m.role, tool: m.tool?.name, toolError: (m.tool?.isError ?? m.tool?.error) ? true : undefined, text: keptText((v => typeof v === "string" ? v : JSON.stringify(v ?? ""))(m.text ?? m.tool?.output ?? m.tool?.input), redact, 200) })) : undefined;
      chain.push({ worker: worker.id, ...(managerTail ? { managerTail } : {}), ms: Math.round(performance.now() - t0), handedOver: srv.handedOver, sawResult: srv.sawResult, leadErrors: srv.failed, statuses: srv.statuses, messaged: srv.messaged,
        fakeText: { handedOver: now.handedOver - before.handedOver, sawResult: now.sawResult - before.sawResult, wokenEmpty: now.wokenEmpty - before.wokenEmpty, leadErrors: now.leadErrors - before.leadErrors }, wokenEmpty: now.wokenEmpty - before.wokenEmpty });
      await quiesce(60_000);
    }
  } finally { restore({ "grok.mode": null, "delegate-to": null }); }
  await sleep(3000);
  const rows = [manager, ...workers].map(b => b.threadId);
  const after = await botsList();
  const pairRooms = (after.groups ?? []).filter(g => g.dm && g.memberIds?.includes(manager.id)).map(g => g.threadId);
  let withheld = 0, contextChanged = 0;
  for (const tid of [...rows, ...pairRooms]) { const ms = await threadMessages(tid, 80); withheld += withheldIn(ms).length; contextChanged += contextChangedIn(ms).length; }
  const sig = countSignatures(logFrom(mark));
  return { handedOver: chain.reduce((a, c) => a + c.handedOver, 0), sawResult: chain.reduce((a, c) => a + c.sawResult, 0), wokenEmpty: chain.reduce((a, c) => a + c.wokenEmpty, 0), leadErrors: chain.reduce((a, c) => a + c.leadErrors, 0),
    chainMs: stats(chain.map(c => c.ms)), chain, turns: summary(turns), withheld, contextChanged: contextChanged + sig.contextCard, fenceRefused: sig.fenceRefused, pairRooms: pairRooms.length };
});

// S3 team room: 3 bots, everyone answers, 4 messages 20 s apart
await scenario("room", async ({ mark, endMeasurement }) => {
  roomState = { incomplete: false, cardCloseTimeout: false, done: false, notes: [] };
  R.scenarios.room = roomState;
  const members = [await makeBot("Smooth Room A", "fast"), await makeBot("Smooth Room B", "fast"), await makeBot("Smooth Room C", "fast")];
  // real engines: room bots run at Full access like S5 (MurageMain 8 Nov ruling), so S3 measures room smoothness, not Ask cards; S4 keeps its own levels
  if (ENGINES === "real") for (const m of members) { const set = await setLevel(m.id, "full"); if (set.status !== 200) note(`room bot ${m.name}: level full ${set.status}`); }
  const memberIds = new Set(members.map(m => m.id));
  const { group } = (await api("POST", "/api/groups", { name: "Smooth room", memberIds: [...memberIds], setup: { bulletin: "A room for the smoothness gate.", defaultResponder: { kind: "everyone" } } })).json;
  R.created.groups.push(group.id);
  registerOwnedThreads({ group });
  const rounds = [], known = new Set(), raised = new Set(), cardRows = [];
  let messages = [];
  const cleanupFor = (group, memberIds, known = new Set(), raised = new Set()) => {
    let rosterSnapshot;
    return {
      state: roomState, known, raised, now: Date.now, sleep,
      fetchRoom: async budget => {
        const response = await roomCall("GET", "/api/bots?messages=0", undefined, budget);
        if (response.status === 404) throw roomSchemaError("room roster route missing");
        if (response.status !== 200) throw Error(`room roster unreadable (${response.status})`);
        if (!Array.isArray(response.json?.groups) || !Array.isArray(response.json?.bots)) throw roomSchemaError("room roster fields missing");
        rosterSnapshot = response.json;
        return rosterSnapshot.groups.find(row => row.id === group.id);
      },
      fetchMembers: async () => [...memberIds].map(id => rosterSnapshot.bots.find(row => row.id === id)),
      fetchOpen: async budget => {
        const response = await roomCall("GET", `/api/threads/${group.threadId}/open-cards`, undefined, budget);
        if (response.status === 404) throw roomSchemaError("room open-cards route missing");
        if (response.status !== 200) throw Error(`room open cards unreadable (${response.status})`);
        if (!Array.isArray(response.json?.openCards)) throw roomSchemaError("room open-cards field missing");
        // Return partial evidence immediately: it resets eligibility and retries next poll.
        return { rows: response.json.openCards, complete: response.json.pending !== true };
      },
      fetchMessages: async budget => ({ rows: await threadMessages(group.threadId, 120, budget), complete: true }),
      keepCard: row => keepCard("room", group.threadId, row),
      respond: (answer, budget) => roomCall("POST", `/api/threads/${group.threadId}/respond`, answer, budget),
      interrupt: budget => roomCall("POST", `/api/groups/${group.id}/interrupt`, {}, budget),
    };
  };
  roomCleanup = cleanupFor(group, memberIds, known, raised);
  const drain = async options => {
    const seen = await drainRoomCards({ ...roomCleanup, ...options });
    messages = seen.messages;
    return seen;
  };
  for (let i = 0; i < 4; i++) {
    const sentAt = Date.now(); const t0 = performance.now();
    const deadline = sentAt + 90_000;
    const sent = await roomCall("POST", `/api/groups/${group.id}/messages`, { text: `Round ${i}: each of you, name one open item of the weekly report in one line.` }, roomBudget(deadline, Date.now, 60_000));
    if (sent.status < 200 || sent.status >= 300) throw Error(`room send rejected (${sent.status})`);
    let got = { members: 0, first: null, last: null };
    const seen = await drain({
      fetchMessages: async budget => { const rows = await threadMessages(group.threadId, 60, budget); got = roomReplies(rows, sentAt - 1, memberIds); return { rows, complete: true }; },
      deadline, round: i,
    });
    const timed = cardTimings(seen.cards);
    cardRows.push(...seen.cards.map((card, index) => ({ round: i, ...card, ...timed.cards[index] })));
    rounds.push({ status: sent.status, drainStatus: seen.status, members: got.members, first: got.first, last: got.last, ms: Math.round(performance.now() - t0), cards: seen.cards.length, cardWaitMs: timed.cardWaitMs });
    if (seen.status !== "DONE") break;
    if (i < 3) await sleep(20_000);
  }
  const tail = roomState.incomplete ? { cards: [], status: "SKIPPED" } : await drain({ deadline: Date.now() + 30_000, round: "tail" });
  roomState.done = tail.status === "DONE" && !roomState.incomplete;
  roomState.drain = { rounds: rounds.map(round => round.drainStatus), tail: tail.status, done: roomState.done };
  const tailTimings = cardTimings(tail.cards);
  cardRows.push(...tail.cards.map((card, index) => ({ round: 3, tail: true, ...card, ...tailTimings.cards[index] })));
  const ms = messages; // Final collection already rechecked the full predicate within the drain's deadline.
  const sig = countSignatures(logFrom(mark));
  const measured = { messages: rounds.length, fullyAnswered: rounds.filter(r => r.members >= 3).length, firstReply: allTimed(rounds.map(r => r.first), stats), lastReply: allTimed(rounds.map(r => r.last), stats), rounds,
    withheld: withheldIn(ms).length, contextChanged: contextChangedIn(ms).length + sig.contextCard, cards: raised.size, cardRows,
    cardAnswerFailed: cardRows.filter(c => c.status !== null && (c.status < 200 || c.status >= 300)).length, group: group.id };
  Object.assign(roomState, measured); // retain measurements even if proof setup throws
  if (R.roomProofRequested && rounds.length === 4 && roomState.done) {
    endMeasurement(); // S3 log, telemetry and latency windows exclude the proof.
    roomState.done = false; roomCleanup = null; // creation exceptions must also gate later work
    // fast is Fuigo (fuigo.mode), so grok.mode needs separate scripted members.
    const proofMembers = [];
    for (const name of ["A", "B", "C"]) proofMembers.push(await makeBot(`Smooth Room Proof ${name}`, "scripted"));
    const proofIds = new Set(proofMembers.map(member => member.id));
    const { group: proofGroup } = (await api("POST", "/api/groups", { name: "Smooth route proof", memberIds: [...proofIds],
      setup: { bulletin: "Fake room route proof.", defaultResponder: { kind: "everyone" } } })).json;
    R.created.groups.push(proofGroup.id);
    registerOwnedThreads({ group: proofGroup });
    roomCleanup = cleanupFor(proofGroup, proofIds);
    roomState.proofGroup = proofGroup.id;
    roomState.done = true; // measured room passed DONE; helper clears before any proof work
    await runRoomRouteProof({ engines: ENGINES, options: roomCleanup, members: proofMembers, ctl, setLevel,
      readControl, onControlFailure: controlFailure,
      send: (text, budget) => roomCall("POST", `/api/groups/${proofGroup.id}/messages`, { text }, budget),
    });
  }
  return roomState;
});

// S4 ordinary dev commands at each level; the fake asks for exactly the command the control file names
await scenario("trust", async () => {
  const levels = {}; let failed = 0;
  ctl("grok.mode", "permission");
  try {
    for (const level of LEVELS) {
      const bot = await makeBot(`Smooth ${level}`, "scripted");
      const set = await setLevel(bot.id, level);
      const row = { patch: set.status, ...(set.status >= 300 ? { patchError: keptText(set.json?.error ?? "", redact, 200) } : {}), cards: 0, extraCards: 0, autoAllowed: 0, turns: 0, failed: 0, stopCards: 0, wipeCards: 0, stopLineCards: 0, stopTurns: 0, cardsFor: [], outcomes: {} };
      const run = async (cmd, stop) => {
        ctl("permission-command", cmd);
        const t = turn(bot.id, bot.threadId, `Run exactly this command and tell me its first output line: ${cmd}`, { wait: false });
        let ended = null; void t.then(x => { ended = x; });
        // every card the turn raises is answered (a real engine may ask again, e.g. to run outside its sandbox), each once
        const seen = await answerCards({ fetchCards: () => openCardsOf(bot.threadId), respond: card => call("POST", `/api/bots/${bot.id}/respond`, { requestId: card.requestId, behavior: stop ? "deny" : "allow" }), isDone: () => ended !== null, cap: TURN_TIMEOUT + 20_000 });
        if (seen.answered.length) { if (stop) { row.stopCards++; row[stopKind(cmd) === "wipe" ? "wipeCards" : "stopLineCards"]++; } else { row.cards++; row.cardsFor.push(DEV_COMMANDS.indexOf(cmd)); } row.extraCards += seen.answered.length - 1; }
        else if (!stop) row.autoAllowed++;
        const done = await t;
        if (stop) row.stopTurns++; else row.turns++;
        row.outcomes[done.outcome] = (row.outcomes[done.outcome] ?? 0) + 1;
        if (done.failed) { row.failed++; failed++; }
      };
      for (const cmd of DEV_COMMANDS) await run(cmd, false);
      // the stop lines go to the fake only: a real engine that was let through would really run them
      if (level === "unlimited" && ENGINES === "fake") for (const cmd of STOP_COMMANDS) await run(cmd, true);
      if (level === "unlimited" && ENGINES === "real") row.stopLines = "not run (real engine)";
      levels[level] = row;
    }
  } finally { restore({ "grok.mode": null, "permission-command": null }); }
  return { levels, failed, commands: DEV_COMMANDS.length };
});

// S10 (real engines only) everyday tasks at Auto on real Claude, Codex and Fuigo, and Fuigo shell turns at Ask: the approval
// cards each turn raised, by tool name. A card on a routine task at Auto is a smoothness regression against the last RC.
// Cards are answered as the owner would (Allow; a question card Skip). Counts, tool names and timings only.
const EVERYDAY_TASKS = [
  "List the files in this folder and tell me how many there are.",
  "Read notes.md and tell me its first line.",
  "Create a file called todo.txt containing the single word hello.",
  "Run git status and tell me the current branch name.",
  "Search this folder for the word TODO and tell me how many matches there are.",
  "Run node -e \"console.log(1+1)\" and tell me the output.",
  "Append a line with the word done to todo.txt.",
  "Run ls -la and tell me how many entries it lists.",
];
const S10_ENGINES = (process.env.SMOOTH_S10_ENGINES ?? "claude,codex,fuigo").split(",").filter(Boolean);
const S10_ASK_ENGINE = process.env.SMOOTH_S10_ASK_ENGINE ?? "fuigo";
async function makeBotOn(name, instanceId) {
  const { bot } = (await api("POST", "/api/bots", {})).json;
  R.created.bots.push(bot.id);
  registerOwnedThreads({ bot });
  const cwd = botFolder(WORKDIR, currentScenario, name); mkdirSync(cwd, { recursive: true });
  // a small everyday folder: a notes file with a TODO, a package.json, a git repo when git is there
  writeFileSync(join(cwd, "notes.md"), "Weekly notes\nTODO: send the client report\n");
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "smooth-everyday", version: "1.0.0", private: true }, null, 1));
  await new Promise(res => { const p = spawn("git", ["init", "-q", "-b", "main"], { cwd, stdio: "ignore" }); p.on("error", () => res()); p.on("exit", () => res()); });
  const patch = { name, modelSelection: { instanceId, model: instances[instanceId]?.model || "default" }, cwd };
  const r = await call("PATCH", `/api/bots/${bot.id}`, patch);
  if (r.status !== 200) { note(`bot ${name}: PATCH ${r.status}; trying without cwd`); await api("PATCH", `/api/bots/${bot.id}`, { name, modelSelection: patch.modelSelection }); }
  const made = (await api("GET", `/api/bots/${bot.id}`)).json.bot;
  scenarioBots.push({ id: made.id, threadId: made?.threadId });
  return made;
}
async function cardTurn(bot, text) {
  const t = turn(bot.id, bot.threadId, text, { wait: false });
  let ended = null; void t.then(x => { ended = x; });
  // what each card asked to run (the runner's own bot in its own seeded folder, never a real conversation): title and subtitle, whole and redacted; results stay on the box
  const what = new Map();
  const fetchCards = async () => { const open = await openCardsOf(bot.threadId); for (const c of open) { const id = c?.card?.requestId; if (typeof id === "string" && !what.has(id)) what.set(id, (t => redact ? redact(t) : "redaction not loaded")([c.card.title, c.card.subtitle].filter(v => typeof v === "string").join(" | "))); } return open; };
  const seen = await answerCards({ fetchCards, respond: card => { const a = ownerAnswer(card); return a ? call("POST", `/api/bots/${bot.id}/respond`, a) : null; }, isDone: () => ended !== null, cap: TURN_TIMEOUT });
  const done = await t;
  const cards = (seen.cards ?? []).filter(c => c.kind === "approval");
  return { cards: cards.length, questions: (seen.cards ?? []).filter(c => c.kind === "question").length, tools: cards.map(c => c.tool ?? "?"), asked: cards.map(c => what.get(c.requestId) ?? null), outcome: done.outcome, failed: Boolean(done.failed), wall: done.wall };
}
await scenario("autoEveryday", async () => {
  if (ENGINES !== "real") return { skipped: "real engines only" };
  const engines = {}; let autoCards = 0, failed = 0;
  for (const id of [...S10_ENGINES, S10_ASK_ENGINE]) if (instances[id] && typeof instances[id].state !== "string") throw new Error(`engine ${id} state unreadable`); // never a skip that leaves failed at 0
  for (const id of S10_ENGINES) {
    if (instances[id]?.state !== "available") { engines[id] = { skipped: `engine ${instances[id]?.state ?? "missing"}` }; continue; }
    const bot = await makeBotOn(`Smooth everyday ${id}`, id);
    const set = await call("PATCH", `/api/bots/${bot.id}`, levelPatch("auto"));
    const turns = [];
    for (let i = 0; i < EVERYDAY_TASKS.length; i++) { await quiesce(); turns.push({ task: i, ...(await cardTurn(bot, EVERYDAY_TASKS[i])) }); }
    const cards = turns.reduce((a, t) => a + t.cards, 0); autoCards += cards;
    const f = turns.filter(t => t.failed).length; failed += f;
    engines[id] = { level: "auto", patch: set.status, turns: turns.length, cards, failed: f, cardsFor: turns.filter(t => t.cards).map(t => ({ task: t.task, n: t.cards, tools: t.tools, asked: t.asked })), perTurn: turns };
  }
  let ask = { skipped: `engine ${instances[S10_ASK_ENGINE]?.state ?? "missing"}` };
  if (instances[S10_ASK_ENGINE]?.state === "available") {
    const bot = await makeBotOn(`Smooth ask shell ${S10_ASK_ENGINE}`, S10_ASK_ENGINE);
    const set = await call("PATCH", `/api/bots/${bot.id}`, levelPatch("ask"));
    const turns = [];
    for (const cmd of DEV_COMMANDS) { await quiesce(); turns.push({ cmd: DEV_COMMANDS.indexOf(cmd), ...(await cardTurn(bot, `Run exactly this command and tell me its first output line: ${cmd}`)) }); }
    const f = turns.filter(t => t.failed).length; failed += f;
    ask = { engine: S10_ASK_ENGINE, level: "ask", patch: set.status, turns: turns.length, cards: turns.reduce((a, t) => a + t.cards, 0), withCard: turns.filter(t => t.cards).length, noCard: turns.filter(t => !t.cards).map(t => t.cmd), failed: f, perTurn: turns };
  }
  return { engines, autoCards, ask, failed, tasks: EVERYDAY_TASKS.length };
});

// S5 the longest real thread of a bot on a fake engine, five turns
await scenario("longThread", async ({ mark }) => {
  const db = new DatabaseSync(join(DATA, "messages.db"), { readOnly: true });
  let top; try { top = db.prepare("SELECT thread_id AS t, count(*) AS n FROM messages GROUP BY thread_id ORDER BY n DESC LIMIT 40").all(); } finally { db.close(); }
  const fakeEngines = new Set(ENGINES === "fake" ? ["claude", "fuigo"] : Object.keys(instances));
  const byThread = new Map();
  for (const b of realBots) { if (!fakeEngines.has(b.modelSelection?.instanceId)) continue; byThread.set(b.threadId, b); for (const t of b.tasks ?? []) byThread.set(t.threadId, b); }
  const pick = top.find(r => byThread.has(r.t));
  if (!pick) return { error: `no top-40 thread belongs to a visible bot on ${[...fakeEngines].join("/")}` };
  const bot = byThread.get(pick.t);
  // the bot's folder is the owner's Mac path: point it at a folder that exists here, so the turn is about the thread, not the folder
  const folder = botFolder(WORKDIR, "longThread", bot.id); mkdirSync(folder, { recursive: true });
  const setup = await prepareLongThread({ call, bot, threadId: pick.t, folder });
  scenarioBots.push({ id: bot.id, threadId: pick.t });
  const turns = [];
  for (let i = 0; i < 5; i++) { const t = await turn(bot.id, pick.t, PROMPT(100 + i, "this conversation")); turns.push(t); log("long turn", i, t.wall, t.outcome, `firstText=${t.firstText} resumed=${t.resumed} resets=${t.resets}`); }
  const ms = await threadMessages(pick.t, 40);
  const sig = countSignatures(logFrom(mark));
  return { thread: pick.t, threadMessages: pick.n, bot: bot.id, engine: bot.modelSelection?.instanceId, ...setup, ...summary(turns), resumed: turns.slice(1).filter(t => t.resumed === true).length, contextChanged: contextChangedIn(ms).length + sig.contextCard, turns: turns.map(t => ({ wall: t.wall, prep: t.prep, firstText: t.firstText, resumed: t.resumed, resets: t.resets, outcome: t.outcome })) };
});

// S6 deletion while three turns are held open: an old real conversation, then an idle fresh bot, then the gate opens
await scenario("deletion", async ({ mark }) => {
  const held = [await makeBot("Smooth Held 1", "scripted"), await makeBot("Smooth Held 2", "scripted"), await makeBot("Smooth Held 3", "scripted")];
  const idle = await makeBot("Smooth Idle", "fast");
  const gate = join(CTL, "gate"); try { rmSync(gate); } catch {}
  ctl("gate-file", gate); ctl("grok.mode", "echo-gated");
  // real engines: the held turn is a shell sleep at Full access (no card), so it is still working when the DELETEs go out
  if (ENGINES === "real") for (const b of held) await setLevel(b.id, "full"); // 1.0.13+ needs the preview and ifRev (see setLevel); a plain PATCH stays at Ask and the sleep waits on a card nobody answers
  const inFlight = held.map((b, i) => turn(b.id, b.threadId, heldPrompt(ENGINES, i), { timeout: 300_000, wait: false }));
  const busyOf = async id => (await getBot(id)).busy === true;
  const result = {};
  try {
    // the deletes start once every held turn is confirmed working (the bot reads busy), not after a fixed sleep
    const started = await waitFor(async () => (await Promise.all(held.map(b => busyOf(b.id)))).every(Boolean), { cap: 90_000, every: 500 });
    result.heldStarted = (await Promise.all(held.map(b => busyOf(b.id)))).filter(Boolean).length; result.heldStartMs = started.ms;
    // (a) an old conversation of the real bot with the most conversations (never its open one)
    const big = [...realBots].sort((a, b) => (b.tasks?.length ?? 0) - (a.tasks?.length ?? 0))[0];
    const old = big?.tasks?.filter(t => t.threadId !== big.threadId).sort((a, b) => (a.createdAt ?? a.at ?? 0) - (b.createdAt ?? b.at ?? 0))[0];
    if (big && old) { const d = await call("DELETE", `/api/bots/${big.id}/tasks/${old.threadId}`, undefined, 300_000); result.deleteThreadStatus = d.status; result.deleteThreadMs = d.status >= 200 && d.status < 300 ? d.ms : null; result.deletedThreadOf = big.id; }
    else result.deleteThreadStatus = "no old conversation found";
    // (b) an idle fresh bot
    const db_ = await call("DELETE", `/api/bots/${idle.id}`, undefined, 300_000); result.deleteBotStatus = db_.status; result.deleteBotMs = db_.status >= 200 && db_.status < 300 ? db_.ms : null;
    // (c) a WORKING conversation's delete must be refused
    // (c) sent only while held[0] reads busy; a turn that already ended is noted and the row is not measured
    const busyBefore = await busyOf(held[0].id);
    const w = await call("DELETE", `/api/bots/${held[0].id}/tasks/${held[0].threadId}`, undefined, 60_000);
    Object.assign(result, workingDeleteVerdict(busyBefore, w.status));
    result.heldZeroDeleted = w.status >= 200 && w.status < 300;
    if (!busyBefore) note("S6: held[0] was not working when its DELETE was sent; S6.workingRefused not measured");
  } finally { restore({ gate: "open" }); }
  const done = await Promise.all(inFlight);
  restore({ "grok.mode": null, "gate-file": null, gate: null });
  // a held conversation that really was deleted has no transcript: only the row that reads transcripts goes not measured, the rest stand
  let contextChanged = 0; for (const b of held) { if (b === held[0] && result.heldZeroDeleted) continue; contextChanged += contextChangedIn(await threadMessages(b.threadId, 40)).length; }
  const sig = countSignatures(logFrom(mark));
  return { ...result, heldCompleted: done.filter(t => !t.failed).length, heldOutcomes: done.map(t => t.outcome), heldWall: stats(done.map(t => t.wall)), heldWalls: done.map(t => t.wall), contextChanged: result.heldZeroDeleted ? null : contextChanged + sig.contextCard, rePreparing: sig.rePreparing, resets: sig.resets, deletionPending: sig.deletionPending };
});

// S7 one bot switches engine twice. The bot stays at the default Ask level (what customers get), so a real engine may raise an
// approval card: the runner answers each one as the owner would, Allow through the app's own route (POST /api/threads/:id/respond,
// store.tsx decideRequest), and times it. A question card (Fuigo's ask_user) gets the card's own Skip. The owner's time on a card is kept outside the turn's own latency and timeout.
await scenario("engineSwitch", async ({ mark }) => {
  const bot = await makeBot("Smooth Switch", "fast");
  const other = engineFor("claude"), first = engineFor("fast");
  const turns = [], afterSwitch = [], cards = [], known = new Set();
  const go = async (i, switched) => {
    await quiesce();
    let ended = null, cardMs = 0, cardOpenAt = null; const before = new Set(known); // a card an earlier turn answered is not this turn's wait
    const t = turn(bot.id, bot.threadId, PROMPT(200 + i, "the switch"), { wait: false, extraMs: () => cardMs + (cardOpenAt === null ? 0 : performance.now() - cardOpenAt) });
    void t.then(x => { ended = x; });
    const seen = await answerCards({
      fetchCards: async () => { const open = await openCardsOf(bot.threadId); const mine = open.filter(c => !before.has(c?.card?.requestId)); if (mine.length && cardOpenAt === null) cardOpenAt = performance.now(); if (!mine.length && cardOpenAt !== null) { cardMs += performance.now() - cardOpenAt; cardOpenAt = null; } return open; },
      respond: card => call("POST", `/api/threads/${bot.threadId}/respond`, ownerAnswer(card)),
      isDone: () => ended !== null, every: 250, cap: TURN_TIMEOUT + 120_000, known,
    });
    const done = await t;
    const timed = cardTimings(seen.cards, permissionWaits(logFrom(mark), done.traceId));
    for (const c of timed.cards) cards.push({ turn: i, ...c });
    // nothing is subtracted: the wall stays whole, the card wait is shown beside it, and a turn with no first text adds no reading
    const row = { ...done, cards: timed.cards.length, cardWaitMs: timed.cardWaitMs };
    turns.push(row);
    if (switched) afterSwitch.push(done.firstText);
    log("switch turn", i, done.outcome, `wall=${done.wall} cards=${timed.cards.length} cardWait=${timed.cardWaitMs}`);
  };
  await go(0); await go(1);
  const s1 = await call("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: other, model: instances[other]?.model || "default" } });
  await go(2, true); await go(3);
  const s2 = await call("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: first, model: instances[first]?.model || "default" } });
  await go(4, true); await go(5);
  await sleep(2000);
  const b = await getBot(bot.id);
  return { ...summary(turns), level: "ask", turnCards: turns.map(t => t.cards), cardWaitMs: turns.map(t => t.cardWaitMs),
    cards: cards.length, questions: cards.filter(c => c.kind === "question").length, limitOffers: cards.filter(c => c.kind === "limit").length, cardRows: cards, cardAppear: stats(cards.map(c => c.appearMs)), approvalCards: cards.filter(c => c.kind === "approval").length, cardVisible: cardStat(cards, "visibleMs", stats), cardResolve: cardStat(cards, "resolveMs", stats),
    cardAnswerFailed: cards.filter(c => c.status !== null && (c.status < 200 || c.status >= 300)).length,
    switches: [s1.status, s2.status], firstTextAfterSwitch: allTimed(afterSwitch, stats), errorRows: errorRowsIn(await threadMessages(bot.threadId, 60)).length, busyAtEnd: b.busy ? 1 : 0 };
});

// S8 Stop mid-turn, three times, then a normal turn after each
await scenario("stop", async () => {
  const bot = await makeBot("Smooth Stop", "scripted");
  // real engines: the Stop bot is at Full access (SMOOTH_STOP_LEVEL to change it), so an unanswered approval card is not what holds the turn
  const stopLevel = ENGINES === "real" ? (process.env.SMOOTH_STOP_LEVEL ?? "full") : null;
  if (stopLevel) await call("PATCH", `/api/bots/${bot.id}`, levelPatch(stopLevel));
  const settles = [], outcomes = [], next = [];
  for (let i = 0; i < 3; i++) {
    ctl("grok.mode", "slow-tool");
    const slowText = ENGINES === "real" ? `Run the shell command \`sleep 45\` and then reply with the word done (${i}).` : `Slow turn ${i}: run the long tool.`;
    const t = turn(bot.id, bot.threadId, slowText, { timeout: 120_000, wait: false });
    await sleep(5000);
    const t0 = performance.now();
    const stop = await call("POST", `/api/bots/${bot.id}/interrupt`, {}, 60_000);
    let settled = false;
    while (performance.now() - t0 < 60_000) { const b = await getBot(bot.id); if (b?.busy === false) { settled = true; break; } if (typeof b?.busy !== "boolean") throw new Error("bot busy state unreadable"); await sleep(250); }
    settles.push({ ms: Math.round(performance.now() - t0), settled, stopStatus: stop.status, stopAt: new Date(Date.now() - Math.round(performance.now() - t0)).toISOString() });
    const done = await t; outcomes.push(done.outcome);
    ctl("grok.mode", null);
    next.push(await turn(bot.id, bot.threadId, PROMPT(300 + i, "after the stop")));
  }
  // Murage's own activity chips in the Stop bot's thread, by name and count (e.g. the deletion-hold waiting note): never engine text
  const chips = {}; for (const m of await threadMessages(bot.threadId, 120)) if (m?.kind === "activity" && typeof m.tool?.name === "string" && !m.turnId) chips[m.tool.name.slice(0, 80)] = (chips[m.tool.name.slice(0, 80)] ?? 0) + 1;
  return { level: stopLevel ?? "default", bot: bot.id, thread: bot.threadId, chips, nextOutcomes: next.map(t => t.outcome), settle: stats(settles.map(s => s.ms)), settled: settles.filter(s => s.settled).length, stops: settles, outcomes, nextCompleted: next.filter(t => !t.failed).length, errorRows: errorRowsIn(await threadMessages(bot.threadId, 60)).length };
});

// S9 idle tail
await scenario("idle", async ({ from, mark }) => {
  const s = Number(process.env.SMOOTH_IDLE_S ?? 180);
  // CPU and RSS keep the settling minute in their window: that can only read high. First-minute lines stay counted in ALL.io.
  // whether memory is active is a fact of this install, so a side by side can say what it compared; an unreadable status records null
  const memoryMode = async () => { try { const r = await call("GET", "/api/memory/status", undefined, 30_000); return r.status === 200 && typeof r.json?.mode === "string" ? r.json.mode : null; } catch { return null; } };
  // the status read runs beside the polling, so a slow answer is never a gap in the polls
  const modeAtStart = memoryMode();
  const io = await idleIoCounts({ seconds: s, mark, startMs: from, now: Date.now, sleep, logSize, logFrom, count: text => countSignatures(text).ioBudget });
  const memoryModeStart = await modeAtStart, memoryModeEnd = await memoryMode();
  return { seconds: s, memoryModeStart, memoryModeEnd, ...io, ...window_(from, Date.now()) };
});

// ---- whole run, then cleanup
{ const excluded = R.excludedWindows ?? [], to = Date.now();
  const w = sampleWindow(samples, windowFrom, to, stats, excluded);
  // memory.peak is cumulative and cannot subtract WARM. With an excluded window the
  // resource row uses retained RSS samples, like macOS/Windows, and labels that source.
  if (tel === "linux-cgroup" && !excluded.length) w.rssMb = withPeak(w.rssMb, linuxPeak());
  if (excluded.length) w.rssPeakSource = "sampled outside S0 WARM; cumulative cgroup peak not attributable";
  // an unreadable log leaves its ALL rows absent, so they read not measured
  let fromLog = {}; try { const text = logText(), io = warmIoCounts(text, excluded); fromLog = { ...countSignatures(text), ioBudget: io.all, ioWrite: ioWriteStats(text, excluded),
    ...allEldWindows(text, R.firstSend, RUN_START, to, stats, excluded), resetLines: resetLines(text).length };
    for (const window of excluded) {
      const rows = eldStalls(text, window.from, to).fixed;
      const end = rows.find(row => row.t > window.to)?.t ?? window.to;
      R.scenarios.bootWarm.measurements.eld = eldSummary(rows.filter(row => row.t <= end), stats);
      R.scenarios.bootWarm.measurements.ioBudget = io.warm;
      R.scenarios.bootWarm.measurements.ioOverlap = io.overlap;
    }
  } catch (error) { note(`the server log could not be read for the ALL rows: ${keptText(error?.message ?? error, redact, 160)}`); }
  R.all = { ...R.all, ...fromLog, ...w }; }
R.phase = "cleanup";
R.status = R.legFailed ? "FAIL" : "CLEANUP";
save();
// Save each outcome before starting the next step, and keep trying after failures.
async function cleanupStep(step, action, accepted = response => response?.status >= 200 && response.status < 300) {
  const outcome = { step, ok: false };
  try {
    const response = await action();
    outcome.status = response?.status ?? null;
    if (!accepted(response)) throw Error(`rejected (${outcome.status ?? "no clean exit"})`);
    outcome.ok = true;
  } catch (error) {
    outcome.reason = `cleanup: ${step}: ${keptText(error?.message ?? error, redact, 160)}`;
    recordCleanupFailure(R, outcome.reason);
  }
  (R.cleanup ??= []).push(outcome);
  save();
}
if (!R.roomNeverSettled && !R.controlRestoreFailed) {
  // DELETE is never settlement evidence.
  for (const id of R.created.groups) await cleanupStep(`room ${id} DELETE`, () => roomCall("DELETE", `/api/groups/${id}`, undefined, roomBudget(Date.now() + 10_000, Date.now, 10_000)));
  for (const id of R.created.routines) await cleanupStep(`routine ${id} DELETE`, () => call("DELETE", `/api/routines/${id}`));
  for (const id of R.created.bots) {
    await cleanupStep(`bot ${id} interrupt`, () => call("POST", `/api/bots/${id}/interrupt`, { all: true }), r => r?.status === 200 || r?.status === 404);
    await cleanupStep(`bot ${id} DELETE`, () => call("DELETE", `/api/bots/${id}`, undefined, 120_000), r => r?.status === 200 || r?.status === 404);
  }
}
sampling = false;
await cleanupStep("owned server stop", stopServer, stopped => stopped === true);
R.all.serverExits = R.all.serverExits ?? 0;
const evidenceExit = await evidence.finish({
  shutdown: () => cleanupStep("SSE abort", shutdownSse, stopped => stopped === true),
  drain: () => drainFailureEnrichments("finalization"),
  complete: persistenceOk => {
    // Evidence failure does not skip cleanup. A failed results write, however,
    // cannot certify successful finalization even if a later save recovers.
    if (!R.roomNeverSettled && !R.controlRestoreFailed && persistenceOk) R.phase = "finished";
    R.finishedAt = new Date().toISOString();
    R.status = R.legFailed ? "FAIL" : "COMPLETE";
  },
});
log("DONE", JSON.stringify({ scenarios: Object.keys(R.scenarios), serverExits: R.all.serverExits, ioBudget: R.all.ioBudget }));
process.exit(evidenceExit);
